import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createStarterRouterConfigV2 } from "../src/config/index.js";
import type { AgentRouterServiceEventBus } from "../src/service/index.js";
import {
  AGENT_ROUTER_DISCOVERY_TOPIC_V2,
  registerAgentRouterServiceV2,
} from "../src/service/index.js";
import { AttemptCleanupManager } from "../src/worker/cleanup.js";
import { AgentWorkerClient } from "../src/worker/index.js";
import { jobDescriptor } from "./helpers/supervisor-fixtures.js";
import { echoCapability, isProcessAlive } from "./helpers/worker-fixtures.js";

class TestEventBus implements AgentRouterServiceEventBus {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  emit(name: string, value: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(value);
  }

  on(name: string, handler: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(handler);
    this.listeners.set(name, listeners);
    return () => listeners.delete(handler);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function serviceHarness(fault?: string, options: { supervisedRouting?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-router-service-v2-e2e-"));
  temporaryDirectories.push(root);
  const configAgentDir = join(root, "config-agent-dir");
  await mkdir(configAgentDir, { recursive: true });
  const config = createStarterRouterConfigV2();
  config.supervisor.limits.providerLimits = [{ provider: "pi-agent-router-test", maxActive: 4 }];
  config.supervisor.deadlines.cooperativeAbortGraceMs = 100;
  config.supervisor.deadlines.processExitGraceMs = 2_000;
  if (options.supervisedRouting) {
    config.router.targets = [
      {
        executorId: "pi",
        model: "pi-agent-router-test/deterministic",
        thinkingLevel: "off",
      },
    ];
    const candidate = config.candidates[0];
    if (!candidate) throw new Error("Starter candidate fixture is missing.");
    candidate.id = "deterministic";
    candidate.model = "pi-agent-router-test/deterministic";
    candidate.allowedThinkingLevels = ["off"];
    candidate.minimumContextWindow = 1;
    config.candidates = [candidate];
  }
  const cleanupManager = new AttemptCleanupManager(config.supervisor.cleanup);
  const workerClient = new AgentWorkerClient({
    environment: {
      PI_AGENT_ROUTER_TEST_MODE: "deterministic",
      ...(fault ? { PI_AGENT_ROUTER_TEST_FAULT: fault } : {}),
    },
    cooperativeAbortGraceMs: 100,
    processExitGraceMs: 2_000,
    cleanupManager,
  });
  const attemptRoots: string[] = [];
  const events = new TestEventBus();
  const host = registerAgentRouterServiceV2(events, {
    loadConfiguration: async () => ({
      ok: true,
      path: join(configAgentDir, "agent-router.json"),
      config,
      configHash: "e2e-config",
      diagnostics: [],
    }),
    configAgentDir,
    cleanupManager,
    workerClient,
    createAttemptRoot: async (_jobId, attemptId) => {
      const path = join(root, attemptId.replaceAll(":", "-"));
      await mkdir(path, { recursive: true });
      attemptRoots.push(path);
      return path;
    },
    ...(options.supervisedRouting
      ? {}
      : {
          selectTarget: async () => ({
            candidateId: "deterministic",
            provider: "pi-agent-router-test",
            modelId: "deterministic",
            thinkingLevel: "off",
          }),
        }),
  });
  return { root, host, cleanupManager, attemptRoots, events };
}

function deterministicModelRegistry(): ModelRegistry {
  return {
    find(provider: string, id: string) {
      return {
        provider,
        id,
        name: id,
        api: "openai-completions",
        baseUrl: "http://127.0.0.1/unused",
        reasoning: false,
        input: ["text"],
        contextWindow: 16_384,
        maxTokens: 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as ModelRegistry;
}

function request(jobId: string, signal: AbortSignal) {
  const capability = echoCapability();
  const descriptor = jobDescriptor({
    jobId,
    ownerId: `session:${jobId}`,
    ownerKind: "session",
    now: Date.now(),
  });
  descriptor.capabilityNames = [capability.toolName];
  return {
    modelRegistry: {} as ModelRegistry,
    cwd: process.cwd(),
    job: {
      descriptor,
      execution: {
        payload: {
          kind: "agent" as const,
          prompt: "PRIVATE_SERVICE_V2_SENTINEL run the proxy tool.",
        },
        capabilities: [capability],
      },
      signal,
    },
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("Agent Router service V2 real Worker lifecycle", () => {
  it("runs a real isolated Worker and publishes terminal state only after cleanup", async () => {
    const { host, cleanupManager, attemptRoots } = await serviceHarness();
    const controller = new AbortController();

    const result = await host.service.runJob(request("job:service-real", controller.signal));

    expect(result).toMatchObject({
      status: "succeeded",
      cleanupComplete: true,
      inspection: {
        lifecycleState: "released",
        lease: { state: "released", processId: expect.any(Number) },
        cleanup: { ok: true },
      },
    });
    expect(result.inspection.lease?.processId).toBeTypeOf("number");
    expect(isProcessAlive(result.inspection.lease?.processId ?? -1)).toBe(false);
    expect(attemptRoots).toHaveLength(1);
    await expectMissing(attemptRoots[0] as string);
    expect(cleanupManager.status()).toMatchObject({ degraded: false, quarantineCount: 0 });
    const audit = await host.service.inspectAudit({ jobId: "job:service-real" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      terminalStatus: "succeeded",
      processExited: true,
      cleanup: { ok: true },
    });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE_SERVICE_V2_SENTINEL");
    expect(JSON.stringify(audit)).not.toContain(attemptRoots[0]);
    await host.dispose();
  }, 20_000);

  it("cleans a real failed control-plane judge before static Worker fallback", async () => {
    const { host, attemptRoots } = await serviceHarness(undefined, {
      supervisedRouting: true,
    });
    const controller = new AbortController();
    const submitted = request("job:service-routed", controller.signal);
    submitted.modelRegistry = deterministicModelRegistry();
    submitted.job.descriptor.task.requirements.requiresReasoning = false;

    await expect(host.service.runJob(submitted)).resolves.toMatchObject({
      status: "succeeded",
      cleanupComplete: true,
    });

    const audits = await host.service.inspectAudit();
    expect(audits.map((audit) => [audit.jobClass, audit.terminalStatus])).toEqual([
      ["router-control-plane", "failed"],
      ["full-agent", "succeeded"],
    ]);
    expect(Date.parse(audits[0]?.finishedAt ?? "")).toBeLessThanOrEqual(
      Date.parse(audits[1]?.startedAt ?? ""),
    );
    expect(attemptRoots).toHaveLength(2);
    await Promise.all(attemptRoots.map(expectMissing));
    await host.dispose();
  }, 20_000);

  it("propagates caller cancellation through Supervisor, Worker exit, and cleanup", async () => {
    const { host, attemptRoots } = await serviceHarness("hang");
    const controller = new AbortController();
    const pending = host.service.runJob(request("job:service-cancel", controller.signal));
    for (let index = 0; index < 100; index += 1) {
      const jobs = await host.service.inspectJobs({ jobId: "job:service-cancel" });
      if (jobs[0]?.processState === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    controller.abort("caller-ended");
    const result = await pending;

    expect(result).toMatchObject({
      status: "cancelled",
      cleanupComplete: true,
      inspection: {
        cancellationReason: "caller-aborted",
        processState: "exited",
        cleanup: { ok: true },
      },
    });
    expect(isProcessAlive(result.inspection.lease?.processId ?? -1)).toBe(false);
    expect(attemptRoots).toHaveLength(1);
    await expectMissing(attemptRoots[0] as string);
    await expect(host.service.inspectAudit({ jobId: "job:service-cancel" })).resolves.toEqual([
      expect.objectContaining({
        terminalStatus: "cancelled",
        cancellationReason: "caller-aborted",
        processExited: true,
        cleanup: expect.objectContaining({ ok: true }),
      }),
    ]);
    await host.dispose();
  }, 20_000);

  it.skipIf(process.platform !== "win32")(
    "escalates an ignored cancellation through the owned Windows process tree",
    async () => {
      const { host, attemptRoots } = await serviceHarness("ignore-cancel-tree");
      const controller = new AbortController();
      const pending = host.service.runJob(request("job:service-force", controller.signal));
      for (let index = 0; index < 100; index += 1) {
        const jobs = await host.service.inspectJobs({ jobId: "job:service-force" });
        if (jobs[0]?.processState === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      controller.abort("force-owned-tree");
      const result = await pending;

      expect(result).toMatchObject({ status: "cancelled", cleanupComplete: true });
      expect(isProcessAlive(result.inspection.lease?.processId ?? -1)).toBe(false);
      await expect(host.service.inspectAudit({ jobId: "job:service-force" })).resolves.toEqual([
        expect.objectContaining({
          terminalStatus: "cancelled",
          processEscalated: true,
          processExited: true,
        }),
      ]);
      expect(attemptRoots).toHaveLength(1);
      await expectMissing(attemptRoots[0] as string);
      await host.dispose();
    },
    20_000,
  );

  it("drains a hanging Worker before unregistering discovery during reload", async () => {
    const { host, attemptRoots, events } = await serviceHarness("hang");
    const controller = new AbortController();
    const pending = host.service.runJob(request("job:service-drain", controller.signal));
    for (let index = 0; index < 100; index += 1) {
      const jobs = await host.service.inspectJobs({ jobId: "job:service-drain" });
      if (jobs[0]?.processState === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const disposal = host.dispose("extension-reload");
    expect(events.listeners.get(AGENT_ROUTER_DISCOVERY_TOPIC_V2)?.size).toBe(1);
    await expect(pending).resolves.toMatchObject({
      status: "service_drained",
      cleanupComplete: true,
      inspection: { processState: "exited", cleanup: { ok: true } },
    });
    await disposal;

    expect(events.listeners.get(AGENT_ROUTER_DISCOVERY_TOPIC_V2)?.size ?? 0).toBe(0);
    expect(attemptRoots).toHaveLength(1);
    await expectMissing(attemptRoots[0] as string);
    await expect(host.service.inspectSupervisor()).resolves.toMatchObject({
      state: "stopped",
      activeFullAgentJobs: 0,
      queuedJobs: 0,
    });
  }, 20_000);
});
