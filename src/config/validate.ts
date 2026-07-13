import { Value } from "typebox/value";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import type { AgentRouterConfig } from "./schema.js";
import { AgentRouterConfigSchema } from "./schema.js";

export interface ConfigValidationResult {
  ok: boolean;
  config?: AgentRouterConfig;
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

export function validateRouterConfig(value: unknown): ConfigValidationResult {
  if (!Value.Check(AgentRouterConfigSchema, value)) {
    const diagnostics = Value.Errors(AgentRouterConfigSchema, value)
      .slice(0, 20)
      .map((error) =>
        diagnostic(
          "config_schema_invalid",
          `${error.instancePath || "/"} ${error.message}`,
          error.instancePath || "/",
        ),
      );
    return {
      ok: false,
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : [diagnostic("config_schema_invalid", "Configuration does not match V1 schema.")],
    };
  }

  const config = value as AgentRouterConfig;
  const diagnostics: RouterDiagnostic[] = [];
  const executorIds = config.executors.map((executor) => executor.id);
  const candidateIds = config.candidates.map((candidate) => candidate.id);

  for (const duplicate of duplicateValues(executorIds)) {
    diagnostics.push(
      diagnostic("executor_id_duplicate", `Executor id '${duplicate}' is duplicated.`),
    );
  }
  for (const duplicate of duplicateValues(candidateIds)) {
    diagnostics.push(
      diagnostic("candidate_id_duplicate", `Candidate id '${duplicate}' is duplicated.`),
    );
  }

  const priorities = config.candidates.map((candidate) => String(candidate.staticPriority));
  for (const duplicate of duplicateValues(priorities)) {
    diagnostics.push(
      diagnostic(
        "candidate_priority_duplicate",
        `Static priority '${duplicate}' is duplicated; fallback ordering must be deterministic.`,
      ),
    );
  }

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

  const routerTargetKeys = config.router.targets.map(
    (target) => `${target.executorId}:${target.model}:${target.thinkingLevel}`,
  );
  for (const duplicate of duplicateValues(routerTargetKeys)) {
    diagnostics.push(
      diagnostic("router_target_duplicate", `Router target '${duplicate}' is duplicated.`),
    );
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

  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, config, diagnostics };
}
