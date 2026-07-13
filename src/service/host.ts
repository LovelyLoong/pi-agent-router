import { randomUUID } from "node:crypto";
import { loadRouterConfig } from "../config/loader.js";
import { createStarterRouterConfig } from "../config/starter.js";
import { PiEventBusRouteSink } from "../observability/sinks.js";
import type {
  CreateAgentRouterRuntimeOptions,
  RuntimeExecutionOptions,
  RuntimeExecutionResult,
} from "../runtime/runtime.js";
import { AgentRouterRuntime } from "../runtime/runtime.js";
import {
  AGENT_ROUTER_DISCOVERY_TOPIC,
  AGENT_ROUTER_PACKAGE_VERSION,
  AGENT_ROUTER_SERVICE_CONTRACT_VERSION,
  AGENT_ROUTER_SERVICE_ID,
  type AgentRouterConfigurationStatus,
  type AgentRouterServiceEventBus,
  type AgentRouterServiceExecutionRequest,
  type AgentRouterServiceV1,
  type AgentRouterStarterSummary,
  isAgentRouterDiscoveryRequest,
} from "./contracts.js";

interface ServiceRuntimeLike {
  execute<TResult = unknown, TPayload = unknown>(
    options: RuntimeExecutionOptions<TPayload>,
  ): Promise<RuntimeExecutionResult<TResult>>;
}

export interface RegisterAgentRouterServiceOptions {
  configPath?: string | undefined;
  healthPath?: string | undefined;
  packageVersion?: string | undefined;
  instanceId?: string | undefined;
  createRuntime?: (options: CreateAgentRouterRuntimeOptions) => Promise<ServiceRuntimeLike>;
}

function starterSummary(): AgentRouterStarterSummary {
  const starter = createStarterRouterConfig();
  return {
    routerTargets: starter.router.targets.map((target) => ({ ...target })),
    candidates: starter.candidates.map((candidate) => ({
      id: candidate.id,
      executorId: candidate.executorId,
      model: candidate.model,
      allowedThinkingLevels: [...candidate.allowedThinkingLevels],
      staticPriority: candidate.staticPriority,
    })),
    execution: { ...starter.execution },
    authoritative: false,
  };
}

async function inspectConfiguration(
  configPath: string | undefined,
): Promise<AgentRouterConfigurationStatus> {
  const loaded = await loadRouterConfig(configPath);
  const missing = loaded.diagnostics.some((item) => item.code === "config_missing");
  return {
    state: loaded.ok ? "configured" : missing ? "missing" : "invalid",
    path: loaded.path,
    admissionAuthority: "explicit-config-only",
    setupCommand: "/agent-router setup",
    doctorCommand: "/agent-router doctor",
    diagnostics: [...loaded.diagnostics],
    ...(loaded.configHash ? { configHash: loaded.configHash } : {}),
    ...(loaded.config
      ? {
          candidateCount: loaded.config.candidates.length,
          routerTargetCount: loaded.config.router.targets.length,
        }
      : {}),
  };
}

export function registerAgentRouterService(
  events: AgentRouterServiceEventBus,
  options: RegisterAgentRouterServiceOptions = {},
): { service: AgentRouterServiceV1; dispose(): void } {
  const createRuntime = options.createRuntime ?? AgentRouterRuntime.create;
  const service: AgentRouterServiceV1 = {
    contractVersion: AGENT_ROUTER_SERVICE_CONTRACT_VERSION,
    serviceId: AGENT_ROUTER_SERVICE_ID,
    packageVersion: options.packageVersion ?? AGENT_ROUTER_PACKAGE_VERSION,
    instanceId: options.instanceId ?? randomUUID(),
    capabilities: ["inspect-config", "execute-routed-task"],
    starter: starterSummary(),
    inspectConfiguration: () => inspectConfiguration(options.configPath),
    async execute<TResult = unknown, TPayload = unknown>(
      request: AgentRouterServiceExecutionRequest<TPayload>,
    ): Promise<RuntimeExecutionResult<TResult>> {
      const runtime = await createRuntime({
        modelRegistry: request.modelRegistry,
        cwd: request.cwd,
        eventSink: new PiEventBusRouteSink(events),
        ...(options.configPath ? { configPath: options.configPath } : {}),
        ...(options.healthPath ? { healthPath: options.healthPath } : {}),
      });
      return runtime.execute<TResult, TPayload>(request.execution);
    },
  };
  const unsubscribe = events.on(AGENT_ROUTER_DISCOVERY_TOPIC, (value) => {
    if (!isAgentRouterDiscoveryRequest(value)) return;
    value.respond(service);
  });
  return {
    service,
    dispose: typeof unsubscribe === "function" ? unsubscribe : () => undefined,
  };
}
