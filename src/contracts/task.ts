import { type Static, Type } from "typebox";

export const TASK_CONTRACT_VERSION = 1 as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const INPUT_MODALITIES = ["text", "image", "audio", "video"] as const;
export const SIDE_EFFECT_CLASSES = ["none", "read", "write", "external"] as const;
export const DATA_SENSITIVITY_LEVELS = ["public", "internal", "sensitive", "restricted"] as const;
export const OUTPUT_KINDS = ["text", "structured", "tool"] as const;

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export const InputModalitySchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("image"),
  Type.Literal("audio"),
  Type.Literal("video"),
]);
export const SideEffectClassSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("external"),
]);
export const DataSensitivitySchema = Type.Union([
  Type.Literal("public"),
  Type.Literal("internal"),
  Type.Literal("sensitive"),
  Type.Literal("restricted"),
]);
export const OutputKindSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("structured"),
  Type.Literal("tool"),
]);

const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  maxItems: 100,
  uniqueItems: true,
});

export const TaskContractSchema = Type.Object(
  {
    contractVersion: Type.Literal(TASK_CONTRACT_VERSION),
    taskId: Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
    taskKind: Type.String({ minLength: 1, maxLength: 100 }),
    goalSummary: Type.String({ minLength: 3, maxLength: 2_000 }),
    requirements: Type.Object(
      {
        requiredCapabilities: StringList,
        preferredCapabilities: StringList,
        allowedTools: StringList,
        inputModalities: Type.Array(InputModalitySchema, {
          minItems: 1,
          uniqueItems: true,
        }),
        minimumContextWindow: Type.Integer({ minimum: 1 }),
        requiresReasoning: Type.Boolean(),
        sideEffectClass: SideEffectClassSchema,
        dataSensitivity: DataSensitivitySchema,
        output: Type.Object(
          {
            kind: OutputKindSchema,
            contractName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    context: Type.Object(
      {
        estimatedTokens: Type.Integer({ minimum: 0 }),
        bytes: Type.Integer({ minimum: 0 }),
        itemCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    budget: Type.Object(
      {
        routeTimeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
        attemptTimeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
        overallTimeoutMs: Type.Integer({ minimum: 1, maximum: 7_200_000 }),
        maxAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
      },
      { additionalProperties: false },
    ),
    preferences: Type.Object(
      {
        quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        cost: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        latency: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type InputModality = (typeof INPUT_MODALITIES)[number];
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];
export type DataSensitivity = (typeof DATA_SENSITIVITY_LEVELS)[number];
export type TaskContract = Static<typeof TaskContractSchema>;
