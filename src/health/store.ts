import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import {
  type FailureClass,
  RETRYABLE_FAILURE_CLASSES,
  type RouteAttempt,
} from "../contracts/routing.js";
import type { CandidateHealthSnapshot } from "../routing/filter.js";
import {
  HEALTH_STATE_VERSION,
  type HealthEntry,
  type HealthState,
  HealthStateSchema,
} from "./schema.js";

const MAX_HEALTH_BYTES = 2 * 1024 * 1024;
const RETRYABLE_FAILURE_SET: ReadonlySet<FailureClass> = new Set(RETRYABLE_FAILURE_CLASSES);

export interface LoadedHealthState {
  state: HealthState;
  diagnostics: RouterDiagnostic[];
  recoveredPath?: string;
}

export interface HealthPolicy {
  successTtlMs: number;
  failureCooldownMs: number;
  rateLimitCooldownMinMs: number;
  rateLimitCooldownMaxMs: number;
}

export function getAgentRouterHealthPath(agentDir?: string): string {
  const root = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(root, "cache", "pi-agent-router", "health-v1.json");
}

export function createHealthState(configHash: string, now = new Date()): HealthState {
  return { version: HEALTH_STATE_VERSION, configHash, updatedAt: now.toISOString(), entries: [] };
}

function diagnostic(code: string, message: string, path: string): RouterDiagnostic {
  return { severity: "warning", code, message, path };
}

function replaceEntry(state: HealthState, entry: HealthEntry, now: Date): HealthState {
  return {
    ...state,
    updatedAt: now.toISOString(),
    entries: [
      ...state.entries.filter((item) => item.candidateId !== entry.candidateId),
      entry,
    ].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  };
}

function findEntry(state: HealthState, candidateId: string): HealthEntry | undefined {
  return state.entries.find((entry) => entry.candidateId === candidateId);
}

export async function loadHealthState(
  configHash: string,
  path = getAgentRouterHealthPath(),
  now = new Date(),
): Promise<LoadedHealthState> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_HEALTH_BYTES) {
      throw new Error(
        metadata.isFile()
          ? `Health state exceeds ${MAX_HEALTH_BYTES} bytes.`
          : "Health state path is not a file.",
      );
    }
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Value.Check(HealthStateSchema, value)) {
      const error = Value.Errors(HealthStateSchema, value)[0];
      throw new Error(`${error?.instancePath || "/"} ${error?.message || "invalid health state"}`);
    }
    const state = value as HealthState;
    const candidateIds = state.entries.map((entry) => entry.candidateId);
    if (new Set(candidateIds).size !== candidateIds.length) {
      throw new Error("Health state contains duplicate candidate ids.");
    }
    if (state.configHash !== configHash) {
      return {
        state: createHealthState(configHash, now),
        diagnostics: [
          diagnostic(
            "health_config_changed",
            "Ignored cached health because the authoritative configuration hash changed.",
            path,
          ),
        ],
      };
    }
    return { state, diagnostics: [] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: createHealthState(configHash, now), diagnostics: [] };

    const recoveredPath = `${path}.corrupt-${now.getTime()}-${randomUUID()}`;
    try {
      await rename(path, recoveredPath);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          state: createHealthState(configHash, now),
          diagnostics: [
            diagnostic(
              "health_recovery_failed",
              `Ignored corrupt health state but could not quarantine it: ${String(renameError)}`,
              path,
            ),
          ],
        };
      }
    }
    return {
      state: createHealthState(configHash, now),
      diagnostics: [
        diagnostic(
          "health_state_recovered",
          `Quarantined unreadable health state and started fresh: ${String(error)}`,
          path,
        ),
      ],
      recoveredPath,
    };
  }
}

export async function saveHealthState(
  state: HealthState,
  path = getAgentRouterHealthPath(),
): Promise<void> {
  if (!Value.Check(HealthStateSchema, state))
    throw new Error("Refusing to persist invalid health state.");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function healthSnapshot(
  state: HealthState,
  candidateId: string,
  now = new Date(),
): CandidateHealthSnapshot {
  const entry = findEntry(state, candidateId);
  if (!entry) return { status: "unknown" };
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= now.getTime()) {
    return { status: "unknown", checkedAt: entry.checkedAt, reason: "Cached health expired." };
  }
  return {
    status: entry.status,
    checkedAt: entry.checkedAt,
    ...(entry.status === "cooldown" && entry.expiresAt ? { cooldownUntil: entry.expiresAt } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
}

export function recordHealthSuccess(
  state: HealthState,
  candidateId: string,
  policy: HealthPolicy,
  now = new Date(),
  latencyMs?: number,
): HealthState {
  const timestamp = now.toISOString();
  const entry: HealthEntry = {
    candidateId,
    status: "healthy",
    checkedAt: timestamp,
    expiresAt: new Date(now.getTime() + policy.successTtlMs).toISOString(),
    lastSuccessAt: timestamp,
    consecutiveFailures: 0,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
  return replaceEntry(state, entry, now);
}

export function recordHealthFailure(
  state: HealthState,
  candidateId: string,
  failureClass: FailureClass,
  policy: HealthPolicy,
  now = new Date(),
  reason?: string,
): HealthState {
  if (!RETRYABLE_FAILURE_SET.has(failureClass)) return state;
  const previous = findEntry(state, candidateId);
  const timestamp = now.toISOString();
  const previousRateLimits =
    previous?.lastFailureClass === "rate-limit" ? previous.consecutiveFailures : 0;
  const rateLimitCooldown = Math.min(
    policy.rateLimitCooldownMaxMs,
    policy.rateLimitCooldownMinMs * 2 ** Math.min(previousRateLimits, 20),
  );
  const cooldownMs = failureClass === "rate-limit" ? rateLimitCooldown : policy.failureCooldownMs;
  const entry: HealthEntry = {
    candidateId,
    status: "cooldown",
    checkedAt: timestamp,
    expiresAt: new Date(now.getTime() + cooldownMs).toISOString(),
    lastFailureAt: timestamp,
    lastFailureClass: failureClass,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
    ...(reason ? { reason } : {}),
  };
  return replaceEntry(state, entry, now);
}

export function recordAttemptHealth(
  state: HealthState,
  attempt: RouteAttempt,
  policy: HealthPolicy,
  now = new Date(),
): HealthState {
  if (attempt.finishedAt && !attempt.failureClass) {
    return recordHealthSuccess(state, attempt.target.candidateId, policy, now, attempt.elapsedMs);
  }
  if (attempt.failureClass) {
    return recordHealthFailure(
      state,
      attempt.target.candidateId,
      attempt.failureClass,
      policy,
      now,
      attempt.errorMessage,
    );
  }
  return state;
}
