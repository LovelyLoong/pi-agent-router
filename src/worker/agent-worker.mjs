import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = 1;
const TEST_PROVIDER = "pi-agent-router-test";
const workerNonce = randomUUID();
let identity;
let limits;
let runningSession;
let completionController;
let terminalSent = false;
let runStarted = false;
let cancellationRequested = false;
let toolCallCount = 0;
const pendingToolCalls = new Map();

function encodedBytes(value) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function assertSize(value, maximum, label) {
  const bytes = encodedBytes(value);
  if (bytes <= maximum) return;
  throw new Error(`${label} exceeds ${maximum} bytes.`);
}

function baseFrame(type) {
  if (!identity) throw new Error("Worker identity is not initialized.");
  return { protocolVersion: PROTOCOL_VERSION, type, nonce: workerNonce, ...identity };
}

function sendRaw(frame, maximum = limits?.maxFrameBytes ?? 4_194_304) {
  assertSize(frame, maximum, frame.type ?? "worker frame");
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Parent IPC is disconnected."));
      return;
    }
    process.send(frame, (error) => (error ? reject(error) : resolve()));
  });
}

async function sendTerminal(status, details = {}) {
  if (terminalSent || !identity) return;
  terminalSent = true;
  await sendRaw({ ...baseFrame("worker.terminal"), status, ...details }).catch(() => undefined);
}

function scheduleExit(code) {
  setTimeout(() => process.exit(code), 10).unref();
}

function failureCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not registered|not available|model/i.test(message)) return "model_unavailable";
  if (/auth|api key|credential/i.test(message)) return "auth_unavailable";
  return "execution_failed";
}

function failureMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function aggregateUsage(messages) {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costTotal: 0,
  };
  let found = false;
  for (const message of messages ?? []) {
    if (message?.role !== "assistant" || !message.usage) continue;
    found = true;
    usage.input += Number(message.usage.input ?? 0);
    usage.output += Number(message.usage.output ?? 0);
    usage.cacheRead += Number(message.usage.cacheRead ?? 0);
    usage.cacheWrite += Number(message.usage.cacheWrite ?? 0);
    usage.totalTokens += Number(message.usage.totalTokens ?? 0);
    usage.costTotal += Number(message.usage.cost?.total ?? 0);
  }
  return found ? usage : undefined;
}

function responseText(content) {
  return (content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function emptyCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function assistantMessage(model, stopReason, content) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: emptyCost(),
    },
    stopReason,
    timestamp: Date.now(),
  };
}

async function registerDeterministicProvider(ai, modelRegistry, authStorage, capsule) {
  if (process.env.PI_AGENT_ROUTER_TEST_MODE !== "deterministic") return;
  if (capsule.target.provider !== TEST_PROVIDER) return;
  let calls = 0;
  const streamSimple = (model) => {
    calls += 1;
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      const manifest = capsule.capabilities[0];
      if (capsule.execution.kind === "agent" && calls === 1 && manifest) {
        const toolCall = {
          type: "toolCall",
          id: `worker-tool-${calls}`,
          name: manifest.toolName,
          arguments: { value: "hello" },
        };
        const output = assistantMessage(model, "toolUse", [toolCall]);
        stream.push({ type: "start", partial: output });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(toolCall.arguments),
          partial: output,
        });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else {
        const text =
          capsule.execution.kind === "completion" ? "WORKER_COMPLETION_OK" : "WORKER_AGENT_OK";
        const output = assistantMessage(model, "stop", [{ type: "text", text }]);
        stream.push({ type: "start", partial: output });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
      }
      stream.end();
    });
    return stream;
  };
  authStorage.setRuntimeApiKey(TEST_PROVIDER, "deterministic-test-key");
  modelRegistry.registerProvider(TEST_PROVIDER, {
    name: "Agent Router deterministic test provider",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "deterministic-test-key",
    api: "openai-completions",
    models: [
      {
        id: capsule.target.modelId,
        name: "Deterministic worker model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxTokens: 1_024,
      },
    ],
    streamSimple,
  });
}

async function createModelRuntime(capsule) {
  const coding = await import("@earendil-works/pi-coding-agent");
  const ai = await import("@earendil-works/pi-ai");
  const authStorage = coding.AuthStorage.create(join(capsule.configAgentDir, "auth.json"));
  const modelRegistry = coding.ModelRegistry.create(
    authStorage,
    join(capsule.configAgentDir, "models.json"),
  );
  await registerDeterministicProvider(ai, modelRegistry, authStorage, capsule);
  const model = modelRegistry.find(capsule.target.provider, capsule.target.modelId);
  if (!model) {
    throw new Error(
      `Selected model '${capsule.target.provider}/${capsule.target.modelId}' is not registered.`,
    );
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error || "Selected model authentication is unavailable.");
  return { coding, modelRegistry, model, auth };
}

function proxyTools(coding, capsule) {
  return capsule.capabilities.map((manifest) =>
    coding.defineTool({
      name: manifest.toolName,
      label: manifest.label,
      description: manifest.description,
      parameters: manifest.parameters,
      execute: async (toolCallId, parameters) => {
        toolCallCount += 1;
        if (toolCallCount > limits.maxToolCalls) throw new Error("Capability call limit exceeded.");
        if (pendingToolCalls.size >= limits.maxPendingToolCalls) {
          throw new Error("Pending capability call limit exceeded.");
        }
        assertSize(parameters, limits.maxToolArgumentBytes, "tool arguments");
        const callId = randomUUID();
        const result = await new Promise((resolve, reject) => {
          pendingToolCalls.set(callId, { resolve, reject });
          void sendRaw({
            ...baseFrame("tool.call"),
            callId,
            toolCallId,
            capabilityId: manifest.capabilityId,
            toolName: manifest.toolName,
            arguments: parameters,
          }).catch(reject);
        });
        pendingToolCalls.delete(callId);
        assertSize(result, limits.maxToolResultBytes, "tool result");
        return result;
      },
    }),
  );
}

async function runAgent(capsule) {
  const { coding, modelRegistry, model } = await createModelRuntime(capsule);
  const attemptAgentDir = join(capsule.attemptRoot, "agent-dir");
  await mkdir(attemptAgentDir, { recursive: true });
  const tools = proxyTools(coding, capsule);
  const resourceLoader = new coding.DefaultResourceLoader({
    cwd: capsule.cwd,
    agentDir: attemptAgentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    ...(capsule.execution.systemPrompt
      ? { systemPromptOverride: () => capsule.execution.systemPrompt }
      : {}),
    ...(capsule.execution.appendSystemPrompt
      ? {
          appendSystemPromptOverride: (base) => [...base, capsule.execution.appendSystemPrompt],
        }
      : {}),
  });
  await resourceLoader.reload();
  const created = await coding.createAgentSession({
    cwd: capsule.cwd,
    agentDir: attemptAgentDir,
    model,
    modelRegistry,
    thinkingLevel: capsule.target.thinkingLevel,
    tools: capsule.capabilities.map((capability) => capability.toolName),
    customTools: tools,
    resourceLoader,
    sessionManager: coding.SessionManager.inMemory(capsule.cwd),
  });
  runningSession = created.session;
  try {
    await runningSession.prompt(capsule.execution.prompt);
    await runningSession.waitForIdle();
    const result = runningSession.getLastAssistantText();
    const usage = aggregateUsage(runningSession.messages);
    runningSession.dispose();
    runningSession = undefined;
    return { result, usage };
  } finally {
    if (runningSession) {
      try {
        runningSession.dispose();
      } catch {}
      runningSession = undefined;
    }
  }
}

async function importCodingAgentCompat() {
  const codingEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const nestedCompat = new URL("../node_modules/@earendil-works/pi-ai/dist/compat.js", codingEntry);
  try {
    return await import(nestedCompat.href);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return await import("@earendil-works/pi-ai/compat");
  }
}

async function runCompletion(capsule) {
  const { model, auth } = await createModelRuntime(capsule);
  const compat = await importCodingAgentCompat();
  completionController = new AbortController();
  const options = {
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers ? { headers: auth.headers } : {}),
    ...(auth.env ? { env: auth.env } : {}),
    ...(capsule.execution.maxTokens ? { maxTokens: capsule.execution.maxTokens } : {}),
    signal: completionController.signal,
    ...(model.reasoning && capsule.target.thinkingLevel !== "off"
      ? { reasoning: capsule.target.thinkingLevel }
      : {}),
  };
  const response = await compat.completeSimple(
    model,
    { systemPrompt: capsule.execution.systemPrompt, messages: capsule.execution.messages },
    options,
  );
  completionController = undefined;
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `Completion stopped with '${response.stopReason}'.`);
  }
  return { result: responseText(response.content), usage: aggregateUsage([response]) };
}

async function cancel(reason) {
  if (terminalSent) return;
  const fault = process.env.PI_AGENT_ROUTER_TEST_FAULT;
  if (fault === "ignore-cancel" || fault === "ignore-cancel-tree") return;
  cancellationRequested = true;
  completionController?.abort(reason);
  for (const pending of pendingToolCalls.values()) pending.reject(new Error(reason));
  pendingToolCalls.clear();
  if (runningSession) {
    try {
      await runningSession.abort();
    } catch {}
    try {
      runningSession.dispose();
    } catch {}
    runningSession = undefined;
  }
  await sendTerminal("cancelled", {
    failure: { code: "execution_failed", message: String(reason).slice(0, 2_000) },
  });
  scheduleExit(0);
}

function argumentsManifest() {
  return {
    capabilityId: "cap-echo",
    toolName: "proxy_echo",
  };
}

async function runFault(fault, capsule) {
  if (!fault) return false;
  if (fault === "hang" || fault === "ignore-cancel") {
    await new Promise(() => undefined);
    return true;
  }
  if (fault === "ignore-cancel-tree") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    descendant.unref();
    const marker = join(
      dirname(capsule.attemptRoot),
      `descendant-${identity.attemptId.replaceAll(":", "-")}.pid`,
    );
    await writeFile(marker, String(descendant.pid), "utf8");
    await new Promise(() => undefined);
    return true;
  }
  if (fault === "malformed") {
    await sendRaw({ protocolVersion: 1, type: "malformed", privateEcho: undefined });
    return true;
  }
  if (fault === "oversize") {
    await sendRaw(
      {
        ...baseFrame("worker.terminal"),
        status: "succeeded",
        result: "x".repeat(limits.maxFrameBytes),
      },
      Number.MAX_SAFE_INTEGER,
    );
    return true;
  }
  if (fault === "identity-mismatch") {
    await sendRaw({
      ...baseFrame("worker.terminal"),
      jobId: "job:wrong",
      status: "failed",
      failure: { code: "execution_failed", message: "identity mismatch fixture" },
    });
    return true;
  }
  if (fault === "disconnect") {
    process.disconnect?.();
    scheduleExit(1);
    return true;
  }
  if (fault === "schema-violation") {
    const manifest = argumentsManifest();
    await sendRaw({
      ...baseFrame("tool.call"),
      callId: randomUUID(),
      toolCallId: "fault-tool",
      capabilityId: manifest.capabilityId,
      toolName: manifest.toolName,
      arguments: { value: 42 },
    });
    return true;
  }
  if (fault === "oversize-arguments") {
    const manifest = argumentsManifest();
    await sendRaw(
      {
        ...baseFrame("tool.call"),
        callId: randomUUID(),
        toolCallId: "fault-tool",
        capabilityId: manifest.capabilityId,
        toolName: manifest.toolName,
        arguments: { value: "x".repeat(limits.maxToolArgumentBytes) },
      },
      Number.MAX_SAFE_INTEGER,
    );
    return true;
  }
  if (fault === "unknown-capability") {
    await sendRaw({
      ...baseFrame("tool.call"),
      callId: randomUUID(),
      toolCallId: "fault-tool",
      capabilityId: "unknown-capability",
      toolName: "unknown_tool",
      arguments: {},
    });
    return true;
  }
  return false;
}

async function executeRun(capsule) {
  try {
    if (await runFault(process.env.PI_AGENT_ROUTER_TEST_FAULT, capsule)) return;
    const output =
      capsule.execution.kind === "agent" ? await runAgent(capsule) : await runCompletion(capsule);
    if (cancellationRequested || terminalSent) return;
    await sendTerminal("succeeded", output);
    scheduleExit(0);
  } catch (error) {
    if (cancellationRequested || terminalSent) return;
    await sendTerminal("failed", {
      failure: { code: failureCode(error), message: failureMessage(error) },
    });
    scheduleExit(1);
  }
}

function validCapsule(capsule) {
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const executionValid =
    capsule?.execution?.kind === "agent"
      ? typeof capsule.execution.prompt === "string"
      : capsule?.execution?.kind === "completion" &&
        typeof capsule.execution.systemPrompt === "string" &&
        Array.isArray(capsule.execution.messages);
  return Boolean(
    capsule &&
      typeof capsule.cwd === "string" &&
      typeof capsule.configAgentDir === "string" &&
      typeof capsule.attemptRoot === "string" &&
      Number.isFinite(Date.parse(capsule.deadlineAt)) &&
      typeof capsule.target?.provider === "string" &&
      typeof capsule.target?.modelId === "string" &&
      thinkingLevels.has(capsule.target?.thinkingLevel) &&
      Array.isArray(capsule.capabilities) &&
      executionValid,
  );
}

function validIdentity(frame) {
  return (
    identity &&
    frame.jobId === identity.jobId &&
    frame.attemptId === identity.attemptId &&
    frame.leaseId === identity.leaseId &&
    frame.nonce === workerNonce
  );
}

process.on("message", (frame) => {
  void (async () => {
    try {
      if (!frame || typeof frame !== "object" || frame.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error("Invalid worker protocol frame.");
      }
      if (frame.type === "worker.run") {
        if (
          runStarted ||
          frame.nonce !== workerNonce ||
          typeof frame.jobId !== "string" ||
          typeof frame.attemptId !== "string" ||
          typeof frame.leaseId !== "string"
        ) {
          throw new Error("Invalid worker run frame.");
        }
        runStarted = true;
        identity = { jobId: frame.jobId, attemptId: frame.attemptId, leaseId: frame.leaseId };
        limits = frame.capsule?.limits;
        if (
          !limits ||
          limits.protocolVersion !== PROTOCOL_VERSION ||
          !validCapsule(frame.capsule)
        ) {
          throw new Error("Invalid worker run capsule or IPC limits.");
        }
        assertSize(frame, limits.maxFrameBytes, "worker run frame");
        assertSize(frame.capsule, limits.maxRunPayloadBytes, "worker run payload");
        void executeRun(frame.capsule);
        return;
      }
      if (!validIdentity(frame)) throw new Error("Worker frame identity mismatch.");
      assertSize(frame, limits.maxFrameBytes, frame.type);
      if (frame.type === "worker.cancel") {
        await cancel(frame.reason ?? "cancelled");
        return;
      }
      if (frame.type === "tool.result") {
        const pending = pendingToolCalls.get(frame.callId);
        if (!pending) throw new Error("Unknown tool result call id.");
        pendingToolCalls.delete(frame.callId);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(String(frame.error ?? "Capability failed.")));
        return;
      }
      throw new Error("Unknown parent frame type.");
    } catch (error) {
      if (identity) {
        await sendTerminal("failed", {
          failure: { code: "invalid_protocol", message: failureMessage(error) },
        });
      }
      scheduleExit(1);
    }
  })();
});

process.on("disconnect", () => {
  if (!terminalSent) void cancel("parent-disconnected");
});

process.on("uncaughtException", (error) => {
  if (identity) {
    void sendTerminal("failed", {
      failure: { code: "execution_failed", message: failureMessage(error) },
    }).finally(() => scheduleExit(1));
  } else {
    console.error(error);
    scheduleExit(1);
  }
});

await sendRaw({
  protocolVersion: PROTOCOL_VERSION,
  type: "worker.hello",
  nonce: workerNonce,
  processId: process.pid,
});
