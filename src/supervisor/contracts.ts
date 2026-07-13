import type { SupervisorConfig } from "../config/schema.js";
import type {
  AgentJobAttemptInspectionV2,
  AgentJobDescriptorV2,
  AgentJobInspectionV2,
  AgentJobLeaseInspectionV2,
  AgentJobTerminalStatus,
} from "../contracts/jobs.js";

export interface SupervisorClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface AgentJobResourceClaim {
  provider: string;
  model: string;
  candidateId?: string | undefined;
  thinkingLevel?: string | undefined;
}

export interface AgentJobRegistration {
  descriptor: AgentJobDescriptorV2;
  resource?: AgentJobResourceClaim | undefined;
}

export interface SupervisedJobSnapshot extends AgentJobInspectionV2 {
  resource?: AgentJobResourceClaim | undefined;
  queueSequence?: number | undefined;
  blockingDependencyIds: string[];
  ownershipTransferred: boolean;
}

export interface AgentJobAdmission {
  jobId: string;
  resource: AgentJobResourceClaim;
  attempt: AgentJobAttemptInspectionV2;
  lease: AgentJobLeaseInspectionV2;
}

export interface SupervisorCancellationRequest {
  jobId: string;
  reason: "owner-ended" | "deadline" | "operator" | "shutdown";
}

export interface SupervisorTerminalTransition {
  jobId: string;
  status: AgentJobTerminalStatus;
}

export interface SupervisorMutationResult {
  admitted: AgentJobAdmission[];
  cancellationRequested: SupervisorCancellationRequest[];
  terminal: SupervisorTerminalTransition[];
}

export interface OwnershipTransferRequest {
  jobId: string;
  serviceOwnerId: string;
  reason: string;
}

export interface OwnershipTransferRecord {
  jobId: string;
  previousOwnerId: string;
  serviceOwnerId: string;
  reason: string;
  transferredAt: string;
  deadlineAt: string;
}

export interface OwnershipTransferResult extends SupervisorMutationResult {
  transfer: OwnershipTransferRecord;
}

export interface AgentJobSupervisorSnapshot {
  state: "accepting" | "draining" | "stopped";
  jobs: SupervisedJobSnapshot[];
  queuedJobIds: string[];
  activeJobIds: string[];
  releasedOwnerIds: string[];
  ownershipTransfers: OwnershipTransferRecord[];
  limits: SupervisorConfig["limits"];
}

export type SupervisorAdmissionErrorCode =
  | "supervisor_not_accepting"
  | "job_invalid"
  | "job_duplicate"
  | "dependency_unknown"
  | "dependency_cycle"
  | "dependency_continue_not_allowed"
  | "owner_parent_unknown"
  | "owner_cycle"
  | "owner_released"
  | "ownership_transfer_not_allowed"
  | "ownership_transfer_expired"
  | "ownership_transfer_quota"
  | "resource_invalid"
  | "resource_limit_missing"
  | "job_state_invalid"
  | "job_unknown";

export class SupervisorAdmissionError extends Error {
  constructor(
    readonly code: SupervisorAdmissionErrorCode,
    message: string,
    readonly jobId?: string,
  ) {
    super(message);
    this.name = "SupervisorAdmissionError";
  }
}

export interface AgentJobSupervisorCoreOptions {
  config: SupervisorConfig;
  clock?: SupervisorClock | undefined;
  idFactory?: (() => string) | undefined;
  onTimedMutation?: ((result: SupervisorMutationResult) => void) | undefined;
}

export interface CompleteJobOptions {
  status: AgentJobTerminalStatus;
}
