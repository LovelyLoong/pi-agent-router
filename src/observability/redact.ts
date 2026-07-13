import { createHash } from "node:crypto";
import type { FeedbackRecord, RouteEvent } from "../contracts/events.js";
import type { RouteAttempt, RouteDecision, RouteOutcome } from "../contracts/routing.js";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted-token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [redacted]"],
  [/(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]"],
];

export function redactText(value: string, maxLength = 1_000): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    redacted = redacted.replace(pattern, replacement);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}

function redactGoal(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `[redacted goal sha256:${hash}]`;
}

function redactDecision(decision: RouteDecision): RouteDecision {
  return {
    ...decision,
    ranked: decision.ranked.map((ranking) => ({
      ...ranking,
      reason: "Selection rationale redacted from telemetry.",
    })),
  };
}

function redactAttempt(attempt: RouteAttempt): RouteAttempt {
  const { errorMessage: _errorMessage, ...safe } = attempt;
  return safe;
}

function redactOutcome(outcome: RouteOutcome): RouteOutcome {
  const { result: _result, terminalMessage: _terminalMessage, ...safe } = outcome;
  return {
    ...safe,
    decision: redactDecision(outcome.decision),
    attempts: outcome.attempts.map(redactAttempt),
  };
}

export function redactRouteEvent(value: RouteEvent): RouteEvent {
  switch (value.type) {
    case "route.requested":
      return {
        ...value,
        task: { ...value.task, goalSummary: redactGoal(value.task.goalSummary) },
      };
    case "route.decided":
      return { ...value, decision: redactDecision(value.decision) };
    case "attempt.started":
    case "attempt.finished":
      return { ...value, attempt: redactAttempt(value.attempt) };
    case "route.finished":
      return { ...value, outcome: redactOutcome(value.outcome) };
  }
}

export function redactFeedback(value: FeedbackRecord): FeedbackRecord {
  return {
    ...value,
    ...(value.summary ? { summary: redactText(value.summary, 500) } : {}),
  };
}
