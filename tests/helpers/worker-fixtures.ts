import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createStarterSupervisorConfig } from "../../src/config/index.js";
import type { AgentJobCapability } from "../../src/contracts/index.js";
import type { AgentWorkerAttemptRequest, AgentWorkerExecution } from "../../src/worker/index.js";

export function echoCapability(
  observed: unknown[] = [],
  resultText = "PARENT_CAPABILITY_OK",
): AgentJobCapability {
  return {
    capabilityId: "cap-echo",
    toolName: "proxy_echo",
    label: "Proxy echo",
    description: "Deterministic parent capability bridge.",
    parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    async invoke(argumentsValue) {
      observed.push(argumentsValue);
      return {
        content: [{ type: "text", text: resultText }],
        details: { bridged: true },
      };
    },
  };
}

export async function workerRequest(
  root: string,
  options: {
    suffix?: string;
    execution?: AgentWorkerExecution;
    capabilities?: readonly AgentJobCapability[];
    provider?: string;
    modelId?: string;
  } = {},
): Promise<AgentWorkerAttemptRequest> {
  const suffix = options.suffix ?? "one";
  const attemptRoot = join(root, `attempt-${suffix}`);
  const configAgentDir = join(root, "config-agent-dir");
  await mkdir(attemptRoot, { recursive: true });
  await mkdir(configAgentDir, { recursive: true });
  return {
    identity: {
      jobId: `job:${suffix}`,
      attemptId: `attempt:${suffix}`,
      leaseId: `lease:${suffix}`,
    },
    capsule: {
      cwd: attemptRoot,
      configAgentDir,
      attemptRoot,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      target: {
        provider: options.provider ?? "pi-agent-router-test",
        modelId: options.modelId ?? "deterministic",
        thinkingLevel: "off",
      },
      execution:
        options.execution ??
        ({ kind: "agent", prompt: "PRIVATE_WORKER_SENTINEL run the proxy tool." } as const),
      limits: createStarterSupervisorConfig().ipc,
    },
    capabilities: options.capabilities ?? [echoCapability()],
    retention: { mode: "ephemeral" },
    isActive: () => true,
  };
}

export function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}
