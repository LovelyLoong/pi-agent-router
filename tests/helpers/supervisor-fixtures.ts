import type {
  AgentJobDescriptorV2,
  AgentJobOwner,
  AgentJobPriority,
  AgentJobTerminalStatus,
  TaskContract,
} from "../../src/contracts/index.js";
import type { AgentJobResourceClaim } from "../../src/supervisor/index.js";

export interface JobFixtureOptions {
  jobId: string;
  now: number;
  deadlineMs?: number;
  jobClass?: AgentJobDescriptorV2["jobClass"];
  priority?: AgentJobPriority;
  ownerId?: string;
  ownerKind?: AgentJobOwner["kind"];
  parentJobId?: string;
  ownerPolicy?: AgentJobOwner["policy"];
  dependsOn?: string[];
  onFailure?: AgentJobDescriptorV2["dependencies"]["onFailure"];
  taskKind?: string;
}

function task(jobId: string, taskKind: string): TaskContract {
  return {
    contractVersion: 1,
    taskId: `task:${jobId}`,
    taskKind,
    goalSummary: `Execute supervised fixture ${jobId}.`,
    requirements: {
      requiredCapabilities: ["analysis"],
      preferredCapabilities: [],
      allowedTools: [],
      inputModalities: ["text"],
      minimumContextWindow: 1,
      requiresReasoning: true,
      sideEffectClass: "none",
      dataSensitivity: "internal",
      output: { kind: "text" },
    },
    context: { estimatedTokens: 100, bytes: 1_000, itemCount: 1 },
    budget: {
      routeTimeoutMs: 1_000,
      attemptTimeoutMs: 10_000,
      overallTimeoutMs: 60_000,
      maxAttempts: 3,
    },
    preferences: {},
  };
}

export function jobDescriptor(options: JobFixtureOptions): AgentJobDescriptorV2 {
  const owner: AgentJobOwner = {
    ownerId: options.ownerId ?? "owner:default",
    kind: options.ownerKind ?? "session",
    ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
    policy: options.ownerPolicy ?? { mode: "bound" },
  };
  return {
    contractVersion: 2,
    jobId: options.jobId,
    submittedAt: new Date(options.now).toISOString(),
    deadlineAt: new Date(options.now + (options.deadlineMs ?? 60_000)).toISOString(),
    jobClass: options.jobClass ?? "full-agent",
    priority: options.priority ?? "maintenance",
    owner,
    dependencies: {
      dependsOn: options.dependsOn ?? [],
      onFailure: options.onFailure ?? "skip",
    },
    isolation: "process",
    retention: { mode: "ephemeral" },
    task: task(options.jobId, options.taskKind ?? "test-job"),
    capabilityNames: [],
  };
}

export function resource(
  model = "openai-codex/gpt-5.4-mini",
  provider = "openai-codex",
): AgentJobResourceClaim {
  return { provider, model, candidateId: model.split("/").at(-1) };
}

export const SUCCESS: AgentJobTerminalStatus = "succeeded";
