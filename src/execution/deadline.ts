export class ExecutionDeadlineError extends Error {
  constructor(
    readonly scope: "route" | "attempt" | "overall",
    readonly timeoutMs: number,
  ) {
    super(`${scope} deadline exceeded after ${timeoutMs}ms.`);
    this.name = "ExecutionDeadlineError";
  }
}

export class ExecutionAbortedError extends Error {
  constructor(message = "Execution was aborted by the caller.") {
    super(message);
    this.name = "ExecutionAbortedError";
  }
}

export interface LinkedDeadline {
  signal: AbortSignal;
  dispose(): void;
}

export function createLinkedDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  scope: ExecutionDeadlineError["scope"],
): LinkedDeadline {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason ?? new ExecutionAbortedError());
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new ExecutionDeadlineError(scope, timeoutMs)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function runWithDeadline<TResult>(
  operation: (signal: AbortSignal) => Promise<TResult>,
  linked: LinkedDeadline,
): Promise<TResult> {
  if (linked.signal.aborted) throw linked.signal.reason ?? new ExecutionAbortedError();
  return await new Promise<TResult>((resolve, reject) => {
    const abort = () => reject(linked.signal.reason ?? new ExecutionAbortedError());
    linked.signal.addEventListener("abort", abort, { once: true });
    operation(linked.signal)
      .then(resolve, reject)
      .finally(() => {
        linked.signal.removeEventListener("abort", abort);
      });
  });
}
