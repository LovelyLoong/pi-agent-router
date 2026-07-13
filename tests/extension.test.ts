import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentRouterExtension from "../extensions/index.js";
import type {
  RouteDecision,
  RouteEvent,
  RouteOutcome,
  TaskContract,
} from "../src/contracts/index.js";
import { PI_ROUTE_EVENT_BUS_TOPIC } from "../src/observability/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryAgentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-router-extension-"));
  temporaryDirectories.push(directory);
  return directory;
}

function registry(): ModelRegistry {
  const ids = ["gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
  const models = ids.map((id) => ({
    provider: "openai-codex",
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
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

type Command = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
};

function harness() {
  const commands = new Map<string, Command>();
  const busListeners = new Map<string, (value: unknown) => void>();
  const lifecycle = new Map<string, () => void>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    registerEntryRenderer: vi.fn(),
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    events: {
      on(name: string, listener: (value: unknown) => void) {
        busListeners.set(name, listener);
      },
      emit(name: string, value: unknown) {
        busListeners.get(name)?.(value);
      },
    },
    on(name: string, listener: () => void) {
      lifecycle.set(name, listener);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  agentRouterExtension(pi);
  return { commands, busListeners, lifecycle, entries };
}

function context(modelRegistry = registry()) {
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  return {
    cwd: process.cwd(),
    modelRegistry,
    hasUI: true,
    ui: { notify, confirm },
  } as unknown as ExtensionCommandContext & {
    ui: { notify: typeof notify; confirm: typeof confirm };
  };
}

function auditEvents(): { requested: RouteEvent; finished: RouteEvent } {
  const task: TaskContract = {
    contractVersion: 1,
    taskId: "extension:audit",
    taskKind: "session-analysis",
    goalSummary: "[redacted goal]",
    requirements: {
      requiredCapabilities: ["analysis"],
      preferredCapabilities: [],
      allowedTools: ["read"],
      inputModalities: ["text"],
      minimumContextWindow: 1,
      requiresReasoning: true,
      sideEffectClass: "read",
      dataSensitivity: "sensitive",
      output: { kind: "text" },
    },
    context: { estimatedTokens: 1, bytes: 1, itemCount: 1 },
    budget: {
      routeTimeoutMs: 1_000,
      attemptTimeoutMs: 1_000,
      overallTimeoutMs: 2_000,
      maxAttempts: 1,
    },
    preferences: {},
  };
  const target = {
    candidateId: "mini",
    executorId: "pi",
    model: "provider/mini",
    thinkingLevel: "medium" as const,
  };
  const decision: RouteDecision = {
    contractVersion: 1,
    routeId: "route-extension",
    taskId: task.taskId,
    source: "router",
    ranked: [{ target, rank: 1, confidence: 0.8, reason: "redacted" }],
    decidedAt: "2026-01-01T00:00:00.000Z",
  };
  const outcome: RouteOutcome = {
    contractVersion: 1,
    routeId: decision.routeId,
    taskId: task.taskId,
    decision,
    attempts: [
      {
        attemptId: "attempt-1",
        routeId: decision.routeId,
        taskId: task.taskId,
        target,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.100Z",
        elapsedMs: 100,
      },
    ],
    success: true,
    selectedTarget: target,
    finishedAt: "2026-01-01T00:00:00.100Z",
  };
  return {
    requested: {
      contractVersion: 1,
      eventId: "event-requested",
      routeId: decision.routeId,
      taskId: task.taskId,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "route.requested",
      task,
    },
    finished: {
      contractVersion: 1,
      eventId: "event-finished",
      routeId: decision.routeId,
      taskId: task.taskId,
      timestamp: "2026-01-01T00:00:00.100Z",
      type: "route.finished",
      outcome,
    },
  };
}

describe("Pi extension lifecycle", () => {
  it("registers explicit commands/renderers without creating configuration at load", async () => {
    const agentDir = await temporaryAgentDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const state = harness();

    expect(state.commands.has("agent-router")).toBe(true);
    expect(state.busListeners.has(PI_ROUTE_EVENT_BUS_TOPIC)).toBe(true);
    await expect(readFile(join(agentDir, "agent-router.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes starter configuration only through the explicit setup command and never overwrites", async () => {
    const agentDir = await temporaryAgentDir();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const state = harness();
    const command = state.commands.get("agent-router");
    if (!command) throw new Error("Agent Router command was not registered.");
    const ctx = context();

    await command.handler("setup", ctx);
    const first = await readFile(join(agentDir, "agent-router.json"), "utf8");
    await command.handler("setup", ctx);
    const second = await readFile(join(agentDir, "agent-router.json"), "utf8");

    expect(JSON.parse(first)).toMatchObject({ configVersion: 1 });
    expect(second).toBe(first);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("overwrite existing"),
      "error",
    );
  });

  it("turns redacted route events into one compact expandable transcript entry", () => {
    const state = harness();
    const listener = state.busListeners.get(PI_ROUTE_EVENT_BUS_TOPIC);
    if (!listener) throw new Error("Route event listener was not registered.");
    const events = auditEvents();

    listener(events.requested);
    listener(events.finished);

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      type: "pi-agent-router.route-audit",
      data: {
        version: 1,
        taskKind: "session-analysis",
        success: true,
        selectedTarget: { model: "provider/mini", thinkingLevel: "medium" },
      },
    });
    state.lifecycle.get("session_shutdown")?.();
  });
});
