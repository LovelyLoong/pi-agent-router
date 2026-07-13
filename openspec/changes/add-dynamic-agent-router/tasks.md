<!-- markdownlint-disable MD013 -->

# Implementation Tasks

> Every task uses a stable ID, maps to acceptance criteria, and is checked only after its stated verification succeeds.

## 1. Architecture and Foundation

- [x] T001 [AC-001] [AC-002] [AC-003] [AC-004] [AC-005] [AC-006] [AC-007] [AC-008] [AC-009] [AC-010] [AC-011] [AC-012] [AC-013] [AC-014] [AC-015] [AC-016] [AC-017] Complete and strictly validate the proposal, specification deltas, technical design, task graph, verification ledger, and handoff; record the selected initial model/thinking admission plan and bounded default timeout/TTL hypotheses before product implementation.
- [x] T002 [AC-001] [AC-002] [AC-010] Scaffold the ESM TypeScript npm/Pi package (`package.json`, TypeScript/lint/test configuration, extension manifest, exports, and source/test layout); implement versioned contracts plus strict `agent-router.json` schema, normalization, diagnostics, config hashing, and explicit starter-config generation with no implicit model admission.
- [x] T003 [AC-003] [AC-004] [AC-005] Implement deterministic hard filtering, minimized/redacted Router input, dedicated fixed Router primary/backup execution, structured `rank_routes` output, thinking-level validation, configured static-priority fallback, and focused fake-judge tests.

## 2. Routed Execution and Operations

- [x] T004 [AC-007] [AC-008] [AC-013] Implement versioned passive health state, TTL/failure cooldown, config-hash invalidation, atomic persistence/recovery, static availability checks, task-as-probe updates, and bounded manual Doctor with focused corruption, expiry, and active-probe tests.
- [x] T005 [AC-006] [AC-009] [AC-010] Implement the executor registry, Pi SDK adapter, linked abort/deadline handling, safe failure classification, attempt/overall budgets, fresh-session retries, normalized usage/outcome, and fail-closed orchestration; prove no fallback on normal output or unknown side-effect outcomes.
- [x] T006 [AC-011] [AC-012] Implement redacted versioned event/feedback sinks, optional Pi event-bus bridge, compact/expanded route audit rendering, configuration/Doctor commands, and extension lifecycle wiring without background resources or hidden paid probes.

## 3. pi-sessions Integration

- [x] T007 [AC-014] [AC-015] [AC-016] [AC-017] Create and workflow-initialize the maintained `C:/Users/GF/Documents/pi-sessions` fork at the pinned v0.8.0 baseline; add the narrow `pi-agent-router` dependency/injection seam and integration-specific planning artifacts without copying session navigation ownership.
- [x] T008 [AC-014] [AC-015] [AC-016] Replace `session_ask` foreground model/thinking inheritance with a minimized read-only task contract and routed Pi invocation; preserve session navigation/custom tools/public result, add route details/progress, enforce bounded fresh attempts, and cover root-max independence plus technical/contract fallback.
- [x] T009 [AC-001] [AC-004] [AC-006] [AC-007] [AC-011] [AC-014] [AC-015] [AC-016] [AC-017] Add end-to-end fake-provider and real disposable-Pi tests proving explicit admission only, Router/static decision sources, no raw-session leakage to Router, first-target failure and second-target success, bounded no-config failure, compact audit rendering, session search preservation, and rollback compatibility.

## 4. Documentation, Verification, and Review

- [x] T010 [AC-001] [AC-002] [AC-007] [AC-008] [AC-010] [AC-011] [AC-012] [AC-013] [AC-017] Document configuration, starter balanced model pool, task/executor/feedback APIs, privacy boundary, deadlines, cache/Doctor behavior, fallback semantics, package installation, pi-sessions fork maintenance, rollback, and future evaluator/CLI adapter seams.
- [x] T011 [AC-001] [AC-002] [AC-003] [AC-004] [AC-005] [AC-006] [AC-007] [AC-008] [AC-009] [AC-010] [AC-011] [AC-012] [AC-013] [AC-014] [AC-015] [AC-016] [AC-017] Run package typecheck/lint/tests/check, fork regressions, strict OpenSpec validation in both repositories, LSP/Lens diagnostics, npm audit, fresh-process package loading, manual Doctor, and disposable routed `session_ask`; record exact evidence in `verification.md`.
- [x] T012 [AC-001] [AC-002] [AC-003] [AC-004] [AC-005] [AC-006] [AC-007] [AC-008] [AC-009] [AC-010] [AC-011] [AC-012] [AC-013] [AC-014] [AC-015] [AC-016] [AC-017] Create the repository-tracked developer review packet with commitment-to-code/evidence mapping, reading order, repeatable acceptance steps, limitations, deferred evaluator/executor scope, publication state, and explicit accept/change/reject request; checkpoint both handoffs as review-ready.

## 5. Mandatory Router Service and Local Activation

- [x] T013 [AC-018] [AC-019] Add a typed bounded `pi.events` service discovery/client protocol, exactly-one-provider validation, machine-readable package metadata, configuration inspection, and focused missing/duplicate/incompatible/unconfigured tests.
- [x] T014 [AC-020] Migrate routed `pi-sessions` production execution to the mandatory Router service, remove direct runtime construction from the managed path, and preserve injected test seams plus privacy/fallback/cancellation behavior.
- [x] T015 [AC-021] Explicitly materialize the reviewed real starter configuration, atomically back up and replace the npm pi-sessions settings entry with the local Router and modified pi-sessions packages, run real/disposable package RPC and service E2E, and preserve rollback without touching installed npm files.
- [x] T016 [AC-022] Add public repository/package metadata, Node 24 CI, Git sibling clone/install guidance, accurate activated-state/review documentation, and a Git-only/no-npm publication boundary.
- [x] T017 [AC-022] Configure repository-local author identity, establish `main`, create and push public `LovelyLoong/pi-agent-router`, then verify fresh public sibling clones with `npm ci`, full checks, and disposable offline Pi exactly-one-service/`session_ask` registration.

## Dependencies and Checkpoints

- T001 precedes every product implementation task.
- T002 precedes T003 through T006.
- T003 and T004 precede T005; T005 precedes T006.
- T002 through T006 precede T007/T008 so the fork integrates against a stable tested public API.
- T007 precedes T008; T008 precedes T009.
- T009 precedes T010 through T012; documentation may begin earlier but cannot claim verified behavior before T009.
- T013 precedes T014; T014 precedes explicit setup/activation and real package verification in T015.
- T015 precedes public-clone preparation T016; T016 precedes initial commit/push and fresh-clone verification T017.
- Each independently verifiable slice requires focused diagnostics/tests, one bounded attempt record, task/evidence updates, and a workflow checkpoint before continuing.
- Any inability to prove explicit admission, Router-input minimization, bounded cancellation, output-contract pairing, or safe retry classification blocks activation rather than degrading to foreground-model inheritance.
- Public GitHub `main` commits/remotes/pushes for `LovelyLoong/pi-agent-router` and `LovelyLoong/pi-sessions` are explicitly authorized with repository-local noreply identity. npm publication, GitHub Releases/tags, force pushes, destructive history rewrites, and automatic policy-learning mutation remain unauthorized.
