import type { SupervisorConfig } from "../config/schema.js";
import type { AgentJobCapability, AgentJobRetention } from "../contracts/jobs.js";

export const AGENT_WORKER_PROTOCOL_VERSION = 1 as const;

export type AgentWorkerFailureCode =
  | "invalid_protocol"
  | "frame_too_large"
  | "payload_too_large"
  | "identity_mismatch"
  | "model_unavailable"
  | "auth_unavailable"
  | "capability_unknown"
  | "capability_schema"
  | "capability_revoked"
  | "capability_limit"
  | "capability_failed"
  | "worker_disconnected"
  | "worker_start_timeout"
  | "execution_failed"
  | "cleanup_failed";

export interface AgentWorkerIdentity {
  jobId: string;
  attemptId: string;
  leaseId: string;
}

export interface AgentWorkerTarget {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface AgentWorkerCapabilityManifest {
  capabilityId: string;
  toolName: string;
  label: string;
  description: string;
  parameters: unknown;
}

export type AgentWorkerExecution =
  | {
      kind: "agent";
      prompt: string;
      systemPrompt?: string | undefined;
      appendSystemPrompt?: string | undefined;
    }
  | {
      kind: "completion";
      systemPrompt: string;
      messages: unknown[];
      maxTokens?: number | undefined;
    };

export interface AgentWorkerRunCapsule {
  cwd: string;
  configAgentDir: string;
  attemptRoot: string;
  deadlineAt: string;
  target: AgentWorkerTarget;
  execution: AgentWorkerExecution;
  capabilities: AgentWorkerCapabilityManifest[];
  limits: SupervisorConfig["ipc"];
}

export type AgentWorkerRunInput = Omit<AgentWorkerRunCapsule, "capabilities">;

export interface AgentWorkerAttemptRequest {
  identity: AgentWorkerIdentity;
  capsule: AgentWorkerRunInput;
  capabilities: readonly AgentJobCapability[];
  retention: AgentJobRetention;
  isActive: () => boolean;
  signal?: AbortSignal | undefined;
  onLifecycleEvent?: ((event: AgentWorkerLifecycleEvent) => void) | undefined;
}

export interface AgentWorkerLifecycleEvent {
  type:
    | "spawned"
    | "ready"
    | "tool_call"
    | "terminal"
    | "cancel_requested"
    | "process_escalated"
    | "exited"
    | "cleanup_started"
    | "cleanup_finished";
  jobId: string;
  attemptId: string;
  at: string;
  processId?: number | undefined;
  toolName?: string | undefined;
  status?: AgentWorkerTerminalStatus | "cleanup_failed" | undefined;
}

export type AgentWorkerTerminalStatus = "succeeded" | "failed" | "cancelled";

export interface AgentWorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
}

export interface AgentWorkerAttemptResult {
  identity: AgentWorkerIdentity;
  processId: number;
  workerNonce: string;
  status: AgentWorkerTerminalStatus | "cleanup_failed";
  result?: unknown;
  usage?: AgentWorkerUsage | undefined;
  failure?: { code: AgentWorkerFailureCode; message: string } | undefined;
  cleanup: {
    ok: boolean;
    attempts: number;
    retained: boolean;
    quarantined: boolean;
    pathHash: string;
    reason?: string | undefined;
  };
  stderr: string;
}

export type ParentToWorkerFrame =
  | ({
      protocolVersion: 1;
      type: "worker.run";
      nonce: string;
      capsule: AgentWorkerRunCapsule;
    } & AgentWorkerIdentity)
  | ({
      protocolVersion: 1;
      type: "worker.cancel";
      nonce: string;
      reason: string;
    } & AgentWorkerIdentity)
  | ({
      protocolVersion: 1;
      type: "tool.result";
      nonce: string;
      callId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    } & AgentWorkerIdentity);

export type WorkerToParentFrame =
  | {
      protocolVersion: 1;
      type: "worker.hello";
      nonce: string;
      processId: number;
    }
  | ({
      protocolVersion: 1;
      type: "tool.call";
      nonce: string;
      callId: string;
      toolCallId: string;
      capabilityId: string;
      toolName: string;
      arguments: unknown;
    } & AgentWorkerIdentity)
  | ({
      protocolVersion: 1;
      type: "worker.terminal";
      nonce: string;
      status: AgentWorkerTerminalStatus;
      result?: unknown;
      usage?: AgentWorkerUsage;
      failure?: { code: AgentWorkerFailureCode; message: string };
    } & AgentWorkerIdentity);

export class AgentWorkerProtocolError extends Error {
  constructor(
    readonly code: AgentWorkerFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentWorkerProtocolError";
  }
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validExecution(execution: AgentWorkerExecution): boolean {
  if (execution.kind === "agent") return typeof execution.prompt === "string";
  return (
    typeof execution.systemPrompt === "string" &&
    Array.isArray(execution.messages) &&
    (execution.maxTokens === undefined ||
      (Number.isInteger(execution.maxTokens) && execution.maxTokens > 0))
  );
}

export function assertValidWorkerAttemptRequest(request: AgentWorkerAttemptRequest): void {
  const { identity, capsule } = request;
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const valid =
    nonEmpty(identity.jobId) &&
    nonEmpty(identity.attemptId) &&
    nonEmpty(identity.leaseId) &&
    nonEmpty(capsule.cwd) &&
    nonEmpty(capsule.configAgentDir) &&
    nonEmpty(capsule.attemptRoot) &&
    Number.isFinite(Date.parse(capsule.deadlineAt)) &&
    nonEmpty(capsule.target.provider) &&
    nonEmpty(capsule.target.modelId) &&
    thinkingLevels.has(capsule.target.thinkingLevel) &&
    capsule.limits.protocolVersion === AGENT_WORKER_PROTOCOL_VERSION &&
    request.capabilities.length <= capsule.limits.maxToolCalls &&
    validExecution(capsule.execution);
  if (valid) return;
  throw new AgentWorkerProtocolError(
    "invalid_protocol",
    "Worker attempt request is malformed or exceeds its declared capability count.",
  );
}

export function encodedFrameBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function assertFrameSize(value: unknown, maximum: number, label: string): void {
  const bytes = encodedFrameBytes(value);
  if (bytes <= maximum) return;
  throw new AgentWorkerProtocolError(
    "frame_too_large",
    `${label} is ${Number.isFinite(bytes) ? bytes : "not serializable"} bytes; limit is ${maximum}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.jobId === "string" &&
    typeof value.attemptId === "string" &&
    typeof value.leaseId === "string"
  );
}

export function isWorkerHelloFrame(
  value: unknown,
): value is Extract<WorkerToParentFrame, { type: "worker.hello" }> {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === AGENT_WORKER_PROTOCOL_VERSION &&
    value.type === "worker.hello" &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    Number.isInteger(value.processId) &&
    Number(value.processId) > 0
  );
}

export function isToolCallFrame(
  value: unknown,
): value is Extract<WorkerToParentFrame, { type: "tool.call" }> {
  if (!isRecord(value) || !hasIdentity(value)) return false;
  return (
    value.protocolVersion === AGENT_WORKER_PROTOCOL_VERSION &&
    value.type === "tool.call" &&
    typeof value.nonce === "string" &&
    typeof value.callId === "string" &&
    typeof value.toolCallId === "string" &&
    typeof value.capabilityId === "string" &&
    typeof value.toolName === "string" &&
    "arguments" in value
  );
}

export function isWorkerTerminalFrame(
  value: unknown,
): value is Extract<WorkerToParentFrame, { type: "worker.terminal" }> {
  if (!isRecord(value) || !hasIdentity(value)) return false;
  return (
    value.protocolVersion === AGENT_WORKER_PROTOCOL_VERSION &&
    value.type === "worker.terminal" &&
    typeof value.nonce === "string" &&
    (value.status === "succeeded" || value.status === "failed" || value.status === "cancelled")
  );
}

export function matchesWorkerIdentity(
  frame: AgentWorkerIdentity,
  expected: AgentWorkerIdentity,
): boolean {
  return (
    frame.jobId === expected.jobId &&
    frame.attemptId === expected.attemptId &&
    frame.leaseId === expected.leaseId
  );
}
