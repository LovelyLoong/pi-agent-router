import type { ExecutionTarget, FailureClass, UsageSnapshot } from "./routing.js";
import type { TaskContract } from "./task.js";

export const EXECUTOR_ADAPTER_VERSION = 1 as const;

export interface ExecutorCapabilities {
  adapterVersion: typeof EXECUTOR_ADAPTER_VERSION;
  executorId: string;
  executorType: string;
  capabilities: string[];
  supportsActiveProbe: boolean;
}

export interface ExecutorAvailability {
  available: boolean;
  reason?: string;
  checkedAt: string;
}

export interface ExecutorProbeResult extends ExecutorAvailability {
  elapsedMs: number;
  failureClass?: FailureClass;
}

export interface ExecutorRunRequest<TPayload = unknown> {
  task: TaskContract;
  target: ExecutionTarget;
  payload: TPayload;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ExecutorRunResult<TResult = unknown> {
  ok: boolean;
  result?: TResult;
  failureClass?: FailureClass;
  errorMessage?: string;
  usage?: UsageSnapshot;
}

export interface ExecutorAdapter<TPayload = unknown, TResult = unknown> {
  readonly capabilities: ExecutorCapabilities;
  checkAvailability(target: ExecutionTarget): Promise<ExecutorAvailability>;
  probe?(target: ExecutionTarget, signal?: AbortSignal): Promise<ExecutorProbeResult>;
  execute(request: ExecutorRunRequest<TPayload>): Promise<ExecutorRunResult<TResult>>;
}
