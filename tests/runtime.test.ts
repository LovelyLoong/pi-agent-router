import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeStarterRouterConfig } from "../src/config/index.js";
import type { TaskContract } from "../src/contracts/index.js";
import {
  OutputContractRegistry,
  type PiSdkExecutionPayload,
  type PiSdkSessionFactory,
} from "../src/execution/index.js";
import { PI_ROUTE_EVENT_BUS_TOPIC, PiEventBusRouteSink } from "../src/observability/index.js";
import { AgentRouterRuntime, AgentRouterSetupError } from "../src/runtime/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryFiles(): Promise<{ configPath: string; healthPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-router-runtime-"));
  temporaryDirectories.push(directory);
  return {
    configPath: join(directory, "agent-router.json"),
    healthPath: join(directory, "health.json"),
  };
}

function modelRegistry(): ModelRegistry {
  const ids = ["gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "rogue"];
  const models = ids.map((id) => ({
    provider: "openai-codex",
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 400_000,
    maxTokens: 100_000,
  }));
  return {
    find: vi.fn((provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
    ),
    getAvailable: vi.fn(() => models),
  } as unknown as ModelRegistry;
}

function task(): TaskContract {
  return {
    contractVersion: 1,
    taskId: "runtime:test",
    taskKind: "session-analysis",
    goalSummary: "Analyze minimized metadata without sending raw session entries.",
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
      routeTimeoutMs: 120_000,
      attemptTimeoutMs: 300_000,
      overallTimeoutMs: 600_000,
      maxAttempts: 5,
    },
    preferences: {},
  };
}

function outputContracts(): OutputContractRegistry {
  const contracts = new OutputContractRegistry();
  contracts.register<{ answer: string }>({
    name: "answer.v1",
    validate(value) {
      return value &&
        typeof value === "object" &&
        typeof (value as { answer?: unknown }).answer === "string"
        ? { ok: true, value: value as { answer: string } }
        : { ok: false, message: "answer missing" };
    },
  });
  return contracts;
}

describe("Agent Router runtime assembly", () => {
  it("fails closed when the sole-authority configuration is missing", async () => {
    const files = await temporaryFiles();

    await expect(
      AgentRouterRuntime.create({
        modelRegistry: modelRegistry(),
        configPath: files.configPath,
        healthPath: files.healthPath,
      }),
    ).rejects.toBeInstanceOf(AgentRouterSetupError);
  });

  it("admits only configured candidates and performs no paid probe for status or static Doctor", async () => {
    const files = await temporaryFiles();
    await writeStarterRouterConfig(files.configPath);
    const sessionFactory = vi.fn<PiSdkSessionFactory>();
    const runtime = await AgentRouterRuntime.create({
      modelRegistry: modelRegistry(),
      configPath: files.configPath,
      healthPath: files.healthPath,
      piSessionFactory: sessionFactory,
    });

    const status = await runtime.status();
    const doctor = await runtime.doctor("static");

    expect(status.candidates.map((candidate) => candidate.model)).toEqual([
      "openai-codex/gpt-5.4-mini",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-sol",
    ]);
    expect(status.candidates.some((candidate) => candidate.model.includes("rogue"))).toBe(false);
    expect(status.candidates.every((candidate) => candidate.available)).toBe(true);
    expect(
      doctor.report.results.every((candidate) => candidate.activeStatus === "not-requested"),
    ).toBe(true);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("executes through fixed Router and child targets, persists health, and emits redacted events", async () => {
    const files = await temporaryFiles();
    await writeStarterRouterConfig(files.configPath);
    const routedTargets: Array<{ model: string; thinkingLevel: string; candidateId: string }> = [];
    const sessionFactory: PiSdkSessionFactory = async (request) => ({
      messages: [],
      agent: { state: {} },
      async prompt() {
        routedTargets.push(request.target);
        if (request.target.candidateId.startsWith("__router__")) {
          const tool = request.payload.customTools?.[0] as unknown as {
            execute(
              id: string,
              value: {
                rankings: Array<{
                  candidateId: string;
                  thinkingLevel: "medium";
                  confidence: number;
                  reason: string;
                }>;
              },
            ): Promise<unknown>;
          };
          await tool.execute("rank", {
            rankings: [
              {
                candidateId: "codex-mini",
                thinkingLevel: "medium",
                confidence: 0.9,
                reason: "Best bounded target.",
              },
            ],
          });
        }
      },
      async abort() {},
      dispose() {},
      subscribe() {
        return () => undefined;
      },
    });
    const emit = vi.fn();
    const runtime = await AgentRouterRuntime.create({
      modelRegistry: modelRegistry(),
      configPath: files.configPath,
      healthPath: files.healthPath,
      eventSink: new PiEventBusRouteSink({ emit }),
      piSessionFactory: sessionFactory,
    });

    const result = await runtime.execute<
      { answer: string },
      PiSdkExecutionPayload<{ answer: string }>
    >({
      task: task(),
      outputContracts: outputContracts(),
      createPayload: () => ({
        cwd: process.cwd(),
        prompt: "Private execution prompt that is never sent to the Router.",
        tools: ["read"],
        captureResult: () => ({ answer: "verified" }),
      }),
    });

    expect(result.outcome.success).toBe(true);
    expect(result.outcome.result).toEqual({ answer: "verified" });
    expect(result.audit).toMatchObject({ taskKind: "session-analysis", fallbackCount: 0 });
    expect(routedTargets).toEqual([
      {
        candidateId: "__router__:pi-router-1",
        model: "openai-codex/gpt-5.4-mini",
        thinkingLevel: "low",
        executorId: "pi",
      },
      {
        candidateId: "codex-mini",
        model: "openai-codex/gpt-5.4-mini",
        thinkingLevel: "medium",
        executorId: "pi",
      },
    ]);
    expect((await stat(files.healthPath)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(files.healthPath, "utf8"))).toMatchObject({
      version: 1,
      entries: [expect.objectContaining({ candidateId: "codex-mini", status: "healthy" })],
    });
    expect(emit).toHaveBeenCalledWith(PI_ROUTE_EVENT_BUS_TOPIC, expect.any(Object));
    expect(JSON.stringify(emit.mock.calls)).not.toContain("Private execution prompt");
  });
});
