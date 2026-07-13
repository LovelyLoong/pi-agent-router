import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FeedbackRecord,
  RouteDecision,
  RouteEvent,
  RouteOutcome,
  TaskContract,
} from "../src/contracts/index.js";
import {
  buildRouteAudit,
  JsonlRouteEventSink,
  PI_FEEDBACK_EVENT_BUS_TOPIC,
  PI_ROUTE_EVENT_BUS_TOPIC,
  PiEventBusRouteSink,
  redactRouteEvent,
  renderRouteAudit,
} from "../src/observability/index.js";
import type { RoutePlanningResult } from "../src/routing/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-router-audit-"));
  temporaryDirectories.push(directory);
  return join(directory, "events.jsonl");
}

function task(): TaskContract {
  return {
    contractVersion: 1,
    taskId: "audit:test",
    taskKind: "session-analysis",
    goalSummary: "Inspect raw secret sk-supersecret123456789 and password=hunter2.",
    requirements: {
      requiredCapabilities: ["analysis"],
      preferredCapabilities: [],
      allowedTools: ["read"],
      inputModalities: ["text"],
      minimumContextWindow: 1,
      requiresReasoning: true,
      sideEffectClass: "read",
      dataSensitivity: "sensitive",
      output: { kind: "structured", contractName: "answer.v1" },
    },
    context: { estimatedTokens: 10, bytes: 100, itemCount: 1 },
    budget: {
      routeTimeoutMs: 1_000,
      attemptTimeoutMs: 1_000,
      overallTimeoutMs: 3_000,
      maxAttempts: 2,
    },
    preferences: {},
  };
}

function decision(): RouteDecision {
  return {
    contractVersion: 1,
    routeId: "route-audit",
    taskId: "audit:test",
    source: "router",
    ranked: [
      {
        target: {
          candidateId: "mini",
          executorId: "pi",
          model: "provider/mini",
          thinkingLevel: "medium",
        },
        rank: 1,
        confidence: 0.8,
        reason: "Contains password=hunter2 from the minimized goal.",
      },
      {
        target: {
          candidateId: "luna",
          executorId: "pi",
          model: "provider/luna",
          thinkingLevel: "high",
        },
        rank: 2,
        confidence: 0.7,
        reason: "Fallback synthesis target.",
      },
    ],
    decidedAt: "2026-01-01T00:00:00.000Z",
  };
}

function outcome(): RouteOutcome<{ answer: string }> {
  const routeDecision = decision();
  const firstTarget = routeDecision.ranked[0]?.target;
  const secondTarget = routeDecision.ranked[1]?.target;
  if (!firstTarget || !secondTarget) throw new Error("Audit decision targets are incomplete.");
  return {
    contractVersion: 1,
    routeId: routeDecision.routeId,
    taskId: routeDecision.taskId,
    decision: routeDecision,
    attempts: [
      {
        attemptId: "attempt-1",
        routeId: routeDecision.routeId,
        taskId: routeDecision.taskId,
        target: firstTarget,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.100Z",
        elapsedMs: 100,
        failureClass: "timeout",
        errorMessage: "Bearer secret-token-value",
      },
      {
        attemptId: "attempt-2",
        routeId: routeDecision.routeId,
        taskId: routeDecision.taskId,
        target: secondTarget,
        startedAt: "2026-01-01T00:00:00.100Z",
        finishedAt: "2026-01-01T00:00:00.300Z",
        elapsedMs: 200,
      },
    ],
    success: true,
    selectedTarget: secondTarget,
    result: { answer: "raw private answer sk-privateanswer123456" },
    finishedAt: "2026-01-01T00:00:00.300Z",
  };
}

function planning(): RoutePlanningResult {
  return {
    decision: decision(),
    rejections: [],
    judgeFailures: [],
    input: {
      contractVersion: 1,
      task: {
        taskId: task().taskId,
        taskKind: task().taskKind,
        goalSummary: task().goalSummary,
        requirements: task().requirements,
        context: task().context,
        budget: task().budget,
        preferences: task().preferences,
      },
      candidates: [
        {
          candidateId: "luna",
          executorId: "pi",
          model: "provider/luna",
          thinkingLevels: ["high"],
          staticPriority: 2,
          capabilities: ["analysis"],
          description: "candidate",
          strengths: ["analysis"],
          qualityClass: "high",
          costClass: "low",
          latencyClass: "medium",
          contextWindow: 100_000,
          inputModalities: ["text"],
          health: { status: "healthy", checkedAt: "2025-12-31T23:59:00.000Z" },
        },
      ],
    },
  };
}

describe("redacted event sinks", () => {
  it("removes raw goals, results, errors, and ranking rationale from telemetry", () => {
    const requested: RouteEvent = {
      contractVersion: 1,
      eventId: "event-1",
      routeId: "route-audit",
      taskId: "audit:test",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "route.requested",
      task: task(),
    };
    const finished: RouteEvent = {
      contractVersion: 1,
      eventId: "event-2",
      routeId: "route-audit",
      taskId: "audit:test",
      timestamp: "2026-01-01T00:00:00.300Z",
      type: "route.finished",
      outcome: outcome(),
    };

    const serialized = JSON.stringify([redactRouteEvent(requested), redactRouteEvent(finished)]);

    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("privateanswer");
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).toContain("redacted goal sha256");
    expect(serialized).toContain("Selection rationale redacted");
  });

  it("writes versioned redacted JSONL events and feedback", async () => {
    const path = await temporaryPath();
    const sink = new JsonlRouteEventSink({ path });
    const event: RouteEvent = {
      contractVersion: 1,
      eventId: "event-1",
      routeId: "route-audit",
      taskId: "audit:test",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "route.requested",
      task: task(),
    };
    const feedback: FeedbackRecord = {
      contractVersion: 1,
      feedbackId: "feedback-1",
      routeId: "route-audit",
      taskId: "audit:test",
      evaluatorId: "external-evaluator",
      dimensions: { correctness: 0.9 },
      summary: "token=top-secret-evaluation",
      recordedAt: "2026-01-01T00:01:00.000Z",
    };

    await sink.emit(event);
    await sink.recordFeedback(feedback);
    await sink.flush();

    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ schema: "pi-agent-router.event", version: 1 });
    expect(lines[1]).toMatchObject({ schema: "pi-agent-router.feedback", version: 1 });
    expect(JSON.stringify(lines)).not.toContain("top-secret-evaluation");
  });

  it("bridges only redacted records to the optional Pi event bus", () => {
    const emit = vi.fn();
    const sink = new PiEventBusRouteSink({ emit });
    const event: RouteEvent = {
      contractVersion: 1,
      eventId: "event-1",
      routeId: "route-audit",
      taskId: "audit:test",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "route.requested",
      task: task(),
    };
    sink.emit(event);
    sink.recordFeedback({
      contractVersion: 1,
      feedbackId: "feedback-1",
      routeId: "route-audit",
      taskId: "audit:test",
      evaluatorId: "evaluator",
      dimensions: {},
      summary: "password=hidden-value",
      recordedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(emit).toHaveBeenNthCalledWith(1, PI_ROUTE_EVENT_BUS_TOPIC, expect.any(Object));
    expect(emit).toHaveBeenNthCalledWith(2, PI_FEEDBACK_EVENT_BUS_TOPIC, expect.any(Object));
    expect(JSON.stringify(emit.mock.calls)).not.toContain("hidden-value");
  });
});

describe("route audit rendering", () => {
  it("renders compact required fields and expanded candidate/attempt details without the goal", () => {
    const record = buildRouteAudit({ task: task(), outcome: outcome(), planning: planning() });
    const compact = renderRouteAudit(record);
    const expanded = renderRouteAudit(record, true);

    expect(compact).toContain("session-analysis");
    expect(compact).toContain("pi:provider/luna@high");
    expect(compact).toContain("router");
    expect(compact).toContain("healthy/60s old");
    expect(compact).toContain("300ms");
    expect(compact).toContain("1 fallback");
    expect(expanded).toContain("Candidates:");
    expect(expanded).toContain("timeout in 100ms");
    expect(expanded).not.toContain("supersecret");
    expect(expanded).not.toContain("hunter2");
  });
});
