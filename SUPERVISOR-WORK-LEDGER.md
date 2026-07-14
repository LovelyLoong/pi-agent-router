# Global Supervisor Single-Agent Work Ledger

## Operating decision

The developer selected a sequential single-Agent continuation on 2026-07-13 after the repository workflow's incomplete forward worktree-entry boundary repeatedly blocked otherwise valid local work.

- Work only in `C:\PiWorkbench\worktrees\pi-agent-router-supervisor-continuation`.
- Current branch: `work/add-global-agent-supervisor-continuation`.
- Verified baseline commit: `ce7fd7e0c49e3a461b69b7691012d23c9e49b9fb`.
- Stable `main` remains `3933dcf5c4e6b87a118dc1eebe3e4b23a843dbc1`.
- Use one Agent and one worktree; execute tasks sequentially.
- The project-local Pi settings disable the `pi-repo-workflow` extension and skills for this Router checkout.
- A trusted no-session Pi RPC startup verified zero workflow commands and zero extension errors after the project override; global Pi settings were not changed.
- Existing OpenSpec, verification, and HANDOFF artifacts are retained as read-only historical evidence.
- Local verified commits are allowed.
- Merge, push, paid smoke tests, publication, remote mutation, force operations, broad deletion, and history rewriting are not authorized.

## Outcome

Complete the Router-owned global Agent Supervisor so every full Agent, auxiliary completion, Router control-plane request, and migrated consumer uses one observable lifecycle domain with bounded admission, ownership, dependencies, quotas, deadlines, isolated execution, confirmed cancellation, cleanup barriers, compliance checks, and redacted audit evidence.

## Safety principles

1. One service instance owns one Supervisor and one job registry.
2. Every full Agent attempt uses a fresh child process and in-memory Pi session.
3. Parent capabilities remain explicit, bounded, revocable, and private.
4. Cancellation escalates from cooperative abort to confirmed process-tree exit.
5. No result, fallback, or release occurs before cleanup finishes.
6. Cleanup failure withholds success and becomes typed `cleanup_failed` with bounded janitor recovery.
7. Lifecycle and audit surfaces never persist prompts, tool payloads, secrets, hidden reasoning, or raw temporary paths.
8. Unknown, drifted, or non-compliant execution paths fail closed.

## Verified baseline

- [x] **T101 — Discovery and architecture:** requirements, affected call sites, decisions, criteria, task graph, and feasibility evidence were completed.
- [x] **T102 — Isolation feasibility:** Node 24 IPC, capability round-trip, cancellation races, Windows process-tree escalation, deletion retry, quarantine, and janitor behavior were demonstrated without paid providers.
- [x] **T103 — Contracts and configuration:** service/job/owner/dependency/attempt/lifecycle/retention/isolation contracts and strict V2 configuration/migration were implemented.
- [x] **T104 — Scheduling core:** singleton registry, owner tree, atomic transfer, dependency DAG, stable bounded priority queue, quotas, and inherited deadlines were implemented and tested.
- [x] **T105 — Isolated Worker:** fresh real child-local Pi AgentSession/completion execution, selected-target resolution, bounded V1 IPC, capability proxies, identity/schema/deadline/size checks, and private lifecycle boundaries were implemented.
- [x] **T106 — Finalization and cleanup:** single-flight finalization, creation/tool/cancel races, PID/nonce-owned process-tree escalation, confirmed exit, cleanup barrier, deletion retry, quarantine, degraded status, janitor, `cleanup_failed`, and cleanup-before-fallback ordering were implemented.

### T106 evidence

- Exact `npm run check`: 19 test files and 111 tests passed.
- Focused Worker lifecycle suites: 27/27 passed.
- Strict OpenSpec validation passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- Project LSP reported no diagnostics.
- Lens reported no blocking error; reviewed state-machine complexity warnings remain.
- The successful full run left no new Router Worker process or attempt root.

## Sequential remaining work

- [ ] **T107 — Service ownership and operations (current):** make service V2 own one Supervisor; bind caller/session/connection cancellation; implement stop-admission, bounded drain, reload, and shutdown; complete redacted lifecycle/audit; expose jobs/job/tree/audit/janitor/Doctor commands, typed inspection API, and lightweight active/queued/degraded status.
- [ ] **T108 — Compliance admission:** package/filter resolution, version/hash attestations, source rules, exemptions, activation gate, drift/degraded behavior, and remediation.
- [ ] **T109 — pi-sessions migration:** move session ask, handoff, and auto-title to service V2 while preserving public contracts and private tools.
- [ ] **T110 — Compaction/tree integration:** route Router-owned `session_before_compact` and `session_before_tree` work through supervised jobs.
- [ ] **T111 — Hermes migration:** establish provenance and move background review to Router jobs with controlled ownership transfer.
- [ ] **T112 — pi-web-access migration:** establish v0.13.0 provenance and move Pi-model summary drafts to Router while retaining documented provider-native exemptions.
- [ ] **T113 — Controlled activation:** audit active packages, migrate/filter/attest findings, back up configuration, and prove violating packages cannot activate.
- [ ] **T114 — Stress verification:** run deterministic concurrency, cancellation, timeout, create/tool races, reload/drain, dependency, force-kill, file-lock, and janitor tests; assert zero owned-process/session/timer/listener residue.
- [ ] **T115 — Documentation and review packet:** finish API, security, operations, migration, rollback, portability, CI, and developer-review documentation.
- [ ] **T116 — Public/live verification:** blocked until separate authorization for remotes, forks, push, and paid smoke tests.
- [ ] **T117 — Final reconciliation:** reconcile commitments with behavior, complete the evidence matrix, and request explicit developer acceptance without claiming it early.

## T107 definition of done

T107 is complete only when all of the following are demonstrated:

- Service V2 constructs and exclusively owns one `AgentJobSupervisorCore` and one `AgentWorkerClient` lifecycle domain.
- Caller, session, and connection aborts cancel the correct queued/running jobs idempotently.
- Reload and shutdown stop admission, cancel queued work, drain running work to a configured deadline, escalate remaining Workers, release subscriptions/timers, and unregister discovery only after cleanup.
- Every terminal path emits one redacted correlated audit record with queue, attempt, cancellation/escalation, process exit, deletion, release, and cleanup status.
- Typed inspection exposes aggregate status, individual jobs, owner/dependency trees, audit records, cleanup degradation, and janitor results without private payloads or raw paths.
- Pi commands and lightweight status use the typed inspection boundary rather than reaching into mutable Supervisor internals.
- Focused service lifecycle tests pass for success, failure, caller cancellation, session/connection teardown, reload, drain timeout, forced exit, cleanup failure, janitor recovery, and listener/timer disposal.
- Full package checks remain green and a successful teardown leaves no new Worker process, attempt root, active job, timer, or listener.

## Known observations

- A pre-fix Vitest 5-second parent timeout created separately identified sandbox-owned diagnostic residue before the final T106 run. Windows denied this session permission to terminate it. It is not evidence from the successful run and must not be targeted without exact ownership proof.
- T106 Worker-layer behavior is verified, while full service/registry/audit integration remains T107/T114 work.
- The Router and repository-workflow packages remain separate; this continuation does not modify `pi-repo-workflow`.

## Next exact action

Verify that a fresh Pi runtime in this checkout does not load `pi-repo-workflow`. Then inspect the current service V1/V2 ownership and lifecycle symbols, define the smallest T107 service slice, add focused failing tests, implement it, and record concrete evidence here before creating the next local commit.
