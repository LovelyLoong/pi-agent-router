import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { type AgentRouterConfigV2, createStarterRouterConfigV2 } from "../src/config/index.js";
import type { AgentJobResultV2 } from "../src/contracts/index.js";
import {
  AGENT_ROUTER_DISCOVERY_TOPIC_V2,
  AGENT_ROUTER_JOB_AUDIT_TOPIC_V2,
  AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2,
  type AgentRouterServiceEventBus,
  registerAgentRouterServiceV2,
} from "../src/service/index.js";
import { AttemptCleanupManager } from "../src/worker/cleanup.js";
import type { AgentWorkerAttemptRequest, AgentWorkerAttemptResult } from "../src/worker/index.js";
import { jobDescriptor } from "./helpers/supervisor-fixtures.js";

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

const NOW = Date.parse("2026-07-13T20:00:00.000Z");

function request(jobId: string, ownerId: string, signal: AbortSignal) {
  return {
    modelRegistry: {} as ModelRegistry,
    cwd: "C:/repo",
    job: {
      descriptor: jobDescriptor({ jobId, ownerId, ownerKind: "plugin", now: Date.now() }),
      execution: {
        payload: { kind: "agent", prompt: `PRIVATE:${jobId}` } as const,
        capabilities: [],
      },
      signal,
    },
  };
}

function availableModelRegistry(): ModelRegistry {
  return {
    find(provider: string, id: string) {
      return {
        provider,
        id,
        name: id,
        api: "openai-codex-responses",
        baseUrl: "https://example.invalid",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as ModelRegistry;
}

function workerResult(
  input: AgentWorkerAttemptRequest,
  status: AgentWorkerAttemptResult["status"] = "succeeded",
): AgentWorkerAttemptResult {
  return {
    identity: input.identity,
    processId: 41,
    workerNonce: "nonce-redacted",
    status,
    ...(status === "succeeded" ? { result: { answer: "ok" } } : {}),
    cleanup: {
      ok: status !== "cleanup_failed",
      attempts: 1,
      retained: false,
      quarantined: status === "cleanup_failed",
      pathHash: "1".repeat(64),
      ...(status === "cleanup_failed" ? { reason: "locked" } : {}),
    },
    stderr: "",
  };
}

function hostOptions(
  runAttempt: (input: AgentWorkerAttemptRequest) => Promise<AgentWorkerAttemptResult>,
  configure?: (config: AgentRouterConfigV2) => void,
) {
  const config = createStarterRouterConfigV2();
  configure?.(config);
  return {
    loadConfiguration: async () => ({
      ok: true as const,
      path: "C:/agent/agent-router.json",
      config,
      configHash: "config-hash",
      diagnostics: [],
    }),
    configAgentDir: "C:/agent",
    workerClient: { runAttempt },
    createAttemptRoot: async (_jobId: string, attemptId: string) => `C:/private/${attemptId}`,
    selectTarget: async () => ({
      candidateId: "codex-mini",
      provider: "openai-codex",
      modelId: "deterministic",
      thinkingLevel: "off",
    }),
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}

describe("Agent Router service V2 lifecycle domain", () => {
  it("fails closed before admission when an owner-bound call has no lifecycle signal", async () => {
    const events = new TestEventBus();
    const runAttempt = vi.fn(async (input: AgentWorkerAttemptRequest) => workerResult(input));
    const host = registerAgentRouterServiceV2(events, hostOptions(runAttempt));
    const submitted = request(
      "job:missing-lifecycle",
      "plugin:missing-lifecycle",
      new AbortController().signal,
    );
    const { signal: _signal, ...jobWithoutSignal } = submitted.job;

    await expect(host.service.runJob({ ...submitted, job: jobWithoutSignal })).rejects.toThrow(
      "requires a caller",
    );
    await expect(host.service.inspectJobs({ includeTerminal: true })).resolves.toEqual([]);
    expect(runAttempt).not.toHaveBeenCalled();
    await host.dispose();
  });

  it("owns one supervisor and worker domain across concurrent plugin jobs", async () => {
    const events = new TestEventBus();
    const pending = new Map<string, (result: AgentWorkerAttemptResult) => void>();
    const runAttempt = vi.fn(
      (input: AgentWorkerAttemptRequest) =>
        new Promise<AgentWorkerAttemptResult>((resolve) => {
          input.onLifecycleEvent?.({
            type: "spawned",
            jobId: input.identity.jobId,
            attemptId: input.identity.attemptId,
            processId: 41,
            at: new Date(NOW).toISOString(),
          });
          pending.set(input.identity.jobId, resolve);
        }),
    );
    const host = registerAgentRouterServiceV2(events, {
      instanceId: "router-v2-one",
      ...hostOptions(runAttempt),
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = host.service.runJob(request("job:first", "plugin:first", firstController.signal));
    const second = host.service.runJob(
      request("job:second", "plugin:second", secondController.signal),
    );

    await waitUntil(() => pending.size === 2);
    await expect(host.service.inspectSupervisor()).resolves.toMatchObject({
      state: "accepting",
      activeFullAgentJobs: 2,
      queuedJobs: 0,
      activeOwners: 2,
    });
    const jobs = await host.service.inspectJobs({ includeTerminal: true });
    expect(jobs.map((job) => job.jobId)).toEqual(["job:first", "job:second"]);
    expect(new Set(jobs.map((job) => job.attempt?.attemptId)).size).toBe(2);

    for (const [jobId, resolve] of pending) {
      const call = runAttempt.mock.calls.find(([input]) => input.identity.jobId === jobId)?.[0];
      if (!call) throw new Error(`Missing worker request for ${jobId}.`);
      resolve(workerResult(call));
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining<Partial<AgentJobResultV2>>({ status: "succeeded" }),
      expect.objectContaining<Partial<AgentJobResultV2>>({ status: "succeeded" }),
    ]);
    expect(runAttempt).toHaveBeenCalledTimes(2);
    await host.dispose("test-complete");
    expect(events.listeners.get(AGENT_ROUTER_DISCOVERY_TOPIC_V2)?.size ?? 0).toBe(0);
  });

  it("binds caller and owner cancellation, drains before discovery disposal, and audits once", async () => {
    const events = new TestEventBus();
    const runAttempt = vi.fn(async (input: AgentWorkerAttemptRequest) => {
      input.onLifecycleEvent?.({
        type: "spawned",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        processId: 42,
        at: new Date(NOW).toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      input.onLifecycleEvent?.({
        type: "cancel_requested",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        at: new Date(NOW + 1).toISOString(),
      });
      input.onLifecycleEvent?.({
        type: "exited",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        at: new Date(NOW + 2).toISOString(),
      });
      input.onLifecycleEvent?.({
        type: "cleanup_finished",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        status: "cancelled",
        at: new Date(NOW + 3).toISOString(),
      });
      return workerResult(input, "cancelled");
    });
    const host = registerAgentRouterServiceV2(events, hostOptions(runAttempt));
    const emittedAudits: unknown[] = [];
    const emittedStatuses: unknown[] = [];
    events.on(AGENT_ROUTER_JOB_AUDIT_TOPIC_V2, (value) => emittedAudits.push(value));
    events.on(AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2, (value) => emittedStatuses.push(value));
    const caller = new AbortController();
    const result = host.service.runJob(request("job:cancel", "plugin:cancel", caller.signal));
    await waitUntil(() => runAttempt.mock.calls.length === 1);

    caller.abort("caller-ended");
    await expect(result).resolves.toMatchObject({
      jobId: "job:cancel",
      status: "cancelled",
      cleanupComplete: true,
    });
    const audits = await host.service.inspectAudit({ jobId: "job:cancel" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      jobId: "job:cancel",
      ownerKind: "plugin",
      terminalStatus: "cancelled",
      cancellationReason: "caller-aborted",
      processExited: true,
      cleanup: { ok: true },
    });
    expect(JSON.stringify(audits)).not.toContain("PRIVATE:job:cancel");
    expect(JSON.stringify(audits)).not.toContain("C:/private");
    expect(emittedAudits).toEqual(audits);
    expect(emittedStatuses).toContainEqual(expect.objectContaining({ activeFullAgentJobs: 1 }));

    const draining = host.dispose("extension-reload");
    expect(events.listeners.get(AGENT_ROUTER_DISCOVERY_TOPIC_V2)?.size).toBe(1);
    await draining;
    expect(events.listeners.get(AGENT_ROUTER_DISCOVERY_TOPIC_V2)?.size ?? 0).toBe(0);
    await expect(host.service.inspectSupervisor()).resolves.toMatchObject({ state: "stopped" });
  });

  it("keeps discovery registered when the drain deadline expires, then permits recovery", async () => {
    const events = new TestEventBus();
    let workerRequest: AgentWorkerAttemptRequest | undefined;
    let resolveWorker: ((result: AgentWorkerAttemptResult) => void) | undefined;
    const runAttempt = vi.fn(
      (input: AgentWorkerAttemptRequest) =>
        new Promise<AgentWorkerAttemptResult>((resolve) => {
          workerRequest = input;
          resolveWorker = resolve;
          input.onLifecycleEvent?.({
            type: "spawned",
            jobId: input.identity.jobId,
            attemptId: input.identity.attemptId,
            processId: 46,
            at: new Date(NOW).toISOString(),
          });
        }),
    );
    const host = registerAgentRouterServiceV2(
      events,
      hostOptions(runAttempt, (config) => {
        config.supervisor.deadlines.drainDeadlineMs = 5;
      }),
    );
    const controller = new AbortController();
    const pending = host.service.runJob(
      request("job:drain-timeout", "plugin:drain", controller.signal),
    );
    await waitUntil(() => Boolean(workerRequest));

    await expect(host.dispose("reload-timeout")).rejects.toThrow("drain exceeded");
    expect(events.listeners.get(AGENT_ROUTER_DISCOVERY_TOPIC_V2)?.size).toBe(1);
    if (!workerRequest || !resolveWorker) throw new Error("Worker fixture was not started.");
    resolveWorker(workerResult(workerRequest, "cancelled"));
    await expect(pending).resolves.toMatchObject({ status: "service_drained" });
    await host.dispose("reload-recovery");
    expect(events.listeners.get(AGENT_ROUTER_DISCOVERY_TOPIC_V2)?.size ?? 0).toBe(0);
  });

  it("streams typed lifecycle events and withAgent cancels work when its scope ends", async () => {
    const events = new TestEventBus();
    const runAttempt = vi.fn(async (input: AgentWorkerAttemptRequest) => {
      input.onLifecycleEvent?.({
        type: "spawned",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        processId: 45,
        at: new Date(NOW).toISOString(),
      });
      if (input.identity.jobId === "job:scoped") {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        input.onLifecycleEvent?.({
          type: "exited",
          jobId: input.identity.jobId,
          attemptId: input.identity.attemptId,
          at: new Date(NOW + 1).toISOString(),
        });
        return workerResult(input, "cancelled");
      }
      input.onLifecycleEvent?.({
        type: "exited",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        at: new Date(NOW + 1).toISOString(),
      });
      return workerResult(input);
    });
    const host = registerAgentRouterServiceV2(events, hostOptions(runAttempt));
    const streamController = new AbortController();
    const stream = host.service.streamJob(
      request("job:stream", "plugin:stream", streamController.signal),
    );
    const streamed: string[] = [];
    for await (const event of stream) streamed.push(event.type);
    await expect(stream.result()).resolves.toMatchObject({ status: "succeeded" });
    expect(streamed).toEqual(
      expect.arrayContaining(["job.state", "attempt.state", "job.output", "job.terminal"]),
    );

    const scopedController = new AbortController();
    await expect(
      host.service.withAgent(
        request("job:scoped", "plugin:scoped", scopedController.signal),
        async () => {
          await waitUntil(() =>
            runAttempt.mock.calls.some(([input]) => input.identity.jobId === "job:scoped"),
          );
          return "scope-result";
        },
      ),
    ).resolves.toBe("scope-result");
    await expect(
      host.service.inspectJobs({ jobId: "job:scoped", includeTerminal: true }),
    ).resolves.toEqual([
      expect.objectContaining({
        terminalStatus: "cancelled",
        cancellationReason: "caller-aborted",
      }),
    ]);
    await host.dispose();
  });

  it("runs route judgment as a control-plane child before the selected Worker", async () => {
    const events = new TestEventBus();
    const timeline: string[] = [];
    let processId = 50;
    const runAttempt = vi.fn(async (input: AgentWorkerAttemptRequest) => {
      const controlPlane = input.capabilities.some(
        (capability) => capability.toolName === "rank_routes",
      );
      timeline.push(`start:${controlPlane ? "control" : "worker"}`);
      processId += 1;
      input.onLifecycleEvent?.({
        type: "spawned",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        processId,
        at: new Date(NOW).toISOString(),
      });
      if (controlPlane) {
        const rankRoutes = input.capabilities.find(
          (capability) => capability.toolName === "rank_routes",
        );
        if (!rankRoutes) throw new Error("Missing rank_routes capability.");
        await rankRoutes.invoke(
          {
            rankings: [
              {
                candidateId: "codex-luna",
                thinkingLevel: "high",
                confidence: 0.9,
                reason: "Selected by supervised control-plane fixture.",
              },
            ],
          },
          input.signal ?? new AbortController().signal,
        );
      }
      input.onLifecycleEvent?.({
        type: "exited",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        at: new Date(NOW + 1).toISOString(),
      });
      input.onLifecycleEvent?.({
        type: "cleanup_finished",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        status: "succeeded",
        at: new Date(NOW + 2).toISOString(),
      });
      timeline.push(`cleanup:${controlPlane ? "control" : "worker"}`);
      return workerResult(input);
    });
    const configured = hostOptions(runAttempt);
    const { selectTarget: _selectTarget, ...supervisedOptions } = configured;
    const host = registerAgentRouterServiceV2(events, supervisedOptions);
    const controller = new AbortController();
    const submitted = request("job:routed", "plugin:routed", controller.signal);
    submitted.modelRegistry = availableModelRegistry();

    await expect(host.service.runJob(submitted)).resolves.toMatchObject({
      status: "succeeded",
      inspection: { jobId: "job:routed", terminalStatus: "succeeded" },
    });

    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(timeline).toEqual([
      "start:control",
      "cleanup:control",
      "start:worker",
      "cleanup:worker",
    ]);
    const workerRequest = runAttempt.mock.calls[1]?.[0];
    expect(workerRequest?.capsule.target).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "high",
    });
    expect(runAttempt.mock.calls[0]?.[0].identity.attemptId).not.toBe(
      workerRequest?.identity.attemptId,
    );
    const audits = await host.service.inspectAudit();
    expect(audits.map((audit) => audit.jobClass)).toEqual(["router-control-plane", "full-agent"]);
    const tree = await host.service.inspectJobTree({ includeTerminal: true });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.job.jobClass).toBe("router-control-plane");
    await host.dispose();
  });

  it("cancels a queued ownership subtree without starting blocked work", async () => {
    const events = new TestEventBus();
    const runAttempt = vi.fn(async (input: AgentWorkerAttemptRequest) => {
      input.onLifecycleEvent?.({
        type: "spawned",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        processId: 43,
        at: new Date(NOW).toISOString(),
      });
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      input.onLifecycleEvent?.({
        type: "exited",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        at: new Date(NOW + 1).toISOString(),
      });
      return workerResult(input, "cancelled");
    });
    const host = registerAgentRouterServiceV2(
      events,
      hostOptions(runAttempt, (config) => {
        config.supervisor.limits.maxFullAgentWorkers = 1;
      }),
    );
    const parentController = new AbortController();
    const childController = new AbortController();
    const parentRequest = request("job:parent", "plugin:root", parentController.signal);
    const parent = host.service.runJob(parentRequest);
    await waitUntil(() => runAttempt.mock.calls.length === 1);

    const childRequest = request("job:child", "plugin:child", childController.signal);
    childRequest.job.descriptor.owner.parentJobId = "job:parent";
    childRequest.job.descriptor.dependencies.dependsOn = ["job:parent"];
    const child = host.service.runJob(childRequest);
    await waitUntil(async () => {
      const jobs = await host.service.inspectJobs({ includeTerminal: true });
      return jobs.length === 2;
    });

    const tree = await host.service.inspectJobTree({ includeTerminal: true });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      job: { jobId: "job:parent" },
      children: [{ job: { jobId: "job:child" } }],
    });
    await expect(host.releaseOwner("plugin:root")).resolves.toBe(2);
    await expect(Promise.all([parent, child])).resolves.toEqual([
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "cancelled" }),
    ]);
    expect(runAttempt).toHaveBeenCalledTimes(1);
    await host.dispose();
  });

  it("reports cleanup degradation and clears it through the bounded janitor", async () => {
    const events = new TestEventBus();
    const config = createStarterRouterConfigV2();
    const cleanupManager = new AttemptCleanupManager(config.supervisor.cleanup, {
      operations: {
        remove: async () => undefined,
        rename: async () => undefined,
        wait: async () => undefined,
      },
    });
    cleanupManager.retainForJanitor(
      "C:/private/locked-attempt",
      new Error("locked C:/private/locked-attempt"),
    );
    const runAttempt = vi.fn(async (input: AgentWorkerAttemptRequest) => {
      input.onLifecycleEvent?.({
        type: "spawned",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        processId: 44,
        at: new Date(NOW).toISOString(),
      });
      input.onLifecycleEvent?.({
        type: "exited",
        jobId: input.identity.jobId,
        attemptId: input.identity.attemptId,
        at: new Date(NOW + 1).toISOString(),
      });
      return workerResult(input, "cleanup_failed");
    });
    const host = registerAgentRouterServiceV2(events, {
      ...hostOptions(runAttempt),
      cleanupManager,
    });

    await expect(host.service.inspectSupervisor()).resolves.toMatchObject({
      state: "degraded",
      quarantinedCleanupItems: 1,
    });
    const controller = new AbortController();
    await expect(
      host.service.runJob(request("job:cleanup", "plugin:cleanup", controller.signal)),
    ).resolves.toMatchObject({ status: "cleanup_failed", cleanupComplete: false });
    await expect(host.service.doctor()).resolves.toMatchObject({ ok: false });
    await expect(host.service.runJanitor()).resolves.toEqual({
      attempted: 1,
      reclaimed: 1,
      remaining: 0,
      degraded: false,
    });
    await expect(host.service.doctor()).resolves.toMatchObject({ ok: true });
    const audit = await host.service.inspectAudit({ jobId: "job:cleanup" });
    expect(JSON.stringify(audit)).not.toContain("C:/private");
    await host.dispose();
  });
});
