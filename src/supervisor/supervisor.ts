import { randomUUID } from "node:crypto";
import type { SupervisorConfig } from "../config/schema.js";
import type {
  AgentJobAttemptInspectionV2,
  AgentJobDescriptorV2,
  AgentJobLeaseInspectionV2,
  AgentJobLifecycleState,
  AgentJobTerminalStatus,
} from "../contracts/jobs.js";
import { SystemSupervisorClock } from "./clock.js";
import type {
  AgentJobAdmission,
  AgentJobRegistration,
  AgentJobResourceClaim,
  AgentJobSupervisorCoreOptions,
  AgentJobSupervisorSnapshot,
  CompleteJobOptions,
  OwnershipTransferRecord,
  OwnershipTransferRequest,
  OwnershipTransferResult,
  SupervisedJobSnapshot,
  SupervisorCancellationRequest,
  SupervisorClock,
  SupervisorMutationResult,
} from "./contracts.js";
import { SupervisorAdmissionError } from "./contracts.js";
import { assertValidRegistrationBatch } from "./graph.js";
import { StablePriorityQueue } from "./priority-queue.js";
import { assertResourceClaim, canAdmitQuotaJob, type QuotaJobView } from "./quota.js";

interface JobRecord {
  descriptor: AgentJobDescriptorV2;
  resource?: AgentJobResourceClaim | undefined;
  lifecycleState: AgentJobLifecycleState;
  terminalStatus?: AgentJobTerminalStatus | undefined;
  attempt?: AgentJobAttemptInspectionV2 | undefined;
  lease?: AgentJobLeaseInspectionV2 | undefined;
  queueSequence?: number | undefined;
  blockingDependencyIds: string[];
  ownershipTransferred: boolean;
  submittedAtMs: number;
  deadlineAtMs: number;
}

function emptyMutation(): SupervisorMutationResult {
  return { admitted: [], cancellationRequested: [], terminal: [] };
}

function isActive(record: JobRecord): boolean {
  return Boolean(record.lease && record.lease.state !== "released" && !record.terminalStatus);
}

function isPendingReadiness(record: JobRecord): boolean {
  return (
    !record.terminalStatus &&
    !isActive(record) &&
    record.lifecycleState !== "queued" &&
    record.lifecycleState !== "cancelling"
  );
}

export class AgentJobSupervisorCore {
  readonly #config: SupervisorConfig;
  readonly #clock: SupervisorClock;
  readonly #idFactory: () => string;
  readonly #onTimedMutation: ((result: SupervisorMutationResult) => void) | undefined;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #queue: StablePriorityQueue;
  readonly #releasedOwnerIds = new Set<string>();
  readonly #ownershipTransfers: OwnershipTransferRecord[] = [];
  #state: "accepting" | "draining" | "stopped" = "accepting";
  #sequence = 0;
  #deadlineTimer: unknown;

  constructor(options: AgentJobSupervisorCoreOptions) {
    this.#config = structuredClone(options.config);
    this.#clock = options.clock ?? new SystemSupervisorClock();
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#onTimedMutation = options.onTimedMutation;
    this.#queue = new StablePriorityQueue(this.#config.priorityOrder);
  }

  registerJob(registration: AgentJobRegistration): SupervisorMutationResult {
    return this.registerJobs([registration]);
  }

  registerJobs(registrations: readonly AgentJobRegistration[]): SupervisorMutationResult {
    this.#assertAccepting();
    const existing = new Map(
      [...this.#jobs].map(([jobId, record]) => [jobId, record.descriptor] as const),
    );
    assertValidRegistrationBatch(existing, registrations, this.#releasedOwnerIds, this.#config);
    for (const registration of registrations) {
      if (registration.resource) {
        assertResourceClaim(registration.resource, this.#config, registration.descriptor.jobId);
      }
      const parentJobId = registration.descriptor.owner.parentJobId;
      if (parentJobId && this.#jobs.get(parentJobId)?.terminalStatus) {
        throw new SupervisorAdmissionError(
          "owner_released",
          `Owner parent job '${parentJobId}' is already terminal.`,
          registration.descriptor.jobId,
        );
      }
    }

    const result = this.#expireDeadlines();
    for (const registration of registrations) {
      const parentJobId = registration.descriptor.owner.parentJobId;
      if (parentJobId && this.#jobs.get(parentJobId)?.terminalStatus) {
        throw new SupervisorAdmissionError(
          "owner_released",
          `Owner parent job '${parentJobId}' became terminal before registration.`,
          registration.descriptor.jobId,
        );
      }
    }

    for (const registration of registrations) {
      const descriptor = structuredClone(registration.descriptor);
      const record: JobRecord = {
        descriptor,
        ...(registration.resource ? { resource: structuredClone(registration.resource) } : {}),
        lifecycleState: "submitted",
        blockingDependencyIds: [],
        ownershipTransferred: false,
        submittedAtMs: Date.parse(descriptor.submittedAt),
        deadlineAtMs: Date.parse(descriptor.deadlineAt),
      };
      this.#jobs.set(descriptor.jobId, record);
      if (record.deadlineAtMs <= this.#clock.now()) {
        this.#finishWithoutAttempt(record, "timed_out", result);
      }
    }
    this.#resolveReadiness(result);
    this.#pump(result);
    this.#rescheduleDeadlineTimer();
    return result;
  }

  assignResource(jobId: string, resource: AgentJobResourceClaim): SupervisorMutationResult {
    const result = this.#expireDeadlines();
    const record = this.#requireJob(jobId);
    if (record.terminalStatus || isActive(record) || record.lifecycleState === "queued") {
      throw new SupervisorAdmissionError(
        "job_state_invalid",
        `Job '${jobId}' cannot receive a resource in state '${record.lifecycleState}'.`,
        jobId,
      );
    }
    assertResourceClaim(resource, this.#config, jobId);
    record.resource = structuredClone(resource);
    this.#resolveReadiness(result);
    this.#pump(result);
    this.#rescheduleDeadlineTimer();
    return result;
  }

  markRunning(jobId: string, process?: { processId: number; processIdentityHash: string }): void {
    const record = this.#requireJob(jobId);
    if (record.lifecycleState !== "starting" || !record.attempt || !record.lease) {
      throw new SupervisorAdmissionError(
        "job_state_invalid",
        `Job '${jobId}' is not starting.`,
        jobId,
      );
    }
    record.lifecycleState = "running";
    record.attempt.state = "running";
    if (process) {
      record.lease.processId = process.processId;
      record.lease.processIdentityHash = process.processIdentityHash;
    }
  }

  completeJob(jobId: string, options: CompleteJobOptions): SupervisorMutationResult {
    const result = this.#expireDeadlines();
    const record = this.#requireJob(jobId);
    if (!isActive(record) || !record.attempt || !record.lease) {
      throw new SupervisorAdmissionError(
        "job_state_invalid",
        `Job '${jobId}' has no active attempt to complete.`,
        jobId,
      );
    }
    const finishedAt = new Date(this.#clock.now()).toISOString();
    record.attempt.state = "released";
    record.attempt.finishedAt = finishedAt;
    record.attempt.terminalStatus = options.status;
    record.lease.state = "released";
    record.lifecycleState = "released";
    record.terminalStatus = options.status;
    record.blockingDependencyIds = [];
    result.terminal.push({ jobId, status: options.status });
    this.#resolveReadiness(result);
    this.#pump(result);
    this.#rescheduleDeadlineTimer();
    return result;
  }

  cancelJob(
    jobId: string,
    reason: SupervisorCancellationRequest["reason"] = "operator",
  ): SupervisorMutationResult {
    const result = this.#expireDeadlines();
    const record = this.#requireJob(jobId);
    this.#cancelRecord(record, reason, result);
    this.#resolveReadiness(result);
    this.#pump(result);
    this.#rescheduleDeadlineTimer();
    return result;
  }

  releaseOwner(ownerId: string): SupervisorMutationResult {
    const result = this.#expireDeadlines();
    this.#releasedOwnerIds.add(ownerId);
    for (const jobId of this.getOwnedJobIds(ownerId)) {
      const record = this.#jobs.get(jobId);
      if (record) this.#cancelRecord(record, "owner-ended", result);
    }
    this.#resolveReadiness(result);
    this.#pump(result);
    this.#rescheduleDeadlineTimer();
    return result;
  }

  transferOwnership(request: OwnershipTransferRequest): OwnershipTransferResult {
    const mutation = this.#expireDeadlines();
    const record = this.#requireJob(request.jobId);
    const policy = record.descriptor.owner.policy;
    if (
      record.terminalStatus ||
      record.lifecycleState === "cancelling" ||
      record.ownershipTransferred ||
      policy.mode !== "service-transfer"
    ) {
      throw new SupervisorAdmissionError(
        "ownership_transfer_not_allowed",
        `Job '${request.jobId}' cannot transfer ownership in state '${record.lifecycleState}'.`,
        request.jobId,
      );
    }
    if (!request.reason.trim() || !request.serviceOwnerId.trim()) {
      throw new SupervisorAdmissionError(
        "ownership_transfer_not_allowed",
        "Ownership transfer requires a service owner id and audit reason.",
        request.jobId,
      );
    }
    const now = this.#clock.now();
    if (record.deadlineAtMs <= now || this.#releasedOwnerIds.has(record.descriptor.owner.ownerId)) {
      throw new SupervisorAdmissionError(
        "ownership_transfer_expired",
        `Job '${request.jobId}' can no longer transfer ownership.`,
        request.jobId,
      );
    }
    if (this.#releasedOwnerIds.has(request.serviceOwnerId)) {
      throw new SupervisorAdmissionError(
        "owner_released",
        `Service owner '${request.serviceOwnerId}' has already been released.`,
        request.jobId,
      );
    }
    const activeForTarget = this.#activeQuotaViews().filter(
      (job) => job.ownerId === request.serviceOwnerId && job.jobId !== request.jobId,
    ).length;
    if (isActive(record) && activeForTarget >= this.#config.limits.maxJobsPerOwner) {
      throw new SupervisorAdmissionError(
        "ownership_transfer_quota",
        `Service owner '${request.serviceOwnerId}' has no active-job quota for transfer.`,
        request.jobId,
      );
    }

    const previousOwnerId = record.descriptor.owner.ownerId;
    const transferredDeadline = Math.min(
      record.deadlineAtMs,
      now + policy.ttlMs,
      now + this.#config.ownership.maxServiceOwnershipTtlMs,
    );
    record.descriptor.owner = {
      ownerId: request.serviceOwnerId,
      kind: "service",
      policy: structuredClone(policy),
    };
    if (record.lease) record.lease.ownerId = request.serviceOwnerId;
    record.descriptor.deadlineAt = new Date(transferredDeadline).toISOString();
    record.deadlineAtMs = transferredDeadline;
    record.ownershipTransferred = true;
    const transfer: OwnershipTransferRecord = {
      jobId: request.jobId,
      previousOwnerId,
      serviceOwnerId: request.serviceOwnerId,
      reason: request.reason,
      transferredAt: new Date(now).toISOString(),
      deadlineAt: record.descriptor.deadlineAt,
    };
    this.#ownershipTransfers.push(transfer);
    this.#pump(mutation);
    this.#rescheduleDeadlineTimer();
    return { transfer: structuredClone(transfer), ...mutation };
  }

  sweepDeadlines(): SupervisorMutationResult {
    const result = this.#expireDeadlines();
    this.#rescheduleDeadlineTimer();
    return result;
  }

  beginDraining(): void {
    if (this.#state === "stopped") return;
    this.#state = "draining";
  }

  stop(): void {
    if ([...this.#jobs.values()].some((record) => !record.terminalStatus)) {
      throw new SupervisorAdmissionError(
        "job_state_invalid",
        "Cannot stop the supervisor while non-terminal jobs remain.",
      );
    }
    this.#state = "stopped";
    this.#queue.clear();
    this.#clearDeadlineTimer();
  }

  getJob(jobId: string): SupervisedJobSnapshot | undefined {
    const record = this.#jobs.get(jobId);
    return record ? this.#snapshotJob(record) : undefined;
  }

  getOwnedJobIds(ownerId: string): string[] {
    const included = new Set(
      [...this.#jobs.values()]
        .filter((record) => record.descriptor.owner.ownerId === ownerId)
        .map((record) => record.descriptor.jobId),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of this.#jobs.values()) {
        const parentJobId = record.descriptor.owner.parentJobId;
        if (!parentJobId || !included.has(parentJobId) || included.has(record.descriptor.jobId)) {
          continue;
        }
        included.add(record.descriptor.jobId);
        changed = true;
      }
    }
    return [...included].sort();
  }

  snapshot(): AgentJobSupervisorSnapshot {
    const jobs = [...this.#jobs.values()]
      .map((record) => this.#snapshotJob(record))
      .sort(
        (left, right) =>
          Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
          left.jobId.localeCompare(right.jobId),
      );
    return {
      state: this.#state,
      jobs,
      queuedJobIds: this.#queue.orderedJobIds(),
      activeJobIds: jobs
        .filter((job) => job.lease && job.lease.state !== "released")
        .map((job) => job.jobId),
      releasedOwnerIds: [...this.#releasedOwnerIds].sort(),
      ownershipTransfers: structuredClone(this.#ownershipTransfers),
      limits: structuredClone(this.#config.limits),
    };
  }

  #assertAccepting(): void {
    if (this.#state === "accepting") return;
    throw new SupervisorAdmissionError(
      "supervisor_not_accepting",
      `Supervisor is '${this.#state}' and cannot accept new jobs.`,
    );
  }

  #requireJob(jobId: string): JobRecord {
    const record = this.#jobs.get(jobId);
    if (record) return record;
    throw new SupervisorAdmissionError("job_unknown", `Job '${jobId}' is not registered.`, jobId);
  }

  #resolveReadiness(result: SupervisorMutationResult): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of this.#jobs.values()) {
        if (!isPendingReadiness(record)) continue;
        const dependencies = record.descriptor.dependencies.dependsOn.map((jobId) =>
          this.#requireJob(jobId),
        );
        const failed = dependencies.filter(
          (dependency) => dependency.terminalStatus && dependency.terminalStatus !== "succeeded",
        );
        if (failed.length > 0 && record.descriptor.dependencies.onFailure === "skip") {
          this.#finishWithoutAttempt(record, "dependency_failed", result);
          changed = true;
          continue;
        }
        const blocking = dependencies.filter((dependency) => !dependency.terminalStatus);
        record.blockingDependencyIds = blocking.map((dependency) => dependency.descriptor.jobId);
        if (blocking.length > 0) {
          record.lifecycleState = "blocked-on-dependencies";
          continue;
        }
        if (!record.resource) {
          record.lifecycleState = "routing";
          continue;
        }
        if (this.#queueRecord(record, result)) changed = true;
      }
    }
  }

  #queueRecord(record: JobRecord, result: SupervisorMutationResult): boolean {
    record.lifecycleState = "queued";
    record.queueSequence = ++this.#sequence;
    this.#queue.enqueue(record.descriptor.jobId, record.descriptor.priority, record.queueSequence);
    this.#pump(result);
    if (this.#queue.size <= this.#config.limits.queueCapacity) return false;
    if (!this.#queue.remove(record.descriptor.jobId)) return false;
    this.#finishWithoutAttempt(record, "queue_full", result);
    return true;
  }

  #pump(result: SupervisorMutationResult): void {
    while (true) {
      const jobId = this.#queue.takeFirst((candidateId) => {
        const record = this.#jobs.get(candidateId);
        return Boolean(record && this.#canAdmit(record));
      });
      if (!jobId) return;
      const record = this.#requireJob(jobId);
      result.admitted.push(this.#admit(record));
    }
  }

  #canAdmit(record: JobRecord): boolean {
    if (!record.resource || record.terminalStatus) return false;
    return canAdmitQuotaJob(this.#quotaView(record), this.#activeQuotaViews(), this.#config);
  }

  #admit(record: JobRecord): AgentJobAdmission {
    if (!record.resource) {
      throw new SupervisorAdmissionError(
        "resource_invalid",
        `Job '${record.descriptor.jobId}' has no resource claim.`,
        record.descriptor.jobId,
      );
    }
    const now = new Date(this.#clock.now()).toISOString();
    const attemptId = `attempt:${this.#idFactory()}`;
    const leaseId = `lease:${this.#idFactory()}`;
    const ordinal = (record.attempt?.ordinal ?? 0) + 1;
    record.queueSequence = undefined;
    record.lifecycleState = "starting";
    const attempt: AgentJobAttemptInspectionV2 = {
      attemptId,
      jobId: record.descriptor.jobId,
      ordinal,
      state: "starting",
      ...(record.resource.candidateId ? { candidateId: record.resource.candidateId } : {}),
      model: record.resource.model,
      ...(record.resource.thinkingLevel ? { thinkingLevel: record.resource.thinkingLevel } : {}),
      leaseId,
      startedAt: now,
    };
    const lease: AgentJobLeaseInspectionV2 = {
      leaseId,
      jobId: record.descriptor.jobId,
      ownerId: record.descriptor.owner.ownerId,
      state: "active",
      isolation: record.descriptor.isolation,
      acquiredAt: now,
      deadlineAt: record.descriptor.deadlineAt,
    };
    record.attempt = attempt;
    record.lease = lease;
    return {
      jobId: record.descriptor.jobId,
      resource: structuredClone(record.resource),
      attempt: structuredClone(attempt),
      lease: structuredClone(lease),
    };
  }

  #quotaView(record: JobRecord): QuotaJobView {
    if (!record.resource) {
      throw new SupervisorAdmissionError(
        "resource_invalid",
        `Job '${record.descriptor.jobId}' has no resource claim.`,
        record.descriptor.jobId,
      );
    }
    return {
      jobId: record.descriptor.jobId,
      jobClass: record.descriptor.jobClass,
      ownerId: record.descriptor.owner.ownerId,
      resource: record.resource,
    };
  }

  #activeQuotaViews(): QuotaJobView[] {
    return [...this.#jobs.values()].filter(isActive).map((record) => this.#quotaView(record));
  }

  #cancelRecord(
    record: JobRecord,
    reason: SupervisorCancellationRequest["reason"],
    result: SupervisorMutationResult,
  ): void {
    if (record.terminalStatus || record.lifecycleState === "cancelling") return;
    if (isActive(record)) {
      record.lifecycleState = "cancelling";
      if (record.attempt) record.attempt.state = "cancelling";
      if (record.lease) record.lease.state = "releasing";
      result.cancellationRequested.push({ jobId: record.descriptor.jobId, reason });
      return;
    }
    this.#queue.remove(record.descriptor.jobId);
    this.#finishWithoutAttempt(record, reason === "deadline" ? "timed_out" : "cancelled", result);
  }

  #finishWithoutAttempt(
    record: JobRecord,
    status: AgentJobTerminalStatus,
    result: SupervisorMutationResult,
  ): void {
    this.#queue.remove(record.descriptor.jobId);
    record.queueSequence = undefined;
    record.lifecycleState = "released";
    record.terminalStatus = status;
    record.blockingDependencyIds = [];
    result.terminal.push({ jobId: record.descriptor.jobId, status });
  }

  #expireDeadlines(): SupervisorMutationResult {
    const result = emptyMutation();
    const now = this.#clock.now();
    for (const record of this.#jobs.values()) {
      if (record.terminalStatus || record.deadlineAtMs > now) continue;
      this.#cancelRecord(record, "deadline", result);
    }
    this.#resolveReadiness(result);
    this.#pump(result);
    return result;
  }

  #rescheduleDeadlineTimer(): void {
    this.#clearDeadlineTimer();
    if (this.#state === "stopped") return;
    const deadlines = [...this.#jobs.values()]
      .filter((record) => !record.terminalStatus && record.lifecycleState !== "cancelling")
      .map((record) => record.deadlineAtMs);
    if (deadlines.length === 0) return;
    const deadline = Math.min(...deadlines);
    this.#deadlineTimer = this.#clock.setTimer(
      () => {
        this.#deadlineTimer = undefined;
        const result = this.#expireDeadlines();
        this.#rescheduleDeadlineTimer();
        if (
          result.admitted.length ||
          result.cancellationRequested.length ||
          result.terminal.length
        ) {
          this.#onTimedMutation?.(result);
        }
      },
      Math.max(0, deadline - this.#clock.now()),
    );
  }

  #clearDeadlineTimer(): void {
    if (this.#deadlineTimer === undefined) return;
    this.#clock.clearTimer(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
  }

  #snapshotJob(record: JobRecord): SupervisedJobSnapshot {
    return {
      contractVersion: 2,
      jobId: record.descriptor.jobId,
      jobClass: record.descriptor.jobClass,
      priority: record.descriptor.priority,
      owner: structuredClone(record.descriptor.owner),
      dependencyIds: [...record.descriptor.dependencies.dependsOn],
      lifecycleState: record.lifecycleState,
      ...(record.terminalStatus ? { terminalStatus: record.terminalStatus } : {}),
      ...(record.attempt ? { attempt: structuredClone(record.attempt) } : {}),
      ...(record.lease ? { lease: structuredClone(record.lease) } : {}),
      submittedAt: record.descriptor.submittedAt,
      deadlineAt: record.descriptor.deadlineAt,
      ...(record.resource ? { resource: structuredClone(record.resource) } : {}),
      ...(record.queueSequence !== undefined ? { queueSequence: record.queueSequence } : {}),
      blockingDependencyIds: [...record.blockingDependencyIds],
      ownershipTransferred: record.ownershipTransferred,
    };
  }
}
