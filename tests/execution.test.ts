import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createStarterRouterConfig } from "../src/config/index.js";
import type {
  ExecutionTarget,
  ExecutorAdapter,
  ExecutorRunRequest,
  ExecutorRunResult,
  TaskContract,
} from "../src/contracts/index.js";
import {
  ExecutorRegistry,
  executeRoutedTask,
  OutputContractRegistry,
  type PiSdkExecutionPayload,
  PiSdkExecutor,
  PiSdkRouteJudge,
} from "../src/execution/index.js";
import { createHealthState, type HealthPolicy } from "../src/health/index.js";
import type { CandidateSnapshot, JudgeRanking, RouterJudgeInput } from "../src/routing/index.js";

const CONFIG_HASH = "c".repeat(64);
const healthPolicy: HealthPolicy = {
  successTtlMs: 900_000,
  failureCooldownMs: 300_000,
  rateLimitCooldownMinMs: 60_000,
  rateLimitCooldownMaxMs: 1_800_000,
};

function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    contractVersion: 1,
    taskId: "execute:test",
    taskKind: "session-analysis",
    goalSummary: "Inspect bounded evidence and return a structured answer.",
    requirements: {
      requiredCapabilities: ["analysis", "retrieval", "structured-output"],
      preferredCapabilities: [],
      allowedTools: ["read"],
      inputModalities: ["text"],
      minimumContextWindow: 128_000,
      requiresReasoning: true,
      sideEffectClass: "read",
      dataSensitivity: "sensitive",
      output: { kind: "structured", contractName: "answer.v1" },
    },
    context: { estimatedTokens: 1_000, bytes: 10_000, itemCount: 10 },
    budget: {
      routeTimeoutMs: 1_000,
      attemptTimeoutMs: 1_000,
      overallTimeoutMs: 5_000,
      maxAttempts: 3,
    },
    preferences: {},
    ...overrides,
  };
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

function outputContracts(): OutputContractRegistry {
  const registry = new OutputContractRegistry();
  registry.register<{ answer: string }>({
    name: "answer.v1",
    validate(value) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { answer?: unknown }).answer === "string"
      ) {
        return { ok: true, value: value as { answer: string } };
      }
      return { ok: false, message: "Expected an answer string." };
    },
  });
  return registry;
}

class FakeExecutor implements ExecutorAdapter<unknown, unknown> {
  readonly capabilities = {
    adapterVersion: 1 as const,
    executorId: "pi",
    executorType: "fake",
    capabilities: [],
    supportsActiveProbe: false,
  };
  readonly calls: Array<ExecutorRunRequest<unknown>> = [];

  constructor(
    readonly run: (
      request: ExecutorRunRequest<unknown>,
      call: number,
    ) => Promise<ExecutorRunResult> | ExecutorRunResult,
  ) {}

  async checkAvailability() {
    return { available: true, checkedAt: new Date().toISOString() };
  }

  async execute(request: ExecutorRunRequest<unknown>): Promise<ExecutorRunResult> {
    this.calls.push(request);
    return await this.run(request, this.calls.length);
  }
}

function executorRegistry(executor: FakeExecutor): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(executor);
  return registry;
}

describe("routed execution orchestration", () => {
  it("retries a technical failure on the next ranked target and aggregates health and usage", async () => {
    const executor = new FakeExecutor((request) =>
      request.target.candidateId === "codex-mini"
        ? {
            ok: false,
            failureClass: "timeout",
            errorMessage: "provider timeout",
            usage: { inputTokens: 10, cost: 0.01 },
          }
        : {
            ok: true,
            result: { answer: "verified" },
            usage: { inputTokens: 20, outputTokens: 5, cost: 0.02 },
          },
    );

    const result = await executeRoutedTask<{ answer: string }>({
      task: task(),
      snapshots: snapshots(),
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: (_target, attemptNumber) => ({ attemptNumber }),
      healthState: createHealthState(CONFIG_HASH),
      healthPolicy,
    });

    expect(result.outcome.success).toBe(true);
    expect(result.outcome.attempts.map((attempt) => attempt.target.candidateId)).toEqual([
      "codex-mini",
      "codex-luna",
    ]);
    expect(result.outcome.result).toEqual({ answer: "verified" });
    expect(result.outcome.usage).toMatchObject({ inputTokens: 30, outputTokens: 5, cost: 0.03 });
    expect(result.healthState?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidateId: "codex-mini", status: "cooldown" }),
        expect.objectContaining({ candidateId: "codex-luna", status: "healthy" }),
      ]),
    );
  });

  it("accepts normal contract-valid output without quality-triggered reruns", async () => {
    const executor = new FakeExecutor(() => ({ ok: true, result: { answer: "brief" } }));

    const result = await executeRoutedTask({
      task: task(),
      snapshots: snapshots(),
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: () => ({}),
    });

    expect(result.outcome.success).toBe(true);
    expect(executor.calls).toHaveLength(1);
  });

  it("retries output-contract failure for read-only work", async () => {
    const executor = new FakeExecutor((_request, call) =>
      call === 1 ? { ok: true, result: { wrong: true } } : { ok: true, result: { answer: "ok" } },
    );

    const result = await executeRoutedTask({
      task: task(),
      snapshots: snapshots(),
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: () => ({}),
    });

    expect(result.outcome.success).toBe(true);
    expect(result.outcome.attempts[0]?.failureClass).toBe("output-contract");
    expect(executor.calls).toHaveLength(2);
  });

  it("does not retry an unknown side-effect outcome", async () => {
    const executor = new FakeExecutor(() => ({
      ok: false,
      failureClass: "timeout",
      errorMessage: "request timed out after dispatch",
    }));
    const writeTask = task({
      requirements: { ...task().requirements, sideEffectClass: "write" },
    });

    const writeSnapshots = snapshots().map((snapshot) => ({
      ...snapshot,
      config: {
        ...snapshot.config,
        allowedSideEffects: [...snapshot.config.allowedSideEffects, "write" as const],
      },
    }));

    const result = await executeRoutedTask({
      task: writeTask,
      snapshots: writeSnapshots,
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: () => ({}),
    });

    expect(result.outcome.success).toBe(false);
    expect(result.outcome.terminalFailure).toBe("unknown-side-effect");
    expect(executor.calls).toHaveLength(1);
  });

  it("does not retry an unclassified executor failure", async () => {
    const executor = new FakeExecutor(() => {
      throw new Error("unexpected adapter state");
    });

    const result = await executeRoutedTask({
      task: task(),
      snapshots: snapshots(),
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: () => ({}),
    });

    expect(result.outcome.terminalFailure).toBe("unknown");
    expect(executor.calls).toHaveLength(1);
  });

  it("uses an attempt deadline and continues only on the safe timeout class", async () => {
    const executor = new FakeExecutor((_request, call) =>
      call === 1
        ? new Promise(() => undefined)
        : Promise.resolve({ ok: true, result: { answer: "bounded" } }),
    );
    const boundedTask = task({
      budget: { ...task().budget, attemptTimeoutMs: 100, overallTimeoutMs: 1_000 },
    });
    const values = snapshots();
    const first = values[0];
    if (!first) throw new Error("Starter candidate missing.");
    first.config = { ...first.config, attemptTimeoutMs: 5 };

    const result = await executeRoutedTask({
      task: boundedTask,
      snapshots: values,
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: () => ({}),
    });

    expect(result.outcome.success).toBe(true);
    expect(result.outcome.attempts[0]?.failureClass).toBe("timeout");
    expect(executor.calls).toHaveLength(2);
  });

  it("caps repeated safe failures at the configured attempt budget", async () => {
    const executor = new FakeExecutor(() => ({
      ok: false,
      failureClass: "timeout",
      errorMessage: "bounded timeout",
    }));
    const boundedTask = task({ budget: { ...task().budget, maxAttempts: 2 } });

    const result = await executeRoutedTask({
      task: boundedTask,
      snapshots: snapshots(),
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: () => ({}),
    });

    expect(result.outcome.success).toBe(false);
    expect(result.outcome.terminalFailure).toBe("timeout");
    expect(executor.calls).toHaveLength(2);
  });

  it("bounds Router judgment before any executor attempt", async () => {
    const executor = new FakeExecutor(() => ({ ok: true, result: { answer: "unused" } }));
    const target = createStarterRouterConfig().router.targets[0];
    if (!target) throw new Error("Starter Router target missing.");
    const boundedTask = task({
      budget: { ...task().budget, routeTimeoutMs: 5, overallTimeoutMs: 1_000 },
    });

    await expect(
      executeRoutedTask({
        task: boundedTask,
        snapshots: snapshots(),
        judges: [{ id: "stuck", target, rank: () => new Promise(() => undefined) }],
        executors: executorRegistry(executor),
        outputContracts: outputContracts(),
        createPayload: () => ({}),
      }),
    ).rejects.toMatchObject({ failureClass: "timeout" });
    expect(executor.calls).toHaveLength(0);
  });

  it("propagates caller cancellation and never starts another target", async () => {
    const controller = new AbortController();
    const executor = new FakeExecutor(
      (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, failureClass: "aborted", errorMessage: "cancelled" }),
            { once: true },
          );
        }),
    );
    setTimeout(() => controller.abort(new Error("user cancelled")), 5);

    const result = await executeRoutedTask({
      task: task(),
      snapshots: snapshots(),
      judges: [],
      executors: executorRegistry(executor),
      outputContracts: outputContracts(),
      createPayload: () => ({}),
      signal: controller.signal,
    });

    expect(result.outcome.terminalFailure).toBe("aborted");
    expect(executor.calls).toHaveLength(1);
  });

  it("fails before execution when the declared output contract is not registered", async () => {
    const executor = new FakeExecutor(() => ({ ok: true, result: { answer: "unused" } }));

    await expect(
      executeRoutedTask({
        task: task(),
        snapshots: snapshots(),
        judges: [],
        executors: executorRegistry(executor),
        outputContracts: new OutputContractRegistry(),
        createPayload: () => ({}),
      }),
    ).rejects.toThrow("unregistered output contract");
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects duplicate executor ids", () => {
    const registry = new ExecutorRegistry();
    registry.register(new FakeExecutor(() => ({ ok: true, result: "ok" })));
    expect(() => registry.register(new FakeExecutor(() => ({ ok: true, result: "ok" })))).toThrow(
      "already registered",
    );
  });
});

describe("Pi SDK executor", () => {
  it("runs a dedicated fixed Router target and captures only structured ranking output", async () => {
    const model = { provider: "openai-codex", id: "gpt-5.4-mini" };
    const modelRegistry = {
      find: vi.fn(() => model),
      getAvailable: vi.fn(() => [model]),
    } as unknown as ModelRegistry;
    const observedTargets: ExecutionTarget[] = [];
    const executor = new PiSdkExecutor<JudgeRanking>({
      modelRegistry,
      sessionFactory: async (request) => ({
        messages: [],
        agent: { state: {} },
        async prompt() {
          observedTargets.push(request.target);
          const tool = request.payload.customTools?.[0] as unknown as {
            execute(id: string, value: JudgeRanking): Promise<unknown>;
          };
          await tool.execute("rank-call", {
            rankings: [
              {
                candidateId: "codex-mini",
                thinkingLevel: "medium",
                confidence: 0.8,
                reason: "Best bounded balance.",
              },
            ],
          });
        },
        async abort() {},
        dispose() {},
        subscribe() {
          return () => undefined;
        },
      }),
    });
    const routerTarget = createStarterRouterConfig().router.targets[0];
    if (!routerTarget) throw new Error("Starter Router target missing.");
    const judge = new PiSdkRouteJudge({ id: "primary", target: routerTarget, executor });
    const input: RouterJudgeInput = {
      contractVersion: 1,
      task: {
        taskId: "judge:test",
        taskKind: "session-analysis",
        goalSummary: "Rank minimized session-analysis metadata.",
        requirements: task().requirements,
        context: task().context,
        budget: task().budget,
        preferences: task().preferences,
      },
      candidates: [],
    };

    const result = await judge.rank(input);

    expect(result).toEqual({
      rankings: [
        {
          candidateId: "codex-mini",
          thinkingLevel: "medium",
          confidence: 0.8,
          reason: "Best bounded balance.",
        },
      ],
    });
    expect(observedTargets[0]).toMatchObject({
      executorId: "pi",
      model: "openai-codex/gpt-5.4-mini",
      thinkingLevel: "low",
    });
  });

  it("creates a fresh isolated session per call with the exact routed model and thinking level", async () => {
    const model = { provider: "openai-codex", id: "gpt-5.4-mini" };
    const modelRegistry = {
      find: vi.fn(() => model),
      getAvailable: vi.fn(() => [model]),
    } as unknown as ModelRegistry;
    const sessions: number[] = [];
    const disposed: number[] = [];
    const sessionFiles: Array<string | undefined> = [];
    const targets: ExecutionTarget[] = [];
    const executor = new PiSdkExecutor<{ answer: string }>({
      modelRegistry,
      sessionFactory: async (request) => {
        const sessionNumber = sessions.length + 1;
        sessions.push(sessionNumber);
        targets.push(request.target);
        return {
          sessionFile: `/tmp/pi-agent-router-${sessionNumber}.jsonl`,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "fallback text" }],
              usage: { input: 10, output: 2, cost: { total: 0.01 } },
              stopReason: "end",
            },
          ],
          agent: { state: {} },
          async prompt() {},
          async abort() {},
          dispose() {
            disposed.push(sessionNumber);
          },
          subscribe() {
            return () => undefined;
          },
        };
      },
    });
    const target: ExecutionTarget = {
      candidateId: "codex-mini",
      executorId: "pi",
      model: "openai-codex/gpt-5.4-mini",
      thinkingLevel: "high",
    };
    const payload: PiSdkExecutionPayload<{ answer: string }> = {
      cwd: process.cwd(),
      prompt: "Analyze evidence.",
      tools: ["read"],
      onSessionCreated: (path) => sessionFiles.push(path),
      captureResult: () => ({ answer: "captured" }),
    };

    const first = await executor.execute({ task: task(), target, payload });
    const second = await executor.execute({ task: task(), target, payload });

    expect(first).toMatchObject({
      ok: true,
      result: { answer: "captured" },
      usage: { inputTokens: 10, outputTokens: 2, cost: 0.01 },
    });
    expect(second.ok).toBe(true);
    expect(sessions).toEqual([1, 2]);
    expect(disposed).toEqual([1, 2]);
    expect(sessionFiles).toEqual(["/tmp/pi-agent-router-1.jsonl", "/tmp/pi-agent-router-2.jsonl"]);
    expect(targets).toEqual([target, target]);
    expect(modelRegistry.find).toHaveBeenCalledWith("openai-codex", "gpt-5.4-mini");
  });
});
