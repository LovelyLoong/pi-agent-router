import type { SupervisorClock } from "../../src/supervisor/index.js";

interface FakeTimerHandle {
  id: number;
}

interface FakeTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

export class FakeSupervisorClock implements SupervisorClock {
  readonly #timers = new Map<number, FakeTimer>();
  #now: number;
  #nextId = 0;

  constructor(now: number) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  setTimer(callback: () => void, delayMs: number): FakeTimerHandle {
    const id = ++this.#nextId;
    this.#timers.set(id, { id, dueAt: this.#now + Math.max(0, delayMs), callback });
    return { id };
  }

  clearTimer(handle: unknown): void {
    if (!handle || typeof handle !== "object" || !("id" in handle)) return;
    this.#timers.delete((handle as FakeTimerHandle).id);
  }

  advanceBy(milliseconds: number): void {
    const target = this.#now + milliseconds;
    let callbacks = 0;
    while (true) {
      const next = [...this.#timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      this.#timers.delete(next.id);
      this.#now = next.dueAt;
      next.callback();
      callbacks += 1;
      if (callbacks > 10_000) throw new Error("Fake clock timer loop exceeded safety bound.");
    }
    this.#now = target;
  }

  pendingTimerCount(): number {
    return this.#timers.size;
  }
}
