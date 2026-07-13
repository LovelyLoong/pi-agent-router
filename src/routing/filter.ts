import type { CandidateConfig } from "../config/schema.js";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import type { InputModality, TaskContract, ThinkingLevel } from "../contracts/task.js";

export const HEALTH_STATUSES = [
  "unknown",
  "healthy",
  "degraded",
  "cooldown",
  "unavailable",
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface ModelRuntimeSnapshot {
  available: boolean;
  reason?: string;
  contextWindow: number;
  inputModalities: InputModality[];
  reasoning: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface CandidateHealthSnapshot {
  status: HealthStatus;
  checkedAt?: string;
  cooldownUntil?: string;
  reason?: string;
}

export interface CandidateSnapshot {
  config: CandidateConfig;
  executorAvailable: boolean;
  executorReason?: string;
  model: ModelRuntimeSnapshot;
  health: CandidateHealthSnapshot;
}

export interface RoutableCandidate {
  candidate: CandidateConfig;
  model: ModelRuntimeSnapshot;
  health: CandidateHealthSnapshot;
  thinkingLevels: ThinkingLevel[];
}

export interface CandidateRejection {
  candidateId: string;
  code: string;
  message: string;
}

export interface FilterResult {
  candidates: RoutableCandidate[];
  rejections: CandidateRejection[];
  diagnostics: RouterDiagnostic[];
}

function missing(required: string[], actual: string[]): string[] {
  const values = new Set(actual);
  return required.filter((value) => !values.has(value));
}

function reject(snapshot: CandidateSnapshot, code: string, message: string): CandidateRejection {
  return { candidateId: snapshot.config.id, code, message };
}

function availabilityRejection(
  snapshot: CandidateSnapshot,
  now: Date,
): CandidateRejection | undefined {
  const { config, model, health } = snapshot;
  if (!config.enabled) {
    return reject(snapshot, "candidate-disabled", `Candidate '${config.id}' is disabled.`);
  }
  if (!snapshot.executorAvailable) {
    return reject(
      snapshot,
      "executor-unavailable",
      snapshot.executorReason ?? `Executor '${config.executorId}' is unavailable.`,
    );
  }
  if (!model.available) {
    return reject(
      snapshot,
      "model-unavailable",
      model.reason ?? `Model '${config.model}' is unavailable.`,
    );
  }
  if (health.status === "unavailable") {
    return reject(
      snapshot,
      "health-unavailable",
      health.reason ?? `Candidate '${config.id}' is unavailable.`,
    );
  }
  const cooldownUntil = health.cooldownUntil ? Date.parse(health.cooldownUntil) : Number.NaN;
  if (health.status === "cooldown" && cooldownUntil > now.getTime()) {
    return reject(
      snapshot,
      "health-cooldown",
      health.reason ?? `Candidate '${config.id}' is cooling down until ${health.cooldownUntil}.`,
    );
  }
  return undefined;
}

function capabilityRejection(
  task: TaskContract,
  snapshot: CandidateSnapshot,
): CandidateRejection | undefined {
  const { config } = snapshot;
  const missingCapabilities = missing(task.requirements.requiredCapabilities, config.capabilities);
  if (missingCapabilities.length > 0) {
    return reject(
      snapshot,
      "capability-missing",
      `Candidate '${config.id}' lacks capabilities: ${missingCapabilities.join(", ")}.`,
    );
  }
  if (
    task.requirements.output.kind !== "text" &&
    !config.capabilities.includes("structured-output")
  ) {
    return reject(
      snapshot,
      "output-contract-incompatible",
      `Candidate '${config.id}' does not declare structured-output capability.`,
    );
  }
  const disallowedTools = missing(task.requirements.allowedTools, config.allowedTools);
  return disallowedTools.length > 0
    ? reject(
        snapshot,
        "tool-policy-mismatch",
        `Candidate '${config.id}' does not allow tools: ${disallowedTools.join(", ")}.`,
      )
    : undefined;
}

function modelRequirementRejection(
  task: TaskContract,
  snapshot: CandidateSnapshot,
): CandidateRejection | undefined {
  const { config, model } = snapshot;
  const unsupportedModalities = missing(task.requirements.inputModalities, model.inputModalities);
  const configModalities = missing(task.requirements.inputModalities, config.inputModalities);
  const modalityFailures = [...new Set([...unsupportedModalities, ...configModalities])];
  if (modalityFailures.length > 0) {
    return reject(
      snapshot,
      "input-modality-mismatch",
      `Candidate '${config.id}' does not support input modalities: ${modalityFailures.join(", ")}.`,
    );
  }
  const minimumContext = Math.max(
    task.requirements.minimumContextWindow,
    config.minimumContextWindow,
  );
  if (model.contextWindow < minimumContext) {
    return reject(
      snapshot,
      "context-window-insufficient",
      `Candidate '${config.id}' context ${model.contextWindow} is below ${minimumContext}.`,
    );
  }
  return task.requirements.requiresReasoning && !model.reasoning
    ? reject(snapshot, "reasoning-required", `Candidate '${config.id}' does not support reasoning.`)
    : undefined;
}

function policyRejection(
  task: TaskContract,
  snapshot: CandidateSnapshot,
): CandidateRejection | undefined {
  const { config } = snapshot;
  if (!config.allowedSideEffects.includes(task.requirements.sideEffectClass)) {
    return reject(
      snapshot,
      "side-effect-policy-mismatch",
      `Candidate '${config.id}' does not allow '${task.requirements.sideEffectClass}' tasks.`,
    );
  }
  return !config.allowedDataSensitivity.includes(task.requirements.dataSensitivity)
    ? reject(
        snapshot,
        "data-policy-mismatch",
        `Candidate '${config.id}' does not allow '${task.requirements.dataSensitivity}' data.`,
      )
    : undefined;
}

function compatibleThinkingLevels(
  task: TaskContract,
  snapshot: CandidateSnapshot,
): ThinkingLevel[] {
  const supported = new Set(snapshot.model.supportedThinkingLevels);
  return snapshot.config.allowedThinkingLevels.filter(
    (level) => supported.has(level) && (!task.requirements.requiresReasoning || level !== "off"),
  );
}

export function filterCandidates(
  task: TaskContract,
  snapshots: CandidateSnapshot[],
  now = new Date(),
): FilterResult {
  const candidates: RoutableCandidate[] = [];
  const rejections: CandidateRejection[] = [];
  const seen = new Set<string>();

  for (const snapshot of snapshots) {
    if (seen.has(snapshot.config.id)) {
      rejections.push(
        reject(snapshot, "candidate-duplicate", `Candidate '${snapshot.config.id}' is duplicated.`),
      );
      continue;
    }
    seen.add(snapshot.config.id);
    const hardRejection =
      availabilityRejection(snapshot, now) ??
      capabilityRejection(task, snapshot) ??
      modelRequirementRejection(task, snapshot) ??
      policyRejection(task, snapshot);
    if (hardRejection) {
      rejections.push(hardRejection);
      continue;
    }
    const thinkingLevels = compatibleThinkingLevels(task, snapshot);
    if (thinkingLevels.length === 0) {
      rejections.push(
        reject(
          snapshot,
          "thinking-level-unavailable",
          `Candidate '${snapshot.config.id}' has no task-compatible configured thinking level.`,
        ),
      );
      continue;
    }
    candidates.push({
      candidate: snapshot.config,
      model: snapshot.model,
      health: snapshot.health,
      thinkingLevels,
    });
  }

  candidates.sort(
    (left, right) =>
      left.candidate.staticPriority - right.candidate.staticPriority ||
      left.candidate.id.localeCompare(right.candidate.id),
  );
  return { candidates, rejections, diagnostics: [] };
}
