import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { RouterTargetConfig } from "../config/schema.js";
import { type TaskContract, ThinkingLevelSchema } from "../contracts/task.js";
import type { RoutableCandidate } from "./filter.js";

export const JudgeRankingSchema = Type.Object(
  {
    rankings: Type.Array(
      Type.Object(
        {
          candidateId: Type.String({ minLength: 1, maxLength: 100 }),
          thinkingLevel: ThinkingLevelSchema,
          confidence: Type.Number({ minimum: 0, maximum: 1 }),
          reason: Type.String({ minLength: 3, maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 200 },
    ),
  },
  { additionalProperties: false },
);

export type JudgeRanking = Static<typeof JudgeRankingSchema>;

export interface RouterCandidateView {
  candidateId: string;
  executorId: string;
  model: string;
  thinkingLevels: string[];
  staticPriority: number;
  capabilities: string[];
  description: string;
  strengths: string[];
  qualityClass: string;
  costClass: string;
  latencyClass: string;
  contextWindow: number;
  inputModalities: string[];
  health: {
    status: string;
    checkedAt?: string;
    cooldownUntil?: string;
  };
  providerCost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface RouterTaskView {
  taskId: string;
  taskKind: string;
  goalSummary: string;
  requirements: TaskContract["requirements"];
  context: TaskContract["context"];
  budget: TaskContract["budget"];
  preferences: TaskContract["preferences"];
}

export interface RouterJudgeInput {
  contractVersion: 1;
  task: RouterTaskView;
  candidates: RouterCandidateView[];
}

export interface RouteJudge {
  readonly id: string;
  readonly target: RouterTargetConfig;
  rank(input: RouterJudgeInput, signal?: AbortSignal): Promise<unknown>;
}

export function buildRouterJudgeInput(
  task: TaskContract,
  candidates: RoutableCandidate[],
): RouterJudgeInput {
  return {
    contractVersion: 1,
    task: {
      taskId: task.taskId,
      taskKind: task.taskKind,
      goalSummary: task.goalSummary,
      requirements: task.requirements,
      context: task.context,
      budget: task.budget,
      preferences: task.preferences,
    },
    candidates: candidates.map(({ candidate, model, health, thinkingLevels }) => ({
      candidateId: candidate.id,
      executorId: candidate.executorId,
      model: candidate.model,
      thinkingLevels,
      staticPriority: candidate.staticPriority,
      capabilities: [...candidate.capabilities],
      description: candidate.metadata.description,
      strengths: [...candidate.metadata.strengths],
      qualityClass: candidate.metadata.qualityClass,
      costClass: candidate.metadata.costClass,
      latencyClass: candidate.metadata.latencyClass,
      contextWindow: model.contextWindow,
      inputModalities: [...model.inputModalities],
      health: {
        status: health.status,
        ...(health.checkedAt ? { checkedAt: health.checkedAt } : {}),
        ...(health.cooldownUntil ? { cooldownUntil: health.cooldownUntil } : {}),
      },
      ...(model.cost ? { providerCost: { ...model.cost } } : {}),
    })),
  };
}

export function parseJudgeRanking(value: unknown): JudgeRanking {
  if (Value.Check(JudgeRankingSchema, value)) return value as JudgeRanking;
  const firstError = Value.Errors(JudgeRankingSchema, value)[0];
  throw new Error(
    `Router judge output contract failed: ${firstError?.instancePath || "/"} ${firstError?.message || "invalid value"}`,
  );
}
