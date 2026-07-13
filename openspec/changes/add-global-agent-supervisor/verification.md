<!-- checkpoint-id: 98e37b54-7ee4-475e-a33a-55f3d468464f -->
# Verification Ledger

Allowed statuses: `unverified`, `passed`, `failed`, `blocked`, `deferred`.
Only `passed` counts as complete. Every `passed` row requires concrete evidence.

| Criterion | Status | Evidence | Verified At |
| --- | --- | --- | --- |
| AC-023 | unverified | Planning target: singleton supervisor and fresh registered jobs/attempts. | - |
| AC-024 | unverified | Planning target: structured APIs expose no raw Agent resource. | - |
| AC-025 | unverified | Planning target: owner binding, cascade cancellation, and bounded transfer. | - |
| AC-026 | passed | tests/supervisor-graph.test.ts proves unknown-id and dependency/owner cycle rejection before mutation, blocking until every prerequisite succeeds, dependency_failed with no attempt on failure, and continuation only for a configured failure-input task kind. Full check passed 15 files/84 tests. | 2026-07-13T08:58:28.208Z |
| AC-027 | passed | tests/supervisor-queue.test.ts proves interactive-over-background stable FIFO, exact balanced 4 full-Agent / 8 completion / 3 per-owner / 32 queued defaults, queue_full for job 33 with no attempt, full-Agent/completion/control-plane/per-owner/provider/model quotas, routed resource admission, and queued/active inherited deadlines. Fake timers clear on stop. | 2026-07-13T08:58:28.208Z |
| AC-028 | passed | tests/worker-execution.test.ts runs the product agent-worker.mjs with a real deterministic Pi AgentSession. Two same-target attempts have distinct PIDs, nonces, attempt ids, in-memory Sessions/tool namespaces and roots; children load no extensions/skills/templates/default tools, exit before return, and create zero Session JSONL files. | 2026-07-13T09:58:18.435Z |
| AC-029 | passed | tests/worker-execution.test.ts and tests/worker-protocol.test.ts prove V1 capability IPC round-trip and parent validation of job/attempt/lease identity, exact capability/tool, TypeBox schema, active state, deadline, call counts, pending calls and frame/payload/argument/result sizes. Unknown/revoked/schema-invalid calls fail before the closure; lifecycle events contain no private prompt. Final full check passed 17 files/100 tests. | 2026-07-13T09:58:18.435Z |
| AC-030 | unverified | Planning target: cancellation at every phase and confirmed process-tree exit. | - |
| AC-031 | unverified | Planning target: cleanup barrier and default Session/temp deletion before terminal outcome. | - |
| AC-032 | unverified | Planning target: cleanup_failed, safe quarantine, degraded state, and bounded janitor. | - |
| AC-033 | unverified | Planning target: reload/shutdown stops admission and drains all owned work. | - |
| AC-034 | unverified | Planning target: safe fallback starts only after prior cleanup succeeds. | - |
| AC-035 | unverified | Planning target: all auxiliary completions and control-plane work use supervised lifecycle. | - |
| AC-036 | unverified | Planning target: jobs/job/tree/audit inspection API and lightweight counts. | - |
| AC-037 | unverified | Planning target: complete terminal audit with no private payload/path leakage. | - |
| AC-038 | passed | tests/config-v2.test.ts proves strict balanced defaults; unknown/unsafe priority, cleanup grace, owner/provider bounds and duplicate limits fail with stable diagnostics; V1 load returns config_migration_required without mutation; explicit migration preserves byte-identical backup, atomically writes and validates V2, and refuses repeat migration. npm run check passed 11 files/67 tests; strict OpenSpec, LSP, Lens and git diff checks passed on 2026-07-13. | 2026-07-13T07:14:37.261Z |
| AC-039 | unverified | Planning target: package classification and exact source/version/hash attestation. | - |
| AC-040 | unverified | Planning target: unknown/stale/violating packages fail managed activation. | - |
| AC-041 | unverified | Planning target: pi-sessions ask/handoff/title migrated and executable legacy bypass removed. | - |
| AC-042 | unverified | Planning target: compaction and branch summary supplied by Router hooks. | - |
| AC-043 | unverified | Planning target: provenance-preserving Hermes fork and routed background review. | - |
| AC-044 | unverified | Planning target: provenance-preserving web-access fork and routed Pi-model summary. | - |
| AC-045 | unverified | Planning target: full active/controlled inventory has no unmanaged dispatch. | - |
| AC-046 | unverified | Planning target: paid hot-reloaded session-ask and compaction with zero cleanup residue. | - |
| AC-047 | unverified | Planning target: four public source repositories, upstream safeguards, CI, and clean-clone portability. | - |

## Verification Notes

- No acceptance criterion is passed at planning time.
- The plan must be independently audited through the deterministic Heavy verifier binding available in the repository workflow before product source mutation.
- Final completion requires strict OpenSpec validation, project checks/audits, clean diagnostics, exact-head CI, clean-clone verification, Workflow Doctor, a current checkpoint shared by this ledger and `HANDOFF.md`, and explicit developer review disposition.

- 2026-07-13T06:19:26.438Z: checkpoint 600f551d-ce33-42a1-ab98-bc12ab9f4e87 — Completed the developer-aligned Heavy architecture and planning gate for the global Agent supervisor. Strict OpenSpec and deterministic structural audits pass; a current permit authorizes only the disposable isolation/IPC/cleanup feasibility spike next.

- 2026-07-13T06:37:12.445Z: checkpoint 6563e8c7-5548-47ef-925b-7286ca3fee1a — Resolved the global supervisor feasibility gate after a bounded replan: a no-paid Node 24/Windows spike ran a real deterministic Pi AgentSession in a fresh child, bridged a parent capability, exercised spawn/tool/cooperative cancellation and forced process-tree termination, and proved deletion retry plus cleanup_failed quarantine/janitor recovery with zero remaining PIDs or temp root.

- 2026-07-13T07:14:37.261Z: checkpoint 3fccef13-52a9-4e72-918a-ceb7a9992164 — Completed T103 without activating V2 prematurely: added strict V2 job/owner/transfer/dependency/attempt/lease/lifecycle/retention/isolation contracts, structured run/stream/withAgent service types and discovery diagnostics, balanced supervisor/compliance configuration, and an explicit atomic backed-up V1-to-V2 migration. V1 remains the live service until T107.

- 2026-07-13T08:58:28.208Z: checkpoint 1e4713be-cf22-47d7-a5ad-e66c985dc32c — Completed T104's deterministic supervisor scheduling core: one encapsulated registry tracks immutable snapshots and unique jobs/attempts/leases; owner trees and bounded atomic transfer, prerequisite DAG policy, stable priority/FIFO, exact balanced queue bounds, hierarchical quotas, explicit resource assignment, terminal transitions and fake-clock deadlines are implemented and verified.

- 2026-07-13T09:58:18.435Z: checkpoint 98e37b54-7ee4-475e-a33a-55f3d468464f — Completed T105's product worker layer: every attempt forks a fresh short-lived child, resolves only the selected target, creates an in-memory extension-free Pi AgentSession or isolated completion, bridges only explicit parent capabilities over bounded V1 IPC, validates identity/schema/active/deadline/size/count state at the parent, waits for normal exit, and exposes only redacted lifecycle metadata.
