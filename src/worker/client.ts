import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { createStarterSupervisorConfig } from "../config/starter.js";
import type { AgentJobCapability } from "../contracts/jobs.js";
import { AttemptCleanupManager } from "./cleanup.js";
import { terminateOwnedProcessTree } from "./process-tree.js";
import {
  AGENT_WORKER_PROTOCOL_VERSION,
  type AgentWorkerAttemptRequest,
  type AgentWorkerAttemptResult,
  type AgentWorkerCapabilityManifest,
  type AgentWorkerLifecycleEvent,
  AgentWorkerProtocolError,
  type AgentWorkerRunCapsule,
  assertFrameSize,
  assertValidWorkerAttemptRequest,
  encodedFrameBytes,
  isToolCallFrame,
  isWorkerHelloFrame,
  isWorkerTerminalFrame,
  matchesWorkerIdentity,
  type ParentToWorkerFrame,
  type WorkerToParentFrame,
} from "./protocol.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;

export interface AgentWorkerClientOptions {
  workerPath?: string | undefined;
  environment?: Readonly<Record<string, string>> | undefined;
  startupTimeoutMs?: number | undefined;
  stderrLimitBytes?: number | undefined;
  cooperativeAbortGraceMs?: number | undefined;
  processExitGraceMs?: number | undefined;
  cleanupManager?: AttemptCleanupManager | undefined;
}

type WorkerHello = Extract<WorkerToParentFrame, { type: "worker.hello" }>;
type WorkerTerminal = Extract<WorkerToParentFrame, { type: "worker.terminal" }>;
type WorkerToolCall = Extract<WorkerToParentFrame, { type: "tool.call" }>;

interface WorkerState {
  hello?: WorkerHello;
  terminal?: WorkerTerminal;
  failure?: AgentWorkerProtocolError;
  toolCalls: number;
  pendingToolCalls: number;
  stderr: string;
}

interface PreparedAttempt {
  request: AgentWorkerAttemptRequest;
  capsule: AgentWorkerRunCapsule;
  capabilities: ReadonlyMap<string, AgentJobCapability>;
}

interface WorkerProcessOptions {
  workerPath: string;
  environment: Readonly<Record<string, string>>;
  startupTimeoutMs: number;
  stderrLimitBytes: number;
  cooperativeAbortGraceMs: number;
  processExitGraceMs: number;
  cleanupManager: AttemptCleanupManager;
}

function capabilityManifests(
  capabilities: readonly AgentJobCapability[],
): AgentWorkerCapabilityManifest[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  return capabilities.map((capability) => {
    if (!capability.capabilityId.trim() || !capability.toolName.trim()) {
      throw new AgentWorkerProtocolError(
        "invalid_protocol",
        "Capability id and tool name must be non-empty.",
      );
    }
    if (ids.has(capability.capabilityId) || names.has(capability.toolName)) {
      throw new AgentWorkerProtocolError(
        "invalid_protocol",
        `Capability '${capability.capabilityId}/${capability.toolName}' is duplicated.`,
      );
    }
    ids.add(capability.capabilityId);
    names.add(capability.toolName);
    if (!Number.isFinite(encodedFrameBytes(capability.parameters))) {
      throw new AgentWorkerProtocolError(
        "invalid_protocol",
        `Capability '${capability.capabilityId}' parameters are not serializable.`,
      );
    }
    return {
      capabilityId: capability.capabilityId,
      toolName: capability.toolName,
      label: capability.label,
      description: capability.description,
      parameters: capability.parameters,
    };
  });
}

function prepareAttempt(request: AgentWorkerAttemptRequest): PreparedAttempt {
  assertValidWorkerAttemptRequest(request);
  const manifests = capabilityManifests(request.capabilities);
  const capsule: AgentWorkerRunCapsule = { ...request.capsule, capabilities: manifests };
  const payloadBytes = encodedFrameBytes(capsule);
  if (payloadBytes > request.capsule.limits.maxRunPayloadBytes) {
    throw new AgentWorkerProtocolError(
      "payload_too_large",
      `Worker run payload is ${Number.isFinite(payloadBytes) ? payloadBytes : "not serializable"} bytes; limit is ${request.capsule.limits.maxRunPayloadBytes}.`,
    );
  }
  return {
    request,
    capsule,
    capabilities: new Map(
      request.capabilities.map((capability) => [capability.capabilityId, capability]),
    ),
  };
}

function lifecycleEvent(
  request: AgentWorkerAttemptRequest,
  type: AgentWorkerLifecycleEvent["type"],
  extra: Partial<AgentWorkerLifecycleEvent> = {},
): AgentWorkerLifecycleEvent {
  return {
    type,
    jobId: request.identity.jobId,
    attemptId: request.identity.attemptId,
    at: new Date().toISOString(),
    ...extra,
  };
}

function boundedAppend(current: string, chunk: unknown, maximum: number): string {
  if (Buffer.byteLength(current, "utf8") >= maximum) return current;
  const appended = `${current}${String(chunk)}`;
  if (Buffer.byteLength(appended, "utf8") <= maximum) return appended;
  return Buffer.from(appended, "utf8").subarray(0, maximum).toString("utf8");
}

function sendFrame(child: ChildProcess, frame: ParentToWorkerFrame, maximum: number): void {
  assertFrameSize(frame, maximum, frame.type);
  if (!child.connected) {
    throw new AgentWorkerProtocolError("worker_disconnected", "Worker IPC is disconnected.");
  }
  child.send(frame, (error) => {
    if (error) child.emit("error", error);
  });
}

function capabilityIsActive(request: AgentWorkerAttemptRequest): boolean {
  try {
    return (
      !request.signal?.aborted &&
      request.isActive() &&
      Date.now() < Date.parse(request.capsule.deadlineAt)
    );
  } catch {
    return false;
  }
}

function capabilityArgumentsMatch(
  capability: AgentJobCapability,
  argumentsValue: unknown,
): boolean {
  try {
    return Value.Check(capability.parameters as TSchema, argumentsValue);
  } catch {
    return false;
  }
}

function workerEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.PI_AGENT_ROUTER_TEST_MODE;
  delete environment.PI_AGENT_ROUTER_TEST_FAULT;
  return { ...environment, ...overrides };
}

function asProtocolError(error: unknown, fallback: "invalid_protocol" | "worker_disconnected") {
  return error instanceof AgentWorkerProtocolError
    ? error
    : new AgentWorkerProtocolError(
        fallback,
        error instanceof Error ? error.message : String(error),
      );
}

class WorkerAttemptController {
  readonly #prepared: PreparedAttempt;
  readonly #options: WorkerProcessOptions;
  readonly #capabilityController = new AbortController();
  readonly #state: WorkerState = { toolCalls: 0, pendingToolCalls: 0, stderr: "" };
  #child!: ChildProcess;
  #startupTimer!: ReturnType<typeof setTimeout>;
  #resolve!: (value: AgentWorkerAttemptResult) => void;
  #reject!: (reason: unknown) => void;
  #settled = false;
  #pendingCancelReason: string | undefined;

  constructor(prepared: PreparedAttempt, options: WorkerProcessOptions) {
    this.#prepared = prepared;
    this.#options = options;
  }

  run(): Promise<AgentWorkerAttemptResult> {
    const { request } = this.#prepared;
    this.#child = fork(this.#options.workerPath, [], {
      cwd: request.capsule.attemptRoot,
      env: workerEnvironment(this.#options.environment),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    });
    this.#emit("spawned", this.#child.pid ? { processId: this.#child.pid } : {});
    this.#wireProcess();
    this.#startupTimer = setTimeout(() => this.#failStartTimeout(), this.#options.startupTimeoutMs);
    this.#startupTimer.unref?.();
    request.signal?.addEventListener("abort", this.#abort, { once: true });
    if (request.signal?.aborted) this.#abort();
    return new Promise<AgentWorkerAttemptResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  #wireProcess(): void {
    this.#child.stderr?.on("data", (chunk) => {
      this.#state.stderr = boundedAppend(this.#state.stderr, chunk, this.#options.stderrLimitBytes);
    });
    this.#child.on("message", (value: unknown) => this.#handleMessage(value));
    this.#child.once("error", (error) => {
      this.#fail(new AgentWorkerProtocolError("worker_disconnected", error.message));
    });
    this.#child.once("exit", () => this.#handleExit());
  }

  #handleMessage(value: unknown): void {
    try {
      assertFrameSize(value, this.#prepared.request.capsule.limits.maxFrameBytes, "worker frame");
      if (isWorkerHelloFrame(value)) {
        this.#handleHello(value);
        return;
      }
      if (!this.#state.hello) {
        throw new AgentWorkerProtocolError("invalid_protocol", "Worker sent data before hello.");
      }
      if (isToolCallFrame(value)) {
        this.#handleToolCall(value);
        return;
      }
      if (isWorkerTerminalFrame(value)) {
        this.#handleTerminal(value);
        return;
      }
      throw new AgentWorkerProtocolError("invalid_protocol", "Malformed worker frame.");
    } catch (error) {
      this.#fail(asProtocolError(error, "invalid_protocol"));
    }
  }

  #handleHello(frame: WorkerHello): void {
    if (this.#state.hello || frame.processId !== this.#child.pid) {
      throw new AgentWorkerProtocolError("invalid_protocol", "Invalid worker hello frame.");
    }
    this.#state.hello = frame;
    clearTimeout(this.#startupTimer);
    this.#emit("ready", { processId: frame.processId });
    sendFrame(
      this.#child,
      {
        protocolVersion: 1,
        type: "worker.run",
        nonce: frame.nonce,
        ...this.#prepared.request.identity,
        capsule: this.#prepared.capsule,
      },
      this.#prepared.request.capsule.limits.maxFrameBytes,
    );
    if (this.#pendingCancelReason !== undefined) this.#sendCancel();
  }

  #handleToolCall(frame: WorkerToolCall): void {
    this.#assertFrameIdentity(frame);
    const capability = this.#prepared.capabilities.get(frame.capabilityId);
    if (!capability || capability.toolName !== frame.toolName) {
      throw new AgentWorkerProtocolError(
        "capability_unknown",
        `Worker requested unauthorized capability '${frame.capabilityId}/${frame.toolName}'.`,
      );
    }
    this.#state.toolCalls += 1;
    const limits = this.#prepared.request.capsule.limits;
    if (
      this.#state.toolCalls > limits.maxToolCalls ||
      this.#state.pendingToolCalls >= limits.maxPendingToolCalls
    ) {
      throw new AgentWorkerProtocolError("capability_limit", "Worker capability limit exceeded.");
    }
    assertFrameSize(frame.arguments, limits.maxToolArgumentBytes, "tool arguments");
    if (!capabilityIsActive(this.#prepared.request)) {
      throw new AgentWorkerProtocolError(
        "capability_revoked",
        `Capability '${frame.capabilityId}' is no longer active.`,
      );
    }
    if (!capabilityArgumentsMatch(capability, frame.arguments)) {
      throw new AgentWorkerProtocolError(
        "capability_schema",
        `Capability '${frame.capabilityId}' arguments do not match its schema.`,
      );
    }
    this.#state.pendingToolCalls += 1;
    this.#emit("tool_call", { toolName: frame.toolName });
    void this.#invokeCapability(frame, capability);
  }

  async #invokeCapability(frame: WorkerToolCall, capability: AgentJobCapability): Promise<void> {
    try {
      const result = await capability.invoke(frame.arguments, this.#capabilityController.signal);
      if (this.#state.failure || this.#settled) return;
      assertFrameSize(
        result,
        this.#prepared.request.capsule.limits.maxToolResultBytes,
        "tool result",
      );
      this.#sendToolResult(frame, { ok: true, result });
    } catch (error) {
      if (this.#state.failure || this.#settled) return;
      if (error instanceof AgentWorkerProtocolError) {
        this.#fail(error);
        return;
      }
      this.#sendToolResult(frame, {
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      });
    } finally {
      this.#state.pendingToolCalls -= 1;
    }
  }

  #sendToolResult(
    frame: WorkerToolCall,
    outcome: { ok: true; result: unknown } | { ok: false; error: string },
  ): void {
    try {
      sendFrame(
        this.#child,
        {
          protocolVersion: 1,
          type: "tool.result",
          nonce: frame.nonce,
          ...this.#prepared.request.identity,
          callId: frame.callId,
          ...outcome,
        },
        this.#prepared.request.capsule.limits.maxFrameBytes,
      );
    } catch (error) {
      this.#fail(asProtocolError(error, "worker_disconnected"));
    }
  }

  #handleTerminal(frame: WorkerTerminal): void {
    this.#assertFrameIdentity(frame);
    if (this.#state.terminal) {
      throw new AgentWorkerProtocolError("invalid_protocol", "Duplicate worker terminal frame.");
    }
    this.#state.terminal = frame;
    this.#emit("terminal", { status: frame.status });
  }

  #assertFrameIdentity(frame: WorkerToolCall | WorkerTerminal): void {
    if (
      frame.nonce === this.#state.hello?.nonce &&
      matchesWorkerIdentity(frame, this.#prepared.request.identity)
    ) {
      return;
    }
    throw new AgentWorkerProtocolError("identity_mismatch", "Worker frame identity mismatch.");
  }

  #abort = (): void => {
    this.#pendingCancelReason = String(this.#prepared.request.signal?.reason ?? "caller-aborted");
    if (this.#state.hello) this.#sendCancel();
  };

  #sendCancel(): void {
    const hello = this.#state.hello;
    if (!hello) return;
    try {
      sendFrame(
        this.#child,
        {
          protocolVersion: 1,
          type: "worker.cancel",
          nonce: hello.nonce,
          ...this.#prepared.request.identity,
          reason: this.#pendingCancelReason ?? "caller-aborted",
        },
        this.#prepared.request.capsule.limits.maxFrameBytes,
      );
    } catch (error) {
      this.#fail(asProtocolError(error, "worker_disconnected"));
    }
  }

  #failStartTimeout(): void {
    this.#fail(
      new AgentWorkerProtocolError(
        "worker_start_timeout",
        `Worker did not complete its V${AGENT_WORKER_PROTOCOL_VERSION} handshake in time.`,
      ),
    );
  }

  #fail(error: AgentWorkerProtocolError): void {
    if (this.#settled || this.#state.failure) return;
    this.#state.failure = error;
    this.#capabilityController.abort(error);
    if (this.#child.connected) this.#child.disconnect();
    this.#child.kill();
  }

  #handleExit(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#cleanup();
    this.#emit("exited", this.#child.pid ? { processId: this.#child.pid } : {});
    if (this.#state.failure) {
      this.#reject(this.#state.failure);
      return;
    }
    if (!this.#state.hello || !this.#state.terminal) {
      this.#reject(
        new AgentWorkerProtocolError(
          "worker_disconnected",
          `Worker exited without a terminal frame. stderr=${this.#state.stderr.slice(0, 2_000)}`,
        ),
      );
      return;
    }
    this.#resolve(this.#result(this.#state.hello, this.#state.terminal));
  }

  #result(hello: WorkerHello, terminal: WorkerTerminal): AgentWorkerAttemptResult {
    return {
      identity: { ...this.#prepared.request.identity },
      processId: hello.processId,
      workerNonce: hello.nonce,
      status: terminal.status,
      ...(terminal.result !== undefined ? { result: terminal.result } : {}),
      ...(terminal.usage ? { usage: terminal.usage } : {}),
      ...(terminal.failure ? { failure: terminal.failure } : {}),
      stderr: this.#state.stderr,
    };
  }

  #cleanup(): void {
    clearTimeout(this.#startupTimer);
    this.#prepared.request.signal?.removeEventListener("abort", this.#abort);
    this.#capabilityController.abort("worker-finished");
  }

  #emit(
    type: AgentWorkerLifecycleEvent["type"],
    extra: Partial<AgentWorkerLifecycleEvent> = {},
  ): void {
    this.#prepared.request.onLifecycleEvent?.(lifecycleEvent(this.#prepared.request, type, extra));
  }
}

export class AgentWorkerClient {
  readonly #options: WorkerProcessOptions;

  constructor(options: AgentWorkerClientOptions = {}) {
    this.#options = {
      workerPath:
        options.workerPath ?? fileURLToPath(new URL("./agent-worker.mjs", import.meta.url)),
      environment: options.environment ?? {},
      startupTimeoutMs: Math.max(1, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS),
      stderrLimitBytes: Math.max(1_024, options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES),
    };
  }

  async runAttempt(request: AgentWorkerAttemptRequest): Promise<AgentWorkerAttemptResult> {
    return await new WorkerAttemptController(prepareAttempt(request), this.#options).run();
  }
}
