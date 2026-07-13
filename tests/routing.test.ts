import { describe, expect, it, vi } from "vitest";
import { createStarterRouterConfig } from "../src/config/index.js";
import type { TaskContract } from "../src/contracts/index.js";
import {
  type CandidateSnapshot,
  filterCandidates,
  planRoute,
  type RouteJudge,
} from "../src/routing/index.js";

function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    contractVersion: 1,
    taskId: "route:test",
    taskKind: "session-analysis",
    goalSummary: "Inspect session evidence and return a structured conclusion.",
    requirements: {
      requiredCapabilities: ["analysis", "retrieval", "structured-output"],
      preferredCapabilities: ["long-context"],
      allowedTools: ["read"],
      inputModalities: ["text"],
      minimumContextWindow: 128_000,
      requiresReasoning: true,
      sideEffectClass: "read",
      dataSensitivity: "sensitive",
      output: { kind: "tool", contractName: "provide_results.v1" },
    },
    context: { estimatedTokens: 20_000, bytes: 900_000, itemCount: 53 },
    budget: {
      routeTimeoutMs: 60_000,
      attemptTimeoutMs: 180_000,
      overallTimeoutMs: 420_000,
      maxAttempts: 3,
    },
    preferences: {},
    ...overrides,
  };
}

function snapshots(): CandidateSnapshot[] {
  const config = createStarterRouterConfig();
  return config.candidates.map((candidate) => ({
    config: candidate,
    executorAvailable: true,
    model: {
      available: true,
      contextWindow: candidate.model.includes("5.4-mini") ? 272_000 : 372_000,
      inputModalities: ["text", "image"],
      reasoning: true,
      supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      cost: { input: 1, output: 6 },
    },
    health: { status: "unknown" },
  }));
}

function routerTarget(index = 0) {
  const target = createStarterRouterConfig().router.targets[index];
  if (!target) throw new Error(`Missing Router target ${index}.`);
  return target;
}

function judge(id: string, implementation: RouteJudge["rank"], targetIndex = 0): RouteJudge {
  return { id, target: routerTarget(targetIndex), rank: implementation };
}

describe("hard candidate filtering", () => {
  it("filters hard capability, health, and model constraints before judgment", () => {
    const values = snapshots();
    const first = values[0];
    const second = values[1];
    const third = values[2];
    if (!first || !second || !third) throw new Error("Starter snapshots are incomplete.");
    first.config = { ...first.config, capabilities: ["retrieval"] };
    second.health = {
      status: "cooldown",
      cooldownUntil: "2030-01-01T00:00:00.000Z",
      reason: "provider timeout",
    };
    third.model = { ...third.model, contextWindow: 64_000 };

    const result = filterCandidates(task(), values, new Date("2026-01-01T00:00:00.000Z"));

    expect(result.candidates.map((candidate) => candidate.candidate.id)).toEqual(["codex-sol"]);
    expect(result.rejections.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "capability-missing",
        "health-cooldown",
        "context-window-insufficient",
      ]),
    );
  });

  it("keeps only model-supported, configured thinking levels", () => {
    const values = snapshots().slice(0, 1);
    const first = values[0];
    if (!first) throw new Error("Starter snapshot is missing.");
    first.model = { ...first.model, supportedThinkingLevels: ["high"] };

    const result = filterCandidates(task(), values);
    expect(result.candidates[0]?.thinkingLevels).toEqual(["high"]);
  });
});

describe("dynamic route planning", () => {
  it("uses a structured judge ranking and appends omitted configured fallbacks", async () => {
    const primary = judge("primary", async () => ({
      rankings: [
        {
          candidateId: "codex-sol",
          thinkingLevel: "high",
          confidence: 0.9,
          reason: "The task benefits from deep evidence synthesis.",
        },
        {
          candidateId: "codex-mini",
          thinkingLevel: "medium",
          confidence: 0.7,
          reason: "Fast fallback for bounded retrieval.",
        },
      ],
    }));

    const result = await planRoute({ task: task(), snapshots: snapshots(), judges: [primary] });

    expect(result.decision.source).toBe("router");
    expect(result.decision.ranked.map((item) => item.target.candidateId)).toEqual([
      "codex-sol",
      "codex-mini",
      "codex-luna",
      "codex-terra",
    ]);
    expect(result.decision.ranked[0]?.target.thinkingLevel).toBe("high");
  });

  it("uses the fixed Router backup when the primary fails", async () => {
    const primary = judge("primary", async () => {
      throw new Error("router provider unavailable");
    });
    const backupRank = vi.fn(async () => ({
      rankings: [
        {
          candidateId: "codex-luna",
          thinkingLevel: "high",
          confidence: 0.8,
          reason: "Balanced modern target.",
        },
      ],
    }));
    const backup = judge("backup", backupRank, 1);

    const result = await planRoute({
      task: task(),
      snapshots: snapshots(),
      judges: [primary, backup],
    });

    expect(result.decision.source).toBe("router");
    expect(result.decision.ranked[0]?.target.candidateId).toBe("codex-luna");
    expect(result.judgeFailures).toHaveLength(1);
    expect(backupRank).toHaveBeenCalledOnce();
  });

  it("falls back to explicit static priority when all judges fail contract", async () => {
    const invalid = judge("invalid", async () => ({
      rankings: [
        {
          candidateId: "unconfigured-model",
          thinkingLevel: "max",
          confidence: 1,
          reason: "Invalid target should never be accepted.",
        },
      ],
    }));

    const result = await planRoute({ task: task(), snapshots: snapshots(), judges: [invalid] });

    expect(result.decision.source).toBe("static-fallback");
    expect(result.decision.ranked[0]?.target).toMatchObject({
      candidateId: "codex-mini",
      model: "openai-codex/gpt-5.4-mini",
      thinkingLevel: "medium",
    });
    expect(result.judgeFailures[0]?.message).toContain("unknown candidate");
  });

  it("does not expose a private execution payload or foreground model to the judge", async () => {
    const captured: unknown[] = [];
    const primary = judge("capture", async (input) => {
      captured.push(input);
      return {
        rankings: [
          {
            candidateId: "codex-mini",
            thinkingLevel: "medium",
            confidence: 0.8,
            reason: "Sufficient for minimized session analysis.",
          },
        ],
      };
    });
    const privatePayload = {
      rawSession: "DO-NOT-SEND-RAW-SESSION",
      foregroundModel: "openai-codex/gpt-5.6-sol:max",
    };

    await planRoute({ task: task(), snapshots: snapshots(), judges: [primary] });

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(privatePayload.rawSession);
    expect(serialized).not.toContain(privatePayload.foregroundModel);
    expect(serialized).toContain("session-analysis");
  });

  it("bypasses the judge for one candidate with one valid thinking level", async () => {
    const values = snapshots().slice(0, 1);
    const first = values[0];
    if (!first) throw new Error("Starter snapshot is missing.");
    first.model = { ...first.model, supportedThinkingLevels: ["high"] };
    const rank = vi.fn(async () => ({ rankings: [] }));

    const result = await planRoute({
      task: task(),
      snapshots: values,
      judges: [judge("unused", rank)],
    });

    expect(result.decision.source).toBe("single-candidate");
    expect(result.decision.ranked[0]?.target.thinkingLevel).toBe("high");
    expect(rank).not.toHaveBeenCalled();
  });

  it("fails closed when no configured candidate satisfies hard constraints", async () => {
    const impossibleTask = task({
      requirements: {
        ...task().requirements,
        requiredCapabilities: ["not-configured"],
      },
    });

    await expect(
      planRoute({ task: impossibleTask, snapshots: snapshots(), judges: [] }),
    ).rejects.toMatchObject({ code: "no-routable-candidates" });
  });
});
