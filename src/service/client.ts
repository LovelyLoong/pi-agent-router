import { randomUUID } from "node:crypto";
import {
  AGENT_ROUTER_DISCOVERY_TOPIC,
  AGENT_ROUTER_DISCOVERY_TOPIC_V2,
  AGENT_ROUTER_SERVICE_CONTRACT_VERSION,
  AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2,
  AGENT_ROUTER_SERVICE_ID,
  type AgentRouterConfigurationStatus,
  type AgentRouterConfigurationStatusV2,
  type AgentRouterDiscoveryRequestV1,
  type AgentRouterDiscoveryRequestV2,
  type AgentRouterServiceEventBus,
  type AgentRouterServiceV1,
  type AgentRouterServiceV2,
  isAgentRouterServiceV1,
  isAgentRouterServiceV2,
} from "./contracts.js";

export type AgentRouterServiceDiscoveryFailure =
  | "service-missing"
  | "service-duplicate"
  | "service-incompatible"
  | "service-malformed"
  | "service-unconfigured"
  | "service-config-invalid"
  | "service-discovery-aborted";

export class AgentRouterServiceDiscoveryError extends Error {
  constructor(
    readonly code: AgentRouterServiceDiscoveryFailure,
    message: string,
    readonly configuration?: AgentRouterConfigurationStatus | AgentRouterConfigurationStatusV2,
  ) {
    super(message);
    this.name = "AgentRouterServiceDiscoveryError";
  }
}

export interface DiscoverAgentRouterServiceOptions {
  timeoutMs?: number | undefined;
  settleMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

function boundedDelay(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.trunc(value))) : fallback;
}

function incompatibleService(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { serviceId?: unknown; contractVersion?: unknown };
  return (
    candidate.serviceId === AGENT_ROUTER_SERVICE_ID &&
    candidate.contractVersion !== AGENT_ROUTER_SERVICE_CONTRACT_VERSION
  );
}

export async function discoverAgentRouterService(
  events: AgentRouterServiceEventBus,
  options: DiscoverAgentRouterServiceOptions = {},
): Promise<AgentRouterServiceV1> {
  if (options.signal?.aborted) {
    throw new AgentRouterServiceDiscoveryError(
      "service-discovery-aborted",
      "Agent Router service discovery was cancelled.",
    );
  }
  const timeoutMs = boundedDelay(options.timeoutMs, 50, 5_000);
  const settleMs = boundedDelay(options.settleMs, 5, timeoutMs);
  const responses: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      reject(
        new AgentRouterServiceDiscoveryError(
          "service-discovery-aborted",
          "Agent Router service discovery was cancelled.",
        ),
      );
    };
    const timeoutTimer = setTimeout(finish, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    const request: AgentRouterDiscoveryRequestV1 = {
      contractVersion: AGENT_ROUTER_SERVICE_CONTRACT_VERSION,
      type: "discover-agent-router",
      requestId: randomUUID(),
      respond(value) {
        responses.push(value);
        if (!settleTimer) settleTimer = setTimeout(finish, settleMs);
      },
    };
    try {
      events.emit(AGENT_ROUTER_DISCOVERY_TOPIC, request);
    } catch (error) {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    }
  });

  if (responses.length === 0) {
    throw new AgentRouterServiceDiscoveryError(
      "service-missing",
      "Agent Router service is not loaded. Install/enable pi-agent-router, restart Pi, then run /agent-router setup and /agent-router doctor.",
    );
  }
  if (responses.length > 1) {
    throw new AgentRouterServiceDiscoveryError(
      "service-duplicate",
      `Agent Router service discovery received ${responses.length} providers. Disable duplicate Router packages and restart Pi.`,
    );
  }
  const response = responses[0];
  if (!isAgentRouterServiceV1(response)) {
    throw new AgentRouterServiceDiscoveryError(
      incompatibleService(response) ? "service-incompatible" : "service-malformed",
      incompatibleService(response)
        ? "Loaded Agent Router service uses an incompatible contract version. Update dependent packages together."
        : "Loaded Agent Router service returned a malformed discovery response.",
    );
  }
  return response;
}

export async function requireConfiguredAgentRouterService(
  events: AgentRouterServiceEventBus,
  options: DiscoverAgentRouterServiceOptions = {},
): Promise<AgentRouterServiceV1> {
  const service = await discoverAgentRouterService(events, options);
  const configuration = await service.inspectConfiguration();
  if (configuration.state === "configured") return service;
  const details = configuration.diagnostics.map((item) => item.message).join("; ");
  throw new AgentRouterServiceDiscoveryError(
    configuration.state === "missing" ? "service-unconfigured" : "service-config-invalid",
    `${details || "Agent Router configuration is unavailable."} Run ${configuration.setupCommand} and ${configuration.doctorCommand}.`,
    configuration,
  );
}

function incompatibleServiceV2(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { serviceId?: unknown; contractVersion?: unknown };
  return (
    candidate.serviceId === AGENT_ROUTER_SERVICE_ID &&
    candidate.contractVersion !== AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2
  );
}

export async function discoverAgentRouterServiceV2(
  events: AgentRouterServiceEventBus,
  options: DiscoverAgentRouterServiceOptions = {},
): Promise<AgentRouterServiceV2> {
  if (options.signal?.aborted) {
    throw new AgentRouterServiceDiscoveryError(
      "service-discovery-aborted",
      "Agent Router V2 service discovery was cancelled.",
    );
  }
  const timeoutMs = boundedDelay(options.timeoutMs, 50, 5_000);
  const settleMs = boundedDelay(options.settleMs, 5, timeoutMs);
  const responses: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      reject(
        new AgentRouterServiceDiscoveryError(
          "service-discovery-aborted",
          "Agent Router V2 service discovery was cancelled.",
        ),
      );
    };
    const timeoutTimer = setTimeout(finish, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    const request: AgentRouterDiscoveryRequestV2 = {
      contractVersion: AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2,
      type: "discover-agent-router",
      requestId: randomUUID(),
      respond(value) {
        responses.push(value);
        if (!settleTimer) settleTimer = setTimeout(finish, settleMs);
      },
    };
    try {
      events.emit(AGENT_ROUTER_DISCOVERY_TOPIC_V2, request);
    } catch (error) {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    }
  });

  if (responses.length === 0) {
    throw new AgentRouterServiceDiscoveryError(
      "service-missing",
      "Agent Router V2 supervisor service is not loaded. Update and enable the Router before using Agent jobs.",
    );
  }
  if (responses.length > 1) {
    throw new AgentRouterServiceDiscoveryError(
      "service-duplicate",
      `Agent Router V2 discovery received ${responses.length} providers. Disable duplicate Router packages and restart Pi.`,
    );
  }
  const response = responses[0];
  if (!isAgentRouterServiceV2(response)) {
    throw new AgentRouterServiceDiscoveryError(
      incompatibleServiceV2(response) ? "service-incompatible" : "service-malformed",
      incompatibleServiceV2(response)
        ? "Loaded Agent Router service uses an incompatible V2 contract. Update dependent packages together."
        : "Loaded Agent Router V2 service returned a malformed discovery response.",
    );
  }
  return response;
}

export async function requireConfiguredAgentRouterServiceV2(
  events: AgentRouterServiceEventBus,
  options: DiscoverAgentRouterServiceOptions = {},
): Promise<AgentRouterServiceV2> {
  const service = await discoverAgentRouterServiceV2(events, options);
  const configuration = await service.inspectConfiguration();
  if (configuration.state === "configured") return service;
  const details = configuration.diagnostics.map((item) => item.message).join("; ");
  const action =
    configuration.state === "migration-required"
      ? configuration.migrationCommand
      : `${configuration.setupCommand} and ${configuration.doctorCommand}`;
  throw new AgentRouterServiceDiscoveryError(
    configuration.state === "missing" ? "service-unconfigured" : "service-config-invalid",
    `${details || "Agent Router V2 configuration is unavailable."} Run ${action}.`,
    configuration,
  );
}
