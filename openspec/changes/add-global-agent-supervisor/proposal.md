<!-- markdownlint-disable MD013 -->

# Change Proposal: Add Global Agent Supervisor

## User Intent

Evolve `pi-agent-router` from a dynamic model router used by `session_ask` into the single global entry point for every Pi plugin that dispatches an Agent, subagent, or auxiliary Pi-model job. Callers must submit structured jobs rather than create or retain `AgentSession` objects. The Router must create a fresh worker per attempt, track ownership and dependencies, bound concurrency, and prove that normal completion, caller release, cancellation, timeout, failure, fallback, reload, and shutdown all end with deterministic resource cleanup.

## Why

The current Router successfully prevents foreground model/thinking inheritance and performed a real hot-reloaded `session_ask`, but it is not yet a pool-style supervisor. Its service creates a runtime per request, has no global lease registry or queue, and cannot inspect active ownership. `runWithDeadline()` may reject before the executor finishes abort/dispose, so a fallback can begin before the prior attempt reaches a cleanup barrier. Pi's `AgentSession.dispose()` aborts and disconnects but does not await idle or delete a persisted session file. Service unload unregisters discovery without centrally draining active work.

The active and maintained plugin set also contains bypasses: Pi compaction/branch summary use the foreground model, Hermes memory review and pi-web-access summary call a model directly, and pi-sessions retains direct handoff/title/legacy execution paths. Without one enforced boundary, every new plugin can reintroduce unbounded work, inherited `max` reasoning, orphaned resources, or unaudited data flow.

## Scope

### In Scope

- Add a singleton job supervisor with a bounded priority queue, global/per-owner/per-provider quotas, active lease registry, owner tree, prerequisite DAG, and typed terminal states.
- Expose only structured `run`, `stream`, and scoped `withAgent` APIs; never expose raw `AgentSession` objects to consumers.
- Run every full Agent attempt in a fresh isolated child process with a capability-scoped IPC tool bridge, cooperative cancellation, grace period, and Windows process-tree termination.
- Make cleanup a completion barrier: process exit, Agent abort/idle/dispose, temporary Session deletion, registry release, and audit finalization must settle before success or fallback.
- Delete execution transcripts and temporary directories by default. Keep only redacted metadata. Permit explicit per-job debug retention with a bounded TTL.
- Mark undeleted critical resources as `cleanup_failed`, quarantine them, expose degraded health, and run a bounded startup/manual janitor.
- Bind ordinary jobs to their owner lifecycle. Permit only allowlisted, budgeted, audited transfer to a service owner with TTL.
- Require successful prerequisites before dependent jobs start; allow failure-tolerant continuation only through an explicit policy.
- Add `/agent-router jobs`, `job`, `tree`, `audit`, compliance, and drain/Doctor inspection surfaces plus a light active/queued/degraded indicator.
- Add package compliance manifests/attestations, version/hash-bound source scanning, and fail-closed install/activation checks for direct Agent or auxiliary Pi-model calls.
- Migrate every known controlled call site: session ask, handoff, auto-title, compaction, branch summary, Hermes background review, and pi-web-access Pi-model summary.
- Remove the executable pi-sessions legacy direct-Agent bypass.
- Maintain public provenance-preserving `LovelyLoong/pi-hermes-memory` and `LovelyLoong/pi-web-access` forks with fetch-only upstream remotes and source-only distribution.
- Give future workflow worker/verifier and external CLI integrations the same versioned job/service contracts.
- Verify cancellation races, creation-time cancellation, timeouts, fallback ordering, force-kill, queue saturation, dependencies, reload/shutdown drain, deletion, janitor recovery, redaction, and clean-clone portability.

### Non-Goals

- Reusing an Agent or conversation across jobs; this is a supervisor/nursery, not an object pool.
- Exposing raw Agent handles or a manual borrow/return API.
- Routing the foreground interactive Pi Agent through itself.
- Recursively routing the Router judge. Router control-plane work remains an explicit internal execution class.
- Replacing third-party search/video provider protocols inside pi-web-access; those provider calls require explicit, narrow compliance exemptions.
- Reliably intercepting arbitrary malicious or dynamically generated third-party code after it is manually activated. Enforcement is package admission, attestation, source audit, managed activation, and startup verification rather than monkey patching Pi internals.
- Publishing npm packages under upstream names, creating release tags, force-pushing, or rewriting upstream history.
- Implementing evaluator-driven self-learning, Agent reuse, distributed scheduling, or multi-machine workers.

## Capabilities

### New Capabilities

- `agent-job-supervision`: Structured job API, ownership, dependencies, admission queue, quotas, and lifecycle state machine.
- `isolated-agent-lifecycle`: Per-attempt process isolation, IPC tool capabilities, cancellation escalation, cleanup barrier, deletion, quarantine, and janitor.
- `agent-job-observability`: Active job inspection, dependency trees, redacted terminal audit, degraded cleanup state, and service drain.
- `router-compliance-admission`: Package classification, signed/hash-bound attestation, forbidden-dispatch scanning, and fail-closed activation.
- `unified-pi-ai-dispatch`: Router-backed compaction, branch summary, session functions, memory review, web summary, and future plugin contracts.
- `public-fork-portability`: Provenance-preserving public consumer forks, sibling installs, upstream sync, and clean-clone verification.

### Modified Capabilities

- `routed-agent-execution`: Replace in-process best-effort attempt cleanup with supervised execution and a cleanup barrier.
- `mandatory-router-service`: Make one long-lived service own queue, registry, workers, drain, and inspection rather than creating an untracked runtime per request.
- `routed-session-analysis`: Remove direct legacy execution and use the structured supervisor API.
- `routing-observability-feedback`: Record complete cancellation and cleanup terminal evidence in addition to route outcomes.

## Constraints and Assumptions

- Node.js 24, Pi 0.80.6, ESM TypeScript, and Windows are the first required platform baseline.
- `~/.pi/agent/agent-router.json` remains the sole model/executor admission authority and gains versioned supervisor/compliance settings.
- Initial limits are four full-Agent workers, eight lightweight completion jobs, three active jobs per owner, and a queue capacity of thirty-two. Interactive work outranks background work; all queue waits inherit caller deadlines.
- Complete Agent jobs use process isolation. Lightweight completion jobs still use the same registry/lease/cleanup contracts and may use a separately approved lighter isolation class.
- Tool closures stay with the selected attempt and are exposed through a bounded IPC capability bridge; Router ranking still sees only the minimized task contract.
- The current `pi-repo-workflow` worktree has unrelated dirty files and is not a product write target for this change.
- Public Git source remains the distribution boundary unless separately authorized.

## Success Signals

- At every observable terminal point, no completed/cancelled/failed job remains active, no worker process remains owned, and no default-retention Session directory remains.
- Fallback never starts until the previous attempt's cleanup barrier passes.
- Session shutdown and extension reload drain or force-terminate all session-owned work within a bounded deadline.
- Package audit classifies every active extension source as Router-internal, Router-client, no-dispatch, or explicitly exempt; unknown and violating packages fail activation.
- Live hot-reloaded `session_ask` and compaction use configured Router targets without inheriting foreground `sol/max`.
- Public sibling clones of Router and all maintained consumers install, check, audit, and load the exactly-one configured service on Windows and CI.

## Risks

- Process isolation and IPC add latency and protocol complexity; mitigate with an early deterministic-provider spike, explicit protocol versions, bounded messages, and no raw callback serialization.
- Windows process-tree termination and locked temporary files can fail; mitigate with cooperative grace, `taskkill /T /F` fallback, exit confirmation, deletion retries, quarantine, janitor, and `cleanup_failed` terminal semantics.
- Static compliance scanning cannot prove arbitrary dynamic behavior; mitigate with version/hash attestations, known API rules, human review for unknown patterns, startup drift detection, and no claim of runtime sandboxing.
- Multiple maintained forks increase update cost; mitigate with narrow patches, official ancestry, fetch-only upstream remotes, semantic-port procedures, and CI that installs Router as a sibling.
- Replacing Pi's built-in compaction summary can affect continuity; mitigate with source-compatible prompts/output, deterministic fixtures, context-resilience E2E, and a real paid smoke test before acceptance.
