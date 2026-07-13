import { Type } from "typebox";
import type { ThinkingLevel } from "./task.js";

export const ROUTING_CONTRACT_VERSION = 1 as const;

export interface ExecutionTarget {
  candidateId: string;
  executorId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface CandidateRanking {
  target: ExecutionTarget;
  rank: number;
  confidence: number;
  reason: string;
}

export type RouteDecisionSource = "router" | "static-fallback" | "single-candidate";

export interface RouteDecision {
  contractVersion: typeof ROUTING_CONTRACT_VERSION;
  routeId: string;
  taskId: string;
  source: RouteDecisionSource;
  ranked: CandidateRanking[];
  decidedAt: string;
}

export const FAILURE_CLASSES = [
  "executor-unavailable",
  "model-unavailable",
  "authentication",
  "rate-limit",
  "provider-transport",
  "timeout",
  "aborted",
  "output-contract",
  "unknown-side-effect",
  "unknown",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const FailureClassSchema = Type.Union([
  Type.Literal("executor-unavailable"),
  Type.Literal("model-unavailable"),
  Type.Literal("authentication"),
  Type.Literal("rate-limit"),
  Type.Literal("provider-transport"),
  Type.Literal("timeout"),
  Type.Literal("aborted"),
  Type.Literal("output-contract"),
  Type.Literal("unknown-side-effect"),
  Type.Literal("unknown"),
]);

export const RETRYABLE_FAILURE_CLASSES = [
  "executor-unavailable",
  "model-unavailable",
  "authentication",
  "rate-limit",
  "provider-transport",
  "timeout",
  "output-contract",
] as const satisfies readonly FailureClass[];

export interface RouteAttempt {
  attemptId: string;
  routeId: string;
  taskId: string;
  target: ExecutionTarget;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  failureClass?: FailureClass;
  errorMessage?: string;
  usage?: UsageSnapshot;
}

export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export interface RouteOutcome<TResult = unknown> {
  contractVersion: typeof ROUTING_CONTRACT_VERSION;
  routeId: string;
  taskId: string;
  decision: RouteDecision;
  attempts: RouteAttempt[];
  success: boolean;
  selectedTarget?: ExecutionTarget;
  result?: TResult;
  terminalFailure?: FailureClass;
  terminalMessage?: string;
  usage?: UsageSnapshot;
  finishedAt: string;
}
