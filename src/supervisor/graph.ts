import type { SupervisorConfig } from "../config/schema.js";
import { type AgentJobDescriptorV2, validateAgentJobDescriptorV2 } from "../contracts/jobs.js";
import type { AgentJobRegistration } from "./contracts.js";
import { SupervisorAdmissionError } from "./contracts.js";

function assertAcyclic(
  graph: ReadonlyMap<string, readonly string[]>,
  code: "dependency_cycle" | "owner_cycle",
  label: string,
): void {
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (jobId: string): void => {
    if (visiting.has(jobId)) {
      throw new SupervisorAdmissionError(
        code,
        `${label} contains a cycle through '${jobId}'.`,
        jobId,
      );
    }
    if (visited.has(jobId)) return;
    visiting.add(jobId);
    for (const target of graph.get(jobId) ?? []) visit(target);
    visiting.delete(jobId);
    visited.add(jobId);
  };

  for (const jobId of graph.keys()) visit(jobId);
}

function assertPolicyAllowed(descriptor: AgentJobDescriptorV2, config: SupervisorConfig): void {
  const configuredIsolation =
    descriptor.jobClass === "full-agent"
      ? config.isolation.fullAgent
      : descriptor.jobClass === "completion"
        ? config.isolation.completion
        : config.isolation.controlPlane;
  if (descriptor.isolation !== configuredIsolation) {
    throw new SupervisorAdmissionError(
      "job_invalid",
      `Job '${descriptor.jobId}' isolation '${descriptor.isolation}' does not match configured '${configuredIsolation}'.`,
      descriptor.jobId,
    );
  }
  if (
    descriptor.retention.mode === "debug" &&
    descriptor.retention.ttlMs > config.retention.maxDebugTtlMs
  ) {
    throw new SupervisorAdmissionError(
      "job_invalid",
      `Job '${descriptor.jobId}' debug retention exceeds the configured TTL.`,
      descriptor.jobId,
    );
  }

  const dependencyPolicy = descriptor.dependencies.onFailure;
  if (
    dependencyPolicy === "continue" &&
    !config.dependencies.failureContinueTaskKinds.includes(descriptor.task.taskKind)
  ) {
    throw new SupervisorAdmissionError(
      "dependency_continue_not_allowed",
      `Task kind '${descriptor.task.taskKind}' is not allowed to continue after dependency failure.`,
      descriptor.jobId,
    );
  }

  const ownerPolicy = descriptor.owner.policy;
  if (ownerPolicy.mode !== "service-transfer") return;
  if (!config.ownership.serviceTransferTaskKinds.includes(descriptor.task.taskKind)) {
    throw new SupervisorAdmissionError(
      "ownership_transfer_not_allowed",
      `Task kind '${descriptor.task.taskKind}' is not allowed to transfer to service ownership.`,
      descriptor.jobId,
    );
  }
  if (
    ownerPolicy.ttlMs > config.ownership.maxServiceOwnershipTtlMs ||
    ownerPolicy.maxAttempts > config.ownership.maxTransferredAttempts
  ) {
    throw new SupervisorAdmissionError(
      "ownership_transfer_not_allowed",
      `Job '${descriptor.jobId}' exceeds configured service-transfer TTL or attempt bounds.`,
      descriptor.jobId,
    );
  }
}

export function assertValidRegistrationBatch(
  existing: ReadonlyMap<string, AgentJobDescriptorV2>,
  registrations: readonly AgentJobRegistration[],
  releasedOwnerIds: ReadonlySet<string>,
  config: SupervisorConfig,
): void {
  const batch = new Map<string, AgentJobDescriptorV2>();
  for (const registration of registrations) {
    const validation = validateAgentJobDescriptorV2(registration.descriptor);
    if (!validation.ok || !validation.descriptor) {
      throw new SupervisorAdmissionError(
        "job_invalid",
        `Invalid job '${registration.descriptor.jobId}': ${validation.errors.join("; ")}`,
        registration.descriptor.jobId,
      );
    }
    const descriptor = validation.descriptor;
    if (existing.has(descriptor.jobId) || batch.has(descriptor.jobId)) {
      throw new SupervisorAdmissionError(
        "job_duplicate",
        `Job '${descriptor.jobId}' is already registered.`,
        descriptor.jobId,
      );
    }
    if (releasedOwnerIds.has(descriptor.owner.ownerId)) {
      throw new SupervisorAdmissionError(
        "owner_released",
        `Owner '${descriptor.owner.ownerId}' has already been released.`,
        descriptor.jobId,
      );
    }
    assertPolicyAllowed(descriptor, config);
    batch.set(descriptor.jobId, descriptor);
  }

  const all = new Map([...existing, ...batch]);
  for (const descriptor of batch.values()) {
    for (const dependencyId of descriptor.dependencies.dependsOn) {
      if (all.has(dependencyId)) continue;
      throw new SupervisorAdmissionError(
        "dependency_unknown",
        `Job '${descriptor.jobId}' references unknown dependency '${dependencyId}'.`,
        descriptor.jobId,
      );
    }
    const parentJobId = descriptor.owner.parentJobId;
    if (parentJobId && !all.has(parentJobId)) {
      throw new SupervisorAdmissionError(
        "owner_parent_unknown",
        `Job '${descriptor.jobId}' references unknown owner parent job '${parentJobId}'.`,
        descriptor.jobId,
      );
    }
  }

  const dependencyGraph = new Map(
    [...all].map(([jobId, descriptor]) => [jobId, descriptor.dependencies.dependsOn]),
  );
  const ownerGraph = new Map(
    [...all].map(([jobId, descriptor]) => [
      jobId,
      descriptor.owner.parentJobId ? [descriptor.owner.parentJobId] : [],
    ]),
  );
  assertAcyclic(dependencyGraph, "dependency_cycle", "Dependency graph");
  assertAcyclic(ownerGraph, "owner_cycle", "Owner graph");
}
