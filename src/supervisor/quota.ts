import type { SupervisorConfig } from "../config/schema.js";
import type { AgentJobClass } from "../contracts/jobs.js";
import type { AgentJobResourceClaim } from "./contracts.js";
import { SupervisorAdmissionError } from "./contracts.js";

export interface QuotaJobView {
  jobId: string;
  jobClass: AgentJobClass;
  ownerId: string;
  resource: AgentJobResourceClaim;
}

function matchesLimit(
  resource: AgentJobResourceClaim,
  limit: SupervisorConfig["limits"]["providerLimits"][number],
): boolean {
  return resource.provider === limit.provider && (!limit.model || resource.model === limit.model);
}

export function assertResourceClaim(
  resource: AgentJobResourceClaim,
  config: SupervisorConfig,
  jobId: string,
): void {
  if (!resource.provider.trim() || !resource.model.trim()) {
    throw new SupervisorAdmissionError(
      "resource_invalid",
      `Job '${jobId}' requires non-empty provider and model resource keys.`,
      jobId,
    );
  }
  if (config.limits.providerLimits.some((limit) => matchesLimit(resource, limit))) return;
  throw new SupervisorAdmissionError(
    "resource_limit_missing",
    `No configured provider/model limit admits '${resource.provider}/${resource.model}'.`,
    jobId,
  );
}

function classHasCapacity(
  candidate: QuotaJobView,
  active: readonly QuotaJobView[],
  limits: SupervisorConfig["limits"],
): boolean {
  const activeInClass = active.filter((job) => job.jobClass === candidate.jobClass).length;
  if (candidate.jobClass === "full-agent") return activeInClass < limits.maxFullAgentWorkers;
  if (candidate.jobClass === "completion") return activeInClass < limits.maxCompletionWorkers;
  return activeInClass < limits.maxControlPlaneJobs;
}

function providerHasCapacity(
  candidate: QuotaJobView,
  active: readonly QuotaJobView[],
  limits: SupervisorConfig["limits"],
): boolean {
  const matchingLimits = limits.providerLimits.filter((limit) =>
    matchesLimit(candidate.resource, limit),
  );
  return matchingLimits.every((limit) => {
    const activeForLimit = active.filter((job) => matchesLimit(job.resource, limit)).length;
    return activeForLimit < limit.maxActive;
  });
}

export function canAdmitQuotaJob(
  candidate: QuotaJobView,
  active: readonly QuotaJobView[],
  config: SupervisorConfig,
): boolean {
  const activeForOwner = active.filter((job) => job.ownerId === candidate.ownerId).length;
  return (
    activeForOwner < config.limits.maxJobsPerOwner &&
    classHasCapacity(candidate, active, config.limits) &&
    providerHasCapacity(candidate, active, config.limits)
  );
}
