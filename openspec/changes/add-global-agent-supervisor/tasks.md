<!-- markdownlint-disable MD013 -->

# Implementation Tasks

> Stable task ids map to acceptance criteria. Check a task only after its listed focused verification and attempt evidence pass. This Heavy change executes under the single-host profile; repository work is dependency ordered, not represented as parallel independent Agent review.

## 1. Planning and Feasibility

- [x] T101 [AC-023] [AC-024] [AC-025] [AC-026] [AC-027] [AC-028] [AC-029] [AC-030] [AC-031] [AC-032] [AC-033] [AC-034] [AC-035] [AC-036] [AC-037] [AC-038] [AC-039] [AC-040] [AC-041] [AC-042] [AC-043] [AC-044] [AC-045] [AC-046] [AC-047] Complete discovery, current-call-site inventory, source-backed feasibility review, strict proposal/spec/design/task/verification/handoff validation, Heavy plan audit, and selected execution permit.
- [x] T102 [AC-028] [AC-029] [AC-030] [AC-031] [AC-032] Build a disposable deterministic-provider feasibility spike outside product paths proving Node 24 parent/child IPC, bridged tool round-trip, cancellation during spawn/run/tool wait, cooperative exit, Windows process-tree escalation, PID identity check, and temporary-root deletion/quarantine semantics. Stop and revise the architecture if a strong cleanup invariant cannot be demonstrated.

## 2. Supervisor Contracts and Scheduling

- [x] T103 [AC-023] [AC-024] [AC-035] [AC-038] Add service/job/owner/dependency/attempt/lifecycle/retention/isolation contracts; strict V2 supervisor configuration and explicit backed-up migration; compatibility diagnostics; no raw AgentSession surface.
- [x] T104 [AC-023] [AC-025] [AC-026] [AC-027] Implement the singleton job registry, owner tree and atomic transfer, validated prerequisite DAG, stable bounded priority queue, global/per-owner/per-provider/control-plane quotas, queue deadlines, and deterministic fake-clock tests.

## 3. Isolated Execution and Cleanup

- [x] T105 [AC-028] [AC-029] [AC-035] Implement the versioned child worker, selected-target model resolution, fresh in-memory AgentSession/completion execution, bounded IPC framing, capability-scoped proxy tools, message limits, private payload separation, and malformed/disconnect protocol tests.
- [x] T106 [AC-030] [AC-031] [AC-032] [AC-034] Implement single-flight finalization, cancellation races, cooperative abort/idle, process-tree escalation and exit confirmation, cleanup barrier, default-ephemeral temp roots, deletion retry, quarantine, janitor, `cleanup_failed`, and fallback-after-cleanup enforcement with real child-process fault fixtures.
- [ ] T107 [AC-023] [AC-033] [AC-036] [AC-037] Make service V2 own one supervisor; bind caller/session/connection lifecycle; implement stop-admission/drain/reload/shutdown; complete redacted events/audit; add jobs/job/tree/audit/janitor/Doctor commands, typed inspection API, and lightweight active/queued/degraded status.

## 4. Compliance Admission

- [ ] T108 [AC-039] [AC-040] Implement compliance schemas, active package/filter resolution, version/hash attestations, known Pi Agent/completion source rules, narrow external-provider exemptions, managed activation gate, startup drift/degraded behavior, fixtures, and operational remediation.

## 5. Controlled Consumer Migration

- [ ] T109 [AC-041] Create/select and prepare a companion pi-sessions Change/permit, then migrate session ask, handoff, and auto-title to service V2; preserve public contracts and private domain tools; remove executable/exported legacy direct-Agent fallback; update tests, docs, evidence, and upstream-sync safeguards.
- [ ] T110 [AC-042] Add Router-owned `session_before_compact` and `session_before_tree` integrations with Pi-compatible output, privacy boundaries, cancellation/deadline/cleanup behavior, fake-provider tests, and context-resilience/workflow-trigger compatibility without modifying unrelated dirty workflow files.
- [ ] T111 [AC-043] Establish the provenance baseline for the current Hermes customization, obtain explicit workflow-initialization/Git authority for the new fork, create/select its companion Change/permit, then migrate background review to Router jobs and controlled ownership transfer while preserving memory semantics and upstream tests.
- [ ] T112 [AC-044] Establish the exact pi-web-access v0.13.0 provenance baseline, obtain explicit workflow-initialization/Git authority for the new fork, create/select its companion Change/permit, then migrate Pi-model summary drafts to Router, enumerate provider-native search/video exemptions, and pass upstream plus Router-focused tests.

## 6. Activation, Verification, and Review

- [ ] T113 [AC-039] [AC-040] [AC-045] Audit the full active package set and controlled repositories; migrate, filter, or attest every finding; atomically back up and activate compliant Router/pi-sessions/Hermes/web-access sources; prove unknown/drifted/violating packages fail managed activation.
- [ ] T114 [AC-023] [AC-025] [AC-026] [AC-027] [AC-028] [AC-029] [AC-030] [AC-031] [AC-032] [AC-033] [AC-034] [AC-035] [AC-036] [AC-037] [AC-038] Run LSP/Lens diagnostics before builds; full package checks/audits; deterministic concurrency stress; success/failure/cancel/timeout/create-race/tool-race/reload/drain/queue/dependency/force-kill/file-lock/janitor tests; and assert zero active leases, owned processes, default Session files, timers, and listeners.
- [ ] T115 [AC-039] [AC-041] [AC-042] [AC-043] [AC-044] [AC-045] [AC-047] Complete configuration/API/security/operations/upstream-sync/new-plugin authoring docs, compliance skill updates, migration/rollback instructions, four-repository clean sibling-clone CI, strict OpenSpec validation, and a draft repository-tracked developer review packet.
- [ ] T116 [AC-046] [AC-047] After explicit Git/publication authorization and automated gates, configure local author/remotes, create and push the two new public maintenance forks plus authorized updates, verify exact public HEAD CI and fresh clones, then run one paid hot-reloaded session-ask and one compaction smoke test with complete cleanup/audit evidence.
- [ ] T117 [AC-023] [AC-030] [AC-031] [AC-032] [AC-033] [AC-036] [AC-037] [AC-039] [AC-040] [AC-041] [AC-042] [AC-043] [AC-044] [AC-045] [AC-046] [AC-047] Reconcile specs/design/docs with observed behavior, finalize the review packet and commitment/evidence matrix, run coordinator Workflow Doctor, checkpoint all repositories review-ready, and request explicit developer acceptance/change/rejection without claiming human acceptance early.

## Dependencies and Stop Conditions

- T101 precedes every product implementation task.
- T102 precedes T103-T107; failure to prove kill/cleanup feasibility stops product mutation and returns to architecture review.
- T103 precedes T104-T108; T104 and T105 precede T106; T104-T106 precede T107.
- T107 and T108 precede every consumer migration.
- T109 and T110 may proceed only after the service/cleanup API is stable; T109 requires a current pi-sessions permit, and T111/T112 additionally require exact upstream provenance, explicit initialization/Git authority, clean baselines, and current companion permits.
- T109-T112 precede T113; T113 precedes stress verification T114 and documentation/CI T115; T114/T115 precede public/live verification T116; T116 precedes final review T117.
- A fallback ordering test must prove prior cleanup timestamps precede the next attempt's start; otherwise activation is blocked.
- Any unexplained active process, lease, timer, listener, temp Session, quarantine item, direct Pi Agent/completion call, stale compliance attestation, raw private data in audit, or foreground-model fallback blocks activation/publication.
- The unrelated dirty `C:/Users/GF/Documents/pi-repo-workflow` files are read-only for this change. Discovery of a required modification there requires a separate user decision and write-set review.
- Product source mutation requires a current Heavy permit. Commits, remotes, repository creation, pushes, tags, releases, npm publication, force pushes, and destructive history operations remain separate authority boundaries; only explicitly authorized operations may occur.
