import { type Static, Type } from "typebox";
import { AgentJobIsolationClassSchema, AgentJobPrioritySchema } from "../contracts/jobs.js";
import {
  DataSensitivitySchema,
  InputModalitySchema,
  SideEffectClassSchema,
  ThinkingLevelSchema,
} from "../contracts/task.js";

export const AGENT_ROUTER_CONFIG_VERSION = 1 as const;
export const AGENT_ROUTER_CONFIG_VERSION_V1 = AGENT_ROUTER_CONFIG_VERSION;
export const AGENT_ROUTER_CONFIG_VERSION_V2 = 2 as const;
export const EXECUTOR_TYPES = ["pi-sdk"] as const;
export const RELATIVE_CLASSES = ["low", "medium", "high", "premium"] as const;
export const COMPLIANCE_RULE_VERSION = 1 as const;
export const EXTERNAL_PROVIDER_EXEMPTION_TYPES = [
  "provider-search",
  "provider-video",
  "provider-url-context",
  "provider-extraction",
] as const;

const Id = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const ModelReference = Type.String({
  minLength: 3,
  maxLength: 300,
  pattern: "^[^/\\s]+/[^/\\s]+$",
});
const RelativeClassSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("premium"),
]);
const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  maxItems: 100,
  uniqueItems: true,
});

export const RouterTargetConfigSchema = Type.Object(
  {
    executorId: Id,
    model: ModelReference,
    thinkingLevel: ThinkingLevelSchema,
  },
  { additionalProperties: false },
);

export const ExecutorConfigSchema = Type.Object(
  {
    id: Id,
    type: Type.Literal("pi-sdk"),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CandidateConfigSchema = Type.Object(
  {
    id: Id,
    enabled: Type.Boolean(),
    executorId: Id,
    model: ModelReference,
    allowedThinkingLevels: Type.Array(ThinkingLevelSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    staticPriority: Type.Integer({ minimum: 1, maximum: 10_000 }),
    capabilities: StringList,
    allowedTools: StringList,
    inputModalities: Type.Array(InputModalitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    minimumContextWindow: Type.Integer({ minimum: 1 }),
    allowedSideEffects: Type.Array(SideEffectClassSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    allowedDataSensitivity: Type.Array(DataSensitivitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    metadata: Type.Object(
      {
        description: Type.String({ minLength: 1, maxLength: 500 }),
        strengths: StringList,
        qualityClass: RelativeClassSchema,
        costClass: RelativeClassSchema,
        latencyClass: RelativeClassSchema,
      },
      { additionalProperties: false },
    ),
    attemptTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
  },
  { additionalProperties: false },
);

const RouterPolicyConfigSchema = Type.Object(
  {
    targets: Type.Array(RouterTargetConfigSchema, { minItems: 1, maxItems: 10 }),
    attemptTimeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
    overallTimeoutMs: Type.Integer({ minimum: 1, maximum: 1_200_000 }),
  },
  { additionalProperties: false },
);

const ExecutionConfigSchema = Type.Object(
  {
    attemptTimeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    overallTimeoutMs: Type.Integer({ minimum: 1, maximum: 7_200_000 }),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
  },
  { additionalProperties: false },
);

const HealthConfigSchema = Type.Object(
  {
    successTtlMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
    failureCooldownMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
    rateLimitCooldownMinMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
    rateLimitCooldownMaxMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
  },
  { additionalProperties: false },
);

const DoctorConfigSchema = Type.Object(
  {
    probeTimeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
    overallTimeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
  },
  { additionalProperties: false },
);

const SharedRouterConfigProperties = {
  router: RouterPolicyConfigSchema,
  executors: Type.Array(ExecutorConfigSchema, { minItems: 1, maxItems: 50 }),
  candidates: Type.Array(CandidateConfigSchema, { minItems: 1, maxItems: 200 }),
  execution: ExecutionConfigSchema,
  health: HealthConfigSchema,
  doctor: DoctorConfigSchema,
} as const;

export const AgentRouterConfigV1Schema = Type.Object(
  {
    configVersion: Type.Literal(AGENT_ROUTER_CONFIG_VERSION_V1),
    ...SharedRouterConfigProperties,
  },
  { additionalProperties: false },
);

export const AgentRouterConfigSchema = AgentRouterConfigV1Schema;

const ProviderLimitConfigSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 100 }),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    maxActive: Type.Integer({ minimum: 1, maximum: 64 }),
  },
  { additionalProperties: false },
);

const ExternalProviderExemptionSchema = Type.Union([
  Type.Literal("provider-search"),
  Type.Literal("provider-video"),
  Type.Literal("provider-url-context"),
  Type.Literal("provider-extraction"),
]);

export const SupervisorConfigSchema = Type.Object(
  {
    limits: Type.Object(
      {
        maxFullAgentWorkers: Type.Integer({ minimum: 1, maximum: 64 }),
        maxCompletionWorkers: Type.Integer({ minimum: 1, maximum: 128 }),
        maxJobsPerOwner: Type.Integer({ minimum: 1, maximum: 64 }),
        maxControlPlaneJobs: Type.Integer({ minimum: 1, maximum: 32 }),
        queueCapacity: Type.Integer({ minimum: 1, maximum: 10_000 }),
        providerLimits: Type.Array(ProviderLimitConfigSchema, {
          maxItems: 100,
        }),
      },
      { additionalProperties: false },
    ),
    priorityOrder: Type.Array(AgentJobPrioritySchema, {
      minItems: 3,
      maxItems: 3,
      uniqueItems: true,
    }),
    deadlines: Type.Object(
      {
        cooperativeAbortGraceMs: Type.Integer({ minimum: 1, maximum: 300_000 }),
        processExitGraceMs: Type.Integer({ minimum: 1, maximum: 300_000 }),
        cleanupDeadlineMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
        drainDeadlineMs: Type.Integer({ minimum: 1, maximum: 1_200_000 }),
      },
      { additionalProperties: false },
    ),
    ipc: Type.Object(
      {
        protocolVersion: Type.Literal(1),
        maxFrameBytes: Type.Integer({ minimum: 1_024, maximum: 16_777_216 }),
        maxRunPayloadBytes: Type.Integer({ minimum: 1_024, maximum: 16_777_216 }),
        maxToolArgumentBytes: Type.Integer({ minimum: 256, maximum: 4_194_304 }),
        maxToolResultBytes: Type.Integer({ minimum: 256, maximum: 4_194_304 }),
        maxPendingToolCalls: Type.Integer({ minimum: 1, maximum: 256 }),
        maxToolCalls: Type.Integer({ minimum: 1, maximum: 10_000 }),
      },
      { additionalProperties: false },
    ),
    cleanup: Type.Object(
      {
        deleteMaxAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
        deleteBackoffMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
        janitorMaxItems: Type.Integer({ minimum: 1, maximum: 10_000 }),
        quarantineTtlMs: Type.Integer({ minimum: 1, maximum: 2_592_000_000 }),
      },
      { additionalProperties: false },
    ),
    retention: Type.Object(
      {
        defaultMode: Type.Literal("ephemeral"),
        maxDebugTtlMs: Type.Integer({ minimum: 1, maximum: 604_800_000 }),
      },
      { additionalProperties: false },
    ),
    ownership: Type.Object(
      {
        serviceTransferTaskKinds: StringList,
        maxServiceOwnershipTtlMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
        maxTransferredAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
      },
      { additionalProperties: false },
    ),
    dependencies: Type.Object(
      {
        failureContinueTaskKinds: StringList,
      },
      { additionalProperties: false },
    ),
    isolation: Type.Object(
      {
        fullAgent: Type.Literal("process"),
        completion: AgentJobIsolationClassSchema,
        controlPlane: AgentJobIsolationClassSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ComplianceConfigSchema = Type.Object(
  {
    ruleVersion: Type.Literal(COMPLIANCE_RULE_VERSION),
    attestationPath: Type.String({ minLength: 1, maxLength: 1_000 }),
    maxSourceFiles: Type.Integer({ minimum: 1, maximum: 100_000 }),
    maxSourceBytes: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
    allowedExternalProviderExemptions: Type.Array(ExternalProviderExemptionSchema, {
      maxItems: EXTERNAL_PROVIDER_EXEMPTION_TYPES.length,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const AgentRouterConfigV2Schema = Type.Object(
  {
    configVersion: Type.Literal(AGENT_ROUTER_CONFIG_VERSION_V2),
    ...SharedRouterConfigProperties,
    supervisor: SupervisorConfigSchema,
    compliance: ComplianceConfigSchema,
  },
  { additionalProperties: false },
);

export type RouterTargetConfig = Static<typeof RouterTargetConfigSchema>;
export type ExecutorConfig = Static<typeof ExecutorConfigSchema>;
export type CandidateConfig = Static<typeof CandidateConfigSchema>;
export type AgentRouterConfigV1 = Static<typeof AgentRouterConfigV1Schema>;
export type AgentRouterConfig = AgentRouterConfigV1;
export type SupervisorConfig = Static<typeof SupervisorConfigSchema>;
export type ComplianceConfig = Static<typeof ComplianceConfigSchema>;
export type AgentRouterConfigV2 = Static<typeof AgentRouterConfigV2Schema>;
export type AnyAgentRouterConfig = AgentRouterConfigV1 | AgentRouterConfigV2;
