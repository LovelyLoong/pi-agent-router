import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExecutorAdapter,
  ExecutorAvailability,
  ExecutorCapabilities,
  ExecutorProbeResult,
  ExecutorRunRequest,
  ExecutorRunResult,
} from "../contracts/executor.js";
import type { ExecutionTarget, FailureClass, UsageSnapshot } from "../contracts/routing.js";
import type { TaskContract } from "../contracts/task.js";
import { ExecutionDeadlineError } from "./deadline.js";

export interface PiSdkExecutionPayload<TResult = unknown> {
  cwd: string;
  prompt: string;
  tools: string[];
  customTools?: ToolDefinition[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  persistSessionDirectory?: string;
  onSessionCreated?: (sessionFile: string | undefined) => void;
  captureResult?: () => TResult | undefined;
}

export interface PiSdkSessionLike {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
  readonly messages: unknown[];
  readonly sessionFile?: string | undefined;
  readonly agent: { state: { errorMessage?: string } };
}

export type PiSdkRegisteredModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

export interface PiSdkSessionFactoryRequest<TResult = unknown> {
  target: ExecutionTarget;
  payload: PiSdkExecutionPayload<TResult>;
  model: PiSdkRegisteredModel;
  modelRegistry: ModelRegistry;
  agentDir: string;
}

export type PiSdkSessionFactory = (
  request: PiSdkSessionFactoryRequest,
) => Promise<PiSdkSessionLike>;

export interface PiSdkExecutorOptions {
  modelRegistry: ModelRegistry;
  executorId?: string;
  agentDir?: string;
  sessionFactory?: PiSdkSessionFactory;
}

interface AssistantMessageLike {
  role: "assistant";
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  errorMessage?: string;
}

function parseModelName(value: string): { provider: string; id: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function assistantMessages(messages: unknown[]): AssistantMessageLike[] {
  return messages.filter((message): message is AssistantMessageLike => {
    return Boolean(
      message && typeof message === "object" && (message as { role?: string }).role === "assistant",
    );
  });
}

function finalText(messages: AssistantMessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.content) continue;
    for (const part of message.content) {
      if (part.type === "text" && part.text?.trim()) return part.text;
    }
  }
  return "";
}

function aggregateUsage(messages: AssistantMessageLike[]): UsageSnapshot | undefined {
  let found = false;
  const usage: Required<UsageSnapshot> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
  for (const message of messages) {
    if (!message.usage) continue;
    found = true;
    usage.inputTokens += message.usage.input ?? 0;
    usage.outputTokens += message.usage.output ?? 0;
    usage.cacheReadTokens += message.usage.cacheRead ?? 0;
    usage.cacheWriteTokens += message.usage.cacheWrite ?? 0;
    usage.cost += message.usage.cost?.total ?? 0;
  }
  return found ? usage : undefined;
}

function classifyPiFailure(error: unknown, signal?: AbortSignal): FailureClass {
  if (signal?.reason instanceof ExecutionDeadlineError) return "timeout";
  if (signal?.aborted) return "aborted";
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/api key|unauthori[sz]ed|forbidden|authentication|oauth|401|403/.test(message)) {
    return "authentication";
  }
  if (/rate.?limit|too many requests|429/.test(message)) return "rate-limit";
  if (/timed? ?out|timeout|deadline/.test(message)) return "timeout";
  if (
    /fetch|network|socket|econn|transport|connection|service unavailable|\b50[234]\b/.test(message)
  ) {
    return "provider-transport";
  }
  if (/model.+(not found|unavailable|unknown)/.test(message)) return "model-unavailable";
  return "unknown";
}

async function defaultSessionFactory(
  request: PiSdkSessionFactoryRequest,
): Promise<PiSdkSessionLike> {
  const loader = new DefaultResourceLoader({
    cwd: request.payload.cwd,
    agentDir: request.agentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    ...(request.payload.systemPrompt
      ? { systemPromptOverride: () => request.payload.systemPrompt as string }
      : {}),
    ...(request.payload.appendSystemPrompt
      ? {
          appendSystemPromptOverride: (base: string[]) => [
            ...base,
            request.payload.appendSystemPrompt as string,
          ],
        }
      : {}),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: request.payload.cwd,
    agentDir: request.agentDir,
    model: request.model,
    modelRegistry: request.modelRegistry,
    thinkingLevel: request.target.thinkingLevel,
    tools: request.payload.tools,
    ...(request.payload.customTools ? { customTools: request.payload.customTools } : {}),
    resourceLoader: loader,
    sessionManager: request.payload.persistSessionDirectory
      ? SessionManager.create(request.payload.cwd, request.payload.persistSessionDirectory)
      : SessionManager.inMemory(request.payload.cwd),
  });
  return session;
}

function probeTask(timeoutMs: number): TaskContract {
  return {
    contractVersion: 1,
    taskId: "doctor:pi-sdk-probe",
    taskKind: "availability-probe",
    goalSummary: "Explicitly requested minimal Pi SDK availability probe.",
    requirements: {
      requiredCapabilities: [],
      preferredCapabilities: [],
      allowedTools: [],
      inputModalities: ["text"],
      minimumContextWindow: 1,
      requiresReasoning: false,
      sideEffectClass: "none",
      dataSensitivity: "public",
      output: { kind: "text" },
    },
    context: { estimatedTokens: 16, bytes: 64, itemCount: 1 },
    budget: {
      routeTimeoutMs: timeoutMs,
      attemptTimeoutMs: timeoutMs,
      overallTimeoutMs: timeoutMs,
      maxAttempts: 1,
    },
    preferences: { latency: 100, cost: 100 },
  };
}

type ExecutorFailureResult = ExecutorRunResult<never>;

type ModelResolution =
  | { ok: true; model: PiSdkRegisteredModel }
  | { ok: false; result: ExecutorFailureResult };

function resolveExecutionModel(
  target: ExecutionTarget,
  executorId: string,
  registry: ModelRegistry,
): ModelResolution {
  if (target.executorId !== executorId) {
    return {
      ok: false,
      result: {
        ok: false,
        failureClass: "executor-unavailable",
        errorMessage: `Target requires executor '${target.executorId}', not '${executorId}'.`,
      },
    };
  }
  const parsed = parseModelName(target.model);
  if (!parsed) {
    return {
      ok: false,
      result: {
        ok: false,
        failureClass: "model-unavailable",
        errorMessage: `Invalid model name '${target.model}'.`,
      },
    };
  }
  const model = registry.find(parsed.provider, parsed.id);
  return model
    ? { ok: true, model }
    : {
        ok: false,
        result: {
          ok: false,
          failureClass: "model-unavailable",
          errorMessage: `Model '${target.model}' is not registered.`,
        },
      };
}

function signalFailure(signal: AbortSignal | undefined): ExecutorFailureResult {
  return {
    ok: false,
    failureClass: classifyPiFailure(signal?.reason, signal),
  };
}

function progressListener(onProgress: ((message: string) => void) | undefined) {
  return (value: unknown): void => {
    if (!onProgress || !value || typeof value !== "object") return;
    const candidate = value as {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    if (
      candidate.type === "message_update" &&
      candidate.assistantMessageEvent?.type === "text_delta" &&
      candidate.assistantMessageEvent.delta
    ) {
      onProgress(candidate.assistantMessageEvent.delta);
    }
  };
}

function resultFromSession<TResult>(
  session: PiSdkSessionLike,
  payload: PiSdkExecutionPayload<TResult>,
  signal: AbortSignal | undefined,
): ExecutorRunResult<TResult | string> {
  const messages = assistantMessages(session.messages);
  const errorMessage = session.agent.state.errorMessage ?? messages.at(-1)?.errorMessage;
  const stopReason = messages.at(-1)?.stopReason;
  const usage = aggregateUsage(messages);
  if (errorMessage || stopReason === "error" || stopReason === "aborted") {
    const message = errorMessage ?? `Pi session stopped with '${stopReason}'.`;
    return {
      ok: false,
      failureClass: stopReason === "aborted" ? "aborted" : classifyPiFailure(message, signal),
      errorMessage: message,
      ...(usage ? { usage } : {}),
    };
  }
  const captured = payload.captureResult?.();
  return {
    ok: true,
    result: captured === undefined ? finalText(messages) : captured,
    ...(usage ? { usage } : {}),
  };
}

async function probePiTarget<TResult>(
  target: ExecutionTarget,
  signal: AbortSignal | undefined,
  execute: (
    request: ExecutorRunRequest<PiSdkExecutionPayload<TResult>>,
  ) => Promise<ExecutorRunResult<TResult | string>>,
): Promise<ExecutorProbeResult> {
  const startedAt = Date.now();
  const result = await execute({
    task: probeTask(30_000),
    target,
    payload: {
      cwd: process.cwd(),
      prompt: "Reply with exactly OK.",
      tools: [],
      systemPrompt: "You are an availability probe. Reply with exactly OK.",
    },
    ...(signal ? { signal } : {}),
  });
  return {
    available: result.ok,
    ...(result.errorMessage ? { reason: result.errorMessage } : {}),
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    checkedAt: new Date().toISOString(),
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

async function checkPiAvailability(
  target: ExecutionTarget,
  executorId: string,
  registry: ModelRegistry,
): Promise<ExecutorAvailability> {
  const checkedAt = new Date().toISOString();
  if (target.executorId !== executorId) {
    return {
      available: false,
      reason: `Target requires executor '${target.executorId}', not '${executorId}'.`,
      checkedAt,
    };
  }
  const parsed = parseModelName(target.model);
  if (!parsed)
    return { available: false, reason: `Invalid model name '${target.model}'.`, checkedAt };
  const model = registry.find(parsed.provider, parsed.id);
  if (!model)
    return { available: false, reason: `Model '${target.model}' is not registered.`, checkedAt };
  try {
    const available = await Promise.resolve(registry.getAvailable());
    const authenticated = available.some(
      (item) => item.provider === parsed.provider && item.id === parsed.id,
    );
    return authenticated
      ? { available: true, checkedAt }
      : {
          available: false,
          reason: `Model '${target.model}' has no available credentials.`,
          checkedAt,
        };
  } catch (error) {
    return {
      available: false,
      reason: `Model availability check failed: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    };
  }
}

async function executePiRequest<TResult>(
  request: ExecutorRunRequest<PiSdkExecutionPayload<TResult>>,
  dependencies: {
    executorId: string;
    modelRegistry: ModelRegistry;
    agentDir: string;
    sessionFactory: PiSdkSessionFactory;
  },
): Promise<ExecutorRunResult<TResult | string>> {
  const resolved = resolveExecutionModel(
    request.target,
    dependencies.executorId,
    dependencies.modelRegistry,
  );
  if (!resolved.ok) return resolved.result;
  if (request.signal?.aborted) return signalFailure(request.signal);

  let session: PiSdkSessionLike | undefined;
  let unsubscribe: (() => void) | undefined;
  const abort = () => {
    if (session) void session.abort();
  };
  try {
    session = await dependencies.sessionFactory({
      target: request.target,
      payload: request.payload,
      model: resolved.model,
      modelRegistry: dependencies.modelRegistry,
      agentDir: dependencies.agentDir,
    });
    request.payload.onSessionCreated?.(session.sessionFile);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) {
      await session.abort();
      return signalFailure(request.signal);
    }
    unsubscribe = session.subscribe(progressListener(request.onProgress));
    await session.prompt(request.payload.prompt);
    return request.signal?.aborted
      ? signalFailure(request.signal)
      : resultFromSession(session, request.payload, request.signal);
  } catch (error) {
    return {
      ok: false,
      failureClass: classifyPiFailure(error, request.signal),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    request.signal?.removeEventListener("abort", abort);
    unsubscribe?.();
    session?.dispose();
  }
}

export class PiSdkExecutor<TResult = unknown>
  implements ExecutorAdapter<PiSdkExecutionPayload<TResult>, TResult | string>
{
  readonly capabilities: ExecutorCapabilities;

  readonly #dependencies: {
    modelRegistry: ModelRegistry;
    agentDir: string;
    sessionFactory: PiSdkSessionFactory;
  };

  constructor(options: PiSdkExecutorOptions) {
    this.capabilities = {
      adapterVersion: 1,
      executorId: options.executorId ?? "pi",
      executorType: "pi-sdk",
      capabilities: ["fresh-session", "custom-tools", "usage", "cancellation"],
      supportsActiveProbe: true,
    };
    this.#dependencies = {
      modelRegistry: options.modelRegistry,
      agentDir: options.agentDir ?? getAgentDir(),
      sessionFactory: options.sessionFactory ?? defaultSessionFactory,
    };
  }

  async checkAvailability(target: ExecutionTarget): Promise<ExecutorAvailability> {
    return checkPiAvailability(
      target,
      this.capabilities.executorId,
      this.#dependencies.modelRegistry,
    );
  }

  async probe(target: ExecutionTarget, signal?: AbortSignal): Promise<ExecutorProbeResult> {
    return probePiTarget<TResult>(target, signal, (request) => this.execute(request));
  }

  async execute(
    request: ExecutorRunRequest<PiSdkExecutionPayload<TResult>>,
  ): Promise<ExecutorRunResult<TResult | string>> {
    return executePiRequest(request, {
      executorId: this.capabilities.executorId,
      ...this.#dependencies,
    });
  }
}
