import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStarterRouterConfig } from "../src/config/index.js";
import type { RuntimeExecutionOptions, RuntimeExecutionResult } from "../src/runtime/index.js";
import {
  AGENT_ROUTER_DISCOVERY_TOPIC,
  type AgentRouterServiceDiscoveryError,
  type AgentRouterServiceEventBus,
  discoverAgentRouterService,
  registerAgentRouterService,
  requireConfiguredAgentRouterService,
} from "../src/service/index.js";

class TestEventBus implements AgentRouterServiceEventBus {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  emit(name: string, value: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(value);
  }

  on(name: string, handler: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(handler);
    this.listeners.set(name, listeners);
    return () => listeners.delete(handler);
  }
}

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-agent-router-service-"));
  tempDirectories.push(directory);
  return join(directory, name);
}

function configuredPath(): string {
  const path = tempPath("agent-router.json");
  writeFileSync(path, `${JSON.stringify(createStarterRouterConfig(), null, 2)}\n`, "utf8");
  return path;
}

function executionResult(): RuntimeExecutionResult<{ answer: string }> {
  return {
    planning: {} as never,
    outcome: {
      contractVersion: 1,
      routeId: "route-service",
      taskId: "task-service",
      decision: {} as never,
      attempts: [],
      success: true,
      result: { answer: "through service" },
      finishedAt: "2026-07-13T00:00:00.000Z",
    },
    diagnostics: [],
    eventErrors: [],
    audit: {} as never,
  };
}

const discoveryOptions = { timeoutMs: 10, settleMs: 1 };

describe("mandatory Agent Router service", () => {
  it("discovers exactly one configured host and exposes non-authoritative starter metadata", async () => {
    const events = new TestEventBus();
    const host = registerAgentRouterService(events, {
      configPath: configuredPath(),
      instanceId: "router-one",
    });

    const service = await requireConfiguredAgentRouterService(events, discoveryOptions);
    const status = await service.inspectConfiguration();

    expect(service.instanceId).toBe("router-one");
    expect(status).toMatchObject({
      state: "configured",
      admissionAuthority: "explicit-config-only",
      candidateCount: 4,
      routerTargetCount: 2,
    });
    expect(service.starter).toMatchObject({ authoritative: false });
    expect(service.starter.candidates.map((candidate) => candidate.model)).toEqual([
      "openai-codex/gpt-5.4-mini",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-sol",
    ]);
    expect(JSON.stringify(service.starter)).not.toContain('"max"');
    host.dispose();
  });

  it("fails closed when the service is missing or duplicated", async () => {
    const missingEvents = new TestEventBus();
    await expect(discoverAgentRouterService(missingEvents, discoveryOptions)).rejects.toMatchObject(
      { code: "service-missing" },
    );

    const duplicateEvents = new TestEventBus();
    const first = registerAgentRouterService(duplicateEvents, { instanceId: "first" });
    const second = registerAgentRouterService(duplicateEvents, { instanceId: "second" });
    await expect(
      discoverAgentRouterService(duplicateEvents, discoveryOptions),
    ).rejects.toMatchObject({ code: "service-duplicate" });
    first.dispose();
    second.dispose();
  });

  it("rejects incompatible, malformed, missing-config, and invalid-config authority", async () => {
    const incompatibleEvents = new TestEventBus();
    incompatibleEvents.on(AGENT_ROUTER_DISCOVERY_TOPIC, (value) => {
      const request = value as { respond(value: unknown): void };
      request.respond({ serviceId: "pi-agent-router", contractVersion: 2 });
    });
    await expect(
      discoverAgentRouterService(incompatibleEvents, discoveryOptions),
    ).rejects.toMatchObject({ code: "service-incompatible" });

    const malformedEvents = new TestEventBus();
    malformedEvents.on(AGENT_ROUTER_DISCOVERY_TOPIC, (value) => {
      const request = value as { respond(value: unknown): void };
      request.respond({ contractVersion: 1, serviceId: "wrong" });
    });
    await expect(
      discoverAgentRouterService(malformedEvents, discoveryOptions),
    ).rejects.toMatchObject({ code: "service-malformed" });

    const missingConfigEvents = new TestEventBus();
    registerAgentRouterService(missingConfigEvents, { configPath: tempPath("missing.json") });
    await expect(
      requireConfiguredAgentRouterService(missingConfigEvents, discoveryOptions),
    ).rejects.toMatchObject({ code: "service-unconfigured" });

    const invalidPath = tempPath("invalid.json");
    writeFileSync(invalidPath, "{}\n", "utf8");
    const invalidConfigEvents = new TestEventBus();
    registerAgentRouterService(invalidConfigEvents, { configPath: invalidPath });
    await expect(
      requireConfiguredAgentRouterService(invalidConfigEvents, discoveryOptions),
    ).rejects.toMatchObject({ code: "service-config-invalid" });
  });

  it("executes only through the service-owned runtime factory", async () => {
    const events = new TestEventBus();
    const expected = executionResult();
    const observedExecutions: unknown[] = [];
    const runtime = {
      async execute<TResult = unknown, TPayload = unknown>(
        options: RuntimeExecutionOptions<TPayload>,
      ): Promise<RuntimeExecutionResult<TResult>> {
        observedExecutions.push(options);
        return expected as unknown as RuntimeExecutionResult<TResult>;
      },
    };
    const createRuntime = vi.fn(async () => runtime);
    registerAgentRouterService(events, {
      configPath: configuredPath(),
      createRuntime,
    });
    const service = await requireConfiguredAgentRouterService(events, discoveryOptions);
    const execution = { task: { taskId: "task-service" } } as never;

    const result = await service.execute<{ answer: string }, unknown>({
      modelRegistry: {} as ModelRegistry,
      cwd: "C:/repo",
      execution,
    });

    expect(result).toBe(expected);
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "C:/repo", configPath: expect.any(String) }),
    );
    expect(observedExecutions).toEqual([execution]);
  });

  it("propagates discovery cancellation without executing", async () => {
    const events = new TestEventBus();
    const controller = new AbortController();
    controller.abort("cancelled");

    await expect(
      discoverAgentRouterService(events, { ...discoveryOptions, signal: controller.signal }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgentRouterServiceDiscoveryError>>({
        code: "service-discovery-aborted",
      }),
    );
  });
});
