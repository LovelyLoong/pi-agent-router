import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SupervisorConfig } from "../config/schema.js";
import type { AgentJobRetention } from "../contracts/jobs.js";

export interface AttemptCleanupOperations {
  remove(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

export interface AttemptCleanupOutcome {
  ok: boolean;
  attempts: number;
  retained: boolean;
  quarantined: boolean;
  pathHash: string;
  reason?: string | undefined;
}

interface QuarantineEntry {
  path: string;
  pathHash: string;
  addedAt: number;
  reason: string;
}

const defaultOperations: AttemptCleanupOperations = {
  remove: (path) => rm(path, { recursive: true, force: true }),
  rename,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactedReason(error: unknown, attemptRoot: string): string {
  const raw = errorMessage(error);
  const variants = new Set([
    attemptRoot,
    attemptRoot.replaceAll("\\", "/"),
    attemptRoot.replaceAll("/", "\\"),
  ]);
  let redacted = raw;
  for (const path of variants) {
    if (path) redacted = redacted.replaceAll(path, "[router-owned-path]");
  }
  return redacted.slice(0, 2_000);
}

export class AttemptCleanupManager {
  readonly #config: SupervisorConfig["cleanup"];
  readonly #operations: AttemptCleanupOperations;
  readonly #quarantineRootName: string;
  readonly #quarantine = new Map<string, QuarantineEntry>();
  readonly #degradedReasons = new Set<string>();

  constructor(
    config: SupervisorConfig["cleanup"],
    options: {
      operations?: AttemptCleanupOperations | undefined;
      quarantineRootName?: string | undefined;
    } = {},
  ) {
    this.#config = structuredClone(config);
    this.#operations = options.operations ?? defaultOperations;
    this.#quarantineRootName = options.quarantineRootName ?? ".pi-agent-router-quarantine";
  }

  async cleanup(attemptRoot: string, retention: AgentJobRetention): Promise<AttemptCleanupOutcome> {
    const pathHash = hashPath(attemptRoot);
    if (retention.mode === "debug") {
      return { ok: true, attempts: 0, retained: true, quarantined: false, pathHash };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#config.deleteMaxAttempts; attempt += 1) {
      try {
        await this.#operations.remove(attemptRoot);
        return { ok: true, attempts: attempt, retained: false, quarantined: false, pathHash };
      } catch (error) {
        lastError = error;
        if (attempt < this.#config.deleteMaxAttempts) {
          await this.#operations.wait(this.#config.deleteBackoffMs * attempt);
        }
      }
    }

    const reason = redactedReason(lastError, attemptRoot);
    const quarantineRoot = join(dirname(attemptRoot), this.#quarantineRootName);
    const quarantinePath = join(quarantineRoot, `${Date.now()}-${randomUUID()}`);
    let quarantined = false;
    try {
      await mkdir(quarantineRoot, { recursive: true });
      await chmod(quarantineRoot, 0o700).catch(() => undefined);
      await this.#operations.rename(attemptRoot, quarantinePath);
      quarantined = true;
      this.#quarantine.set(pathHash, {
        path: quarantinePath,
        pathHash,
        addedAt: Date.now(),
        reason,
      });
    } catch {
      this.#quarantine.set(pathHash, { path: attemptRoot, pathHash, addedAt: Date.now(), reason });
    }
    this.#degradedReasons.add(`cleanup:${pathHash}:${reason}`);
    return {
      ok: false,
      attempts: this.#config.deleteMaxAttempts,
      retained: false,
      quarantined,
      pathHash,
      reason,
    };
  }

  retainForJanitor(attemptRoot: string, failure: unknown): AttemptCleanupOutcome {
    const pathHash = hashPath(attemptRoot);
    const reason = redactedReason(failure, attemptRoot);
    this.#quarantine.set(pathHash, {
      path: attemptRoot,
      pathHash,
      addedAt: Date.now(),
      reason,
    });
    this.#degradedReasons.add(`cleanup:${pathHash}:${reason}`);
    return {
      ok: false,
      attempts: 0,
      retained: false,
      quarantined: false,
      pathHash,
      reason,
    };
  }

  async runJanitor(): Promise<{ attempted: number; removed: number; remaining: number }> {
    let attempted = 0;
    let removed = 0;
    for (const entry of [...this.#quarantine.values()].slice(0, this.#config.janitorMaxItems)) {
      attempted += 1;
      try {
        await this.#operations.remove(entry.path);
        this.#quarantine.delete(entry.pathHash);
        removed += 1;
      } catch {
        // Keep bounded metadata for the next explicit/startup janitor pass.
      }
    }
    if (this.#quarantine.size === 0) this.#degradedReasons.clear();
    return { attempted, removed, remaining: this.#quarantine.size };
  }

  status(): { degraded: boolean; quarantineCount: number; reasons: string[] } {
    return {
      degraded: this.#degradedReasons.size > 0,
      quarantineCount: this.#quarantine.size,
      reasons: [...this.#degradedReasons],
    };
  }
}
