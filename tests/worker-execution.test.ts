import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

async function jsonlFiles(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(entry.name);
  }
  return found;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function deterministicClient(): AgentWorkerClient {
  return new AgentWorkerClient({
    environment: { PI_AGENT_ROUTER_TEST_MODE: "deterministic" },
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
    expect(await jsonlFiles(request.capsule.attemptRoot)).toEqual([]);
  });
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
    expect(isProcessAlive(first.processId)).toBe(false);
    expect(isProcessAlive(second.processId)).toBe(false);
  });
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

    expect(result).toMatchObject({ status: "succeeded", result: "WORKER_COMPLETION_OK" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_COMPLETION_SENTINEL");
    expect(isProcessAlive(result.processId)).toBe(false);
  });

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
    });
    expect(isProcessAlive(result.processId)).toBe(false);
  });
});
