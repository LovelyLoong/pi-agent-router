import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStarterSupervisorConfig } from "../src/config/index.js";
import { AttemptCleanupManager } from "../src/worker/cleanup.js";
import {
  type AgentWorkerAttemptRequest,
  type AgentWorkerAttemptResult,
  AgentWorkerClient,
} from "../src/worker/index.js";
import { echoCapability, isProcessAlive, workerRequest } from "./helpers/worker-fixtures.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-agent-worker-"));
  temporaryDirectories.push(path);
  return path;
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function deterministicClient(): AgentWorkerClient {
  return new AgentWorkerClient({
    environment: { PI_AGENT_ROUTER_TEST_MODE: "deterministic" },
    cooperativeAbortGraceMs: 500,
    processExitGraceMs: 2_000,
  });
}

function expectAgentResult(
  result: AgentWorkerAttemptResult,
  request: AgentWorkerAttemptRequest,
): void {
  expect(result).toMatchObject({
    identity: request.identity,
    status: "succeeded",
    result: "WORKER_AGENT_OK",
    cleanup: { ok: true, retained: false, quarantined: false },
    stderr: "",
  });
  expect(result.usage).toMatchObject({ input: 2, output: 2, totalTokens: 4 });
  expect(isProcessAlive(result.processId)).toBe(false);
}

function expectAgentLifecycle(
  events: unknown[],
  request: AgentWorkerAttemptRequest,
  result: AgentWorkerAttemptResult,
): void {
  expect(events).toEqual([
    expect.objectContaining({ type: "spawned", jobId: request.identity.jobId }),
    expect.objectContaining({ type: "ready", processId: result.processId }),
    expect.objectContaining({ type: "tool_call", toolName: "proxy_echo" }),
    expect.objectContaining({ type: "terminal", status: "succeeded" }),
    expect.objectContaining({ type: "exited", processId: result.processId }),
    expect.objectContaining({ type: "cleanup_started" }),
    expect.objectContaining({ type: "cleanup_finished", status: "succeeded" }),
  ]);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_WORKER_SENTINEL");
}

describe("isolated Pi Agent worker", () => {
  it("runs a real fresh in-memory AgentSession through a parent capability", async () => {
    const root = await temporaryDirectory();
    const observed: unknown[] = [];
    const events: unknown[] = [];
    const request = await workerRequest(root, {
      capabilities: [echoCapability(observed)],
    });
    request.onLifecycleEvent = (event) => events.push(event);

    const result = await deterministicClient().runAttempt(request);

    expectAgentResult(result, request);
    expectAgentLifecycle(events, request, result);
    expect(observed).toEqual([{ value: "hello" }]);
    await expectPathMissing(request.capsule.attemptRoot);
  }, 20_000);
});

describe("isolated Pi Agent attempt freshness", () => {
  it("uses a new process, nonce, AgentSession, and tool namespace for every attempt", async () => {
    const root = await temporaryDirectory();
    const client = deterministicClient();
    const first = await client.runAttempt(await workerRequest(root, { suffix: "first" }));
    const second = await client.runAttempt(await workerRequest(root, { suffix: "second" }));

    expect(first.processId).not.toBe(second.processId);
    expect(first.workerNonce).not.toBe(second.workerNonce);
    expect(first.identity.attemptId).not.toBe(second.identity.attemptId);
    expect(first.cleanup.ok).toBe(true);
    expect(second.cleanup.ok).toBe(true);
    expect(isProcessAlive(first.processId)).toBe(false);
    expect(isProcessAlive(second.processId)).toBe(false);
  }, 20_000);
});

describe("isolated worker cancellation and cleanup barrier", () => {
  it("settles a cancellation racing with process creation through one cleanup barrier", async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort("cancel-before-ready");
    const request = await workerRequest(root, { suffix: "creation-race" });
    request.signal = controller.signal;
    const events: Array<{ type: string }> = [];
    request.onLifecycleEvent = (event) => events.push(event);
    const client = new AgentWorkerClient({
      environment: {
        PI_AGENT_ROUTER_TEST_MODE: "deterministic",
        PI_AGENT_ROUTER_TEST_FAULT: "hang",
      },
      cooperativeAbortGraceMs: 100,
      processExitGraceMs: 2_000,
    });

    const result = await client.runAttempt(request);

    expect(result).toMatchObject({ status: "cancelled", cleanup: { ok: true } });
    expect(events.filter((event) => event.type === "cancel_requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "cleanup_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "cleanup_finished")).toHaveLength(1);
    expect(isProcessAlive(result.processId)).toBe(false);
    await expectPathMissing(request.capsule.attemptRoot);
  }, 20_000);

  it("revokes a pending parent capability before cooperative worker cancellation settles", async () => {
    const root = await temporaryDirectory();
    const controller = new AbortController();
    const capability = echoCapability();
    capability.invoke = async (_argumentsValue, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const request = await workerRequest(root, {
      suffix: "tool-cancel",
      capabilities: [capability],
    });
    request.signal = controller.signal;
    const events: Array<{ type: string }> = [];
    request.onLifecycleEvent = (event) => {
      events.push(event);
      if (event.type === "tool_call") setTimeout(() => controller.abort("tool-cancel"), 0);
    };

    const result = await deterministicClient().runAttempt(request);

    expect(result).toMatchObject({ status: "cancelled", cleanup: { ok: true } });
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.filter((event) => event.type === "cleanup_finished")).toHaveLength(1);
    expect(isProcessAlive(result.processId)).toBe(false);
    await expectPathMissing(request.capsule.attemptRoot);
  }, 20_000);

  it.skipIf(process.platform !== "win32")(
    "force-terminates an owned ignored-cancel process tree and confirms descendant exit",
    async () => {
      const root = await temporaryDirectory();
      const controller = new AbortController();
      const request = await workerRequest(root, { suffix: "tree" });
      request.signal = controller.signal;
      const events: Array<{ type: string }> = [];
      request.onLifecycleEvent = (event) => {
        events.push(event);
        if (event.type === "ready") setTimeout(() => controller.abort("force-tree"), 0);
      };
      const client = new AgentWorkerClient({
        environment: {
          PI_AGENT_ROUTER_TEST_MODE: "deterministic",
          PI_AGENT_ROUTER_TEST_FAULT: "ignore-cancel-tree",
        },
        cooperativeAbortGraceMs: 100,
        processExitGraceMs: 2_000,
      });

      const result = await client.runAttempt(request);
      const descendantProcessId = Number(
        await readFile(join(root, "descendant-attempt-tree.pid"), "utf8"),
      );

      expect(result).toMatchObject({ status: "cancelled", cleanup: { ok: true } });
      expect(events.filter((event) => event.type === "process_escalated")).toHaveLength(1);
      expect(isProcessAlive(result.processId)).toBe(false);
      expect(isProcessAlive(descendantProcessId)).toBe(false);
      await expectPathMissing(request.capsule.attemptRoot);
    },
    20_000,
  );

  it("overrides successful output with cleanup_failed and exposes bounded janitor recovery", async () => {
    const root = await temporaryDirectory();
    const request = await workerRequest(root, { suffix: "cleanup-failure" });
    let janitorMayRemove = false;
    const cleanupConfig = {
      ...createStarterSupervisorConfig().cleanup,
      deleteMaxAttempts: 1,
    };
    const cleanupManager = new AttemptCleanupManager(cleanupConfig, {
      operations: {
        async remove(path) {
          if (!janitorMayRemove) throw new Error(`locked Router path ${path}`);
          await rm(path, { recursive: true, force: true });
        },
        async rename() {
          throw new Error("rename blocked by Windows lock");
        },
        async wait() {},
      },
    });
    const client = new AgentWorkerClient({
      environment: { PI_AGENT_ROUTER_TEST_MODE: "deterministic" },
      cooperativeAbortGraceMs: 500,
      processExitGraceMs: 2_000,
      cleanupManager,
    });

    const result = await client.runAttempt(request);

    expect(result).toMatchObject({
      status: "cleanup_failed",
      failure: { code: "cleanup_failed" },
      cleanup: { ok: false, quarantined: false },
    });
    expect(result.result).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(request.capsule.attemptRoot);
    expect(JSON.stringify(cleanupManager.status())).not.toContain(request.capsule.attemptRoot);
    expect(cleanupManager.status()).toMatchObject({ degraded: true, quarantineCount: 1 });
    expect(isProcessAlive(result.processId)).toBe(false);

    janitorMayRemove = true;
    await expect(cleanupManager.runJanitor()).resolves.toEqual({
      attempted: 1,
      removed: 1,
      remaining: 0,
    });
    expect(cleanupManager.status().degraded).toBe(false);
    await expectPathMissing(request.capsule.attemptRoot);
  }, 20_000);

  it("publishes cleanup completion before a caller can start the next fallback attempt", async () => {
    const root = await temporaryDirectory();
    const order: string[] = [];
    const first = await workerRequest(root, { suffix: "fallback-first" });
    const second = await workerRequest(root, { suffix: "fallback-second" });
    first.onLifecycleEvent = (event) => {
      if (event.type === "cleanup_finished") order.push("first:cleanup_finished");
    };
    second.onLifecycleEvent = (event) => {
      if (event.type === "spawned") order.push("second:spawned");
    };
    const client = deterministicClient();

    const firstResult = await client.runAttempt(first);
    const secondResult = await client.runAttempt(second);

    expect(firstResult.cleanup.ok).toBe(true);
    expect(secondResult.cleanup.ok).toBe(true);
    expect(order).toEqual(["first:cleanup_finished", "second:spawned"]);
  }, 30_000);
});

describe("isolated Pi completion worker", () => {
  it("runs completion work in a fresh supervised process", async () => {
    const root = await temporaryDirectory();
    const request = await workerRequest(root, {
      suffix: "completion",
      capabilities: [],
      execution: {
        kind: "completion",
        systemPrompt: "Return the deterministic completion.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "PRIVATE_COMPLETION_SENTINEL" }],
            timestamp: Date.now(),
          },
        ],
        maxTokens: 64,
      },
    });
    const events: unknown[] = [];
    request.onLifecycleEvent = (event) => events.push(event);

    const result = await deterministicClient().runAttempt(request);

    expect(result).toMatchObject({
      status: "succeeded",
      result: "WORKER_COMPLETION_OK",
      cleanup: { ok: true },
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_COMPLETION_SENTINEL");
    expect(isProcessAlive(result.processId)).toBe(false);
    await expectPathMissing(request.capsule.attemptRoot);
  }, 20_000);

  it("fails closed when the already-selected model is not registered", async () => {
    const root = await temporaryDirectory();
    const request = await workerRequest(root, {
      suffix: "missing-model",
      provider: "missing-provider",
      modelId: "missing-model",
      capabilities: [],
      execution: {
        kind: "completion",
        systemPrompt: "No request should run.",
        messages: [],
      },
    });

    const result = await deterministicClient().runAttempt(request);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "model_unavailable" },
      cleanup: { ok: true },
    });
    expect(isProcessAlive(result.processId)).toBe(false);
    await expectPathMissing(request.capsule.attemptRoot);
  }, 20_000);
});
