import type { AgentJobEventV2, AgentJobResultV2 } from "../contracts/jobs.js";
import type { AgentJobStreamV2, AgentRouterJobInspectionV2 } from "./contracts.js";

interface EventWaiter<TResult> {
  resolve(value: IteratorResult<AgentJobEventV2<TResult>>): void;
  reject(error: unknown): void;
}

export class ManagedAgentJobStream<TResult = unknown> implements AgentJobStreamV2<TResult> {
  readonly jobId: string;
  readonly #events: AgentJobEventV2<TResult>[] = [];
  readonly #waiters: EventWaiter<TResult>[] = [];
  readonly #resultPromise: Promise<AgentJobResultV2<TResult>>;
  readonly #resolveResult: (value: AgentJobResultV2<TResult>) => void;
  readonly #rejectResult: (error: unknown) => void;
  readonly #cancelJob: () => Promise<void>;
  readonly #inspectJob: () => Promise<AgentRouterJobInspectionV2 | undefined>;
  #finished = false;
  #failure: unknown;

  constructor(options: {
    jobId: string;
    cancelJob: () => Promise<void>;
    inspectJob: () => Promise<AgentRouterJobInspectionV2 | undefined>;
  }) {
    this.jobId = options.jobId;
    this.#cancelJob = options.cancelJob;
    this.#inspectJob = options.inspectJob;
    let resolveResult!: (value: AgentJobResultV2<TResult>) => void;
    let rejectResult!: (error: unknown) => void;
    this.#resultPromise = new Promise<AgentJobResultV2<TResult>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#resultPromise.catch(() => undefined);
    this.#resolveResult = resolveResult;
    this.#rejectResult = rejectResult;
  }

  result(): Promise<AgentJobResultV2<TResult>> {
    return this.#resultPromise;
  }

  async cancel(_reason?: string): Promise<void> {
    await this.#cancelJob();
  }

  inspect(): Promise<AgentRouterJobInspectionV2 | undefined> {
    return this.#inspectJob();
  }

  emit(event: AgentJobEventV2<TResult>): void {
    if (this.#finished) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.#events.push(event);
  }

  finish(result: AgentJobResultV2<TResult>): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#resolveResult(result);
    this.#flushFinishedWaiters();
  }

  fail(error: unknown): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#failure = error;
    this.#rejectResult(error);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentJobEventV2<TResult>> {
    return {
      next: () => this.#nextEvent(),
      return: async () => {
        await this.cancel("stream-closed");
        return { done: true, value: undefined };
      },
    };
  }

  #nextEvent(): Promise<IteratorResult<AgentJobEventV2<TResult>>> {
    const event = this.#events.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#finished) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #flushFinishedWaiters(): void {
    if (this.#events.length > 0) return;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}
