import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AGENT_JOB_CONTRACT_VERSION,
  AGENT_JOB_TERMINAL_STATUSES,
  type AgentJobDescriptorV2,
  AgentJobDescriptorV2Schema,
  type TaskContract,
  validateAgentJobDescriptorV2,
} from "../src/contracts/index.js";
import { isAgentRouterServiceV2 } from "../src/service/index.js";

function task(): TaskContract {
  return {
    contractVersion: 1,
    taskId: "session-ask:supervised",
    taskKind: "session-analysis",
    goalSummary: "Answer from bounded evidence through a supervised Agent job.",
    requirements: {
      requiredCapabilities: ["analysis", "retrieval"],
      preferredCapabilities: ["structured-output"],
      allowedTools: ["session_search", "session_read", "provide_results"],
      inputModalities: ["text"],
      minimumContextWindow: 128_000,
      requiresReasoning: true,
      sideEffectClass: "read",
      dataSensitivity: "sensitive",
      output: { kind: "tool", contractName: "provide_results.v1" },
    },
    context: { estimatedTokens: 10_000, bytes: 500_000, itemCount: 30 },
    budget: {
      routeTimeoutMs: 60_000,
      attemptTimeoutMs: 180_000,
      overallTimeoutMs: 420_000,
      maxAttempts: 3,
    },
    preferences: {},
  };
}

function descriptor(): AgentJobDescriptorV2 {
  return {
    contractVersion: AGENT_JOB_CONTRACT_VERSION,
    jobId: "job:session-ask:1",
    submittedAt: "2026-07-13T06:00:00.000Z",
    deadlineAt: "2026-07-13T06:07:00.000Z",
    jobClass: "full-agent",
    priority: "interactive",
    owner: {
      ownerId: "session:foreground",
      kind: "session",
      policy: { mode: "bound" },
    },
    dependencies: { dependsOn: [], onFailure: "skip" },
    isolation: "process",
    retention: { mode: "ephemeral" },
    task: task(),
    capabilityNames: ["session_search", "session_read", "provide_results"],
  };
}

describe("V2 Agent job contracts", () => {
  it("accepts a minimized full-Agent descriptor with owner, DAG, isolation, and retention", () => {
    const value = descriptor();
    expect(Value.Check(AgentJobDescriptorV2Schema, value)).toBe(true);
    expect(validateAgentJobDescriptorV2(value)).toEqual({
      ok: true,
      descriptor: value,
      errors: [],
    });
  });

  it("rejects raw execution state, self-dependencies, and non-process full Agents", () => {
    expect(
      Value.Check(AgentJobDescriptorV2Schema, {
        ...descriptor(),
        rawAgentSession: { prompt: "escape" },
      }),
    ).toBe(false);

    const invalid = descriptor();
    invalid.isolation = "in-process";
    invalid.dependencies.dependsOn = [invalid.jobId];
    invalid.owner.parentJobId = invalid.jobId;
    expect(validateAgentJobDescriptorV2(invalid)).toMatchObject({
      ok: false,
      errors: [
        "Full Agent jobs require process isolation.",
        "A job cannot depend on itself.",
        "A job cannot be its own parent owner job.",
      ],
    });
  });

  it("rejects unbounded service ownership transfer", () => {
    const invalid = descriptor();
    invalid.owner.policy = {
      mode: "service-transfer",
      ttlMs: 1_000,
      purpose: "Continue approved maintenance after the foreground owner exits.",
      maxAttempts: 4,
      maxRuntimeMs: 2_000,
    };
    expect(validateAgentJobDescriptorV2(invalid)).toMatchObject({
      ok: false,
      errors: [
        "Transferred ownership runtime cannot exceed its TTL.",
        "Transferred ownership attempts cannot exceed the task attempt budget.",
      ],
    });
  });

  it("makes cleanup and dependency outcomes first-class terminal states", () => {
    expect(AGENT_JOB_TERMINAL_STATUSES).toEqual(
      expect.arrayContaining([
        "succeeded",
        "cancelled",
        "timed_out",
        "dependency_failed",
        "queue_full",
        "cleanup_failed",
        "service_drained",
      ]),
    );
  });

  it("exposes only structured job APIs, never AgentSession", async () => {
    const sources = await Promise.all([
      readFile(new URL("../src/contracts/jobs.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/service/contracts.ts", import.meta.url), "utf8"),
    ]);
    expect(sources.join("\n")).not.toMatch(/\bAgentSession\b/);

    const candidate = {
      contractVersion: 2,
      serviceId: "pi-agent-router",
      packageVersion: "0.1.0",
      instanceId: "router-v2",
      capabilities: [
        "inspect-config-v2",
        "run-agent-job",
        "stream-agent-job",
        "with-agent-job",
        "inspect-agent-jobs",
        "cancel-agent-job",
        "drain-supervisor",
      ],
      inspectConfiguration() {},
      inspectSupervisor() {},
      runJob() {},
      streamJob() {},
      withAgent() {},
      inspectJobs() {},
      cancelJob() {},
      drain() {},
    };
    expect(isAgentRouterServiceV2(candidate)).toBe(true);
    expect(isAgentRouterServiceV2({ ...candidate, runJob: undefined })).toBe(false);
  });
});
