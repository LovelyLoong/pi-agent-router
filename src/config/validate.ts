import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import type {
  AgentRouterConfig,
  AgentRouterConfigV1,
  AgentRouterConfigV2,
  AnyAgentRouterConfig,
} from "./schema.js";
import { AgentRouterConfigSchema, AgentRouterConfigV2Schema } from "./schema.js";

export interface ConfigValidationResult<TConfig = AgentRouterConfig> {
  ok: boolean;
  config?: TConfig;
  diagnostics: RouterDiagnostic[];
}

function diagnostic(code: string, message: string, path?: string): RouterDiagnostic {
  return { code, severity: "error", message, ...(path ? { path } : {}) };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function schemaDiagnostics(schema: TSchema, value: unknown, label: string) {
  const diagnostics = [...Value.Errors(schema, value)]
    .slice(0, 20)
    .map((error) =>
      diagnostic(
        "config_schema_invalid",
        `${error.instancePath || "/"} ${error.message}`,
        error.instancePath || "/",
      ),
    );
  return diagnostics.length > 0
    ? diagnostics
    : [diagnostic("config_schema_invalid", `Configuration does not match ${label} schema.`)];
}

type SharedRouterConfig = AgentRouterConfigV1 | AgentRouterConfigV2;

function validateUniqueRouterEntries(config: SharedRouterConfig): RouterDiagnostic[] {
  const diagnostics: RouterDiagnostic[] = [];
  for (const duplicate of duplicateValues(config.executors.map((executor) => executor.id))) {
    diagnostics.push(
      diagnostic("executor_id_duplicate", `Executor id '${duplicate}' is duplicated.`),
    );
  }
  for (const duplicate of duplicateValues(config.candidates.map((candidate) => candidate.id))) {
    diagnostics.push(
      diagnostic("candidate_id_duplicate", `Candidate id '${duplicate}' is duplicated.`),
    );
  }
  for (const duplicate of duplicateValues(
    config.candidates.map((candidate) => String(candidate.staticPriority)),
  )) {
    diagnostics.push(
      diagnostic(
        "candidate_priority_duplicate",
        `Static priority '${duplicate}' is duplicated; fallback ordering must be deterministic.`,
      ),
    );
  }
  const targetKeys = config.router.targets.map(
    (target) => `${target.executorId}:${target.model}:${target.thinkingLevel}`,
  );
  for (const duplicate of duplicateValues(targetKeys)) {
    diagnostics.push(
      diagnostic("router_target_duplicate", `Router target '${duplicate}' is duplicated.`),
    );
  }
  return diagnostics;
}

function validateExecutorReferences(config: SharedRouterConfig): RouterDiagnostic[] {
  const diagnostics: RouterDiagnostic[] = [];
  const executors = new Map(config.executors.map((executor) => [executor.id, executor]));
  for (const target of config.router.targets) {
    const executor = executors.get(target.executorId);
    if (!executor) {
      diagnostics.push(
        diagnostic(
          "router_executor_unknown",
          `Router target '${target.model}' references unknown executor '${target.executorId}'.`,
        ),
      );
    } else if (!executor.enabled) {
      diagnostics.push(
        diagnostic(
          "router_executor_disabled",
          `Router target '${target.model}' references disabled executor '${target.executorId}'.`,
        ),
      );
    }
  }
  for (const candidate of config.candidates) {
    const executor = executors.get(candidate.executorId);
    if (!executor) {
      diagnostics.push(
        diagnostic(
          "candidate_executor_unknown",
          `Candidate '${candidate.id}' references unknown executor '${candidate.executorId}'.`,
        ),
      );
    } else if (candidate.enabled && !executor.enabled) {
      diagnostics.push(
        diagnostic(
          "candidate_executor_disabled",
          `Enabled candidate '${candidate.id}' references disabled executor '${candidate.executorId}'.`,
        ),
      );
    }
  }
  return diagnostics;
}

function validateSharedLimits(config: SharedRouterConfig): RouterDiagnostic[] {
  const diagnostics: RouterDiagnostic[] = [];
  if (!config.candidates.some((candidate) => candidate.enabled)) {
    diagnostics.push(
      diagnostic(
        "candidate_enabled_required",
        "At least one candidate must be explicitly enabled.",
      ),
    );
  }
  if (config.router.overallTimeoutMs < config.router.attemptTimeoutMs) {
    diagnostics.push(
      diagnostic(
        "router_timeout_order_invalid",
        "router.overallTimeoutMs must be greater than or equal to router.attemptTimeoutMs.",
      ),
    );
  }
  if (config.execution.overallTimeoutMs < config.execution.attemptTimeoutMs) {
    diagnostics.push(
      diagnostic(
        "execution_timeout_order_invalid",
        "execution.overallTimeoutMs must be greater than or equal to execution.attemptTimeoutMs.",
      ),
    );
  }
  if (config.doctor.overallTimeoutMs < config.doctor.probeTimeoutMs) {
    diagnostics.push(
      diagnostic(
        "doctor_timeout_order_invalid",
        "doctor.overallTimeoutMs must be greater than or equal to doctor.probeTimeoutMs.",
      ),
    );
  }
  if (config.health.rateLimitCooldownMaxMs < config.health.rateLimitCooldownMinMs) {
    diagnostics.push(
      diagnostic(
        "rate_limit_cooldown_order_invalid",
        "health.rateLimitCooldownMaxMs must be greater than or equal to rateLimitCooldownMinMs.",
      ),
    );
  }
  return diagnostics;
}

function validateSharedConfig(config: SharedRouterConfig): RouterDiagnostic[] {
  return [
    ...validateUniqueRouterEntries(config),
    ...validateExecutorReferences(config),
    ...validateSharedLimits(config),
  ];
}

export function validateRouterConfig(value: unknown): ConfigValidationResult<AgentRouterConfigV1> {
  if (!Value.Check(AgentRouterConfigSchema, value)) {
    return { ok: false, diagnostics: schemaDiagnostics(AgentRouterConfigSchema, value, "V1") };
  }

  const config = value as AgentRouterConfigV1;
  const diagnostics = validateSharedConfig(config);
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, config, diagnostics };
}

export function validateRouterConfigV2(
  value: unknown,
): ConfigValidationResult<AgentRouterConfigV2> {
  if (!Value.Check(AgentRouterConfigV2Schema, value)) {
    return { ok: false, diagnostics: schemaDiagnostics(AgentRouterConfigV2Schema, value, "V2") };
  }

  const config = value as AgentRouterConfigV2;
  const diagnostics = validateSharedConfig(config);
  const expectedPriorityOrder = ["interactive", "maintenance", "background"];
  if (
    config.supervisor.priorityOrder.some((value, index) => value !== expectedPriorityOrder[index])
  ) {
    diagnostics.push(
      diagnostic(
        "supervisor_priority_order_invalid",
        "supervisor.priorityOrder must be interactive, maintenance, background.",
        "/supervisor/priorityOrder",
      ),
    );
  }

  for (const duplicate of duplicateValues(
    config.supervisor.limits.providerLimits.map(
      (limit) => `${limit.provider}/${limit.model ?? "*"}`,
    ),
  )) {
    diagnostics.push(
      diagnostic(
        "supervisor_provider_limit_duplicate",
        `Provider/model limit '${duplicate}' is duplicated.`,
        "/supervisor/limits/providerLimits",
      ),
    );
  }

  const { deadlines, limits, ipc, cleanup, ownership } = config.supervisor;
  const globalActiveCapacity =
    limits.maxFullAgentWorkers + limits.maxCompletionWorkers + limits.maxControlPlaneJobs;
  if (limits.maxJobsPerOwner > globalActiveCapacity) {
    diagnostics.push(
      diagnostic(
        "supervisor_owner_limit_exceeds_global",
        "supervisor.limits.maxJobsPerOwner cannot exceed combined global active capacity.",
        "/supervisor/limits/maxJobsPerOwner",
      ),
    );
  }
  for (const [index, providerLimit] of limits.providerLimits.entries()) {
    if (providerLimit.maxActive <= globalActiveCapacity) continue;
    diagnostics.push(
      diagnostic(
        "supervisor_provider_limit_exceeds_global",
        `Provider '${providerLimit.provider}' maxActive cannot exceed combined global active capacity.`,
        `/supervisor/limits/providerLimits/${index}/maxActive`,
      ),
    );
  }
  if (
    deadlines.cleanupDeadlineMs <
    deadlines.cooperativeAbortGraceMs + deadlines.processExitGraceMs
  ) {
    diagnostics.push(
      diagnostic(
        "supervisor_cleanup_deadline_invalid",
        "supervisor.deadlines.cleanupDeadlineMs must cover cooperative and process-exit grace periods.",
        "/supervisor/deadlines/cleanupDeadlineMs",
      ),
    );
  }
  if (deadlines.drainDeadlineMs < deadlines.cleanupDeadlineMs) {
    diagnostics.push(
      diagnostic(
        "supervisor_drain_deadline_invalid",
        "supervisor.deadlines.drainDeadlineMs must be greater than or equal to cleanupDeadlineMs.",
        "/supervisor/deadlines/drainDeadlineMs",
      ),
    );
  }
  if (limits.queueCapacity < limits.maxJobsPerOwner) {
    diagnostics.push(
      diagnostic(
        "supervisor_queue_capacity_invalid",
        "supervisor.limits.queueCapacity must be greater than or equal to maxJobsPerOwner.",
        "/supervisor/limits/queueCapacity",
      ),
    );
  }
  for (const [field, value] of [
    ["maxRunPayloadBytes", ipc.maxRunPayloadBytes],
    ["maxToolArgumentBytes", ipc.maxToolArgumentBytes],
    ["maxToolResultBytes", ipc.maxToolResultBytes],
  ] as const) {
    if (value <= ipc.maxFrameBytes) continue;
    diagnostics.push(
      diagnostic(
        "supervisor_ipc_limit_invalid",
        `supervisor.ipc.${field} cannot exceed maxFrameBytes.`,
        `/supervisor/ipc/${field}`,
      ),
    );
  }
  if (cleanup.quarantineTtlMs < deadlines.cleanupDeadlineMs) {
    diagnostics.push(
      diagnostic(
        "supervisor_quarantine_ttl_invalid",
        "supervisor.cleanup.quarantineTtlMs must be greater than or equal to cleanupDeadlineMs.",
        "/supervisor/cleanup/quarantineTtlMs",
      ),
    );
  }
  if (ownership.maxTransferredAttempts > config.execution.maxAttempts) {
    diagnostics.push(
      diagnostic(
        "supervisor_transfer_attempts_invalid",
        "supervisor.ownership.maxTransferredAttempts cannot exceed execution.maxAttempts.",
        "/supervisor/ownership/maxTransferredAttempts",
      ),
    );
  }

  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, config, diagnostics };
}

export function validateAnyRouterConfig(
  value: unknown,
): ConfigValidationResult<AnyAgentRouterConfig> {
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      diagnostics: [diagnostic("config_version_missing", "Configuration version is missing.")],
    };
  }
  const version = (value as { configVersion?: unknown }).configVersion;
  if (version === 1) return validateRouterConfig(value);
  if (version === 2) return validateRouterConfigV2(value);
  return {
    ok: false,
    diagnostics: [
      diagnostic(
        "config_version_unsupported",
        `Configuration version '${String(version)}' is not supported.`,
        "/configVersion",
      ),
    ],
  };
}
