import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStarterSupervisorConfig } from "../src/config/index.js";
import { AttemptCleanupManager, type AttemptCleanupOperations } from "../src/worker/cleanup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function operations(overrides: Partial<AttemptCleanupOperations> = {}): AttemptCleanupOperations {
  return {
    remove: async () => undefined,
    rename: async () => undefined,
    wait: async () => undefined,
    ...overrides,
  };
}

describe("attempt cleanup manager", () => {
  it("retries bounded deletion before reporting a clean ephemeral release", async () => {
    let removals = 0;
    const waits: number[] = [];
    const config = {
      ...createStarterSupervisorConfig().cleanup,
      deleteMaxAttempts: 3,
      deleteBackoffMs: 10,
    };
    const manager = new AttemptCleanupManager(config, {
      operations: operations({
        async remove() {
          removals += 1;
          if (removals < 3) throw new Error("transient Windows lock");
        },
        async wait(milliseconds) {
          waits.push(milliseconds);
        },
      }),
    });

    const result = await manager.cleanup("C:/router-owned/attempt", { mode: "ephemeral" });

    expect(result).toMatchObject({
      ok: true,
      attempts: 3,
      retained: false,
      quarantined: false,
    });
    expect(result.pathHash).toMatch(/^[a-f0-9]{64}$/);
    expect(waits).toEqual([10, 20]);
    expect(manager.status()).toEqual({ degraded: false, quarantineCount: 0, reasons: [] });
  });

  it("quarantines a bounded path-hash record and clears degraded state after janitor recovery", async () => {
    const attemptRoot = "C:/private/session/attempt-one";
    let janitorMayRemove = false;
    let quarantinePath = "";
    const config = {
      ...createStarterSupervisorConfig().cleanup,
      deleteMaxAttempts: 1,
      janitorMaxItems: 1,
    };
    const manager = new AttemptCleanupManager(config, {
      operations: operations({
        async remove(path) {
          if (!janitorMayRemove) throw new Error(`locked resource at ${attemptRoot}`);
          expect(path).toBe(quarantinePath);
        },
        async rename(source, destination) {
          expect(source).toBe(attemptRoot);
          quarantinePath = destination;
        },
      }),
    });

    const result = await manager.cleanup(attemptRoot, { mode: "ephemeral" });

    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      retained: false,
      quarantined: true,
    });
    expect(JSON.stringify(result)).not.toContain(attemptRoot);
    expect(JSON.stringify(manager.status())).not.toContain(attemptRoot);
    expect(manager.status()).toMatchObject({ degraded: true, quarantineCount: 1 });

    janitorMayRemove = true;
    await expect(manager.runJanitor()).resolves.toEqual({ attempted: 1, removed: 1, remaining: 0 });
    expect(manager.status()).toEqual({ degraded: false, quarantineCount: 0, reasons: [] });
  });

  it("discovers only bounded Router-owned startup quarantine entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-router-cleanup-startup-"));
    temporaryDirectories.push(root);
    const quarantine = join(root, ".pi-agent-router-quarantine");
    const owned = join(quarantine, randomUUID());
    const unrelated = join(quarantine, "not-a-router-quarantine-entry");
    await mkdir(owned, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    const manager = new AttemptCleanupManager(createStarterSupervisorConfig().cleanup);

    await expect(manager.discoverQuarantine(root)).resolves.toBe(1);
    expect(manager.status()).toMatchObject({ degraded: true, quarantineCount: 1 });
    await expect(manager.runJanitor()).resolves.toEqual({ attempted: 1, removed: 1, remaining: 0 });
    await expect(stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(unrelated)).resolves.toBeDefined();
  });

  it("retains an unconfirmed-process root for janitor without attempting unsafe deletion", async () => {
    const attemptRoot = "C:/private/session/live-attempt";
    let removeCalls = 0;
    const manager = new AttemptCleanupManager(createStarterSupervisorConfig().cleanup, {
      operations: operations({
        async remove() {
          removeCalls += 1;
        },
      }),
    });

    const result = manager.retainForJanitor(
      attemptRoot,
      `Worker exit was not confirmed for ${attemptRoot}`,
    );

    expect(result).toMatchObject({
      ok: false,
      attempts: 0,
      retained: false,
      quarantined: false,
    });
    expect(JSON.stringify(result)).not.toContain(attemptRoot);
    expect(JSON.stringify(manager.status())).not.toContain(attemptRoot);
    expect(removeCalls).toBe(0);
  });
});
