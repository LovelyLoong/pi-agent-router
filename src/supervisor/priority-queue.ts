import type { AgentJobPriority } from "../contracts/jobs.js";

interface QueueEntry {
  jobId: string;
  priority: AgentJobPriority;
  sequence: number;
}

export class StablePriorityQueue {
  readonly #entries = new Map<string, QueueEntry>();
  readonly #priorityRanks: ReadonlyMap<AgentJobPriority, number>;

  constructor(priorityOrder: readonly AgentJobPriority[]) {
    this.#priorityRanks = new Map(priorityOrder.map((priority, index) => [priority, index]));
  }

  get size(): number {
    return this.#entries.size;
  }

  enqueue(jobId: string, priority: AgentJobPriority, sequence: number): void {
    if (this.#entries.has(jobId)) throw new Error(`Job '${jobId}' is already queued.`);
    this.#entries.set(jobId, { jobId, priority, sequence });
  }

  remove(jobId: string): boolean {
    if (!this.#entries.has(jobId)) return false;
    this.#entries.delete(jobId);
    return true;
  }

  orderedJobIds(): string[] {
    return this.#orderedEntries().map((entry) => entry.jobId);
  }

  takeFirst(predicate: (jobId: string) => boolean): string | undefined {
    const entry = this.#orderedEntries().find((candidate) => predicate(candidate.jobId));
    if (!entry) return undefined;
    this.#entries.delete(entry.jobId);
    return entry.jobId;
  }

  clear(): void {
    this.#entries.clear();
  }

  #orderedEntries(): QueueEntry[] {
    return [...this.#entries.values()].sort((left, right) => {
      const priorityDifference =
        (this.#priorityRanks.get(left.priority) ?? Number.MAX_SAFE_INTEGER) -
        (this.#priorityRanks.get(right.priority) ?? Number.MAX_SAFE_INTEGER);
      return priorityDifference || left.sequence - right.sequence;
    });
  }
}
