<!-- checkpoint-id: f9a64e55-6435-443c-93ad-37a5371a2cf4 -->
# Verification Ledger

Allowed statuses: `unverified`, `passed`, `failed`, `blocked`, `deferred`.
Only `passed` counts as complete. Every `passed` row requires concrete evidence.

| Criterion | Status | Evidence | Verified At |
| --- | --- | --- | --- |
| AC-001 | passed | Strict config schema/loader/hash/starter and runtime tests exclude unconfigured models, fail closed when config is absent/invalid, and starter admits explicit targets only. | 2026-07-12T20:12:01.184Z |
| AC-002 | passed | Versioned TaskContract/output/executor/event contracts pass tests; session_ask sentinel task proves full private payload is created only per selected attempt. | 2026-07-12T20:12:01.184Z |
| AC-003 | passed | Routing tests cover executor/model availability, capability, modality, context, tools, side effects, sensitivity, health, thinking, deadline, and output hard rejection before judge input. | 2026-07-12T20:12:01.184Z |
| AC-004 | passed | PiSdkRouteJudge tests use fixed mini/low then backup/static configured priority, reject malformed rankings/thinking, and never inherit root sol@max. | 2026-07-12T20:12:01.184Z |
| AC-005 | passed | Router input/judge/event tests omit raw sentinel, navigation/body/execution prompt and retain only minimized sensitive task/candidate/health metadata. | 2026-07-12T20:12:01.184Z |
| AC-006 | passed | Execution tests cover linked route/attempt/overall deadlines, attempt cap, cancellation, terminal diagnostics, and no foreground/unapproved fallback. | 2026-07-12T20:12:01.184Z |
| AC-007 | passed | Health tests cover static checks, task-as-probe, TTL/cooldown/rate-limit backoff, config-hash invalidation, and no per-route paid probe. | 2026-07-12T20:12:01.184Z |
| AC-008 | passed | Doctor tests and disposable static Doctor cover config/registry/auth/cache and bounded opt-in active probes with no background resources. | 2026-07-12T20:12:01.184Z |
| AC-009 | passed | Orchestrator tests advance only classified technical/read-only output-contract failure; valid normal output, cancellation, unknown failure, and uncertain side effects stop. | 2026-07-12T20:12:01.184Z |
| AC-010 | passed | Executor registry/adapter contracts and PiSdkExecutor tests cover capability, availability, probe, exact model/thinking, cancellation, usage, failure normalization, fresh session, and disposal. | 2026-07-12T20:12:01.184Z |
| AC-011 | passed | Audit tests and session_ask rendering verify compact route/target/source/health/time/fallback and expanded candidate/attempt failure details without raw data. | 2026-07-12T20:12:01.184Z |
| AC-012 | passed | Redacted JSONL/Pi/composite sinks and versioned feedback tests link route/task/outcome while policy/config remain immutable. | 2026-07-12T20:12:01.184Z |
| AC-013 | passed | Health store tests verify atomic persistence, bounded schema, corruption quarantine, missing-cache recovery, config/cache separation, and unknown-state rebuild. | 2026-07-12T20:12:01.184Z |
| AC-014 | passed | Child routed/default tests and cross-package E2E preserve answer/relevantFiles/debugSessionPath, add route audit, and use configured luna@medium while root context is sol@max; child ledger checkpoint b2f00d3a passes all 7 criteria. | 2026-07-12T19:53:56.032Z |
| AC-015 | passed | test/session-ask.routed.integration.test.ts uses actual runtime/executor with two fresh execution sessions: mini is deadline-aborted timeout/disposed, luna privately invokes session_search/session_read/provide_results and succeeds, and audit records both attempts/fallbackCount=1. | 2026-07-12T19:53:56.032Z |
| AC-016 | passed | Focused missing-config test fails before child execution with setup guidance; cancellation reaches runtime and terminates aborted; task/events contain no foreground sol@max fallback. | 2026-07-12T19:53:56.032Z |
| AC-017 | passed | Disposable sibling local-package install and offline Pi RPC load pass; operations/integration docs specify filtered activation, no duplicate package, maintenance, and pinned npm 0.8.0 rollback without data migration. | 2026-07-12T20:12:01.184Z |
| AC-018 | passed | Versioned pi.events host/client discovers exactly one compatible service, exposes non-authoritative starter/config status, performs no paid discovery work, and Router check passes 9 files/56 tests. | 2026-07-13T03:02:51.921Z |
| AC-019 | passed | Focused tests reject missing, duplicate, incompatible, malformed, missing-config, invalid-config, and cancelled discovery without foreground or in-memory-default fallback. | 2026-07-13T03:02:51.921Z |
| AC-020 | passed | Production pi-sessions routed-agent requires the configured service handle, contains no direct AgentRouterRuntime construction, and service-backed privacy/cancellation/actual fallback plus full 163 regressions pass. | 2026-07-13T03:02:51.921Z |
| AC-021 | passed | Real config deep-equals createStarterRouterConfig and admits no max; atomic settings replacement preserved unrelated data/filters; fresh Pi loaded local Router and local pi-sessions, independent verifier found one configured v1 provider plus session_ask, static Doctor passed without active probes, and timestamped backup/npm 0.8.0 rollback remain. | 2026-07-13T03:33:19.758Z |
| AC-022 | unverified | — | — |

## Verification Notes

- Shared understanding was explicitly confirmed by the developer before repository initialization.
- Planning evidence is not implementation evidence; all behavioral criteria remain unverified until focused and end-to-end checks exercise actual code.
- The initial balanced model pool and timeout/TTL values are implementation hypotheses and must be recorded in design/docs plus tested before activation.
- Human acceptance remains separate from automated verification and OpenSpec strict validation.

- 2026-07-12T16:57:07.445Z: checkpoint e953717a-d20c-4eaa-918e-50a13c250c3a — Completed the evidence-backed architecture and planning gate for the dynamic Agent Router MVP. Strict OpenSpec validation passes, explicit starter model/thinking and bounded timeout/health hypotheses are recorded, and the Heavy execution permit is current.

- 2026-07-12T17:12:31.718Z: checkpoint 0dfabf9a-7c13-4a0e-9236-cdb7b922b384 — Completed and verified the pi-agent-router package foundation: ESM/npm/Pi scaffold, versioned task/routing/executor/event contracts, strict configuration authority, canonical hashing, fail-closed loading, and explicit balanced starter generation.

- 2026-07-12T17:21:16.556Z: checkpoint 3d6c69ca-3668-48d0-895f-ce44295e06e3 — Verified deterministic hard candidate filtering and dedicated Router planning. Only valid configured targets reach the judge; fixed judge backup/static fallback are deterministic; minimized input excludes execution payload and foreground model state.

- 2026-07-12T17:28:28.424Z: checkpoint bbd5b6fa-d326-41ec-a262-7b604d005f03 — Verified versioned passive health and manual Doctor core: task-as-probe updates, TTL/cooldown, config-hash invalidation, atomic persistence, corruption quarantine, static checks, and explicitly bounded active probes.

- 2026-07-12T18:02:12.674Z: checkpoint 75860dfc-3b74-4cdc-96e9-6553b3698042 — Verified the stable execution layer: registry, output contracts, linked route/per-candidate/overall deadlines, safe retry taxonomy, normalized outcomes/usage/health, dedicated fixed Pi Router judge, and fresh-session Pi SDK executor.

- 2026-07-12T18:27:26.704Z: checkpoint 4ed0e527-803b-413d-a9c5-b23bd5423268 — Verified the public Agent Router runtime and Pi operations surface: configured-only assembly, redacted event/feedback sinks, compact/expanded audit, explicit setup/status/Doctor commands, event-bus bridge, health persistence, and no background paid probes.

- 2026-07-12T18:52:56.102Z: checkpoint 292feb38-1c22-418b-8be0-8222e48c5a1c — Created and verified the maintained local pi-sessions@0.8.0 fork, reconciled upstream tag/published metadata provenance, initialized its Heavy OpenSpec workflow, installed the sibling Router dependency, and added a tested legacy-default injectable runner seam.

- 2026-07-12T19:34:34.301Z: checkpoint 2e7e3111-f399-4ff9-942f-4b52e77cae0c — T008 activation slice verified: Router gained persisted fresh-session path hooks and session tool admission; pi-sessions now defaults session_ask to minimized/private routed execution with root-max independence, explicit legacy rollback, cancellation/no-config failure, and compact/expanded audit. T008 stays open for actual two-attempt fallback E2E.

- 2026-07-12T19:53:56.032Z: checkpoint 6f65a497-adbc-48cd-97b6-a0d06e54c95d — T008/T009 verified: actual AgentRouterRuntime/PiSdkExecutor session_ask execution deadline-aborted mini and returned private contract-valid output from fresh luna; audit/events prove fallback, configured-only root-max independence, privacy, no-config/cancellation behavior, full regressions, and disposable Pi package loading.

- 2026-07-12T20:12:01.184Z: checkpoint 72445567-75de-4eeb-9b08-92bb35b57994 — All 17 product acceptance criteria now have concrete source/test/integration/documentation evidence. T010 documentation is complete. Final workflow completion remains blocked only by repository workflow Doctor coordination: uncommitted repositories have no HEAD, coordinator lease launch fails, and commits are not authorized.

- 2026-07-13T03:02:51.921Z: checkpoint 8b3f7529-a406-444d-8d42-ddc3e4d7e5c8 — Mandatory Router service and consumer migration verified: exactly-one typed discovery, fail-closed missing/duplicate/incompatible/unconfigured states, machine-readable metadata, and service-backed pi-sessions execution with no direct managed runtime construction.

- 2026-07-13T03:30:46.947Z: T015/AC-021 activation evidence — Explicit setup materialized the reviewed starter; the corrected Windows `r+` fsync path atomically replaced package selection while preserving unrelated settings/filter/backup; fresh real-settings Pi loaded one configured Router service and local `session_ask`; static Doctor passed without active probes. Existing foreground processes require restart/reload, and paid manual answer acceptance remains separate.

- 2026-07-13T03:33:19.758Z: checkpoint 3452e6dd-7ae3-4c01-a40a-377ba19b8080 — T015/AC-021 verified: explicit setup materialized the reviewed starter, corrected Windows r+ fsync enabled atomic package activation, and fresh Pi proved one configured Router service plus local session_ask with rollback preserved.

- 2026-07-13T04:04:19.266Z: checkpoint f9a64e55-6435-443c-93ad-37a5371a2cf4 — T016/T1100 verified: Router is public-clone ready with LovelyLoong metadata, accurate Git-only sibling installation/activation docs, SHA-pinned Node 24 CI, clean diagnostics, 9/56 checks, zero audit, and strict OpenSpec.
