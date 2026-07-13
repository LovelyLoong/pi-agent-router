import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import type { RuntimeExecutionOptions, RuntimeExecutionResult } from "../runtime/runtime.js";

export const AGENT_ROUTER_SERVICE_ID = "pi-agent-router";
export const AGENT_ROUTER_SERVICE_CONTRACT_VERSION = 1;
export const AGENT_ROUTER_PACKAGE_VERSION = "0.1.0";
export const AGENT_ROUTER_DISCOVERY_TOPIC = "pi-agent-router.service.discover.v1";

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
