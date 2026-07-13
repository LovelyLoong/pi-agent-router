import { type Static, Type } from "typebox";
import {
  DataSensitivitySchema,
  InputModalitySchema,
  SideEffectClassSchema,
  ThinkingLevelSchema,
} from "../contracts/task.js";

export const AGENT_ROUTER_CONFIG_VERSION = 1 as const;
export const EXECUTOR_TYPES = ["pi-sdk"] as const;
export const RELATIVE_CLASSES = ["low", "medium", "high", "premium"] as const;

const Id = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
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

export const AgentRouterConfigSchema = Type.Object(
  {
    configVersion: Type.Literal(AGENT_ROUTER_CONFIG_VERSION),
    router: Type.Object(
      {
        targets: Type.Array(RouterTargetConfigSchema, { minItems: 1, maxItems: 10 }),
        attemptTimeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
        overallTimeoutMs: Type.Integer({ minimum: 1, maximum: 1_200_000 }),
      },
      { additionalProperties: false },
    ),
    executors: Type.Array(ExecutorConfigSchema, { minItems: 1, maxItems: 50 }),
    candidates: Type.Array(CandidateConfigSchema, { minItems: 1, maxItems: 200 }),
    execution: Type.Object(
      {
        attemptTimeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
        overallTimeoutMs: Type.Integer({ minimum: 1, maximum: 7_200_000 }),
        maxAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
      },
      { additionalProperties: false },
    ),
    health: Type.Object(
      {
        successTtlMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
        failureCooldownMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
        rateLimitCooldownMinMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
        rateLimitCooldownMaxMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
      },
      { additionalProperties: false },
    ),
    doctor: Type.Object(
      {
        probeTimeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
        overallTimeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type RouterTargetConfig = Static<typeof RouterTargetConfigSchema>;
export type ExecutorConfig = Static<typeof ExecutorConfigSchema>;
export type CandidateConfig = Static<typeof CandidateConfigSchema>;
export type AgentRouterConfig = Static<typeof AgentRouterConfigSchema>;
