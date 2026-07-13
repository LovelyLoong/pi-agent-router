<!-- markdownlint-disable MD013 -->

# Technical Design: Dynamic Agent Routing Boundary

## Context and Repository Orientation

`pi-agent-router` is a new independent package. It must work both as a library imported by Agent-backed tools and as a Pi extension that supplies configuration, Doctor commands, shared state, and compact rendering. The first production caller is a maintained fork of `pi-sessions@0.8.0`.

Today `pi-sessions/extensions/session-ask/agent.ts` resolves an optional configured model, otherwise uses `ctx.model`, and resolves an optional thinking level, otherwise inherits the caller's level. It directly creates an in-memory `AgentSession` and awaits up to three unbounded prompts. The Router integration must preserve session navigation and structured `provide_results`, but move target selection, deadlines, attempt classification, fallback, and audit information behind the new package.

Pi exposes the required public seams:

- `ExtensionContext.modelRegistry` resolves configured and authenticated models.
- `createAgentSession()` accepts an explicit model, thinking level, tools, custom tools, resource loader, session manager, and abort signal through `session.abort()`.
- Model metadata includes provider/id, context window, input types, reasoning support, thinking-level map, and cost.
- Tool `onUpdate` and renderers support compact live audit status.
- `pi.events` can publish package-local events, while library consumers can use typed sinks directly.

## Goals / Non-Goals

**Goals:**

- Make user configuration the only admission authority for Agent execution targets.
- Select a concrete executor/model/thinking target dynamically from a structured task contract.
- Keep hard capability and safety rules deterministic; use a dedicated Router Agent only for ranking valid candidates.
- Avoid recursive Router selection and avoid coupling to the foreground Agent.
- Bound selection and execution with cancellation, timeouts, attempts, failure classes, and fail-closed terminal behavior.
- Make every decision and fallback inspectable without leaking raw task payloads.
- Preserve a stable feedback boundary for a future independent evaluator/iteration package.
- Prove the design through a real routed `session_ask` integration.

**Non-Goals:**

- External CLI executors, active background probing, subjective answer grading, self-modifying policy, or npm publication in V1.
- A generic distributed scheduler or multi-host queue.
- Replacing Pi provider authentication or ModelRegistry.

## Decisions

### D-001: Separate routing policy from execution adapters

- **Decision:** Define a pure routing core that accepts `TaskContract`, approved candidate snapshots, health snapshots, and a `RouteJudge`. Execution occurs through `ExecutorAdapter` instances selected by the returned target.
- **Rationale:** Future Pi SDK, Claude Code, Codex CLI, and local executors have different invocation mechanics but share admission, ranking, health, failure, telemetry, and feedback semantics.
- **Alternatives considered:** Put all behavior in one Pi extension (too coupled); let each caller choose its own model (current defect).
- **Related criteria:** AC-001, AC-003, AC-004, AC-010.

### D-002: Use explicit versioned task contracts

- **Decision:** Every caller submits `TaskContractV1` containing an id, minimized `goalSummary`, required/preferred capabilities, allowed tools, input modalities, minimum context, output contract, side-effect class, data sensitivity, context metrics, deadline, and attempt budget. The execution payload remains separate and is not visible to the Router judge.
- **Rationale:** Hard requirements must not depend on model inference, while a minimized summary gives the judge enough semantic context to compare valid candidates.
- **Alternatives considered:** Raw prompt only (unsafe and unreliable); caller-selected candidates only (fails to centralize policy).
- **Related criteria:** AC-002, AC-005, AC-011.

### D-003: Make `agent-router.json` the sole admission authority

- **Decision:** Load and strictly validate `~/.pi/agent/agent-router.json`. Unknown fields, duplicate ids, unresolved executors/models, invalid thinking levels, recursive Router references, empty fallback chains, and unsafe budgets produce actionable diagnostics. Models discovered from Pi but absent from the file remain ineligible.
- **Rationale:** Automatic discovery is useful for Doctor evidence but must not silently expand what can receive user data or spend resources.
- **Alternatives considered:** Pi settings-only configuration (too large); fully automatic discovery (violates explicit approval); implicit current-model fallback (original defect).
- **Related criteria:** AC-001, AC-006, AC-012.

### D-004: Apply deterministic hard filtering before model judgment

- **Decision:** Filter candidates by enabled state, executor presence, ModelRegistry resolution/auth, model modalities/context/reasoning support, allowed thinking levels, required capabilities, tool policy, side-effect/data policy, health cooldown, and task deadline. The Router judge sees only survivors.
- **Rationale:** An LLM should optimize among valid choices, not decide security, compatibility, or impossible constraints.
- **Alternatives considered:** Give all candidates to the Router (non-deterministic safety); static profile mapping only (insufficient for novel tasks).
- **Related criteria:** AC-003, AC-004, AC-005.

### D-005: Use a dedicated, non-recursive Router Agent with structured output

- **Decision:** Configure a fixed primary Router target plus ordered backups. The judge receives the minimized task descriptor, aggregate context metrics, valid candidate metadata, health age/state, model cost/context metadata, and user qualitative labels. It must call a structured `rank_routes` tool exactly once with an ordered candidate list, selected thinking level, confidence, and concise reason. Router targets never route through this same decision path.
- **Rationale:** The user wants dynamic semantic judgment while avoiding dependence on the foreground model or an infinite “router chooses router” chain.
- **Alternatives considered:** Main Agent judgment (inherits foreground bias); rules only (weak on ambiguous tasks); full task prompt (privacy/cost risk).
- **Related criteria:** AC-003, AC-005, AC-011.

### D-006: Fall back deterministically when Router judgment is unavailable

- **Decision:** Try the configured Router primary/backups under a strict routing deadline. If all fail technically or violate the ranking contract, use the valid candidates' configured static priority. If no valid candidate remains, fail closed.
- **Rationale:** Routing should not make an otherwise valid configured task unavailable merely because the lightweight judge is temporarily down, but it must never invent an unapproved target.
- **Alternatives considered:** Inherit foreground model (rejected); run every candidate (costly); fail immediately on judge failure (unnecessarily brittle).
- **Related criteria:** AC-003, AC-006.

### D-007: Use passive health and task-as-probe semantics

- **Decision:** Maintain a versioned health store keyed by config hash, executor, model, and relevant target options. Static checks establish `unknown`, `available`, or `unavailable` without inference. Successful real tasks refresh health. Classified auth/model/provider/timeout/transport failures set cooldown/degraded state. No background timer or per-task paid preflight runs. `/agent-router-doctor` performs explicit active probes when requested.
- **Rationale:** Health must reduce repeated known failures without doubling normal request cost.
- **Alternatives considered:** Probe every call (expensive); periodic active requests (hidden spend); no cache (repeated failure latency).
- **Related criteria:** AC-007, AC-008.

### D-008: Retry only safe, classified failure categories

- **Decision:** Auto-fallback only for unavailable model/executor, authentication, rate limit/provider transport, timeout/abort policy, and required output-contract failure. Normal model output ends execution even if subjective quality is uncertain. Unknown side-effect outcomes stop rather than replay.
- **Rationale:** V1 has no independent evaluator and must avoid duplicate work or self-serving quality loops.
- **Alternatives considered:** Router grades every answer (extra calls and bias); run multiple candidates (high cost); retry all errors (unsafe).
- **Related criteria:** AC-006, AC-009.

### D-009: Expose versioned audit and feedback contracts

- **Decision:** Emit redacted `route.requested`, `route.decided`, `attempt.started`, `attempt.finished`, `route.finished`, and `feedback.recorded` events through typed sinks and optional Pi event-bus bridges. `RouteOutcomeV1` contains target, timing, token/cost usage when available, failure class, fallback chain, output-contract status, and caller correlation ids. A future package may call `recordFeedback()` with external scores, but Router policy never rewrites itself in V1.
- **Rationale:** Self-iteration requires trustworthy data and an explicit actuator boundary, not hidden prompt mutation.
- **Alternatives considered:** Log only text (not machine-usable); implement learning now (premature and unsafe).
- **Related criteria:** AC-009, AC-010.

### D-010: Provide compact default observability

- **Decision:** Render a compact card showing task kind, selected executor/model/thinking, selection source (judge/static), health freshness, and fallback count. Expanded view shows candidate ordering, concise reasons, attempts, timing, and failure classes. Raw task payloads and secrets never appear.
- **Rationale:** Dynamic routing must be understandable without flooding normal chat.
- **Alternatives considered:** Silent routing (hard to trust/debug); confirmation before every internal task (breaks automatic tools).
- **Related criteria:** AC-009.

### D-011: Integrate `session_ask` through an injected routed execution seam

- **Decision:** In the local `pi-sessions` fork, preserve navigation and custom tools but replace direct target inheritance with a `TaskContractV1` and routed Pi execution. The Router sees target size/count, requested analysis traits, read-only/tool/output requirements, and a minimized question summary; it does not see raw JSONL entries. Each candidate attempt constructs a fresh in-memory AgentSession with the selected model/thinking and a bounded deadline. Tool output preserves the existing `session_ask` public shape while adding route audit details.
- **Rationale:** This is the smallest real integration that reproduces the current defect and validates custom tools plus structured output.
- **Alternatives considered:** Copy session navigation into Router package (ownership duplication); patch installed npm files (not durable).
- **Related criteria:** AC-011, AC-012.

### D-012: Keep the first executor in-process and adapters capability-driven

- **Decision:** Ship only `PiSdkExecutorAdapter` in V1. The generic adapter reports capabilities, performs static availability, optionally active Doctor probing, executes a portable invocation request, classifies failures, and returns normalized usage/outcome. Adapter registration is explicit.
- **Rationale:** The interface can be validated without taking on external CLI installation, authentication, stream parsing, or process-isolation risk in the first change.
- **Alternatives considered:** Ship Codex/Claude adapters immediately (scope and compatibility risk); hard-code Pi in core types (future rewrite).
- **Related criteria:** AC-004, AC-010.

### D-013: Make the loaded Router extension a mandatory versioned service host

- **Decision:** Add a typed bounded `pi.events` discovery handshake and client. Exactly one compatible loaded Router extension exposes configuration inspection and controlled runtime execution. Managed Pi consumers must discover this service and fail closed on absence, duplication, version mismatch, or invalid/unconfigured state; they may not instantiate `AgentRouterRuntime` directly. External CLI/library consumers retain direct imports.
- **Rationale:** Direct package imports reuse algorithms but create independent runtime instances and cannot prove that the globally loaded Router service, lifecycle, diagnostics, and policy boundary are present. Pi packages have isolated module roots, while `pi.events` is the supported same-process cross-extension surface.
- **Alternatives considered:** Direct-import fallback (policy/state can fragment); `globalThis` registry (unsupported lifecycle/collision semantics); implicit in-memory starter defaults (violates explicit admission).
- **Related criteria:** AC-018, AC-019, AC-020.

### D-014: Materialize configuration and activate local dependent packages explicitly

- **Decision:** Keep missing configuration fail-closed, but after explicit developer approval run setup against the real agent directory and atomically back up/replace global package settings so one local Router host and the local modified pi-sessions package replace—not duplicate—the npm pi-sessions package. Add static package service metadata for catalog inspection.
- **Rationale:** Starter defaults in source are not active authority, and a service protocol is not discoverable until its host extension is loaded. Explicit setup plus replace-with-backup closes deployment without hidden admission or installed npm mutation.
- **Alternatives considered:** Auto-create on load (surprising policy mutation); use in-memory defaults (unsafe); load npm and local packages together (duplicate registrations).
- **Related criteria:** AC-021.

### D-015: Distribute public source as tested sibling Git repositories

- **Decision:** Publish `LovelyLoong/pi-agent-router` and the maintained `LovelyLoong/pi-sessions` fork on public `main` branches. Keep Router npm-unpublished; keep pi-sessions private in npm metadata. Document sibling cloning, add Node 24 CI, and require a fresh GitHub sibling clone to pass `npm ci`, full checks, and disposable offline Pi exactly-one-service/`session_ask` registration before portability is accepted.
- **Rationale:** The developer needs the verified packages reproducible on a new computer without copying local directories or claiming ownership of the official npm package.
- **Alternatives considered:** Local-only directories (not portable); npm publication (not authorized and the pi-sessions name belongs to upstream); embedding Router into the fork (breaks independent service ownership).
- **Related criteria:** AC-022.

## Interfaces and File Map

- `src/contracts/`: Versioned task, candidate, route, attempt, outcome, failure, health, event, and feedback contracts.
- `src/config/`: Strict schema, loader, normalization, config hashing, diagnostics, and starter-config generation.
- `src/routing/`: Hard filter, Router judge, static fallback, route orchestration, and deadline/attempt policy.
- `src/executors/`: `ExecutorAdapter` registry and Pi SDK adapter.
- `src/health/`: Passive health state, TTL/cooldown logic, atomic persistence, and Doctor orchestration.
- `src/observability/`: Event sinks, redaction, route audit details, and rendering helpers.
- `extensions/index.ts`: Pi extension wiring, commands, event-bus bridge, and compact UI integration.
- `tests/`: Unit, fake-provider, extension, config, health, failure/fallback, privacy, and end-to-end coverage.
- `docs/`: Configuration, caller API, adapter API, Doctor, security, and pi-sessions integration.
- `C:/Users/GF/Documents/pi-sessions`: Maintained upstream fork with a narrow `session_ask` integration seam and regression tests.

## Data, Control Flow, and Failure Handling

1. Caller builds `TaskContractV1` and keeps the full execution payload private.
2. Config loader validates the current config and computes its hash.
3. Executor registry resolves only explicitly enabled adapters and candidates.
4. Static availability plus cached health produce candidate snapshots.
5. Hard filter rejects invalid candidates with stable reason codes.
6. Dedicated Router primary/backups rank the valid candidates from minimized metadata; static priority is used only if judge execution/contract fails.
7. The orchestrator selects the first route not excluded by health/deadline/attempt limits and emits `attempt.started`.
8. Executor receives the selected target and full private execution request. Abort and candidate/overall deadlines are linked.
9. Success updates health and returns normalized outcome plus audit details.
10. A classified safe failure updates health and advances to the next ranked target while budget remains.
11. Unknown side-effect outcome, invalid configuration, no candidate, exhausted attempts, or overall deadline returns a structured terminal failure with a setup/Doctor/recovery action.
12. Feedback may be attached later by an external package but does not modify configuration or routing in V1.

Configuration and health writes use temporary files plus atomic rename. Config is never auto-expanded. Health state is cache data and may be deleted safely. Config changes invalidate stale health by hash rather than migrating trust implicitly.

## Initial Balanced Configuration Hypotheses

These values are explicit, user-editable V1 starting hypotheses and activation gates, not hidden constants. Focused fake-provider and real local checks may revise them through a planning-version update before production activation:

- Router primary: `openai-codex/gpt-5.4-mini` at `low`; Router backup: `openai-codex/gpt-5.6-luna` at `low`.
- Approved execution candidates: `gpt-5.4-mini` at `medium|high`, `gpt-5.6-luna` at `medium|high`, `gpt-5.6-terra` at `high|xhigh`, and `gpt-5.6-sol` at `high|xhigh`; `max` is not admitted in the starter config.
- Static fallback priority: mini → luna → terra → sol. The Router may reorder only valid candidates for a specific task.
- Router timeout: 30 seconds per judge target and 60 seconds overall.
- Default execution timeout: 180 seconds per attempt, 420 seconds overall, and at most three candidate attempts.
- Health success TTL: 15 minutes; ordinary technical-failure cooldown: 5 minutes; provider rate-limit cooldown honors bounded `Retry-After` between 1 and 30 minutes.
- Active Doctor probe: 30 seconds per target and 180 seconds overall, only after explicit invocation.

## Risks / Trade-offs

- **Risk:** The Router's semantic choice can be wrong.
  **Mitigation:** deterministic hard constraints, explicit candidate labels, compact audit, static fallback, and future external scoring.
- **Risk:** Router latency erases savings for tiny tasks.
  **Mitigation:** small minimized prompt, lightweight configured model, strict timeout, cacheable task-class hints where safe, and optional caller policy for deterministic single-candidate execution.
- **Risk:** One provider outage affects Router and candidates.
  **Mitigation:** configurable Router backups, independent candidate chain, cached failure cooldown, and fail-closed diagnostics.
- **Risk:** Session retries re-read large files and increase cost.
  **Mitigation:** bounded attempts, reuse immutable local navigation data where safe, fresh AgentSession per target, and technical-failure-only fallback.
- **Risk:** Fork drift complicates upgrades.
  **Mitigation:** narrow dependency seam, pinned upstream baseline, no copied navigation implementation, focused diff, and documented update procedure.

## Migration, Rollback, and Recovery

Install `pi-agent-router` from its local repository, create and validate `agent-router.json`, and run Doctor before enabling the routed `session_ask` fork. Keep the existing npm `pi-sessions@0.8.0` configuration available for rollback. Activation replaces only the session-ask extension source; session hooks, index, and search remain unchanged.

Rollback disables the forked session-ask extension and restores the pinned npm extension. Router health state is disposable; configuration and audit evidence remain for diagnosis. A failed config migration never rewrites the prior valid file. No session transcript migration is required because the public `session_ask` result remains compatible.

## Open Questions

- Non-blocking implementation detail: validate the recorded starter timeouts, TTLs, candidate ordering, and thinking levels with fake-provider and real local checks; revise them through a reviewed plan update if evidence refutes the hypotheses.
- Current distribution decision: public GitHub source and sibling clones only. Any future npm name/scope or GitHub Release requires a separate reviewed change.
- Deferred: external executor process isolation, quality evaluators, learned policies, and automatic configuration proposals belong to later packages/changes.
