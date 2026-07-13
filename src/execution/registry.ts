import type {
  ExecutorAdapter,
  ExecutorAvailability,
  ExecutorRunRequest,
  ExecutorRunResult,
} from "../contracts/executor.js";
import type { ExecutionTarget } from "../contracts/routing.js";

export interface RegisteredExecutorAdapter {
  capabilities: ExecutorAdapter["capabilities"];
  checkAvailability(target: ExecutionTarget): Promise<ExecutorAvailability>;
  probe?: ExecutorAdapter["probe"];
  execute(request: ExecutorRunRequest<unknown>): Promise<ExecutorRunResult<unknown>>;
}

export class ExecutorRegistry {
  readonly #adapters = new Map<string, RegisteredExecutorAdapter>();

  register<TPayload, TResult>(adapter: ExecutorAdapter<TPayload, TResult>): void {
    const id = adapter.capabilities.executorId;
    if (this.#adapters.has(id)) throw new Error(`Executor '${id}' is already registered.`);
    this.#adapters.set(id, adapter as unknown as RegisteredExecutorAdapter);
  }

  get(executorId: string): RegisteredExecutorAdapter | undefined {
    const normalizedId = executorId.trim();
    if (!normalizedId) return undefined;
    return this.#adapters.get(normalizedId);
  }

  list(): ExecutorAdapter["capabilities"][] {
    return [...this.#adapters.values()]
      .map((adapter) => adapter.capabilities)
      .sort((left, right) => left.executorId.localeCompare(right.executorId));
  }
}
