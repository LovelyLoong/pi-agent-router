import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { TaskContractSchema } from "./task.js";

export const AGENT_JOB_CONTRACT_VERSION = 2 as const;
export const AGENT_JOB_CLASSES = ["full-agent", "completion", "router-control-plane"] as const;
export const AGENT_JOB_PRIORITIES = ["interactive", "maintenance", "background"] as const;
export const AGENT_JOB_OWNER_KINDS = ["session", "plugin", "service", "external-cli"] as const;
export const AGENT_JOB_DEPENDENCY_FAILURE_POLICIES = ["skip", "continue"] as const;
export const AGENT_JOB_ISOLATION_CLASSES = ["process", "worker-thread", "in-process"] as const;
export const AGENT_JOB_LIFECYCLE_STATES = [
  "submitted",
  "blocked-on-dependencies",
  "queued",
  "routing",
  "starting",
  "running",
  "cancelling",
  "draining",
  "disposing",
  "deleting",
  "released",
] as const;
export const AGENT_JOB_ATTEMPT_STATES = [
  "created",
  "starting",
  "running",
  "cancelling",
  "exited",
  "disposing",
  "deleting",
  "released",
] as const;
export const AGENT_JOB_LEASE_STATES = ["active", "releasing", "released"] as const;
export const AGENT_JOB_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "dependency_failed",
  "queue_full",
  "cleanup_failed",
  "service_drained",
] as const;

const Identifier = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  maxItems: 100,
  uniqueItems: true,
});

export const AgentJobClassSchema = Type.Union([
  Type.Literal("full-agent"),
  Type.Literal("completion"),
  Type.Literal("router-control-plane"),
]);
export const AgentJobPrioritySchema = Type.Union([
  Type.Literal("interactive"),
  Type.Literal("maintenance"),
  Type.Literal("background"),
]);
export const AgentJobOwnerKindSchema = Type.Union([
  Type.Literal("session"),
  Type.Literal("plugin"),
  Type.Literal("service"),
  Type.Literal("external-cli"),
]);
export const AgentJobDependencyFailurePolicySchema = Type.Union([
  Type.Literal("skip"),
  Type.Literal("continue"),
]);
export const AgentJobIsolationClassSchema = Type.Union([
  Type.Literal("process"),
  Type.Literal("worker-thread"),
  Type.Literal("in-process"),
]);
export const AgentJobLifecycleStateSchema = Type.Union([
  Type.Literal("submitted"),
  Type.Literal("blocked-on-dependencies"),
  Type.Literal("queued"),
  Type.Literal("routing"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("draining"),
  Type.Literal("disposing"),
  Type.Literal("deleting"),
  Type.Literal("released"),
]);
export const AgentJobTerminalStatusSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("dependency_failed"),
  Type.Literal("queue_full"),
  Type.Literal("cleanup_failed"),
  Type.Literal("service_drained"),
]);

export const AgentJobOwnershipPolicySchema = Type.Union([
  Type.Object({ mode: Type.Literal("bound") }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal("service-transfer"),
      ttlMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
      purpose: Type.String({ minLength: 3, maxLength: 500 }),
      maxAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
      maxRuntimeMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
    },
    { additionalProperties: false },
  ),
]);

export const AgentJobOwnerSchema = Type.Object(
  {
    ownerId: Identifier,
    kind: AgentJobOwnerKindSchema,
    parentJobId: Type.Optional(Identifier),
    policy: AgentJobOwnershipPolicySchema,
  },
  { additionalProperties: false },
);

export const AgentJobDependenciesSchema = Type.Object(
  {
    dependsOn: Type.Array(Identifier, { maxItems: 100, uniqueItems: true }),
    onFailure: AgentJobDependencyFailurePolicySchema,
  },
  { additionalProperties: false },
);

export const AgentJobRetentionSchema = Type.Union([
  Type.Object({ mode: Type.Literal("ephemeral") }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal("debug"),
      ttlMs: Type.Integer({ minimum: 1, maximum: 604_800_000 }),
    },
    { additionalProperties: false },
  ),
]);

export const AgentJobDescriptorV2Schema = Type.Object(
  {
    contractVersion: Type.Literal(AGENT_JOB_CONTRACT_VERSION),
    jobId: Identifier,
    submittedAt: Type.String({ minLength: 10, maxLength: 100 }),
    deadlineAt: Type.String({ minLength: 10, maxLength: 100 }),
    jobClass: AgentJobClassSchema,
    priority: AgentJobPrioritySchema,
    owner: AgentJobOwnerSchema,
    dependencies: AgentJobDependenciesSchema,
    isolation: AgentJobIsolationClassSchema,
    retention: AgentJobRetentionSchema,
    task: TaskContractSchema,
    capabilityNames: StringList,
  },
  { additionalProperties: false },
);

export const AgentJobAttemptStateSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("exited"),
  Type.Literal("disposing"),
  Type.Literal("deleting"),
  Type.Literal("released"),
]);
export const AgentJobLeaseStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("releasing"),
  Type.Literal("released"),
]);

export const AgentJobAttemptInspectionV2Schema = Type.Object(
  {
    attemptId: Identifier,
    jobId: Identifier,
    ordinal: Type.Integer({ minimum: 1, maximum: 20 }),
    state: AgentJobAttemptStateSchema,
    candidateId: Type.Optional(Identifier),
    model: Type.Optional(Type.String({ minLength: 3, maxLength: 300 })),
    thinkingLevel: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    leaseId: Type.Optional(Identifier),
    startedAt: Type.Optional(Type.String({ minLength: 10, maxLength: 100 })),
    finishedAt: Type.Optional(Type.String({ minLength: 10, maxLength: 100 })),
    terminalStatus: Type.Optional(AgentJobTerminalStatusSchema),
  },
  { additionalProperties: false },
);

export const AgentJobLeaseInspectionV2Schema = Type.Object(
  {
    leaseId: Identifier,
    jobId: Identifier,
    ownerId: Identifier,
    state: AgentJobLeaseStateSchema,
    isolation: AgentJobIsolationClassSchema,
    acquiredAt: Type.String({ minLength: 10, maxLength: 100 }),
    deadlineAt: Type.String({ minLength: 10, maxLength: 100 }),
    processId: Type.Optional(Type.Integer({ minimum: 1 })),
    processIdentityHash: Type.Optional(Type.String({ minLength: 16, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export const AgentJobInspectionV2Schema = Type.Object(
  {
    contractVersion: Type.Literal(AGENT_JOB_CONTRACT_VERSION),
    jobId: Identifier,
    jobClass: AgentJobClassSchema,
    priority: AgentJobPrioritySchema,
    owner: AgentJobOwnerSchema,
    dependencyIds: Type.Array(Identifier, { maxItems: 100, uniqueItems: true }),
    lifecycleState: AgentJobLifecycleStateSchema,
    terminalStatus: Type.Optional(AgentJobTerminalStatusSchema),
    attempt: Type.Optional(AgentJobAttemptInspectionV2Schema),
    lease: Type.Optional(AgentJobLeaseInspectionV2Schema),
    submittedAt: Type.String({ minLength: 10, maxLength: 100 }),
    deadlineAt: Type.String({ minLength: 10, maxLength: 100 }),
    cleanupPhase: Type.Optional(AgentJobLifecycleStateSchema),
  },
  { additionalProperties: false },
);

export type AgentJobClass = (typeof AGENT_JOB_CLASSES)[number];
export type AgentJobPriority = (typeof AGENT_JOB_PRIORITIES)[number];
export type AgentJobOwnerKind = (typeof AGENT_JOB_OWNER_KINDS)[number];
export type AgentJobDependencyFailurePolicy =
  (typeof AGENT_JOB_DEPENDENCY_FAILURE_POLICIES)[number];
export type AgentJobIsolationClass = (typeof AGENT_JOB_ISOLATION_CLASSES)[number];
export type AgentJobLifecycleState = (typeof AGENT_JOB_LIFECYCLE_STATES)[number];
export type AgentJobAttemptState = (typeof AGENT_JOB_ATTEMPT_STATES)[number];
export type AgentJobLeaseState = (typeof AGENT_JOB_LEASE_STATES)[number];
export type AgentJobTerminalStatus = (typeof AGENT_JOB_TERMINAL_STATUSES)[number];
export type AgentJobOwnershipPolicy = Static<typeof AgentJobOwnershipPolicySchema>;
export type AgentJobOwner = Static<typeof AgentJobOwnerSchema>;
export type AgentJobDependencies = Static<typeof AgentJobDependenciesSchema>;
export type AgentJobRetention = Static<typeof AgentJobRetentionSchema>;
export type AgentJobDescriptorV2 = Static<typeof AgentJobDescriptorV2Schema>;
export type AgentJobAttemptInspectionV2 = Static<typeof AgentJobAttemptInspectionV2Schema>;
export type AgentJobLeaseInspectionV2 = Static<typeof AgentJobLeaseInspectionV2Schema>;
export type AgentJobInspectionV2 = Static<typeof AgentJobInspectionV2Schema>;

export interface AgentJobDescriptorValidationResult {
  ok: boolean;
  descriptor?: AgentJobDescriptorV2;
  errors: string[];
}

export function validateAgentJobDescriptorV2(value: unknown): AgentJobDescriptorValidationResult {
  if (!Value.Check(AgentJobDescriptorV2Schema, value)) {
    return {
      ok: false,
      errors: [...Value.Errors(AgentJobDescriptorV2Schema, value)]
        .slice(0, 20)
        .map((error) => `${error.instancePath || "/"} ${error.message}`),
    };
  }
  const descriptor = value as AgentJobDescriptorV2;
  const errors: string[] = [];
  if (descriptor.jobClass === "full-agent" && descriptor.isolation !== "process") {
    errors.push("Full Agent jobs require process isolation.");
  }
  if (descriptor.dependencies.dependsOn.includes(descriptor.jobId)) {
    errors.push("A job cannot depend on itself.");
  }
  if (descriptor.owner.parentJobId === descriptor.jobId) {
    errors.push("A job cannot be its own parent owner job.");
  }
  const submittedAt = Date.parse(descriptor.submittedAt);
  const deadlineAt = Date.parse(descriptor.deadlineAt);
  if (!Number.isFinite(submittedAt) || !Number.isFinite(deadlineAt) || deadlineAt <= submittedAt) {
    errors.push("A job deadline must be a valid instant after its submission instant.");
  }
  if (descriptor.owner.policy.mode === "service-transfer") {
    if (descriptor.owner.policy.maxRuntimeMs > descriptor.owner.policy.ttlMs) {
      errors.push("Transferred ownership runtime cannot exceed its TTL.");
    }
    if (descriptor.owner.policy.maxAttempts > descriptor.task.budget.maxAttempts) {
      errors.push("Transferred ownership attempts cannot exceed the task attempt budget.");
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, descriptor, errors };
}

export interface AgentJobCapability<TArguments = unknown, TResult = unknown> {
  capabilityId: string;
  toolName: string;
  label: string;
  description: string;
  parameters: unknown;
  invoke(argumentsValue: TArguments, signal: AbortSignal): Promise<TResult>;
}

export interface AgentJobPrivateExecution<TPayload = unknown> {
  payload: TPayload;
  capabilities?: readonly AgentJobCapability[] | undefined;
}

export interface AgentJobSubmissionV2<TPayload = unknown> {
  descriptor: AgentJobDescriptorV2;
  execution: AgentJobPrivateExecution<TPayload>;
  signal?: AbortSignal | undefined;
}

export type AgentJobEventV2<TResult = unknown> =
  | {
      contractVersion: 2;
      type: "job.state";
      jobId: string;
      state: AgentJobLifecycleState;
      at: string;
    }
  | {
      contractVersion: 2;
      type: "attempt.state";
      jobId: string;
      attempt: AgentJobAttemptInspectionV2;
      at: string;
    }
  | {
      contractVersion: 2;
      type: "job.output";
      jobId: string;
      output: TResult;
      at: string;
    }
  | {
      contractVersion: 2;
      type: "job.terminal";
      jobId: string;
      status: AgentJobTerminalStatus;
      cleanupComplete: boolean;
      at: string;
    };

export interface AgentJobResultV2<TResult = unknown> {
  contractVersion: 2;
  jobId: string;
  status: AgentJobTerminalStatus;
  cleanupComplete: boolean;
  output?: TResult | undefined;
  inspection: AgentJobInspectionV2;
}
