import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type AgentRouterConfig, type CandidateConfig, loadRouterConfig } from "../config/index.js";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import type { FeedbackRecord, RouteEventSink } from "../contracts/events.js";
import type { ExecutionTarget } from "../contracts/routing.js";
import { type TaskContract, THINKING_LEVELS, type ThinkingLevel } from "../contracts/task.js";
import {
  ExecutorRegistry,
  executeRoutedTask,
  type OutputContractRegistry,
  PiSdkExecutor,
  type PiSdkRegisteredModel,
  PiSdkRouteJudge,
  type PiSdkSessionFactory,
  type RoutedExecutionResult,
} from "../execution/index.js";
import {
  type DoctorMode,
  type DoctorProbe,
  type DoctorReport,
  getAgentRouterHealthPath,
  type HealthState,
  healthSnapshot,
  loadHealthState,
  runDoctor,
  saveHealthState,
} from "../health/index.js";
import {
  buildRouteAudit,
  CompositeRouteEventSink,
  type RouteAuditRecord,
} from "../observability/index.js";
import type { CandidateSnapshot, JudgeRanking, RouteJudge } from "../routing/index.js";

export interface CreateAgentRouterRuntimeOptions {
  modelRegistry: ModelRegistry;
  cwd?: string;
  configPath?: string;
  healthPath?: string;
  eventSink?: RouteEventSink;
  piSessionFactory?: PiSdkSessionFactory;
}

export interface RuntimeExecutionOptions<TPayload> {
  task: TaskContract;
  outputContracts: OutputContractRegistry;
  createPayload(
    target: ExecutionTarget,
    attemptNumber: number,
    signal: AbortSignal,
  ): Promise<TPayload> | TPayload;
  eventSink?: RouteEventSink;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface RuntimeExecutionResult<TResult> extends RoutedExecutionResult<TResult> {
  audit: RouteAuditRecord;
}

export interface AgentRouterStatus {
  configPath: string;
  healthPath: string;
  configHash: string;
  routerTargets: AgentRouterConfig["router"]["targets"];
  candidates: Array<{
    candidateId: string;
    executorId: string;
    model: string;
    enabled: boolean;
    available: boolean;
    health: string;
    reason?: string;
  }>;
  diagnostics: RouterDiagnostic[];
}

export interface RuntimeDoctorResult {
  report: DoctorReport;
  diagnostics: RouterDiagnostic[];
}

export class AgentRouterSetupError extends Error {
  constructor(readonly diagnostics: RouterDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; ") || "Agent Router setup failed.");
    this.name = "AgentRouterSetupError";
  }
}

function parseModel(value: string): { provider: string; id: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function supportedThinkingLevels(model: PiSdkRegisteredModel | undefined): ThinkingLevel[] {
  if (!model) return [];
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

function mergeHealthStates(current: HealthState, incoming: HealthState): HealthState {
  const entries = new Map(current.entries.map((entry) => [entry.candidateId, entry]));
  for (const entry of incoming.entries) {
    const previous = entries.get(entry.candidateId);
    if (!previous || Date.parse(entry.checkedAt) >= Date.parse(previous.checkedAt)) {
      entries.set(entry.candidateId, entry);
    }
  }
  return {
    version: 1,
    configHash: current.configHash,
    updatedAt:
      Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
        ? incoming.updatedAt
        : current.updatedAt,
    entries: [...entries.values()].sort((left, right) =>
      left.candidateId.localeCompare(right.candidateId),
    ),
  };
}

function boundedTask(task: TaskContract, config: AgentRouterConfig): TaskContract {
  return {
    ...task,
    budget: {
      routeTimeoutMs: Math.min(task.budget.routeTimeoutMs, config.router.overallTimeoutMs),
      attemptTimeoutMs: Math.min(task.budget.attemptTimeoutMs, config.execution.attemptTimeoutMs),
      overallTimeoutMs: Math.min(task.budget.overallTimeoutMs, config.execution.overallTimeoutMs),
      maxAttempts: Math.min(task.budget.maxAttempts, config.execution.maxAttempts),
    },
  };
}

export class AgentRouterRuntime {
  readonly config: AgentRouterConfig;
  readonly configHash: string;
  readonly configPath: string;
  readonly healthPath: string;
  readonly diagnostics: RouterDiagnostic[];
  readonly executors: ExecutorRegistry;

  readonly #modelRegistry: ModelRegistry;
  readonly #cwd: string;
  readonly #eventSink: RouteEventSink | undefined;
  readonly #piExecutors: Map<string, PiSdkExecutor<JudgeRanking>>;
  readonly #judges: RouteJudge[];
  #healthState: HealthState;
  #saveQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    modelRegistry: ModelRegistry;
    cwd: string;
    config: AgentRouterConfig;
    configHash: string;
    configPath: string;
    healthPath: string;
    healthState: HealthState;
    diagnostics: RouterDiagnostic[];
    eventSink?: RouteEventSink;
    piSessionFactory?: PiSdkSessionFactory;
  }) {
    this.#modelRegistry = options.modelRegistry;
    this.#cwd = options.cwd;
    this.config = options.config;
    this.configHash = options.configHash;
    this.configPath = options.configPath;
    this.healthPath = options.healthPath;
    this.#healthState = options.healthState;
    this.diagnostics = options.diagnostics;
    this.#eventSink = options.eventSink;
    this.executors = new ExecutorRegistry();
    this.#piExecutors = new Map();
    for (const configured of this.config.executors) {
      if (!configured.enabled) continue;
      const executor = new PiSdkExecutor<JudgeRanking>({
        modelRegistry: this.#modelRegistry,
        executorId: configured.id,
        ...(options.piSessionFactory ? { sessionFactory: options.piSessionFactory } : {}),
      });
      this.executors.register(executor);
      this.#piExecutors.set(configured.id, executor);
    }
    this.#judges = this.config.router.targets.flatMap((target, index) => {
      const executor = this.#piExecutors.get(target.executorId);
      return executor
        ? [
            new PiSdkRouteJudge({
              id: `pi-router-${index + 1}`,
              target,
              executor,
              timeoutMs: this.config.router.attemptTimeoutMs,
              cwd: this.#cwd,
            }),
          ]
        : [];
    });
  }

  static async create(options: CreateAgentRouterRuntimeOptions): Promise<AgentRouterRuntime> {
    const loaded = await loadRouterConfig(options.configPath);
    if (!loaded.ok || !loaded.config || !loaded.configHash) {
      throw new AgentRouterSetupError(loaded.diagnostics);
    }
    const healthPath = options.healthPath ?? getAgentRouterHealthPath();
    const health = await loadHealthState(loaded.configHash, healthPath);
    return new AgentRouterRuntime({
      modelRegistry: options.modelRegistry,
      cwd: options.cwd ?? process.cwd(),
      config: loaded.config,
      configHash: loaded.configHash,
      configPath: loaded.path,
      healthPath,
      healthState: health.state,
      diagnostics: [...loaded.diagnostics, ...health.diagnostics],
      ...(options.eventSink ? { eventSink: options.eventSink } : {}),
      ...(options.piSessionFactory ? { piSessionFactory: options.piSessionFactory } : {}),
    });
  }

  async candidateSnapshots(): Promise<CandidateSnapshot[]> {
    return await Promise.all(this.config.candidates.map((candidate) => this.#snapshot(candidate)));
  }

  async status(): Promise<AgentRouterStatus> {
    const snapshots = await this.candidateSnapshots();
    return {
      configPath: this.configPath,
      healthPath: this.healthPath,
      configHash: this.configHash,
      routerTargets: this.config.router.targets,
      candidates: snapshots.map((snapshot) => ({
        candidateId: snapshot.config.id,
        executorId: snapshot.config.executorId,
        model: snapshot.config.model,
        enabled: snapshot.config.enabled,
        available: snapshot.executorAvailable && snapshot.model.available,
        health: snapshot.health.status,
        ...(snapshot.executorReason || snapshot.model.reason
          ? { reason: snapshot.executorReason ?? snapshot.model.reason }
          : {}),
      })),
      diagnostics: [...this.diagnostics],
    };
  }

  async execute<TResult = unknown, TPayload = unknown>(
    options: RuntimeExecutionOptions<TPayload>,
  ): Promise<RuntimeExecutionResult<TResult>> {
    const task = boundedTask(options.task, this.config);
    const snapshots = await this.candidateSnapshots();
    const eventSink =
      this.#eventSink && options.eventSink
        ? new CompositeRouteEventSink([this.#eventSink, options.eventSink])
        : (options.eventSink ?? this.#eventSink);
    const result = await executeRoutedTask<TResult, TPayload>({
      task,
      snapshots,
      judges: this.#judges,
      executors: this.executors,
      outputContracts: options.outputContracts,
      createPayload: options.createPayload,
      healthState: this.#healthState,
      healthPolicy: this.config.health,
      ...(eventSink ? { eventSink } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    if (result.healthState) await this.#persistHealth(result.healthState, result.diagnostics);
    return {
      ...result,
      audit: buildRouteAudit({ task, outcome: result.outcome, planning: result.planning }),
    };
  }

  async doctor(mode: DoctorMode, signal?: AbortSignal): Promise<RuntimeDoctorResult> {
    const snapshots = await this.candidateSnapshots();
    const probes = this.#doctorProbes(snapshots);
    const report = await runDoctor({
      mode,
      snapshots,
      probes,
      healthState: this.#healthState,
      healthPolicy: this.config.health,
      probeTimeoutMs: this.config.doctor.probeTimeoutMs,
      overallTimeoutMs: this.config.doctor.overallTimeoutMs,
      maxConcurrency: 2,
      ...(signal ? { signal } : {}),
    });
    if (mode === "active") await this.#persistHealth(report.healthState, this.diagnostics);
    return { report, diagnostics: [...this.diagnostics] };
  }

  async recordFeedback(value: FeedbackRecord): Promise<void> {
    await this.#eventSink?.recordFeedback?.(value);
  }

  async #snapshot(candidate: CandidateConfig): Promise<CandidateSnapshot> {
    const executor = this.executors.get(candidate.executorId);
    const parsed = parseModel(candidate.model);
    const model = parsed ? this.#modelRegistry.find(parsed.provider, parsed.id) : undefined;
    const target: ExecutionTarget = {
      candidateId: candidate.id,
      executorId: candidate.executorId,
      model: candidate.model,
      thinkingLevel: candidate.allowedThinkingLevels[0] ?? "off",
    };
    const availability = executor
      ? await executor.checkAvailability(target)
      : {
          available: false,
          reason: `Executor '${candidate.executorId}' is not registered.`,
          checkedAt: new Date().toISOString(),
        };
    return {
      config: candidate,
      executorAvailable: Boolean(executor),
      ...(!executor && availability.reason ? { executorReason: availability.reason } : {}),
      model: {
        available: Boolean(model) && availability.available,
        ...(!availability.available && availability.reason ? { reason: availability.reason } : {}),
        contextWindow: model?.contextWindow ?? 0,
        inputModalities: model?.input ?? [],
        reasoning: model?.reasoning ?? false,
        supportedThinkingLevels: supportedThinkingLevels(model),
        ...(model
          ? {
              cost: {
                input: model.cost.input,
                output: model.cost.output,
                cacheRead: model.cost.cacheRead,
                cacheWrite: model.cost.cacheWrite,
              },
            }
          : {}),
      },
      health: healthSnapshot(this.#healthState, candidate.id),
    };
  }

  #doctorProbes(snapshots: CandidateSnapshot[]): DoctorProbe[] {
    return snapshots.flatMap((snapshot) => {
      const executor = this.executors.get(snapshot.config.executorId);
      const thinkingLevel = snapshot.config.allowedThinkingLevels[0];
      if (!snapshot.config.enabled || !executor?.probe || !thinkingLevel) return [];
      const target: ExecutionTarget = {
        candidateId: snapshot.config.id,
        executorId: snapshot.config.executorId,
        model: snapshot.config.model,
        thinkingLevel,
      };
      return [
        {
          candidateId: snapshot.config.id,
          async run(signal: AbortSignal) {
            const result = await executor.probe?.(target, signal);
            return {
              ok: result?.available ?? false,
              latencyMs: result?.elapsedMs ?? 0,
              ...(result?.failureClass ? { failureClass: result.failureClass } : {}),
              ...(result?.reason ? { message: result.reason } : {}),
            };
          },
        },
      ];
    });
  }

  async #persistHealth(state: HealthState, diagnostics: RouterDiagnostic[]): Promise<void> {
    this.#healthState = mergeHealthStates(this.#healthState, state);
    const snapshot = this.#healthState;
    const pending = this.#saveQueue
      .catch(() => undefined)
      .then(() => saveHealthState(snapshot, this.healthPath));
    this.#saveQueue = pending;
    try {
      await pending;
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        code: "health_persist_failed",
        message: `Could not persist Agent Router health: ${error instanceof Error ? error.message : String(error)}`,
        path: this.healthPath,
      });
    }
  }
}
