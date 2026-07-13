import { randomUUID } from "node:crypto";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import type { RouteEvent, RouteEventSink } from "../contracts/events.js";
import type { ExecutorRunResult } from "../contracts/executor.js";
import {
  type ExecutionTarget,
  type FailureClass,
  RETRYABLE_FAILURE_CLASSES,
  type RouteAttempt,
  type RouteOutcome,
  type UsageSnapshot,
} from "../contracts/routing.js";
import type { TaskContract } from "../contracts/task.js";
import type { HealthState } from "../health/schema.js";
import { type HealthPolicy, recordAttemptHealth } from "../health/store.js";
import type { CandidateSnapshot } from "../routing/filter.js";
import type { RouteJudge } from "../routing/judge.js";
import { planRoute, type RoutePlanningResult } from "../routing/router.js";
import {
  createLinkedDeadline,
  ExecutionAbortedError,
  ExecutionDeadlineError,
  runWithDeadline,
} from "./deadline.js";
import type { OutputContractRegistry } from "./output.js";
import type { ExecutorRegistry } from "./registry.js";

const RETRYABLE_FAILURE_SET: ReadonlySet<FailureClass> = new Set(RETRYABLE_FAILURE_CLASSES);

export interface RoutedExecutionResult<TResult = unknown> {
  planning: RoutePlanningResult;
  outcome: RouteOutcome<TResult>;
  healthState?: HealthState;
  diagnostics: RouterDiagnostic[];
  eventErrors: string[];
}

export interface RoutedExecutionOptions<TPayload = unknown> {
  task: TaskContract;
  snapshots: CandidateSnapshot[];
  judges: RouteJudge[];
  executors: ExecutorRegistry;
  outputContracts: OutputContractRegistry;
  createPayload(
    target: ExecutionTarget,
    attemptNumber: number,
    signal: AbortSignal,
  ): Promise<TPayload> | TPayload;
  healthState?: HealthState;
  healthPolicy?: HealthPolicy;
  eventSink?: RouteEventSink;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  now?: () => Date;
}

export class RouteOrchestrationError extends Error {
  constructor(
    readonly failureClass: FailureClass,
    message: string,
  ) {
    super(message);
    this.name = "RouteOrchestrationError";
  }
}

type RouteEventPayload<T = RouteEvent> = T extends RouteEvent
  ? Omit<T, "contractVersion" | "eventId" | "routeId" | "taskId" | "timestamp">
  : never;

function event(
  routeId: string,
  taskId: string,
  timestamp: string,
  value: RouteEventPayload,
): RouteEvent {
  return {
    contractVersion: 1,
    eventId: randomUUID(),
    routeId,
    taskId,
    timestamp,
    ...value,
  } as RouteEvent;
}

function elapsed(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

function aggregateUsage(attempts: RouteAttempt[]): UsageSnapshot | undefined {
  let found = false;
  const total: Required<UsageSnapshot> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
  for (const attempt of attempts) {
    if (!attempt.usage) continue;
    found = true;
    total.inputTokens += attempt.usage.inputTokens ?? 0;
    total.outputTokens += attempt.usage.outputTokens ?? 0;
    total.cacheReadTokens += attempt.usage.cacheReadTokens ?? 0;
    total.cacheWriteTokens += attempt.usage.cacheWriteTokens ?? 0;
    total.cost += attempt.usage.cost ?? 0;
  }
  return found ? total : undefined;
}

function classifyThrown(error: unknown, signal: AbortSignal): FailureClass {
  const reason = signal.reason;
  if (reason instanceof ExecutionDeadlineError || error instanceof ExecutionDeadlineError)
    return "timeout";
  if (signal.aborted || error instanceof ExecutionAbortedError) return "aborted";
  return "unknown";
}

function protectSideEffects(task: TaskContract, failureClass: FailureClass): FailureClass {
  if (
    task.requirements.sideEffectClass !== "write" &&
    task.requirements.sideEffectClass !== "external"
  ) {
    return failureClass;
  }
  if (
    failureClass === "timeout" ||
    failureClass === "provider-transport" ||
    failureClass === "output-contract" ||
    failureClass === "unknown"
  ) {
    return "unknown-side-effect";
  }
  return failureClass;
}

function shouldRetry(failureClass: FailureClass, overallSignal: AbortSignal): boolean {
  return !overallSignal.aborted && RETRYABLE_FAILURE_SET.has(failureClass);
}

async function safeEmit(
  sink: RouteEventSink | undefined,
  value: RouteEvent,
  errors: string[],
): Promise<void> {
  if (!sink) return;
  try {
    await sink.emit(value);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

function finalizeAttempt(
  attempt: RouteAttempt,
  finishedAt: Date,
  result: ExecutorRunResult,
  task: TaskContract,
): RouteAttempt {
  const rawFailure = result.ok ? undefined : (result.failureClass ?? "unknown");
  const failureClass = rawFailure ? protectSideEffects(task, rawFailure) : undefined;
  return {
    ...attempt,
    finishedAt: finishedAt.toISOString(),
    elapsedMs: elapsed(new Date(attempt.startedAt), finishedAt),
    ...(failureClass ? { failureClass } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

type Clock = () => Date;

interface AttemptCompletion<TResult> {
  attempt: RouteAttempt;
  succeeded: boolean;
  result?: TResult;
}

interface TerminalState {
  failure?: FailureClass;
  message?: string;
}

async function planWithinDeadline<TPayload>(
  options: RoutedExecutionOptions<TPayload>,
  overallSignal: AbortSignal,
  now: Clock,
): Promise<RoutePlanningResult> {
  const routeDeadline = createLinkedDeadline(
    overallSignal,
    options.task.budget.routeTimeoutMs,
    "route",
  );
  try {
    return await runWithDeadline(
      (signal) =>
        planRoute({
          task: options.task,
          snapshots: options.snapshots,
          judges: options.judges,
          signal,
          now: now(),
        }),
      routeDeadline,
    );
  } catch (error) {
    throw new RouteOrchestrationError(
      classifyThrown(error, routeDeadline.signal),
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    routeDeadline.dispose();
  }
}

async function emitRoutePrelude(
  sink: RouteEventSink | undefined,
  planning: RoutePlanningResult,
  task: TaskContract,
  now: Clock,
  errors: string[],
): Promise<void> {
  const { routeId } = planning.decision;
  await safeEmit(
    sink,
    event(routeId, task.taskId, now().toISOString(), { type: "route.requested", task }),
    errors,
  );
  await safeEmit(
    sink,
    event(routeId, task.taskId, now().toISOString(), {
      type: "route.decided",
      decision: planning.decision,
    }),
    errors,
  );
}

async function invokeExecutor<TPayload>(
  options: RoutedExecutionOptions<TPayload>,
  target: ExecutionTarget,
  attemptNumber: number,
  signal: AbortSignal,
): Promise<ExecutorRunResult> {
  const adapter = options.executors.get(target.executorId);
  if (!adapter) {
    return {
      ok: false,
      failureClass: "executor-unavailable",
      errorMessage: `Executor '${target.executorId}' is not registered.`,
    };
  }
  const payload = await options.createPayload(target, attemptNumber, signal);
  return await adapter.execute({
    task: options.task,
    target,
    payload,
    signal,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

function validateExecution<TResult>(
  options: RoutedExecutionOptions,
  execution: ExecutorRunResult,
): { execution: ExecutorRunResult; succeeded: boolean; result?: TResult } {
  if (!execution.ok) return { execution, succeeded: false };
  const validated = options.outputContracts.validate(options.task, execution.result);
  if (!validated.ok) {
    return {
      execution: {
        ...execution,
        ok: false,
        failureClass: "output-contract",
        errorMessage: validated.message ?? "Output contract failed.",
      },
      succeeded: false,
    };
  }
  const result = (validated.value === undefined ? execution.result : validated.value) as TResult;
  return { execution, succeeded: true, ...(result === undefined ? {} : { result }) };
}

async function runAttempt<TResult, TPayload>(options: {
  execution: RoutedExecutionOptions<TPayload>;
  attempt: RouteAttempt;
  attemptNumber: number;
  timeoutMs: number;
  overallSignal: AbortSignal;
  now: Clock;
}): Promise<AttemptCompletion<TResult>> {
  const deadline = createLinkedDeadline(options.overallSignal, options.timeoutMs, "attempt");
  let execution: ExecutorRunResult;
  try {
    execution = await runWithDeadline(
      (signal) =>
        invokeExecutor(options.execution, options.attempt.target, options.attemptNumber, signal),
      deadline,
    );
  } catch (error) {
    execution = {
      ok: false,
      failureClass: classifyThrown(error, deadline.signal),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deadline.dispose();
  }
  const validated = validateExecution<TResult>(options.execution, execution);
  return {
    attempt: finalizeAttempt(
      options.attempt,
      options.now(),
      validated.execution,
      options.execution.task,
    ),
    succeeded: validated.succeeded,
    ...(validated.result === undefined ? {} : { result: validated.result }),
  };
}

function stoppedByOverall(signal: AbortSignal): TerminalState | undefined {
  if (!signal.aborted) return undefined;
  return {
    failure: signal.reason instanceof ExecutionDeadlineError ? "timeout" : "aborted",
    message: signal.reason instanceof Error ? signal.reason.message : "Overall execution stopped.",
  };
}

function buildOutcome<TResult>(options: {
  planning: RoutePlanningResult;
  task: TaskContract;
  attempts: RouteAttempt[];
  selectedTarget?: ExecutionTarget;
  selectedResult?: TResult;
  terminal: TerminalState;
  finishedAt: string;
}): RouteOutcome<TResult> {
  const usage = aggregateUsage(options.attempts);
  return {
    contractVersion: 1,
    routeId: options.planning.decision.routeId,
    taskId: options.task.taskId,
    decision: options.planning.decision,
    attempts: options.attempts,
    success: options.selectedTarget !== undefined,
    ...(options.selectedTarget ? { selectedTarget: options.selectedTarget } : {}),
    ...(options.selectedTarget && options.selectedResult !== undefined
      ? { result: options.selectedResult }
      : {}),
    ...(!options.selectedTarget && options.terminal.failure
      ? { terminalFailure: options.terminal.failure }
      : {}),
    ...(!options.selectedTarget && options.terminal.message
      ? { terminalMessage: options.terminal.message }
      : {}),
    ...(usage ? { usage } : {}),
    finishedAt: options.finishedAt,
  };
}

export async function executeRoutedTask<TResult = unknown, TPayload = unknown>(
  options: RoutedExecutionOptions<TPayload>,
): Promise<RoutedExecutionResult<TResult>> {
  options.outputContracts.assertTaskContract(options.task);
  const now = options.now ?? (() => new Date());
  const eventErrors: string[] = [];
  const overall = createLinkedDeadline(
    options.signal,
    options.task.budget.overallTimeoutMs,
    "overall",
  );

  try {
    const planning = await planWithinDeadline(options, overall.signal, now);
    await emitRoutePrelude(options.eventSink, planning, options.task, now, eventErrors);
    const attempts: RouteAttempt[] = [];
    const candidateTimeouts = new Map(
      options.snapshots.map((snapshot) => [snapshot.config.id, snapshot.config.attemptTimeoutMs]),
    );
    const maxAttempts = Math.min(options.task.budget.maxAttempts, planning.decision.ranked.length);
    let healthState = options.healthState;
    let selectedTarget: ExecutionTarget | undefined;
    let selectedResult: TResult | undefined;
    let terminal: TerminalState = {};

    for (let index = 0; index < maxAttempts; index += 1) {
      const ranking = planning.decision.ranked[index];
      if (!ranking) break;
      const stopped = stoppedByOverall(overall.signal);
      if (stopped) {
        terminal = stopped;
        break;
      }

      const startedAt = now();
      const attempt: RouteAttempt = {
        attemptId: randomUUID(),
        routeId: planning.decision.routeId,
        taskId: options.task.taskId,
        target: ranking.target,
        startedAt: startedAt.toISOString(),
      };
      await safeEmit(
        options.eventSink,
        event(attempt.routeId, attempt.taskId, attempt.startedAt, {
          type: "attempt.started",
          attempt,
        }),
        eventErrors,
      );

      const configuredTimeout = candidateTimeouts.get(ranking.target.candidateId);
      const completion = await runAttempt<TResult, TPayload>({
        execution: options,
        attempt,
        attemptNumber: index + 1,
        timeoutMs: configuredTimeout
          ? Math.min(configuredTimeout, options.task.budget.attemptTimeoutMs)
          : options.task.budget.attemptTimeoutMs,
        overallSignal: overall.signal,
        now,
      });
      attempts.push(completion.attempt);
      if (healthState && options.healthPolicy) {
        healthState = recordAttemptHealth(
          healthState,
          completion.attempt,
          options.healthPolicy,
          now(),
        );
      }
      await safeEmit(
        options.eventSink,
        event(attempt.routeId, attempt.taskId, now().toISOString(), {
          type: "attempt.finished",
          attempt: completion.attempt,
        }),
        eventErrors,
      );

      if (completion.succeeded) {
        selectedTarget = ranking.target;
        selectedResult = completion.result;
        break;
      }
      terminal = {
        failure: completion.attempt.failureClass ?? "unknown",
        ...(completion.attempt.errorMessage ? { message: completion.attempt.errorMessage } : {}),
      };
      if (!shouldRetry(terminal.failure as FailureClass, overall.signal)) break;
    }

    const outcome = buildOutcome<TResult>({
      planning,
      task: options.task,
      attempts,
      ...(selectedTarget ? { selectedTarget } : {}),
      ...(selectedResult === undefined ? {} : { selectedResult }),
      terminal,
      finishedAt: now().toISOString(),
    });
    await safeEmit(
      options.eventSink,
      event(outcome.routeId, outcome.taskId, outcome.finishedAt, {
        type: "route.finished",
        outcome,
      }),
      eventErrors,
    );
    return {
      planning,
      outcome,
      ...(healthState ? { healthState } : {}),
      diagnostics: planning.rejections.map((rejection) => ({
        severity: "info",
        code: rejection.code,
        message: rejection.message,
      })),
      eventErrors,
    };
  } finally {
    overall.dispose();
  }
}
