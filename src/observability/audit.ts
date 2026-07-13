import type { RouteOutcome } from "../contracts/routing.js";
import type { TaskContract } from "../contracts/task.js";
import type { RoutePlanningResult } from "../routing/router.js";
import { redactText } from "./redact.js";

export const ROUTE_AUDIT_VERSION = 1 as const;

export interface RouteAuditRecord {
  version: typeof ROUTE_AUDIT_VERSION;
  routeId: string;
  taskId: string;
  taskKind: string;
  success: boolean;
  decisionSource: string;
  selectedTarget?: {
    executorId: string;
    model: string;
    thinkingLevel: string;
  };
  selectedHealth: {
    status: string;
    ageMs?: number;
  };
  elapsedMs: number;
  fallbackCount: number;
  ranked: Array<{
    rank: number;
    executorId: string;
    model: string;
    thinkingLevel: string;
    confidence: number;
    reason: string;
  }>;
  attempts: Array<{
    executorId: string;
    model: string;
    thinkingLevel: string;
    elapsedMs: number;
    failureClass?: string;
  }>;
  terminalFailure?: string;
}

function healthSummary(
  planning: RoutePlanningResult | undefined,
  candidateId: string | undefined,
  finishedAt: string,
): RouteAuditRecord["selectedHealth"] {
  const candidate = planning?.input.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) return { status: "unknown" };
  const checkedAt = candidate.health.checkedAt
    ? Date.parse(candidate.health.checkedAt)
    : Number.NaN;
  const finished = Date.parse(finishedAt);
  return {
    status: candidate.health.status,
    ...(!Number.isNaN(checkedAt) && !Number.isNaN(finished)
      ? { ageMs: Math.max(0, finished - checkedAt) }
      : {}),
  };
}

export function buildRouteAudit(options: {
  task: TaskContract;
  outcome: RouteOutcome;
  planning?: RoutePlanningResult;
}): RouteAuditRecord {
  const { task, outcome, planning } = options;
  const selectedIndex = outcome.selectedTarget
    ? outcome.attempts.findIndex(
        (attempt) => attempt.target.candidateId === outcome.selectedTarget?.candidateId,
      )
    : -1;
  return {
    version: ROUTE_AUDIT_VERSION,
    routeId: outcome.routeId,
    taskId: outcome.taskId,
    taskKind: task.taskKind,
    success: outcome.success,
    decisionSource: outcome.decision.source,
    ...(outcome.selectedTarget
      ? {
          selectedTarget: {
            executorId: outcome.selectedTarget.executorId,
            model: outcome.selectedTarget.model,
            thinkingLevel: outcome.selectedTarget.thinkingLevel,
          },
        }
      : {}),
    selectedHealth: healthSummary(
      planning,
      outcome.selectedTarget?.candidateId,
      outcome.finishedAt,
    ),
    elapsedMs: outcome.attempts.reduce((total, attempt) => total + (attempt.elapsedMs ?? 0), 0),
    fallbackCount: selectedIndex >= 0 ? selectedIndex : Math.max(0, outcome.attempts.length - 1),
    ranked: outcome.decision.ranked.map((ranking) => ({
      rank: ranking.rank,
      executorId: ranking.target.executorId,
      model: ranking.target.model,
      thinkingLevel: ranking.target.thinkingLevel,
      confidence: ranking.confidence,
      reason: redactText(ranking.reason, 300),
    })),
    attempts: outcome.attempts.map((attempt) => ({
      executorId: attempt.target.executorId,
      model: attempt.target.model,
      thinkingLevel: attempt.target.thinkingLevel,
      elapsedMs: attempt.elapsedMs ?? 0,
      ...(attempt.failureClass ? { failureClass: attempt.failureClass } : {}),
    })),
    ...(outcome.terminalFailure ? { terminalFailure: outcome.terminalFailure } : {}),
  };
}

function duration(value: number): string {
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function health(value: RouteAuditRecord["selectedHealth"]): string {
  if (value.ageMs === undefined) return value.status;
  return `${value.status}/${duration(value.ageMs)} old`;
}

export function renderRouteAudit(record: RouteAuditRecord, expanded = false): string {
  const target = record.selectedTarget
    ? `${record.selectedTarget.executorId}:${record.selectedTarget.model}@${record.selectedTarget.thinkingLevel}`
    : `failed:${record.terminalFailure ?? "unknown"}`;
  const compact = [
    `${record.success ? "✓" : "✗"} route ${record.taskKind}`,
    target,
    record.decisionSource,
    `health ${health(record.selectedHealth)}`,
    duration(record.elapsedMs),
    `${record.fallbackCount} fallback${record.fallbackCount === 1 ? "" : "s"}`,
  ].join(" · ");
  if (!expanded) return compact;
  const rankings = record.ranked.map(
    (item) =>
      `  ${item.rank}. ${item.executorId}:${item.model}@${item.thinkingLevel} (${Math.round(item.confidence * 100)}%) — ${item.reason}`,
  );
  const attempts = record.attempts.map(
    (item, index) =>
      `  ${index + 1}. ${item.executorId}:${item.model}@${item.thinkingLevel} — ${item.failureClass ?? "success"} in ${duration(item.elapsedMs)}`,
  );
  return [compact, "Candidates:", ...rankings, "Attempts:", ...attempts].join("\n");
}
