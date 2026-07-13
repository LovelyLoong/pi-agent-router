import type { SupervisorClock } from "./contracts.js";

interface SystemTimerHandle {
  timer: ReturnType<typeof setTimeout>;
}

export class SystemSupervisorClock implements SupervisorClock {
  readonly now = Date.now;

  setTimer(callback: () => void, delayMs: number): SystemTimerHandle {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref?.();
    return { timer };
  }

  clearTimer(handle: unknown): void {
    if (!handle || typeof handle !== "object" || !("timer" in handle)) return;
    clearTimeout((handle as SystemTimerHandle).timer);
  }
}
