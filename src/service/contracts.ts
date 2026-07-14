import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import type {
  AgentJobEventV2,
  AgentJobInspectionV2,
  AgentJobResultV2,
  AgentJobSubmissionV2,
} from "../contracts/jobs.js";
import type { RuntimeExecutionOptions, RuntimeExecutionResult } from "../runtime/runtime.js";

export const AGENT_ROUTER_SERVICE_ID = "pi-agent-router";
export const AGENT_ROUTER_SERVICE_CONTRACT_VERSION = 1;
export const AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2 = 2;
export const AGENT_ROUTER_PACKAGE_VERSION = "0.1.0";
export const AGENT_ROUTER_DISCOVERY_TOPIC = "pi-agent-router.service.discover.v1";
export const AGENT_ROUTER_DISCOVERY_TOPIC_V2 = "pi-agent-router.service.discover.v2";
export const AGENT_ROUTER_JOB_AUDIT_TOPIC_V2 = "pi-agent-router.job.audit.v2";
export const AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2 = "pi-agent-router.supervisor.status.v2";
export const AGENT_ROUTER_SERVICE_V2_CAPABILITIES = [
  "inspect-config-v2",
  "run-agent-job",
  "stream-agent-job",
  "with-agent-job",
  "inspect-agent-jobs",
  "inspect-agent-tree",
  "inspect-agent-audit",
  "cancel-agent-job",
  "release-agent-owner",
  "run-agent-janitor",
  "doctor-supervisor",
  "drain-supervisor",
] as const;

export type AgentRouterConfigurationState = "configured" | "missing" | "invalid";

export interface AgentRouterServiceEventBus {
  emit(name: string, value: unknown): void;
  on(name: string, handler: (value: unknown) => void): () => void;
}

export interface AgentRouterStarterSummary {
  routerTargets: Array<{ executorId: string; model: string; thinkingLevel: string }>;
  candidates: Array<{
    id: string;
    executorId: string;
    model: string;
    allowedThinkingLevels: string[];
    staticPriority: number;
  }>;
  execution: { attemptTimeoutMs: number; overallTimeoutMs: number; maxAttempts: number };
  authoritative: false;
}

export interface AgentRouterConfigurationStatus {
  state: AgentRouterConfigurationState;
  path: string;
  admissionAuthority: "explicit-config-only";
  setupCommand: "/agent-router setup";
  doctorCommand: "/agent-router doctor";
  diagnostics: RouterDiagnostic[];
  configHash?: string | undefined;
  candidateCount?: number | undefined;
  routerTargetCount?: number | undefined;
}

export interface AgentRouterServiceExecutionRequest<TPayload> {
  modelRegistry: ModelRegistry;
  cwd: string;
  execution: RuntimeExecutionOptions<TPayload>;
}

export interface AgentRouterServiceV1 {
  contractVersion: 1;
  serviceId: typeof AGENT_ROUTER_SERVICE_ID;
  packageVersion: string;
  instanceId: string;
  capabilities: readonly ["inspect-config", "execute-routed-task"];
  starter: AgentRouterStarterSummary;
  inspectConfiguration(): Promise<AgentRouterConfigurationStatus>;
  execute<TResult = unknown, TPayload = unknown>(
    request: AgentRouterServiceExecutionRequest<TPayload>,
  ): Promise<RuntimeExecutionResult<TResult>>;
}

export interface AgentRouterDiscoveryRequestV1 {
  contractVersion: 1;
  type: "discover-agent-router";
  requestId: string;
  respond(value: unknown): void;
}

export function isAgentRouterDiscoveryRequest(
  value: unknown,
): value is AgentRouterDiscoveryRequestV1 {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<AgentRouterDiscoveryRequestV1>;
  return (
    request.contractVersion === AGENT_ROUTER_SERVICE_CONTRACT_VERSION &&
    request.type === "discover-agent-router" &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    typeof request.respond === "function"
  );
}

export function isAgentRouterServiceV1(value: unknown): value is AgentRouterServiceV1 {
  if (!value || typeof value !== "object") return false;
  const service = value as Partial<AgentRouterServiceV1>;
  return (
    service.contractVersion === AGENT_ROUTER_SERVICE_CONTRACT_VERSION &&
    service.serviceId === AGENT_ROUTER_SERVICE_ID &&
    typeof service.packageVersion === "string" &&
    typeof service.instanceId === "string" &&
    service.instanceId.length > 0 &&
    typeof service.inspectConfiguration === "function" &&
    typeof service.execute === "function"
  );
}

export type AgentRouterConfigurationStateV2 = AgentRouterConfigurationState | "migration-required";

export interface AgentRouterConfigurationStatusV2
  extends Omit<AgentRouterConfigurationStatus, "state"> {
  state: AgentRouterConfigurationStateV2;
  migrationCommand: "/agent-router migrate-v2";
  configVersion?: 2 | undefined;
}

export interface AgentRouterSupervisorStatusV2 {
  state: "accepting" | "draining" | "degraded" | "stopped";
  queuedJobs: number;
  activeFullAgentJobs: number;
  activeCompletionJobs: number;
  activeControlPlaneJobs: number;
  activeOwners: number;
  quarantinedCleanupItems: number;
  degradedReasons: string[];
}

export interface AgentRouterServiceJobRequestV2<TPayload = unknown> {
  modelRegistry: ModelRegistry;
  cwd: string;
  job: AgentJobSubmissionV2<TPayload>;
}

export interface AgentRouterServiceJobQueryV2 {
  jobId?: string | undefined;
  ownerId?: string | undefined;
  includeTerminal?: boolean | undefined;
  limit?: number | undefined;
}

export interface AgentRouterServiceCancelRequestV2 {
  jobId: string;
  reason: "caller-aborted" | "owner-ended" | "deadline" | "shutdown" | "operator";
}

export interface AgentRouterJobCleanupV2 {
  ok: boolean;
  attempts: number;
  retained: boolean;
  quarantined: boolean;
  pathHash: string;
}

export type AgentRouterJobInspectionV2 = AgentJobInspectionV2 & {
  cancellationReason?: AgentRouterServiceCancelRequestV2["reason"] | undefined;
  processState?: "not-started" | "running" | "exited" | undefined;
  cleanup?: AgentRouterJobCleanupV2 | undefined;
};

export interface AgentRouterJobTreeNodeV2 {
  job: AgentRouterJobInspectionV2;
  children: AgentRouterJobTreeNodeV2[];
  dependencies: AgentRouterJobInspectionV2[];
}

export interface AgentRouterJobAuditQueryV2 {
  jobId?: string | undefined;
  ownerKind?: AgentJobInspectionV2["owner"]["kind"] | undefined;
  limit?: number | undefined;
}

export interface AgentRouterJobAuditRecordV2 {
  contractVersion: 2;
  auditId: string;
  jobId: string;
  ownerKind: AgentJobInspectionV2["owner"]["kind"];
  ownerIdHash: string;
  jobClass: AgentJobInspectionV2["jobClass"];
  dependencyIds: string[];
  dependencyOutcomes: Array<{
    jobId: string;
    terminalStatus?: AgentJobResultV2["status"] | undefined;
  }>;
  submittedAt: string;
  queuedAt?: string | undefined;
  startedAt?: string | undefined;
  finishedAt: string;
  attemptId?: string | undefined;
  candidateId?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  terminalStatus: AgentJobResultV2["status"];
  cancellationReason?: AgentRouterServiceCancelRequestV2["reason"] | undefined;
  failureCode?: string | undefined;
  processEscalated: boolean;
  processExited: boolean;
  cleanup: AgentRouterJobCleanupV2;
  lifecycle: Array<{ type: AgentJobEventV2["type"] | string; at: string }>;
}

export interface AgentRouterJanitorResultV2 {
  attempted: number;
  reclaimed: number;
  remaining: number;
  degraded: boolean;
}

export interface AgentRouterSupervisorDoctorV2 {
  ok: boolean;
  inspectedAt: string;
  supervisor: AgentRouterSupervisorStatusV2;
  findings: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  }>;
}

export interface AgentJobStreamV2<TResult = unknown>
  extends AsyncIterable<AgentJobEventV2<TResult>> {
  readonly jobId: string;
  result(): Promise<AgentJobResultV2<TResult>>;
  cancel(reason?: string): Promise<void>;
  inspect(): Promise<AgentRouterJobInspectionV2 | undefined>;
}

export interface AgentRouterServiceV2 {
  contractVersion: 2;
  serviceId: typeof AGENT_ROUTER_SERVICE_ID;
  packageVersion: string;
  instanceId: string;
  capabilities: typeof AGENT_ROUTER_SERVICE_V2_CAPABILITIES;
  inspectConfiguration(): Promise<AgentRouterConfigurationStatusV2>;
  inspectSupervisor(): Promise<AgentRouterSupervisorStatusV2>;
  runJob<TResult = unknown, TPayload = unknown>(
    request: AgentRouterServiceJobRequestV2<TPayload>,
  ): Promise<AgentJobResultV2<TResult>>;
  streamJob<TResult = unknown, TPayload = unknown>(
    request: AgentRouterServiceJobRequestV2<TPayload>,
  ): AgentJobStreamV2<TResult>;
  withAgent<TResult = unknown, TPayload = unknown, TConsumed = void>(
    request: AgentRouterServiceJobRequestV2<TPayload>,
    consume: (job: AgentJobStreamV2<TResult>) => Promise<TConsumed>,
  ): Promise<TConsumed>;
  inspectJobs(query?: AgentRouterServiceJobQueryV2): Promise<AgentRouterJobInspectionV2[]>;
  inspectJobTree(query?: AgentRouterServiceJobQueryV2): Promise<AgentRouterJobTreeNodeV2[]>;
  inspectAudit(query?: AgentRouterJobAuditQueryV2): Promise<AgentRouterJobAuditRecordV2[]>;
  cancelJob(request: AgentRouterServiceCancelRequestV2): Promise<boolean>;
  releaseOwner(ownerId: string): Promise<number>;
  runJanitor(): Promise<AgentRouterJanitorResultV2>;
  doctor(): Promise<AgentRouterSupervisorDoctorV2>;
  drain(reason: string): Promise<void>;
}

export interface AgentRouterDiscoveryRequestV2 {
  contractVersion: 2;
  type: "discover-agent-router";
  requestId: string;
  respond(value: unknown): void;
}

export function isAgentRouterDiscoveryRequestV2(
  value: unknown,
): value is AgentRouterDiscoveryRequestV2 {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<AgentRouterDiscoveryRequestV2>;
  return (
    request.contractVersion === AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2 &&
    request.type === "discover-agent-router" &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    typeof request.respond === "function"
  );
}

const AGENT_ROUTER_SERVICE_V2_METHODS = [
  "inspectConfiguration",
  "inspectSupervisor",
  "runJob",
  "streamJob",
  "withAgent",
  "inspectJobs",
  "inspectJobTree",
  "inspectAudit",
  "cancelJob",
  "releaseOwner",
  "runJanitor",
  "doctor",
  "drain",
] as const;

function hasAgentRouterServiceV2Identity(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const service = value as Record<string, unknown>;
  return (
    service.contractVersion === AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2 &&
    service.serviceId === AGENT_ROUTER_SERVICE_ID &&
    typeof service.packageVersion === "string" &&
    typeof service.instanceId === "string" &&
    service.instanceId.length > 0
  );
}

function hasAgentRouterServiceV2Capabilities(service: Record<string, unknown>): boolean {
  const capabilities = service.capabilities;
  return (
    Array.isArray(capabilities) &&
    capabilities.length === AGENT_ROUTER_SERVICE_V2_CAPABILITIES.length &&
    AGENT_ROUTER_SERVICE_V2_CAPABILITIES.every(
      (capability, index) => capabilities[index] === capability,
    )
  );
}

function hasAgentRouterServiceV2Methods(service: Record<string, unknown>): boolean {
  return AGENT_ROUTER_SERVICE_V2_METHODS.every((method) => typeof service[method] === "function");
}

export function isAgentRouterServiceV2(value: unknown): value is AgentRouterServiceV2 {
  return (
    hasAgentRouterServiceV2Identity(value) &&
    hasAgentRouterServiceV2Capabilities(value) &&
    hasAgentRouterServiceV2Methods(value)
  );
}
