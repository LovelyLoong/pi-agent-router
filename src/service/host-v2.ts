import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  getAgentRouterConfigPath,
  type LoadedRouterConfigV2,
  loadRouterConfigV2,
} from "../config/loader.js";
import type { AgentRouterConfigV2 } from "../config/schema.js";
import type {
  AgentJobCapability,
  AgentJobDescriptorV2,
  AgentJobInspectionV2,
  AgentJobResultV2,
  AgentJobTerminalStatus,
} from "../contracts/jobs.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../contracts/task.js";
import { ROUTER_SYSTEM_PROMPT, routerTask } from "../execution/pi-judge.js";
import {
  type CandidateSnapshot,
  filterCandidates,
  type RoutableCandidate,
} from "../routing/filter.js";
import {
  buildRouterJudgeInput,
  type JudgeRanking,
  JudgeRankingSchema,
  parseJudgeRanking,
  type RouterJudgeInput,
} from "../routing/judge.js";
import {
  type AgentJobAdmission,
  AgentJobSupervisorCore,
  SupervisorAdmissionError,
  type SupervisorCancellationRequest,
  type SupervisorMutationResult,
} from "../supervisor/index.js";
import { AttemptCleanupManager } from "../worker/cleanup.js";
import {
  type AgentWorkerAttemptRequest,
  type AgentWorkerAttemptResult,
  AgentWorkerClient,
  type AgentWorkerLifecycleEvent,
} from "../worker/index.js";
import {
  AGENT_ROUTER_DISCOVERY_TOPIC_V2,
  AGENT_ROUTER_JOB_AUDIT_TOPIC_V2,
  AGENT_ROUTER_PACKAGE_VERSION,
  AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2,
  AGENT_ROUTER_SERVICE_ID,
  AGENT_ROUTER_SERVICE_V2_CAPABILITIES,
  AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2,
  type AgentJobStreamV2,
  type AgentRouterConfigurationStatusV2,
  type AgentRouterJanitorResultV2,
  type AgentRouterJobAuditQueryV2,
  type AgentRouterJobAuditRecordV2,
  type AgentRouterJobCleanupV2,
  type AgentRouterJobInspectionV2,
  type AgentRouterJobTreeNodeV2,
  type AgentRouterServiceCancelRequestV2,
  type AgentRouterServiceEventBus,
  type AgentRouterServiceJobQueryV2,
  type AgentRouterServiceJobRequestV2,
  type AgentRouterServiceV2,
  type AgentRouterSupervisorDoctorV2,
  type AgentRouterSupervisorStatusV2,
  isAgentRouterDiscoveryRequestV2,
} from "./contracts.js";
import { ManagedAgentJobStream } from "./job-stream.js";

export interface AgentRouterSelectedTargetV2 {
  candidateId: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

interface WorkerClientLike {
  runAttempt(request: AgentWorkerAttemptRequest): Promise<AgentWorkerAttemptResult>;
}

export interface RegisterAgentRouterServiceV2Options {
  configPath?: string | undefined;
  configAgentDir?: string | undefined;
  packageVersion?: string | undefined;
  instanceId?: string | undefined;
  loadConfiguration?: (() => Promise<LoadedRouterConfigV2>) | undefined;
  workerClient?: WorkerClientLike | undefined;
  cleanupManager?: AttemptCleanupManager | undefined;
  createAttemptRoot?: ((jobId: string, attemptId: string) => Promise<string>) | undefined;
  selectTarget?:
    | ((
        request: AgentRouterServiceJobRequestV2,
        config: AgentRouterConfigV2,
      ) => Promise<AgentRouterSelectedTargetV2>)
    | undefined;
}

export interface RegisteredAgentRouterServiceV2 {
  service: AgentRouterServiceV2;
  releaseOwner(ownerId: string): Promise<number>;
  dispose(reason?: string): Promise<void>;
}

interface ManagedJob {
  request: AgentRouterServiceJobRequestV2;
  stream: ManagedAgentJobStream<unknown>;
  abortController: AbortController;
  accepted: boolean;
  finished: boolean;
  removeCallerAbort?: (() => void) | undefined;
  target?: AgentRouterSelectedTargetV2 | undefined;
  queuedAt?: string | undefined;
  processState: "not-started" | "running" | "exited";
  cancellationReason?: AgentRouterServiceCancelRequestV2["reason"] | undefined;
  cleanup?: AgentRouterJobCleanupV2 | undefined;
  failureCode?: string | undefined;
  processEscalated: boolean;
  processExited: boolean;
  lifecycle: Array<{ type: string; at: string }>;
  validateSuccess?: (() => boolean) | undefined;
}

function configurationState(
  loaded: LoadedRouterConfigV2,
): AgentRouterConfigurationStatusV2["state"] {
  if (loaded.ok) return "configured";
  if (loaded.diagnostics.some((item) => item.code === "config_migration_required")) {
    return "migration-required";
  }
  if (loaded.diagnostics.some((item) => item.code === "config_missing")) return "missing";
  return "invalid";
}

function configurationStatus(loaded: LoadedRouterConfigV2): AgentRouterConfigurationStatusV2 {
  return {
    state: configurationState(loaded),
    path: loaded.path,
    admissionAuthority: "explicit-config-only",
    setupCommand: "/agent-router setup",
    doctorCommand: "/agent-router doctor",
    migrationCommand: "/agent-router migrate-v2",
    diagnostics: [...loaded.diagnostics],
    ...(loaded.configHash ? { configHash: loaded.configHash } : {}),
    ...(loaded.config
      ? {
          configVersion: 2 as const,
          candidateCount: loaded.config.candidates.length,
          routerTargetCount: loaded.config.router.targets.length,
        }
      : {}),
  };
}

function splitModel(value: string): { provider: string; modelId: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function supportedThinkingLevels(model: ReturnType<ModelRegistry["find"]>): ThinkingLevel[] {
  if (!model) return [];
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

function candidateSnapshots(
  request: AgentRouterServiceJobRequestV2,
  config: AgentRouterConfigV2,
): CandidateSnapshot[] {
  const enabledExecutors = new Set(
    config.executors.flatMap((executor) => (executor.enabled ? [executor.id] : [])),
  );
  return config.candidates.map((candidate) => {
    const parsed = splitModel(candidate.model);
    const model = parsed ? request.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
    return {
      config: candidate,
      executorAvailable: enabledExecutors.has(candidate.executorId),
      ...(!enabledExecutors.has(candidate.executorId)
        ? { executorReason: `Executor '${candidate.executorId}' is disabled or missing.` }
        : {}),
      model: {
        available: Boolean(model),
        ...(!model ? { reason: `Configured model '${candidate.model}' is unavailable.` } : {}),
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
      health: { status: "healthy" as const },
    };
  });
}

function selectStaticTarget(
  request: AgentRouterServiceJobRequestV2,
  config: AgentRouterConfigV2,
): AgentRouterSelectedTargetV2 {
  const filtered = filterCandidates(
    request.job.descriptor.task,
    candidateSnapshots(request, config),
  );
  const selected = filtered.candidates[0];
  const thinkingLevel = selected?.thinkingLevels[0];
  const parsed = selected ? splitModel(selected.candidate.model) : undefined;
  if (!selected || !thinkingLevel || !parsed) {
    const reason = filtered.rejections.map((rejection) => rejection.code).join(", ");
    throw new Error(`No routable V2 worker target is available${reason ? ` (${reason})` : ""}.`);
  }
  return {
    candidateId: selected.candidate.id,
    provider: parsed.provider,
    modelId: parsed.modelId,
    thinkingLevel,
  };
}

function ownerHash(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex");
}

function processIdentityHash(jobId: string, attemptId: string, processId: number): string {
  return createHash("sha256").update(`${jobId}:${attemptId}:${processId}`).digest("hex");
}

function emptyCleanup(jobId: string): AgentRouterJobCleanupV2 {
  return {
    ok: true,
    attempts: 0,
    retained: false,
    quarantined: false,
    pathHash: createHash("sha256").update(`no-attempt:${jobId}`).digest("hex"),
  };
}

function mapWorkerStatus(
  result: AgentWorkerAttemptResult,
  cancellationReason: AgentRouterServiceCancelRequestV2["reason"] | undefined,
): AgentJobTerminalStatus {
  if (result.status === "cleanup_failed") return "cleanup_failed";
  if (result.status === "succeeded") return "succeeded";
  if (result.status === "failed") return "failed";
  if (cancellationReason === "deadline") return "timed_out";
  if (cancellationReason === "shutdown") return "service_drained";
  return "cancelled";
}

function supervisorCancellationReason(
  reason: AgentRouterServiceCancelRequestV2["reason"],
): SupervisorCancellationRequest["reason"] {
  if (reason === "owner-ended" || reason === "deadline" || reason === "shutdown") return reason;
  return "operator";
}

function boundedLimit(value: number | undefined, fallback = 100): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1_000, Math.floor(value as number)));
}

async function waitWithTimeout(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Supervisor drain exceeded its ${timeoutMs}ms deadline.`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([Promise.allSettled(promises), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class AgentRouterServiceDomainV2 {
  readonly #config: AgentRouterConfigV2;
  readonly #configAgentDir: string;
  readonly #cleanupManager: AttemptCleanupManager;
  readonly #workerClient: WorkerClientLike;
  readonly #createAttemptRoot: (jobId: string, attemptId: string) => Promise<string>;
  readonly #selectTarget:
    | ((
        request: AgentRouterServiceJobRequestV2,
        config: AgentRouterConfigV2,
      ) => Promise<AgentRouterSelectedTargetV2>)
    | undefined;
  readonly #supervisor: AgentJobSupervisorCore;
  readonly #onAudit: ((record: AgentRouterJobAuditRecordV2) => void) | undefined;
  readonly #onStatus: ((status: AgentRouterSupervisorStatusV2) => void) | undefined;
  readonly #jobs = new Map<string, ManagedJob>();
  readonly #audits: AgentRouterJobAuditRecordV2[] = [];
  #drainPromise: Promise<void> | undefined;

  constructor(options: {
    config: AgentRouterConfigV2;
    configAgentDir: string;
    workerClient?: WorkerClientLike | undefined;
    cleanupManager?: AttemptCleanupManager | undefined;
    createAttemptRoot?: ((jobId: string, attemptId: string) => Promise<string>) | undefined;
    selectTarget?:
      | ((
          request: AgentRouterServiceJobRequestV2,
          config: AgentRouterConfigV2,
        ) => Promise<AgentRouterSelectedTargetV2>)
      | undefined;
    onAudit?: ((record: AgentRouterJobAuditRecordV2) => void) | undefined;
    onStatus?: ((status: AgentRouterSupervisorStatusV2) => void) | undefined;
  }) {
    this.#config = structuredClone(options.config);
    this.#configAgentDir = options.configAgentDir;
    this.#cleanupManager =
      options.cleanupManager ?? new AttemptCleanupManager(this.#config.supervisor.cleanup);
    this.#workerClient =
      options.workerClient ??
      new AgentWorkerClient({
        cooperativeAbortGraceMs: this.#config.supervisor.deadlines.cooperativeAbortGraceMs,
        processExitGraceMs: this.#config.supervisor.deadlines.processExitGraceMs,
        cleanupManager: this.#cleanupManager,
      });
    this.#createAttemptRoot =
      options.createAttemptRoot ??
      (async () => await mkdtemp(join(tmpdir(), "pi-agent-router-attempt-")));
    this.#selectTarget = options.selectTarget;
    this.#onAudit = options.onAudit;
    this.#onStatus = options.onStatus;
    this.#supervisor = new AgentJobSupervisorCore({
      config: this.#config.supervisor,
      onTimedMutation: (result) => this.#processMutation(result),
    });
  }

  start<TResult, TPayload>(
    request: AgentRouterServiceJobRequestV2<TPayload>,
    stream: ManagedAgentJobStream<TResult>,
  ): void {
    const jobId = request.job.descriptor.jobId;
    const declaredCapabilities = [...request.job.descriptor.capabilityNames].sort((left, right) =>
      left.localeCompare(right),
    );
    const suppliedCapabilities = (request.job.execution.capabilities ?? [])
      .map((capability) => capability.toolName)
      .sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(declaredCapabilities) !== JSON.stringify(suppliedCapabilities)) {
      stream.fail(
        new Error(`Job '${jobId}' capability names do not match its private capability set.`),
      );
      return;
    }
    if (request.job.descriptor.owner.kind !== "service" && !request.job.signal) {
      stream.fail(
        new Error(
          `Owner-bound job '${jobId}' requires a caller, session, or connection AbortSignal.`,
        ),
      );
      return;
    }
    if (this.#jobs.has(jobId)) {
      stream.fail(
        new SupervisorAdmissionError("job_duplicate", `Job '${jobId}' already exists.`, jobId),
      );
      return;
    }
    const managed: ManagedJob = {
      request: request as AgentRouterServiceJobRequestV2,
      stream: stream as ManagedAgentJobStream<unknown>,
      abortController: new AbortController(),
      accepted: false,
      finished: false,
      processState: "not-started",
      processEscalated: false,
      processExited: false,
      lifecycle: [],
    };
    this.#jobs.set(jobId, managed);
    void this.#admit(managed).catch((error) => {
      if (!managed.accepted) {
        this.#jobs.delete(jobId);
        stream.fail(error);
        return;
      }
      const snapshot = this.#supervisor.getJob(jobId);
      if (snapshot?.terminalStatus || managed.finished) return;
      managed.failureCode = error instanceof Error ? error.name : "route_selection_failed";
      this.#processMutation(this.#supervisor.finishJobWithoutAttempt(jobId, "failed"));
    });
  }

  inspectSupervisor(): AgentRouterSupervisorStatusV2 {
    const snapshot = this.#supervisor.snapshot();
    const active = snapshot.jobs.filter(
      (job) => job.lease !== undefined && job.lease.state !== "released",
    );
    const cleanup = this.#cleanupManager.status();
    return {
      state: cleanup.degraded ? "degraded" : snapshot.state,
      queuedJobs: snapshot.queuedJobIds.length,
      activeFullAgentJobs: active.filter((job) => job.jobClass === "full-agent").length,
      activeCompletionJobs: active.filter((job) => job.jobClass === "completion").length,
      activeControlPlaneJobs: active.filter((job) => job.jobClass === "router-control-plane")
        .length,
      activeOwners: new Set(active.map((job) => job.owner.ownerId)).size,
      quarantinedCleanupItems: cleanup.quarantineCount,
      degradedReasons: [...cleanup.reasons],
    };
  }

  inspectJobs(query: AgentRouterServiceJobQueryV2 = {}): AgentRouterJobInspectionV2[] {
    const includeTerminal = query.includeTerminal ?? false;
    return this.#supervisor
      .snapshot()
      .jobs.filter((job) => !query.jobId || job.jobId === query.jobId)
      .filter((job) => !query.ownerId || job.owner.ownerId === query.ownerId)
      .filter((job) => includeTerminal || !job.terminalStatus)
      .slice(0, boundedLimit(query.limit))
      .map((job) => this.#enrichInspection(job));
  }

  inspectJob(jobId: string): AgentRouterJobInspectionV2 | undefined {
    const job = this.#supervisor.getJob(jobId);
    return job ? this.#enrichInspection(job) : undefined;
  }

  inspectJobTree(query: AgentRouterServiceJobQueryV2 = {}): AgentRouterJobTreeNodeV2[] {
    const jobs = this.inspectJobs({ ...query, includeTerminal: query.includeTerminal ?? true });
    const byId = new Map(jobs.map((job) => [job.jobId, job]));
    const children = new Map<string, AgentRouterJobInspectionV2[]>();
    for (const job of jobs) {
      const parentJobId = job.owner.parentJobId;
      if (!parentJobId || !byId.has(parentJobId)) continue;
      const values = children.get(parentJobId) ?? [];
      values.push(job);
      children.set(parentJobId, values);
    }
    const build = (job: AgentRouterJobInspectionV2): AgentRouterJobTreeNodeV2 => ({
      job,
      children: (children.get(job.jobId) ?? []).map(build),
      dependencies: job.dependencyIds.flatMap((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return dependency ? [dependency] : [];
      }),
    });
    return jobs
      .filter((job) => !job.owner.parentJobId || !byId.has(job.owner.parentJobId))
      .map(build);
  }

  inspectAudit(query: AgentRouterJobAuditQueryV2 = {}): AgentRouterJobAuditRecordV2[] {
    return this.#audits
      .filter((audit) => !query.jobId || audit.jobId === query.jobId)
      .filter((audit) => !query.ownerKind || audit.ownerKind === query.ownerKind)
      .slice(-boundedLimit(query.limit))
      .map((audit) => structuredClone(audit));
  }

  cancelJob(request: AgentRouterServiceCancelRequestV2): boolean {
    const snapshot = this.#supervisor.getJob(request.jobId);
    if (!snapshot || snapshot.terminalStatus) return false;
    const subtree = this.#jobSubtreeIds(request.jobId);
    for (let index = subtree.length - 1; index >= 0; index -= 1) {
      const jobId = subtree[index];
      if (!jobId) continue;
      const childSnapshot = this.#supervisor.getJob(jobId);
      if (!childSnapshot || childSnapshot.terminalStatus) continue;
      const managed = this.#jobs.get(jobId);
      if (managed) {
        managed.cancellationReason ??= request.reason;
        managed.abortController.abort(managed.cancellationReason);
      }
      this.#processMutation(
        this.#supervisor.cancelJob(jobId, supervisorCancellationReason(request.reason)),
      );
    }
    return true;
  }

  releaseOwner(ownerId: string): number {
    const jobIds = this.#supervisor
      .getOwnedJobIds(ownerId)
      .filter((jobId) => !this.#supervisor.getJob(jobId)?.terminalStatus);
    for (const jobId of jobIds) {
      const managed = this.#jobs.get(jobId);
      if (managed) managed.cancellationReason ??= "owner-ended";
    }
    this.#processMutation(this.#supervisor.releaseOwner(ownerId));
    return jobIds.length;
  }

  async runStartupJanitor(parentRoot: string): Promise<void> {
    await this.#cleanupManager.discoverQuarantine(parentRoot);
    await this.#cleanupManager.runJanitor();
    this.#notifyStatus();
  }

  async runJanitor(): Promise<AgentRouterJanitorResultV2> {
    const result = await this.#cleanupManager.runJanitor();
    this.#notifyStatus();
    return {
      attempted: result.attempted,
      reclaimed: result.removed,
      remaining: result.remaining,
      degraded: this.#cleanupManager.status().degraded,
    };
  }

  doctor(): AgentRouterSupervisorDoctorV2 {
    const supervisor = this.inspectSupervisor();
    const findings: AgentRouterSupervisorDoctorV2["findings"] = [];
    if (supervisor.quarantinedCleanupItems > 0) {
      findings.push({
        code: "cleanup_quarantine_pending",
        severity: "error",
        message: `${supervisor.quarantinedCleanupItems} cleanup item(s) remain quarantined; run /agent-router janitor.`,
      });
    }
    if (supervisor.state === "stopped" && this.#supervisor.snapshot().activeJobIds.length > 0) {
      findings.push({
        code: "stopped_with_active_jobs",
        severity: "error",
        message: "The stopped supervisor still reports active jobs.",
      });
    }
    if (findings.length === 0) {
      findings.push({
        code: "supervisor_lifecycle_ok",
        severity: "info",
        message: "Supervisor lifecycle state is internally consistent.",
      });
    }
    return {
      ok: findings.every((finding) => finding.severity !== "error"),
      inspectedAt: new Date().toISOString(),
      supervisor,
      findings,
    };
  }

  drain(_reason: string): Promise<void> {
    if (this.#drainPromise) return this.#drainPromise;
    const drain = this.#performDrain();
    this.#drainPromise = drain.catch((error) => {
      this.#drainPromise = undefined;
      throw error;
    });
    return this.#drainPromise;
  }

  async #admit(managed: ManagedJob): Promise<void> {
    const { request } = managed;
    const registered = this.#supervisor.registerJob({ descriptor: request.job.descriptor });
    managed.accepted = true;
    managed.queuedAt = new Date().toISOString();
    this.#bindCallerAbort(managed);
    const registeredSnapshot = this.#supervisor.getJob(request.job.descriptor.jobId);
    if (registeredSnapshot) this.#emitJobState(managed, registeredSnapshot.lifecycleState);
    this.#processMutation(registered);
    if (request.job.signal?.aborted) {
      this.cancelJob({ jobId: request.job.descriptor.jobId, reason: "caller-aborted" });
      return;
    }
    await this.#waitForDependencies(managed);
    const ready = this.#supervisor.getJob(request.job.descriptor.jobId);
    if (!ready || ready.terminalStatus || managed.abortController.signal.aborted) return;
    const target = this.#selectTarget
      ? await this.#selectTarget(request, this.#config)
      : await this.#selectSupervisedTarget(managed);
    const current = this.#supervisor.getJob(request.job.descriptor.jobId);
    if (!current || current.terminalStatus) return;
    managed.target = target;
    this.#processMutation(
      this.#supervisor.assignResource(request.job.descriptor.jobId, {
        provider: target.provider,
        model: `${target.provider}/${target.modelId}`,
        candidateId: target.candidateId,
        thinkingLevel: target.thinkingLevel,
      }),
    );
  }

  async #waitForDependencies(managed: ManagedJob): Promise<void> {
    const dependencies = managed.request.job.descriptor.dependencies.dependsOn.flatMap((jobId) => {
      const dependency = this.#jobs.get(jobId);
      return dependency ? [dependency] : [];
    });
    if (dependencies.length === 0 || dependencies.every((dependency) => dependency.finished))
      return;
    const signal = managed.abortController.signal;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      abort = () => resolve();
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([
        Promise.allSettled(dependencies.map((dependency) => dependency.stream.result())),
        cancelled,
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  async #selectSupervisedTarget(managed: ManagedJob): Promise<AgentRouterSelectedTargetV2> {
    const filtered = filterCandidates(
      managed.request.job.descriptor.task,
      candidateSnapshots(managed.request, this.#config),
    );
    if (filtered.candidates.length === 0) {
      return selectStaticTarget(managed.request, this.#config);
    }
    const input = buildRouterJudgeInput(managed.request.job.descriptor.task, filtered.candidates);
    for (const [index, routerTarget] of this.#config.router.targets.entries()) {
      try {
        const ranking = await this.#runRouteJudge(managed, input, index);
        return this.#targetFromRanking(ranking, filtered.candidates);
      } catch {
        if (managed.abortController.signal.aborted)
          throw new Error("Route selection was cancelled.");
        if (!splitModel(routerTarget.model)) continue;
      }
    }
    return selectStaticTarget(managed.request, this.#config);
  }

  async #runRouteJudge(
    parent: ManagedJob,
    input: RouterJudgeInput,
    index: number,
  ): Promise<JudgeRanking> {
    const routerTarget = this.#config.router.targets[index];
    const parsed = routerTarget ? splitModel(routerTarget.model) : undefined;
    if (!routerTarget || !parsed) throw new Error(`Router target ${index + 1} is invalid.`);
    let captured: JudgeRanking | undefined;
    const capability: AgentJobCapability = {
      capabilityId: `rank-routes:${randomUUID()}`,
      toolName: "rank_routes",
      label: "Rank configured routes",
      description: "Return the ordered candidate and thinking-level ranking.",
      parameters: JudgeRankingSchema,
      async invoke(argumentsValue) {
        captured = parseJudgeRanking(argumentsValue);
        return {
          content: [{ type: "text", text: "Route ranking captured." }],
          details: captured,
          terminate: true,
        };
      },
    };
    const now = Date.now();
    const parentDeadline = Date.parse(parent.request.job.descriptor.deadlineAt);
    const deadline = Math.min(parentDeadline, now + this.#config.router.attemptTimeoutMs);
    if (!Number.isFinite(deadline) || deadline <= now) throw new Error("Route deadline expired.");
    const jobId = `route:${randomUUID()}`;
    const descriptor: AgentJobDescriptorV2 = {
      contractVersion: 2,
      jobId,
      submittedAt: new Date(now).toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
      jobClass: "router-control-plane",
      priority: parent.request.job.descriptor.priority,
      owner: {
        ownerId: parent.request.job.descriptor.owner.ownerId,
        kind: parent.request.job.descriptor.owner.kind,
        parentJobId: parent.request.job.descriptor.jobId,
        policy: { mode: "bound" },
      },
      dependencies: { dependsOn: [], onFailure: "skip" },
      isolation: "process",
      retention: { mode: "ephemeral" },
      task: routerTask(input),
      capabilityNames: [capability.toolName],
    };
    const request: AgentRouterServiceJobRequestV2 = {
      modelRegistry: parent.request.modelRegistry,
      cwd: parent.request.cwd,
      job: {
        descriptor,
        execution: {
          payload: {
            kind: "agent",
            prompt: `Rank the configured routes for this minimized input:\n\n${JSON.stringify(input)}`,
            systemPrompt: ROUTER_SYSTEM_PROMPT,
          },
          capabilities: [capability],
        },
        signal: parent.abortController.signal,
      },
    };
    const stream = new ManagedAgentJobStream<unknown>({
      jobId,
      cancelJob: async () => {
        this.cancelJob({ jobId, reason: "caller-aborted" });
      },
      inspectJob: async () => this.inspectJob(jobId),
    });
    const managed: ManagedJob = {
      request,
      stream,
      abortController: new AbortController(),
      accepted: false,
      finished: false,
      target: {
        candidateId: `__router__:${index + 1}`,
        provider: parsed.provider,
        modelId: parsed.modelId,
        thinkingLevel: routerTarget.thinkingLevel,
      },
      processState: "not-started",
      processEscalated: false,
      processExited: false,
      lifecycle: [],
      validateSuccess: () => captured !== undefined,
    };
    this.#jobs.set(jobId, managed);
    try {
      const mutation = this.#supervisor.registerJob({
        descriptor,
        resource: {
          provider: parsed.provider,
          model: routerTarget.model,
          candidateId: `__router__:${index + 1}`,
          thinkingLevel: routerTarget.thinkingLevel,
        },
      });
      managed.accepted = true;
      managed.queuedAt = new Date().toISOString();
      this.#bindCallerAbort(managed);
      const snapshot = this.#supervisor.getJob(jobId);
      if (snapshot) this.#emitJobState(managed, snapshot.lifecycleState);
      this.#processMutation(mutation);
      if (request.job.signal?.aborted) {
        this.cancelJob({ jobId, reason: "caller-aborted" });
      }
      const result = await stream.result();
      if (result.status !== "succeeded" || !captured) {
        throw new Error(`Router target ${index + 1} did not produce a valid ranking.`);
      }
      return captured;
    } catch (error) {
      if (!managed.accepted) this.#jobs.delete(jobId);
      throw error;
    }
  }

  #targetFromRanking(
    ranking: JudgeRanking,
    candidates: RoutableCandidate[],
  ): AgentRouterSelectedTargetV2 {
    const byId = new Map(candidates.map((candidate) => [candidate.candidate.id, candidate]));
    const selected = new Set<string>();
    for (const item of ranking.rankings) {
      const candidate = byId.get(item.candidateId);
      if (!candidate)
        throw new Error(`Router judge selected unknown candidate '${item.candidateId}'.`);
      if (selected.has(item.candidateId)) {
        throw new Error(`Router judge selected duplicate candidate '${item.candidateId}'.`);
      }
      selected.add(item.candidateId);
      if (!candidate.thinkingLevels.includes(item.thinkingLevel)) {
        throw new Error(
          `Router judge selected unsupported thinking '${item.thinkingLevel}' for '${item.candidateId}'.`,
        );
      }
      const parsed = splitModel(candidate.candidate.model);
      if (!parsed) throw new Error(`Candidate '${item.candidateId}' has an invalid model.`);
      return {
        candidateId: candidate.candidate.id,
        provider: parsed.provider,
        modelId: parsed.modelId,
        thinkingLevel: item.thinkingLevel,
      };
    }
    throw new Error("Router judge returned no candidate ranking.");
  }

  #jobSubtreeIds(rootJobId: string): string[] {
    const jobs = this.#supervisor.snapshot().jobs;
    const included = new Set([rootJobId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const job of jobs) {
        if (
          job.owner.parentJobId &&
          included.has(job.owner.parentJobId) &&
          !included.has(job.jobId)
        ) {
          included.add(job.jobId);
          changed = true;
        }
      }
    }
    return [...included];
  }

  #bindCallerAbort(managed: ManagedJob): void {
    const signal = managed.request.job.signal;
    if (!signal) return;
    const abort = () => {
      this.cancelJob({
        jobId: managed.request.job.descriptor.jobId,
        reason: "caller-aborted",
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    managed.removeCallerAbort = () => signal.removeEventListener("abort", abort);
  }

  #processMutation(mutation: SupervisorMutationResult): void {
    for (const cancellation of mutation.cancellationRequested) {
      const managed = this.#jobs.get(cancellation.jobId);
      if (!managed) continue;
      managed.cancellationReason ??= cancellation.reason;
      this.#emitJobState(managed, "cancelling");
      managed.abortController.abort(managed.cancellationReason);
    }
    for (const terminal of mutation.terminal) {
      const managed = this.#jobs.get(terminal.jobId);
      if (managed) this.#finishManagedJob(managed, terminal.status, emptyCleanup(terminal.jobId));
    }
    for (const admission of mutation.admitted) {
      const managed = this.#jobs.get(admission.jobId);
      if (managed) void this.#runAdmission(managed, admission);
    }
    this.#notifyStatus();
  }

  async #runAdmission(managed: ManagedJob, admission: AgentJobAdmission): Promise<void> {
    let attemptRoot: string | undefined;
    try {
      attemptRoot = await this.#createAttemptRoot(admission.jobId, admission.attempt.attemptId);
      const result = await this.#workerClient.runAttempt({
        identity: {
          jobId: admission.jobId,
          attemptId: admission.attempt.attemptId,
          leaseId: admission.lease.leaseId,
        },
        capsule: {
          cwd: managed.request.cwd,
          configAgentDir: this.#configAgentDir,
          attemptRoot,
          deadlineAt: managed.request.job.descriptor.deadlineAt,
          target: {
            provider: admission.resource.provider,
            modelId: splitModel(admission.resource.model)?.modelId ?? admission.resource.model,
            thinkingLevel: admission.resource.thinkingLevel ?? "off",
          },
          execution: managed.request.job.execution
            .payload as AgentWorkerAttemptRequest["capsule"]["execution"],
          limits: this.#config.supervisor.ipc,
        },
        capabilities: managed.request.job.execution.capabilities ?? [],
        retention: managed.request.job.descriptor.retention,
        isActive: () => {
          const snapshot = this.#supervisor.getJob(admission.jobId);
          return snapshot?.lifecycleState === "starting" || snapshot?.lifecycleState === "running";
        },
        signal: managed.abortController.signal,
        onLifecycleEvent: (event) => this.#onWorkerLifecycle(managed, admission, event),
      });
      managed.cleanup = {
        ok: result.cleanup.ok,
        attempts: result.cleanup.attempts,
        retained: result.cleanup.retained,
        quarantined: result.cleanup.quarantined,
        pathHash: result.cleanup.pathHash,
      };
      managed.failureCode = result.failure?.code;
      let status = mapWorkerStatus(result, managed.cancellationReason);
      if (status === "succeeded" && managed.validateSuccess && !managed.validateSuccess()) {
        status = "failed";
        managed.failureCode = "output_contract_failed";
      }
      const mutation = this.#supervisor.completeJob(admission.jobId, { status });
      this.#finishManagedJob(
        managed,
        status,
        managed.cleanup,
        status === "succeeded" ? result.result : undefined,
      );
      this.#processMutation(mutation);
    } catch (error) {
      const cleanup = attemptRoot
        ? await this.#cleanupManager.cleanup(attemptRoot, managed.request.job.descriptor.retention)
        : undefined;
      managed.cleanup = cleanup
        ? {
            ok: cleanup.ok,
            attempts: cleanup.attempts,
            retained: cleanup.retained,
            quarantined: cleanup.quarantined,
            pathHash: cleanup.pathHash,
          }
        : emptyCleanup(admission.jobId);
      managed.failureCode = error instanceof Error ? error.name : "worker_start_failed";
      const status: AgentJobTerminalStatus = managed.cleanup.ok ? "failed" : "cleanup_failed";
      const snapshot = this.#supervisor.getJob(admission.jobId);
      if (snapshot && !snapshot.terminalStatus) {
        const mutation = this.#supervisor.completeJob(admission.jobId, { status });
        this.#finishManagedJob(managed, status, managed.cleanup);
        this.#processMutation(mutation);
      }
    }
  }

  #onWorkerLifecycle(
    managed: ManagedJob,
    admission: AgentJobAdmission,
    event: AgentWorkerLifecycleEvent,
  ): void {
    managed.lifecycle.push({ type: event.type, at: event.at });
    if (event.type === "spawned" && event.processId) {
      const snapshot = this.#supervisor.getJob(admission.jobId);
      if (snapshot?.lifecycleState === "starting") {
        this.#supervisor.markRunning(admission.jobId, {
          processId: event.processId,
          processIdentityHash: processIdentityHash(
            admission.jobId,
            admission.attempt.attemptId,
            event.processId,
          ),
        });
        managed.processState = "running";
        this.#emitJobState(managed, "running");
        this.#emitAttemptState(managed, admission.jobId);
      }
    }
    if (event.type === "process_escalated") managed.processEscalated = true;
    if (event.type === "exited") {
      managed.processExited = true;
      managed.processState = "exited";
    }
  }

  #emitJobState(managed: ManagedJob, state: AgentJobInspectionV2["lifecycleState"]): void {
    const at = new Date().toISOString();
    managed.lifecycle.push({ type: `job.state:${state}`, at });
    managed.stream.emit({
      contractVersion: 2,
      type: "job.state",
      jobId: managed.request.job.descriptor.jobId,
      state,
      at,
    });
  }

  #emitAttemptState(managed: ManagedJob, jobId: string): void {
    const attempt = this.#supervisor.getJob(jobId)?.attempt;
    if (!attempt) return;
    managed.stream.emit({
      contractVersion: 2,
      type: "attempt.state",
      jobId,
      attempt,
      at: new Date().toISOString(),
    });
  }

  #finishManagedJob(
    managed: ManagedJob,
    status: AgentJobTerminalStatus,
    cleanup: AgentRouterJobCleanupV2,
    output?: unknown,
  ): void {
    if (managed.finished) return;
    managed.finished = true;
    managed.cleanup = cleanup;
    managed.processState = managed.processState === "not-started" ? "not-started" : "exited";
    managed.removeCallerAbort?.();
    const jobId = managed.request.job.descriptor.jobId;
    this.#emitJobState(managed, "released");
    if (output !== undefined) {
      managed.stream.emit({
        contractVersion: 2,
        type: "job.output",
        jobId,
        output,
        at: new Date().toISOString(),
      });
    }
    const finishedAt = new Date().toISOString();
    managed.stream.emit({
      contractVersion: 2,
      type: "job.terminal",
      jobId,
      status,
      cleanupComplete: cleanup.ok,
      at: finishedAt,
    });
    const inspection = this.inspectJob(jobId);
    if (!inspection) {
      managed.stream.fail(new Error(`Terminal job '${jobId}' has no inspection snapshot.`));
      return;
    }
    const result: AgentJobResultV2 = {
      contractVersion: 2,
      jobId,
      status,
      cleanupComplete: cleanup.ok,
      ...(output !== undefined ? { output } : {}),
      inspection,
    };
    this.#appendAudit(managed, status, cleanup, finishedAt);
    managed.stream.finish(result);
  }

  #appendAudit(
    managed: ManagedJob,
    status: AgentJobTerminalStatus,
    cleanup: AgentRouterJobCleanupV2,
    finishedAt: string,
  ): void {
    const descriptor = managed.request.job.descriptor;
    const snapshot = this.#supervisor.getJob(descriptor.jobId);
    const audit: AgentRouterJobAuditRecordV2 = {
      contractVersion: 2,
      auditId: randomUUID(),
      jobId: descriptor.jobId,
      ownerKind: descriptor.owner.kind,
      ownerIdHash: ownerHash(descriptor.owner.ownerId),
      jobClass: descriptor.jobClass,
      dependencyIds: [...descriptor.dependencies.dependsOn],
      dependencyOutcomes: descriptor.dependencies.dependsOn.map((jobId) => {
        const terminalStatus = this.#supervisor.getJob(jobId)?.terminalStatus;
        return { jobId, ...(terminalStatus ? { terminalStatus } : {}) };
      }),
      submittedAt: descriptor.submittedAt,
      ...(managed.queuedAt ? { queuedAt: managed.queuedAt } : {}),
      ...(snapshot?.attempt?.startedAt ? { startedAt: snapshot.attempt.startedAt } : {}),
      finishedAt,
      ...(snapshot?.attempt?.attemptId ? { attemptId: snapshot.attempt.attemptId } : {}),
      ...(managed.target?.candidateId ? { candidateId: managed.target.candidateId } : {}),
      ...(managed.target ? { model: `${managed.target.provider}/${managed.target.modelId}` } : {}),
      ...(managed.target?.thinkingLevel ? { thinkingLevel: managed.target.thinkingLevel } : {}),
      terminalStatus: status,
      ...(managed.cancellationReason ? { cancellationReason: managed.cancellationReason } : {}),
      ...(managed.failureCode ? { failureCode: managed.failureCode } : {}),
      processEscalated: managed.processEscalated,
      processExited: managed.processExited,
      cleanup: structuredClone(cleanup),
      lifecycle: managed.lifecycle.slice(-128).map((event) => ({ ...event })),
    };
    this.#audits.push(audit);
    if (this.#audits.length > 1_000) this.#audits.splice(0, this.#audits.length - 1_000);
    try {
      this.#onAudit?.(structuredClone(audit));
    } catch {
      // Audit observers are best-effort and cannot skip cleanup or terminal publication.
    }
  }

  #enrichInspection(job: AgentJobInspectionV2): AgentRouterJobInspectionV2 {
    const managed = this.#jobs.get(job.jobId);
    return {
      ...structuredClone(job),
      ...(managed?.cancellationReason ? { cancellationReason: managed.cancellationReason } : {}),
      ...(managed ? { processState: managed.processState } : {}),
      ...(managed?.cleanup ? { cleanup: structuredClone(managed.cleanup) } : {}),
    };
  }

  #notifyStatus(): void {
    try {
      this.#onStatus?.(this.inspectSupervisor());
    } catch {
      // UI/status observers are best-effort and cannot mutate Supervisor state.
    }
  }

  async #performDrain(): Promise<void> {
    const snapshot = this.#supervisor.snapshot();
    if (snapshot.state === "stopped") return;
    this.#supervisor.beginDraining();
    this.#notifyStatus();
    for (const job of snapshot.jobs) {
      if (job.terminalStatus) continue;
      const managed = this.#jobs.get(job.jobId);
      if (managed) managed.cancellationReason ??= "shutdown";
      this.#processMutation(this.#supervisor.cancelJob(job.jobId, "shutdown"));
    }
    const pending = [...this.#jobs.values()].flatMap((managed) =>
      managed.accepted && !managed.finished ? [managed.stream.result()] : [],
    );
    await waitWithTimeout(pending, this.#config.supervisor.deadlines.drainDeadlineMs);
    this.#supervisor.stop();
    this.#notifyStatus();
  }
}

class AgentRouterServiceV2Controller {
  readonly service: AgentRouterServiceV2;
  readonly #loaded: Promise<LoadedRouterConfigV2>;
  readonly #domain: Promise<AgentRouterServiceDomainV2 | undefined>;
  #unsubscribe: () => void = () => undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(events: AgentRouterServiceEventBus, options: RegisterAgentRouterServiceV2Options) {
    const configPath = options.configPath ?? getAgentRouterConfigPath();
    this.#loaded = options.loadConfiguration?.() ?? loadRouterConfigV2(configPath);
    this.#domain = this.#loaded.then(async (loaded) => {
      if (!loaded.ok || !loaded.config) return undefined;
      const domain = new AgentRouterServiceDomainV2({
        config: loaded.config,
        configAgentDir: options.configAgentDir ?? dirname(loaded.path),
        ...(options.workerClient ? { workerClient: options.workerClient } : {}),
        ...(options.cleanupManager ? { cleanupManager: options.cleanupManager } : {}),
        ...(options.createAttemptRoot ? { createAttemptRoot: options.createAttemptRoot } : {}),
        ...(options.selectTarget ? { selectTarget: options.selectTarget } : {}),
        onAudit: (record) => events.emit(AGENT_ROUTER_JOB_AUDIT_TOPIC_V2, record),
        onStatus: (status) => events.emit(AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2, status),
      });
      if (!options.cleanupManager) await domain.runStartupJanitor(tmpdir());
      try {
        events.emit(AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2, domain.inspectSupervisor());
      } catch {
        // Discovery remains authoritative even when an optional UI observer fails.
      }
      return domain;
    });

    this.service = {
      contractVersion: AGENT_ROUTER_SERVICE_CONTRACT_VERSION_V2,
      serviceId: AGENT_ROUTER_SERVICE_ID,
      packageVersion: options.packageVersion ?? AGENT_ROUTER_PACKAGE_VERSION,
      instanceId: options.instanceId ?? randomUUID(),
      capabilities: AGENT_ROUTER_SERVICE_V2_CAPABILITIES,
      inspectConfiguration: async () => configurationStatus(await this.#loaded),
      inspectSupervisor: async () => (await this.#requireDomain()).inspectSupervisor(),
      runJob: async <TResult = unknown, TPayload = unknown>(
        request: AgentRouterServiceJobRequestV2<TPayload>,
      ) => await this.#streamJob<TResult, TPayload>(request).result(),
      streamJob: <TResult = unknown, TPayload = unknown>(
        request: AgentRouterServiceJobRequestV2<TPayload>,
      ) => this.#streamJob<TResult, TPayload>(request),
      withAgent: async <TResult = unknown, TPayload = unknown, TConsumed = void>(
        request: AgentRouterServiceJobRequestV2<TPayload>,
        consume: (job: AgentJobStreamV2<TResult>) => Promise<TConsumed>,
      ) => {
        const stream = this.#streamJob<TResult, TPayload>(request);
        try {
          return await consume(stream);
        } finally {
          const inspection = await stream.inspect().catch(() => undefined);
          if (!inspection?.terminalStatus) await stream.cancel("scope-ended");
          await stream.result().catch(() => undefined);
        }
      },
      inspectJobs: async (query) => (await this.#requireDomain()).inspectJobs(query),
      inspectJobTree: async (query) => (await this.#requireDomain()).inspectJobTree(query),
      inspectAudit: async (query) => (await this.#requireDomain()).inspectAudit(query),
      cancelJob: async (request) => (await this.#requireDomain()).cancelJob(request),
      releaseOwner: async (ownerId) => (await this.#requireDomain()).releaseOwner(ownerId),
      runJanitor: async () => await (await this.#requireDomain()).runJanitor(),
      doctor: async () => (await this.#requireDomain()).doctor(),
      drain: async (reason) => await this.#drainIfConfigured(reason),
    };

    const unsubscribe = events.on(AGENT_ROUTER_DISCOVERY_TOPIC_V2, (value) => {
      if (!isAgentRouterDiscoveryRequestV2(value)) return;
      value.respond(this.service);
    });
    this.#unsubscribe = typeof unsubscribe === "function" ? unsubscribe : () => undefined;
  }

  async releaseOwner(ownerId: string): Promise<number> {
    const domain = await this.#domain;
    return domain?.releaseOwner(ownerId) ?? 0;
  }

  dispose(reason = "service-disposed"): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const dispose = this.#drainIfConfigured(reason).then(() => this.#unsubscribe());
    this.#disposePromise = dispose.catch((error) => {
      this.#disposePromise = undefined;
      throw error;
    });
    return this.#disposePromise;
  }

  #streamJob<TResult, TPayload>(
    request: AgentRouterServiceJobRequestV2<TPayload>,
  ): ManagedAgentJobStream<TResult> {
    const scope = new AbortController();
    const signal = request.job.signal
      ? AbortSignal.any([request.job.signal, scope.signal])
      : scope.signal;
    const scopedRequest: AgentRouterServiceJobRequestV2<TPayload> = {
      ...request,
      job: { ...request.job, signal },
    };
    const stream = new ManagedAgentJobStream<TResult>({
      jobId: request.job.descriptor.jobId,
      cancelJob: async () => {
        scope.abort("caller-scope-ended");
        const domain = await this.#requireDomain();
        domain.cancelJob({ jobId: request.job.descriptor.jobId, reason: "caller-aborted" });
      },
      inspectJob: async () =>
        (await this.#requireDomain()).inspectJob(request.job.descriptor.jobId),
    });
    if (request.job.descriptor.owner.kind !== "service" && !request.job.signal) {
      stream.fail(
        new Error(
          `Owner-bound job '${request.job.descriptor.jobId}' requires a caller, session, or connection AbortSignal.`,
        ),
      );
      return stream;
    }
    void this.#requireDomain()
      .then((domain) => domain.start(scopedRequest, stream))
      .catch((error) => stream.fail(error));
    return stream;
  }

  async #requireDomain(): Promise<AgentRouterServiceDomainV2> {
    const domain = await this.#domain;
    if (domain) return domain;
    const status = configurationStatus(await this.#loaded);
    throw new Error(
      `Agent Router V2 service is not configured (${status.state}). ${
        status.state === "migration-required" ? status.migrationCommand : status.setupCommand
      }`,
    );
  }

  async #drainIfConfigured(reason: string): Promise<void> {
    const domain = await this.#domain;
    if (domain) await domain.drain(reason);
  }
}

export function registerAgentRouterServiceV2(
  events: AgentRouterServiceEventBus,
  options: RegisterAgentRouterServiceV2Options = {},
): RegisteredAgentRouterServiceV2 {
  const controller = new AgentRouterServiceV2Controller(events, options);
  return {
    service: controller.service,
    releaseOwner: (ownerId) => controller.releaseOwner(ownerId),
    dispose: (reason) => controller.dispose(reason),
  };
}
