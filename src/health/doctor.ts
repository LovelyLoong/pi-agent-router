import type { FailureClass } from "../contracts/routing.js";
import type { CandidateSnapshot } from "../routing/filter.js";
import type { HealthState } from "./schema.js";
import { type HealthPolicy, recordHealthFailure, recordHealthSuccess } from "./store.js";

export type DoctorMode = "static" | "active";

export interface DoctorProbeResult {
  ok: boolean;
  latencyMs: number;
  failureClass?: FailureClass;
  message?: string;
}

export interface DoctorProbe {
  candidateId: string;
  run(signal: AbortSignal): Promise<DoctorProbeResult>;
}

export interface DoctorCandidateResult {
  candidateId: string;
  staticStatus: "passed" | "failed" | "skipped";
  staticMessages: string[];
  activeStatus: "not-requested" | "passed" | "failed" | "skipped";
  activeMessage?: string;
  latencyMs?: number;
}

export interface DoctorReport {
  mode: DoctorMode;
  startedAt: string;
  completedAt: string;
  results: DoctorCandidateResult[];
  healthState: HealthState;
}

function staticCheck(snapshot: CandidateSnapshot): string[] {
  const messages: string[] = [];
  const { config, model } = snapshot;
  if (!config.enabled) return ["Candidate is disabled."];
  if (!snapshot.executorAvailable) {
    messages.push(snapshot.executorReason ?? `Executor '${config.executorId}' is unavailable.`);
  }
  if (!model.available) {
    messages.push(model.reason ?? `Model '${config.model}' is unavailable.`);
  }
  if (model.contextWindow < config.minimumContextWindow) {
    messages.push(`Model context ${model.contextWindow} is below ${config.minimumContextWindow}.`);
  }
  const supportedLevels = new Set(model.supportedThinkingLevels);
  if (!config.allowedThinkingLevels.some((level) => supportedLevels.has(level))) {
    messages.push("No configured thinking level is supported by the model.");
  }
  const supportedModalities = new Set(model.inputModalities);
  const missingModalities = config.inputModalities.filter((item) => !supportedModalities.has(item));
  if (missingModalities.length > 0) {
    messages.push(`Model lacks configured modalities: ${missingModalities.join(", ")}.`);
  }
  return messages;
}

class DoctorTimeoutError extends Error {
  constructor(
    readonly scope: "probe" | "overall",
    timeoutMs: number,
  ) {
    super(`Doctor ${scope} timed out after ${timeoutMs}ms.`);
    this.name = "DoctorTimeoutError";
  }
}

async function withProbeTimeout(
  probe: DoctorProbe,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<DoctorProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const abortFromOuter = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) abortFromOuter();
  else outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DoctorTimeoutError("probe", timeoutMs)),
    timeoutMs,
  );
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<DoctorProbeResult>((resolve) => {
    const onAbort = () => {
      const reason = controller.signal.reason;
      resolve({
        ok: false,
        latencyMs: Math.max(0, Date.now() - startedAt),
        failureClass: reason instanceof DoctorTimeoutError ? "timeout" : "aborted",
        message: reason instanceof Error ? reason.message : "Doctor probe aborted.",
      });
    };
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([probe.run(controller.signal), aborted]);
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.max(0, Date.now() - startedAt),
      failureClass: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    outerSignal?.removeEventListener("abort", abortFromOuter);
  }
}

async function runBounded<T>(
  values: T[],
  concurrency: number,
  signal: AbortSignal,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length && !signal.aborted) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) await run(value);
    }
  });
  await Promise.all(workers);
}

export interface DoctorRunOptions {
  mode: DoctorMode;
  snapshots: CandidateSnapshot[];
  probes?: DoctorProbe[];
  healthState: HealthState;
  healthPolicy: HealthPolicy;
  probeTimeoutMs: number;
  overallTimeoutMs: number;
  maxConcurrency: number;
  signal?: AbortSignal;
  now?: () => Date;
}

interface DoctorDeadline {
  signal: AbortSignal;
  dispose(): void;
}

function createDoctorDeadline(signal: AbortSignal | undefined, timeoutMs: number): DoctorDeadline {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DoctorTimeoutError("overall", timeoutMs)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function initialDoctorResults(options: DoctorRunOptions): DoctorCandidateResult[] {
  return options.snapshots.map((snapshot): DoctorCandidateResult => {
    const messages = staticCheck(snapshot);
    const disabled = !snapshot.config.enabled;
    return {
      candidateId: snapshot.config.id,
      staticStatus: disabled ? "skipped" : messages.length === 0 ? "passed" : "failed",
      staticMessages: messages,
      activeStatus: options.mode === "active" ? "skipped" : "not-requested",
    };
  });
}

function applyProbeHealth(
  state: HealthState,
  candidateId: string,
  probe: DoctorProbeResult,
  policy: HealthPolicy,
  observedAt: Date,
): HealthState {
  return probe.ok
    ? recordHealthSuccess(state, candidateId, policy, observedAt, probe.latencyMs)
    : recordHealthFailure(
        state,
        candidateId,
        probe.failureClass ?? "unknown",
        policy,
        observedAt,
        probe.message,
      );
}

function updateDoctorResult(result: DoctorCandidateResult, probe: DoctorProbeResult): void {
  result.activeStatus = probe.ok ? "passed" : "failed";
  result.latencyMs = probe.latencyMs;
  if (probe.message) result.activeMessage = probe.message;
}

function markSkippedResults(results: DoctorCandidateResult[], signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason =
    signal.reason instanceof Error ? signal.reason.message : "Doctor active checks aborted.";
  for (const result of results) {
    if (result.activeStatus === "skipped") result.activeMessage = reason;
  }
}

async function runActiveDoctor(
  options: DoctorRunOptions,
  results: DoctorCandidateResult[],
  probes: Map<string, DoctorProbe>,
  now: () => Date,
): Promise<HealthState> {
  const deadline = createDoctorDeadline(options.signal, options.overallTimeoutMs);
  const eligible = results.filter(
    (result) => result.staticStatus === "passed" && probes.has(result.candidateId),
  );
  let healthState = options.healthState;
  try {
    await runBounded(
      eligible,
      Math.max(1, options.maxConcurrency),
      deadline.signal,
      async (result) => {
        const probe = probes.get(result.candidateId);
        if (!probe) return;
        const probeResult = await withProbeTimeout(probe, options.probeTimeoutMs, deadline.signal);
        updateDoctorResult(result, probeResult);
        healthState = applyProbeHealth(
          healthState,
          result.candidateId,
          probeResult,
          options.healthPolicy,
          now(),
        );
      },
    );
    markSkippedResults(eligible, deadline.signal);
    return healthState;
  } finally {
    deadline.dispose();
  }
}

export async function runDoctor(options: DoctorRunOptions): Promise<DoctorReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const probes = new Map((options.probes ?? []).map((probe) => [probe.candidateId, probe]));
  const results = initialDoctorResults(options);
  const healthState =
    options.mode === "active"
      ? await runActiveDoctor(options, results, probes, now)
      : options.healthState;
  return {
    mode: options.mode,
    startedAt: startedAt.toISOString(),
    completedAt: now().toISOString(),
    results,
    healthState,
  };
}
