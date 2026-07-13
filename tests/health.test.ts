import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStarterRouterConfig } from "../src/config/index.js";
import type { RouteAttempt } from "../src/contracts/index.js";
import {
  createHealthState,
  type DoctorProbe,
  type HealthPolicy,
  healthSnapshot,
  loadHealthState,
  recordAttemptHealth,
  recordHealthFailure,
  recordHealthSuccess,
  runDoctor,
  saveHealthState,
} from "../src/health/index.js";
import type { CandidateSnapshot } from "../src/routing/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const policy: HealthPolicy = {
  successTtlMs: 900_000,
  failureCooldownMs: 300_000,
  rateLimitCooldownMinMs: 60_000,
  rateLimitCooldownMaxMs: 1_800_000,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-router-health-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function snapshots(): CandidateSnapshot[] {
  return createStarterRouterConfig().candidates.map((candidate) => ({
    config: candidate,
    executorAvailable: true,
    model: {
      available: true,
      contextWindow: 400_000,
      inputModalities: ["text", "image"],
      reasoning: true,
      supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    },
    health: { status: "unknown" },
  }));
}

describe("passive health state", () => {
  it("expires successful task-as-probe evidence after its TTL", () => {
    const observedAt = new Date("2026-01-01T00:00:00.000Z");
    const state = recordHealthSuccess(
      createHealthState(HASH_A, observedAt),
      "codex-mini",
      policy,
      observedAt,
      120,
    );

    expect(healthSnapshot(state, "codex-mini", observedAt)).toMatchObject({ status: "healthy" });
    expect(healthSnapshot(state, "codex-mini", new Date("2026-01-01T00:15:01.000Z"))).toMatchObject(
      {
        status: "unknown",
      },
    );
  });

  it("cools down retryable failures without poisoning health for non-retryable outcomes", () => {
    const observedAt = new Date("2026-01-01T00:00:00.000Z");
    const fresh = createHealthState(HASH_A, observedAt);
    const cooldown = recordHealthFailure(
      fresh,
      "codex-mini",
      "timeout",
      policy,
      observedAt,
      "provider timed out",
    );

    expect(healthSnapshot(cooldown, "codex-mini", observedAt)).toMatchObject({
      status: "cooldown",
      reason: "provider timed out",
    });
    expect(
      healthSnapshot(cooldown, "codex-mini", new Date("2026-01-01T00:05:01.000Z")),
    ).toMatchObject({ status: "unknown" });
    expect(
      recordHealthFailure(fresh, "codex-mini", "unknown-side-effect", policy, observedAt),
    ).toBe(fresh);
  });

  it("backs off repeated rate limits within configured bounds", () => {
    const firstAt = new Date("2026-01-01T00:00:00.000Z");
    const first = recordHealthFailure(
      createHealthState(HASH_A, firstAt),
      "codex-mini",
      "rate-limit",
      policy,
      firstAt,
    );
    const secondAt = new Date("2026-01-01T00:00:01.000Z");
    const second = recordHealthFailure(first, "codex-mini", "rate-limit", policy, secondAt);

    expect(first.entries[0]?.expiresAt).toBe("2026-01-01T00:01:00.000Z");
    expect(second.entries[0]?.expiresAt).toBe("2026-01-01T00:02:01.000Z");
  });

  it("uses completed real attempts as passive probes", () => {
    const observedAt = new Date("2026-01-01T00:00:00.000Z");
    const attempt: RouteAttempt = {
      attemptId: "attempt-1",
      routeId: "route-1",
      taskId: "task-1",
      target: {
        candidateId: "codex-mini",
        executorId: "pi-sdk",
        model: "openai-codex/gpt-5.4-mini",
        thinkingLevel: "medium",
      },
      startedAt: observedAt.toISOString(),
      finishedAt: new Date(observedAt.getTime() + 200).toISOString(),
      elapsedMs: 200,
    };

    const state = recordAttemptHealth(
      createHealthState(HASH_A, observedAt),
      attempt,
      policy,
      observedAt,
    );
    expect(healthSnapshot(state, "codex-mini", observedAt)).toMatchObject({ status: "healthy" });
  });

  it("atomically persists valid state and invalidates it when config hash changes", async () => {
    const path = await temporaryPath("health.json");
    const observedAt = new Date("2026-01-01T00:00:00.000Z");
    const state = recordHealthSuccess(
      createHealthState(HASH_A, observedAt),
      "codex-mini",
      policy,
      observedAt,
    );
    await saveHealthState(state, path);

    const loaded = await loadHealthState(HASH_A, path, observedAt);
    expect(loaded.state.entries).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      configHash: HASH_A,
    });

    const invalidated = await loadHealthState(HASH_B, path, observedAt);
    expect(invalidated.state).toMatchObject({ configHash: HASH_B, entries: [] });
    expect(invalidated.diagnostics[0]?.code).toBe("health_config_changed");
  });

  it("quarantines corrupt persisted state and starts fresh", async () => {
    const path = await temporaryPath("health.json");
    await writeFile(path, "{ not-json", "utf8");

    const loaded = await loadHealthState(HASH_A, path, new Date("2026-01-01T00:00:00.000Z"));

    expect(loaded.state.entries).toEqual([]);
    expect(loaded.diagnostics[0]?.code).toBe("health_state_recovered");
    expect(loaded.recoveredPath).toBeDefined();
    if (!loaded.recoveredPath) throw new Error("Missing recovery path.");
    expect((await stat(loaded.recoveredPath)).isFile()).toBe(true);
  });
});

describe("manual Doctor", () => {
  it("never invokes paid probes in static mode", async () => {
    const run = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
    const report = await runDoctor({
      mode: "static",
      snapshots: snapshots(),
      probes: [{ candidateId: "codex-mini", run }],
      healthState: createHealthState(HASH_A),
      healthPolicy: policy,
      probeTimeoutMs: 50,
      overallTimeoutMs: 200,
      maxConcurrency: 2,
    });

    expect(run).not.toHaveBeenCalled();
    expect(report.results.every((item) => item.activeStatus === "not-requested")).toBe(true);
  });

  it("runs active probes only when requested, with bounded concurrency and health updates", async () => {
    let active = 0;
    let peak = 0;
    const probes: DoctorProbe[] = snapshots().map((snapshot) => ({
      candidateId: snapshot.config.id,
      async run() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, latencyMs: 5 };
      },
    }));

    const report = await runDoctor({
      mode: "active",
      snapshots: snapshots(),
      probes,
      healthState: createHealthState(HASH_A),
      healthPolicy: policy,
      probeTimeoutMs: 100,
      overallTimeoutMs: 200,
      maxConcurrency: 2,
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(report.results.every((item) => item.activeStatus === "passed")).toBe(true);
    expect(report.healthState.entries).toHaveLength(4);
  });

  it("bounds an active probe by timeout and records cooldown", async () => {
    const values = snapshots().slice(0, 1);
    const candidate = values[0];
    if (!candidate) throw new Error("Starter candidate missing.");
    const probe: DoctorProbe = {
      candidateId: candidate.config.id,
      run: () => new Promise(() => undefined),
    };

    const report = await runDoctor({
      mode: "active",
      snapshots: values,
      probes: [probe],
      healthState: createHealthState(HASH_A),
      healthPolicy: policy,
      probeTimeoutMs: 5,
      overallTimeoutMs: 100,
      maxConcurrency: 1,
    });

    expect(report.results[0]?.activeStatus).toBe("failed");
    expect(report.results[0]?.activeMessage).toContain("timed out");
    expect(report.healthState.entries[0]).toMatchObject({ status: "cooldown" });
  });

  it("stops starting active probes at the Doctor overall deadline", async () => {
    const probes: DoctorProbe[] = snapshots().map((snapshot) => ({
      candidateId: snapshot.config.id,
      run: () => new Promise(() => undefined),
    }));

    const report = await runDoctor({
      mode: "active",
      snapshots: snapshots(),
      probes,
      healthState: createHealthState(HASH_A),
      healthPolicy: policy,
      probeTimeoutMs: 1_000,
      overallTimeoutMs: 5,
      maxConcurrency: 1,
    });

    expect(report.results[0]?.activeStatus).toBe("failed");
    expect(report.results[0]?.activeMessage).toContain("overall timed out");
    expect(report.results.slice(1).every((item) => item.activeStatus === "skipped")).toBe(true);
  });
});
