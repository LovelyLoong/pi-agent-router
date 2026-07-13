<!-- markdownlint-disable MD013 -->

# Technical Design: Global Agent Job Supervisor

## Context and Evidence

The existing package already provides strict configuration, hard candidate filtering, a non-recursive Router judge, bounded attempts, passive health, typed events, a Pi executor, and a mandatory event-bus service. A real hot-reloaded production call on 2026-07-13 proved that path: Router ranked luna → terra → mini → sol, classified luna's output-contract failure after 107.186 seconds, and returned a terra result after 62.022 seconds without inheriting foreground `sol/max`.

That evidence also exposes the next boundary:

- `runWithDeadline()` rejects as soon as its signal aborts, while the underlying operation can continue cleaning asynchronously.
- `PiSdkExecutor` calls `session.abort()` from an event listener and `session.dispose()` in `finally`, but no central owner waits for all attempts after service shutdown.
- Pi 0.80.6 `AgentSession.abort()` waits for idle, while `dispose()` synchronously aborts/disconnects and does not delete the `SessionManager` file.
- The service host creates an `AgentRouterRuntime` per execution request and unregisters discovery on `session_shutdown`; it has no singleton queue, active job registry, drain, or orphan reconciliation.
- Pi exposes `session_before_compact` and `session_before_tree`, so an extension can supply Router-generated compaction and branch summaries without forking Pi core.
- `createAgentSession({ agentDir })` can construct auth/model/settings state inside a child process. A selected worker can resolve a configured provider/model by id and use `SessionManager.inMemory()`.
- Controlled source inventory found direct execution in pi-sessions handoff/auto-title/legacy paths, Hermes memory review, and pi-web-access summary review. Context-resilience and pi-repo-workflow call `ctx.compact()`, which can be intercepted centrally.

## Goals / Non-Goals

**Goals:**

- One long-lived Router host owns all plugin-dispatched Pi Agent and auxiliary LLM jobs.
- Every full Agent attempt is new, isolated, bounded, capability-scoped, and deterministically reclaimed.
- Ownership, dependencies, queue state, deadlines, route attempts, process identity, and cleanup state are inspectable.
- A caller cannot leak a raw Agent object or accidentally outlive its owner.
- Every known controlled bypass is migrated or explicitly classified as a narrow external-provider exemption.
- Activation and upgrades fail closed when package compliance evidence is absent or stale.

**Non-goals:**

- Agent reuse, distributed workers, foreground-Agent routing, recursive control-plane routing, arbitrary runtime sandboxing, or upstream npm publication.

## Decisions

### D-016: Model the system as a structured job supervisor, not an Agent pool

- **Decision:** Introduce a singleton `AgentJobSupervisor` whose units are immutable jobs and fresh attempts. No Agent process, `AgentSession`, context, or tool instance is reused between jobs or fallback attempts.
- **Rationale:** The user wants thread-pool-style centralized scheduling but explicitly does not want reuse. “Supervisor” makes ownership and cleanup semantics precise without implying warm reusable workers.
- **Alternatives:** Object pool (state leakage); independent runtime per request (current lifecycle gap).
- **Related criteria:** AC-023, AC-024, AC-033.

### D-017: Expose only structured scoped execution APIs

- **Decision:** Service V2 exposes `runJob()`, `streamJob()`, and scoped `withAgent()` forms. Consumers receive results/events, never an `AgentSession` or child-process handle. Every call requires owner metadata and an `AbortSignal`/lifecycle token supplied by the client helper.
- **Rationale:** A raw borrow/release API permits escaped handles and forgotten release. A structured promise/stream gives the host one deterministic finalization path.
- **Alternatives:** Raw lease with `release()` (leak-prone); `FinalizationRegistry` (non-deterministic).
- **Related criteria:** AC-024, AC-030.

### D-018: Separate ownership trees from prerequisite DAGs

- **Decision:** Each job has exactly one current owner and optional parent job. Ownership forms a tree used for cancellation and budget accounting. `dependsOn` forms a separate acyclic graph used for readiness. Failed/cancelled/timed-out prerequisites skip dependents by default; an explicit allowlisted failure-input policy may continue them.
- **Rationale:** Lifecycle responsibility and data dependency are different relationships. Combining them creates incorrect cancellation or scheduling.
- **Alternatives:** One graph for both (ambiguous); caller-only dependency handling (inconsistent).
- **Related criteria:** AC-025, AC-026.

### D-019: Permit only explicit bounded ownership transfer

- **Decision:** Ordinary jobs cannot outlive their caller/session owner. A configured task kind may transfer to the Router service owner only before caller release and only with TTL, deadline, cost/attempt budget, purpose, and audit reason. Transfer is atomic; orphaned ownership is impossible.
- **Rationale:** Memory maintenance may be legitimate background work, but fire-and-forget is incompatible with leak prevention.
- **Alternatives:** No transfer (blocks useful maintenance); arbitrary detached jobs (unowned work).
- **Related criteria:** AC-025, AC-033.

### D-020: Use a bounded stable priority queue with hierarchical quotas

- **Decision:** Queue order is priority class then FIFO sequence. Interactive > maintenance > background. Admission enforces configurable global full-Agent/completion limits, per-owner active limit, per-provider/model limits, and queue capacity. Queue waits consume the caller's overall deadline; full queues return `queue_full` without model work.
- **Rationale:** Bounded backpressure avoids unbounded spend and memory while preserving responsive interactive tasks.
- **Alternatives:** Immediate rejection (poor concurrency UX); unbounded queue (resource/cost spike).
- **Related criteria:** AC-027, AC-038.

### D-021: Run full Agent attempts in dedicated child processes

- **Decision:** A versioned Router worker entry point receives a serialized execution capsule over Node IPC. The worker loads Pi 0.80.6 from the package environment, resolves only the already-selected configured model/thinking target, creates a fresh in-memory AgentSession, executes one attempt, awaits idle, disposes, emits a terminal protocol frame, and exits. No extensions, skills, prompt templates, or default tools load unless the capsule explicitly grants them.
- **Rationale:** In-process cancellation cannot forcibly stop an uncooperative provider or extension. A child process gives the supervisor a killable resource boundary.
- **Alternatives:** In-process only (cannot hard-stop); long-lived warm worker (state/reuse risk).
- **Related criteria:** AC-028, AC-030, AC-031.

### D-022: Bridge selected tools through capability-scoped IPC

- **Decision:** Consumers register per-job tool capabilities with the supervisor. The worker receives only tool schemas and opaque capability ids. A tool call frame includes job/attempt/capability/call ids and bounded arguments; the parent verifies ownership, active state, allowed tool name, schema, byte limit, and deadline before invoking the consumer closure. Responses are bounded and correlated. Capabilities are revoked at cancellation/finalization.
- **Rationale:** JavaScript closures cannot be serialized, and domain logic such as session navigation must stay with the consumer. The bridge reveals private data only to the selected attempt, not to the Router judge.
- **Alternatives:** Copy consumer code into Router (ownership violation); serialize full sessions (privacy risk); load arbitrary consumer extensions in worker (unbounded surface).
- **Related criteria:** AC-029, AC-037.

### D-023: Make cleanup a barrier before terminal success or fallback

- **Decision:** Attempt finalization is idempotent and single-flight. It transitions `running → cancelling? → draining → disposing → deleting → released`. The supervisor waits for cooperative abort and worker terminal/exit; after a configurable grace period it terminates the process tree and confirms exit. It then revokes tools, removes listeners/timers, deletes the attempt directory with bounded retries, unregisters process/lease state, and writes terminal audit. Only then may the caller receive success or the orchestrator start a fallback.
- **Rationale:** Returning on signal abort currently allows cleanup/fallback overlap. A barrier turns cleanup into an observable invariant.
- **Alternatives:** Fire-and-forget cleanup (current gap); start fallback immediately (overlap/side-effect risk).
- **Related criteria:** AC-030, AC-031, AC-034.

### D-024: Treat cleanup failure as a typed terminal failure

- **Decision:** If the process is confirmed dead but a critical temporary resource cannot be removed after retry, move it to a restrictive quarantine when possible, record a path hash rather than content/path, mark the job `cleanup_failed`, and set supervisor health `degraded`. A startup/manual janitor retries bounded cleanup. The original output is not reported as successful.
- **Rationale:** Default-ephemeral retention is a product promise. Silent cleanup warnings are too easy to ignore.
- **Alternatives:** Return result with warning (weak); shut down service permanently (too disruptive).
- **Related criteria:** AC-032.

### D-025: Keep execution data ephemeral by default

- **Decision:** Each attempt gets a Router-owned random temporary directory with restrictive permissions. Full Agents use `SessionManager.inMemory()`; any bridge spill file is encrypted/permission-restricted and deleted at finalization. Only redacted lifecycle metadata persists. An explicit debug-retention request creates a separate bounded artifact with a configured TTL and owner-visible location.
- **Rationale:** `dispose()` does not delete session files. Avoid creating them unless the user explicitly asks.
- **Alternatives:** Persist failures (privacy/disk risk); retain every run (rejected).
- **Related criteria:** AC-031, AC-032, AC-037.

### D-026: Manage lightweight completion work under the same lease model

- **Decision:** `jobClass` distinguishes full Agent from auxiliary completion and Router control-plane. Every class uses queue, owner, dependency, deadline, audit, cancellation, and cleanup contracts. Full Agents always use child processes. Completion isolation is explicit per adapter/config and may use a lighter worker only when approved; no consumer may call Pi `complete`, `completeSimple`, or `streamSimple` directly.
- **Rationale:** Compaction/title/review are not AgentSessions but have the same ownership, cost, timeout, and routing risks.
- **Alternatives:** Ignore completions (violates confirmed scope); force a tool-capable Agent for every title (unnecessary overhead).
- **Related criteria:** AC-035, AC-038.

### D-027: Make the service host own runtime and shutdown drain

- **Decision:** Service V2 creates one supervisor for the extension host and all service calls. `session_shutdown`/reload first stop admission, cancel session-owned jobs, await bounded drain, escalate remaining workers, finalize audits, dispose event subscriptions, then unregister discovery. External clients bind ownership to connection lifetime. V1 discovery is reported incompatible to V2-only managed consumers rather than silently downgraded.
- **Rationale:** Per-request runtimes cannot inspect, cap, or drain global work.
- **Alternatives:** Global mutable singleton outside extension lifecycle (reload leak); direct-import fallback (fragmented state).
- **Related criteria:** AC-023, AC-033, AC-036.

### D-028: Keep Router control-plane execution explicit and non-recursive

- **Decision:** Route-judge jobs are registered as `router-control-plane`, use fixed configured primary/backups, and execute through an internal supervised adapter without invoking route selection again. They count against separate control-plane limits and emit the same cleanup evidence.
- **Rationale:** The judge is itself model work and must be bounded without recursion.
- **Alternatives:** Leave judge untracked (lifecycle gap); route judge through itself (recursion).
- **Related criteria:** AC-023, AC-035, AC-037.

### D-029: Add version/hash-bound package compliance admission

- **Decision:** Define `PiAgentRouterComplianceV1` classifications: `router-internal`, `router-client`, `no-pi-ai-dispatch`, and narrowly enumerated `external-provider-exempt`. The audit resolves active package sources and extension filters from Pi settings, hashes relevant source/package metadata, applies AST/text rules for known Pi Agent/completion APIs, and verifies a local attestation lock. Safe third-party packages may be attested without a fork; direct dispatch requires migration/fork. Unknown, drifted, or violating active packages fail managed activation and put startup in compliance-degraded mode.
- **Rationale:** Pi has no reliable global Agent-creation hook. Admission governance is stronger and less brittle than monkey patching.
- **Alternatives:** Warning only (not unique entry); fork every safe package solely for metadata (maintenance burden).
- **Related criteria:** AC-039, AC-040, AC-045.

### D-030: Intercept compaction and branch summary at Pi's public hooks

- **Decision:** Router extension handles `session_before_compact` and `session_before_tree`, builds minimized task contracts, retains raw preparation/entries in the private selected-attempt payload, and returns Pi-compatible compaction/summary objects. Missing config or exhausted candidates fails the operation visibly; it never falls back to foreground summarization.
- **Rationale:** This centralizes built-in and context-resilience-triggered summaries without forking Pi core.
- **Alternatives:** Fork Pi (high drift); allow core fallback (violates unique entry).
- **Related criteria:** AC-042, AC-046.

### D-031: Migrate controlled consumers and remove executable bypasses

- **Decision:** pi-sessions routes ask, handoff, and auto-title through service V2 and removes its executable direct legacy runner. Maintain public forks of Hermes memory and pi-web-access: Hermes review becomes a Router completion job; web-access Router-routes only its Pi-model summary draft while provider-native search/video calls remain declared exemptions. Future workflow worker/verifier code consumes the public client API when implemented.
- **Rationale:** A unique boundary is only true when known call sites no longer bypass it.
- **Alternatives:** Leave inactive code untouched (future regression); disable useful features (avoidable).
- **Related criteria:** AC-041, AC-043, AC-044, AC-045.

### D-032: Expose command/API observability without a permanent dashboard

- **Decision:** Typed inspection snapshots and commands show counts, queue, owner tree, dependency status, selected target, deadlines, attempt state, cleanup phase, and terminal reason. Transcript audit remains compact/redacted; a small status indicator shows only active/queued/degraded counts.
- **Rationale:** Operators need live leak diagnosis without consuming the TUI.
- **Alternatives:** Logs only (not live); full permanent panel (maintenance/noise).
- **Related criteria:** AC-036, AC-037.

### D-033: Roll out in dependency-ordered slices

- **Decision:** First prove process/IPC/kill/deletion feasibility with deterministic local providers. Then land contracts/supervisor, isolation/cleanup, service/observability, compliance, consumer migrations, activation, stress/live tests, and public portability in that order. Keep current production Router active until the new service and session_ask pass compatibility tests.
- **Rationale:** A single cross-repository cutover would be difficult to diagnose and rollback.
- **Alternatives:** Big-bang replacement (high risk); consumer migration before supervisor (unstable API).
- **Related criteria:** AC-046, AC-047.

## Contracts and State

### Job envelope

`AgentJobRequestV2` contains:

- `contractVersion`, `jobId`, `taskContract`, `jobClass`, priority, owner reference, optional parent job, prerequisite ids/policy, queue/deadline/attempt budget, retention policy, and private execution capsule reference.
- Ownership, dependency, retention, and queue metadata are orchestration metadata and are not sent to the Router judge unless needed in minimized aggregate form.
- Private payload and tool capabilities remain outside persisted audit and Router ranking.

### Lifecycle state machine

`submitted → blocked_on_dependencies | queued → routing → starting → running → cancelling? → draining → disposing → deleting → released`.

Terminal outcomes are `succeeded`, `failed`, `cancelled`, `timed_out`, `dependency_failed`, `queue_full`, `cleanup_failed`, and `service_drained`. A terminal outcome is published only after `released`; `cleanup_failed` is the only terminal state allowed to retain a quarantined resource reference, and that reference is not an active lease.

### Attempt identity and fallback

Each candidate attempt has a fresh `attemptId`, process id/start token, temp directory, capability namespace, and cleanup promise. The route orchestrator awaits that cleanup promise before classifying whether a next candidate may start. Side-effect policy from V1 remains: only classified technical/output-contract failures on safe work can advance.

### Configuration additions

A schema-versioned supervisor block holds:

- limits: full agents 4, completions 8, per owner 3, queue 32, plus provider/model/control-plane limits;
- priority classes and allowed task-kind overrides;
- cooperative abort grace, process-exit grace, delete retries/backoff, total cleanup deadline, drain deadline, janitor budget;
- retention default `ephemeral`, explicit debug TTL limit;
- service-owner transfer allowlist and maximum TTL/budgets;
- compliance attestation path, source limits, forbidden API rule version, and external exemption types.

Unknown fields and unsafe combinations fail strict validation. Missing V2 fields are not silently inferred during activation; an explicit migration command writes a backed-up config.

## Consumer Migration Map

| Consumer | Current behavior | V2 behavior |
| --- | --- | --- |
| `pi-sessions/session_ask` | Router V1, in-process attempt | Supervisor V2 full-Agent job with bridged session tools |
| pi-sessions legacy ask | Direct `createAgentSession()` | Removed from executable/exported paths |
| pi-sessions handoff | Direct in-memory AgentSession | Full-Agent Router job with structured output tool |
| pi-sessions auto-title | Direct `completeSimple()` | Auxiliary completion Router job |
| Pi manual/auto compaction | Foreground model stream | Router `session_before_compact` completion job |
| Pi branch summary | Foreground model stream | Router `session_before_tree` completion job |
| context-resilience/workflow compaction | Calls `ctx.compact()` | No caller rewrite required; central hook handles model work |
| Hermes background review | Direct `completeSimple()` | Service-owned/owner-bound Router completion by policy |
| pi-web-access summary draft | Direct Pi model `complete()` | Router completion job |
| pi-web provider search/video | Provider-native HTTP/model APIs | Explicit narrow external-provider exemptions |
| future workflow workers | Not currently spawned | Must use Router service V2 when introduced |

## Failure Handling and Recovery

- Cancellation is idempotent and may arrive before queueing, during routing, process creation, tool execution, output delivery, or cleanup.
- Child process `error`, IPC disconnect, malformed frame, non-zero exit, and exit-before-terminal are typed failures and still enter cleanup.
- On Windows, cooperative IPC cancel is followed by direct process termination and then process-tree termination when needed; process identity includes creation evidence to avoid killing a reused PID.
- Service restart scans only Router-owned temp/quarantine roots with validated markers; it never deletes arbitrary paths.
- If janitor cannot reclaim a quarantine item, Doctor reports exact safe remediation without recording task content.
- Audit sinks must be best-effort but terminal state remains queryable in memory until released; sink failure cannot skip cleanup.
- Compliance failure blocks managed package activation and Router service work. It does not claim to sandbox a manually loaded malicious extension; operations docs require restoring the last compliant settings backup.

## Verification Strategy

- Deterministic worker fixtures for success, tool bridge, provider hang, ignored abort, process child tree, malformed IPC, exit races, file lock, and cleanup retry.
- Fake-clock queue/dependency/owner tests plus real Node child-process integration on Windows.
- High-volume stress with repeated success/failure/cancel/timeout and post-run assertions of zero active leases/processes/temp directories.
- Service reload/shutdown E2E with active queued/running jobs.
- AST/source compliance fixtures and scans of the actual active settings package set.
- Pi fake-provider compaction/tree hooks and consumer package regressions.
- Paid manual smoke tests only after automated/offline checks: one hot-reloaded session ask and one compaction; record route, attempts, cleanup, and absence of foreground `max`.
- Clean sibling clones and CI for Router, pi-sessions, Hermes, and web-access forks.

## Rollout and Rollback

1. Preserve current working production configuration and create atomic backups before V2 config/settings changes.
2. Keep V1 service/session_ask active while implementing and testing V2 behind explicit contracts.
3. Activate Router V2 and the migrated pi-sessions fork together; V2 consumers fail closed against V1.
4. Activate maintained Hermes and web-access forks only after their full regressions and compliance attestation pass.
5. Run active-package compliance audit, then reload/restart Pi and perform live smoke tests.
6. Rollback restores the pre-V2 settings/config backup as one unit. Because the new policy removes direct Agent bypasses, a rollback to noncompliant official packages is an emergency historical state, not an accepted steady-state configuration.

## Open Implementation Questions

These are bounded design tasks, not unresolved product decisions:

- Choose the smallest Node IPC framing and schema implementation that supports streaming updates and tool calls without new native dependencies.
- Validate Windows process-tree termination and PID-reuse evidence on Node 24 before relying on force-kill.
- Decide whether approved lightweight completions use short-lived child processes or worker threads after measuring overhead and termination behavior; both must satisfy the same lease/cleanup tests.
- Determine the exact upstream tags/commits and local-diff provenance for the Hermes and web-access forks before any public history is created.
