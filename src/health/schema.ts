import { type Static, Type } from "typebox";
import { FailureClassSchema } from "../contracts/routing.js";

export const HEALTH_STATE_VERSION = 1 as const;
export const PersistedHealthStatusSchema = Type.Union([
  Type.Literal("healthy"),
  Type.Literal("cooldown"),
  Type.Literal("degraded"),
]);

export const HealthEntrySchema = Type.Object(
  {
    candidateId: Type.String({ minLength: 1, maxLength: 100 }),
    status: PersistedHealthStatusSchema,
    checkedAt: Type.String({ format: "date-time" }),
    expiresAt: Type.Optional(Type.String({ format: "date-time" })),
    lastSuccessAt: Type.Optional(Type.String({ format: "date-time" })),
    lastFailureAt: Type.Optional(Type.String({ format: "date-time" })),
    lastFailureClass: Type.Optional(FailureClassSchema),
    reason: Type.Optional(Type.String({ maxLength: 1_000 })),
    consecutiveFailures: Type.Integer({ minimum: 0 }),
    latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const HealthStateSchema = Type.Object(
  {
    version: Type.Literal(HEALTH_STATE_VERSION),
    configHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    updatedAt: Type.String({ format: "date-time" }),
    entries: Type.Array(HealthEntrySchema, { maxItems: 1_000 }),
  },
  { additionalProperties: false },
);

export type HealthEntry = Static<typeof HealthEntrySchema>;
export type HealthState = Static<typeof HealthStateSchema>;
