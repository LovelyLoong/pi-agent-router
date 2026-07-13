import { describe, expect, it } from "vitest";
import { createStarterSupervisorConfig } from "../src/config/index.js";
import { AttemptCleanupManager, type AttemptCleanupOperations } from "../src/worker/cleanup.js";

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
