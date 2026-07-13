import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  RETRYABLE_FAILURE_CLASSES,
  TASK_CONTRACT_VERSION,
  type TaskContract,
  TaskContractSchema,
} from "../src/contracts/index.js";

function validTask(): TaskContract {
  return {
    contractVersion: TASK_CONTRACT_VERSION,
    taskId: "session-ask:example",
    taskKind: "session-analysis",
    goalSummary: "Verify the last completed tool result and explain the stopping state.",
    requirements: {
      requiredCapabilities: ["retrieval", "analysis", "structured-output"],
      preferredCapabilities: ["long-context"],
      allowedTools: ["read", "grep", "find", "ls", "session_search", "session_read"],
      inputModalities: ["text"],
      minimumContextWindow: 128_000,
      requiresReasoning: true,
      sideEffectClass: "read",
      dataSensitivity: "sensitive",
      output: { kind: "tool", contractName: "provide_results.v1" },
    },
    context: { estimatedTokens: 10_000, bytes: 900_000, itemCount: 53 },
    budget: {
      routeTimeoutMs: 60_000,
      attemptTimeoutMs: 180_000,
      overallTimeoutMs: 420_000,
      maxAttempts: 3,
    },
    preferences: {},
  };
}

describe("Task and routing contracts", () => {
  it("accepts a minimized structured task contract", () => {
    expect(Value.Check(TaskContractSchema, validTask())).toBe(true);
  });

  it("rejects a private execution payload embedded in the Router-visible contract", () => {
    const task = { ...validTask(), executionPayload: { rawSession: "secret" } };
    expect(Value.Check(TaskContractSchema, task)).toBe(false);
  });

  it("does not classify abort, unknown side effects, or unknown failures as retryable", () => {
    expect(RETRYABLE_FAILURE_CLASSES).not.toContain("aborted");
    expect(RETRYABLE_FAILURE_CLASSES).not.toContain("unknown-side-effect");
    expect(RETRYABLE_FAILURE_CLASSES).not.toContain("unknown");
    expect(RETRYABLE_FAILURE_CLASSES).toContain("output-contract");
  });
});
