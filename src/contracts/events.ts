import type { RouteAttempt, RouteDecision, RouteOutcome } from "./routing.js";
import type { TaskContract } from "./task.js";

export const ROUTE_EVENT_VERSION = 1 as const;

export interface RouteEventBase {
  contractVersion: typeof ROUTE_EVENT_VERSION;
  eventId: string;
  routeId: string;
  taskId: string;
  timestamp: string;
}

export type RouteEvent =
  | (RouteEventBase & { type: "route.requested"; task: TaskContract })
  | (RouteEventBase & { type: "route.decided"; decision: RouteDecision })
  | (RouteEventBase & { type: "attempt.started"; attempt: RouteAttempt })
  | (RouteEventBase & { type: "attempt.finished"; attempt: RouteAttempt })
  | (RouteEventBase & { type: "route.finished"; outcome: RouteOutcome });

export interface FeedbackRecord {
  contractVersion: typeof ROUTE_EVENT_VERSION;
  feedbackId: string;
  routeId: string;
  taskId: string;
  evaluatorId: string;
  dimensions: Record<string, number>;
  summary?: string;
  recordedAt: string;
}

export interface RouteEventSink {
  emit(event: RouteEvent): Promise<void> | void;
  recordFeedback?(feedback: FeedbackRecord): Promise<void> | void;
}
