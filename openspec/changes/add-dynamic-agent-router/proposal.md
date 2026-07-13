<!-- markdownlint-disable MD013 -->

# Change Proposal: Add Dynamic Agent Router

## User Intent

Create an independent Pi package that becomes the common decision and execution boundary for internal Agent work. Session tools, compaction, workflow delegates, and future Claude Code, Codex CLI, or local-model adapters must stop inheriting the current foreground model and thinking level. Instead, each caller submits a bounded task contract; a dedicated Router Agent chooses only from user-approved executors, models, and thinking levels, and the runtime records an auditable decision, applies bounded technical fallback, and exposes future feedback hooks.

## Why

Current Agent-backed features choose models independently and often inherit the foreground Pi model and reasoning level. A developer may intentionally run a complex root task at `max`, while a retrieval, summarization, or session-analysis subtask needs a cheaper and faster model. This coupling caused a real `session_ask` call to remain on `Working` for more than twelve minutes because it inherited `gpt-5.6-sol` with `max` reasoning and had no bounded routing policy.

The problem extends beyond `session_ask`: context compaction, title/summary generation, workflow scouts/planners/reviewers/workers, and future external CLI Agents all need the same answer to “which available Agent, model, and reasoning level best satisfies this task?” A central Router is required so user approval, capability metadata, cost/latency trade-offs, health, fallback, telemetry, and future outcome learning do not diverge across call sites.

## Scope

### In Scope

- Ship an independent Git-distributed npm/Pi package named `pi-agent-router` in the public `LovelyLoong/pi-agent-router` repository.
- Define a versioned `TaskContract` combining a minimal natural-language goal summary with hard capability, tool, side-effect, context, output-contract, sensitivity, timeout, and attempt constraints.
- Use `~/.pi/agent/agent-router.json` as the sole authority for approved executors, models, allowed thinking levels, qualitative capabilities, fixed Router-model fallback, static fallback priority, and health policy.
- Implement a Pi SDK executor and a stable `ExecutorAdapter` boundary for future Claude Code, Codex CLI, and local/open-source models.
- Use deterministic hard filtering before a dedicated, non-recursive Router Agent ranks valid model/thinking candidates.
- Restrict the Router Agent to a minimized, redacted task descriptor and candidate metadata; never provide raw session history, repository code, or hidden reasoning by default.
- Resolve Router-model failure through its configured fixed fallback chain and then configured static candidate priority.
- Maintain passive health with static availability checks, a TTL cache, configuration-hash invalidation, failure cooldown, and task-as-probe updates; expose an explicit Doctor for active checks.
- Retry only technical, timeout, availability, and output-contract failures; do not silently rerun a normally returned answer for subjective quality in V1.
- Fail closed with actionable setup/Doctor guidance when configuration is missing, no approved candidate is valid, or all bounded attempts fail. Never fall back to the foreground model implicitly.
- Emit a compact, expandable routing audit card and versioned decision/attempt/outcome/feedback events without exposing sensitive task payloads.
- Provide feedback interfaces that a future independent evaluation/self-iteration package can consume, without implementing learning in this change.
- Maintain a local `pi-sessions` fork that routes `session_ask` through this package while preserving its evidence-first navigation and structured result contract.
- Expose a versioned typed `pi.events` service so independently loaded Pi packages can discover exactly one Router host, inspect configuration state, and execute through the common runtime; managed consumers fail closed instead of constructing their own runtime.
- Materialize the reviewed starter only through explicit setup, then activate one local Router package and replace npm pi-sessions with the dependent local fork using a backed-up reversible settings change.
- Verify that a root Pi session running `max` can invoke `session_ask` without the child inheriting `max`.
- Publish Router and the maintained `pi-sessions` fork as public sibling GitHub repositories and prove a fresh sibling clone can install, check, and load exactly one configured service plus `session_ask` without paid requests.

### Non-Goals

- Implementing Claude Code, Codex CLI, remote Agent, or local-model executor adapters in V1.
- Automatically discovering and approving every available model; unconfigured models are never eligible.
- Letting the Router recursively route its own model selection.
- Sending full task context to the Router Agent.
- Running periodic paid model probes in the background or before every task.
- Subjective result-quality judging, tournament execution, reinforcement learning, prompt mutation, or automatic policy rewriting.
- Replacing Pi's ModelRegistry, provider authentication, retry implementation, or AgentSession lifecycle.
- Publishing either package to npm, creating GitHub Releases/tags, or running paid publication verification. Public GitHub source commits and pushes are explicitly authorized for this outcome.

## Capabilities

### New Capabilities

- `configured-agent-routing`: User-approved model/executor inventory, task contracts, hard filtering, dedicated Router ranking, and deterministic fallback.
- `routed-agent-execution`: Pi SDK execution, bounded deadlines/attempts, passive health, failure classification, and fail-closed behavior.
- `routing-observability-feedback`: Compact audit rendering, Doctor, durable health state, versioned events, and future evaluator hooks.
- `routed-session-analysis`: `session_ask` integration through a maintained `pi-sessions` fork without foreground model/thinking inheritance.
- `public-git-portability`: Public source metadata, CI, sibling clone/install instructions, and clean-clone service verification without npm publication.
- `mandatory-router-service`: Versioned cross-package discovery, exactly-one service authority, managed consumer enforcement, and explicit local package activation.

### Modified Capabilities

- None in this new repository. The companion `pi-sessions` fork will modify its existing session-analysis execution path while preserving its public tool contract.

## Constraints and Assumptions

- Node.js 24 and Pi 0.80.6 are the initial compatibility baseline.
- The package uses ESM TypeScript and Pi public SDK/extension APIs.
- `ModelRegistry` availability proves configured authentication/registration, not provider health; active inference is reserved for real work or explicit Doctor probes.
- Configured model cost/context/input/reasoning metadata may come from Pi, while user configuration remains authoritative for admission and qualitative capability labels.
- Initial balanced configuration may use `openai-codex/gpt-5.4-mini` as the Router and approve selected `mini`, `luna`, `terra`, and `sol` candidates without `max`; exact defaults remain editable and are never expanded implicitly.
- Router and execution deadlines are bounded and configurable. Abort signals must propagate through selection and execution.
- Cross-repository integration is tracked separately in the public maintained `LovelyLoong/pi-sessions` fork; this change remains the authority for Router contracts and behavior.
- Repository-local Git author identity is `可爱的龙 <54889641+LovelyLoong@users.noreply.github.com>`; global Git identity remains unchanged.

## Impact

- **Code:** New core routing, configuration, health, Pi executor, Doctor, event, UI, and test modules; companion `pi-sessions` integration changes.
- **APIs / Schemas:** Versioned configuration schema, task/route/executor/failure/event/feedback contracts, and adapter interfaces.
- **Dependencies / Operations:** Pi SDK peer dependencies, TypeBox/schema validation, a user configuration file, bounded health-state storage, and a local `pi-sessions` fork installation.

## Risks

- A Router Agent introduces latency and another possible failure; mitigate with a lightweight fixed model, minimized prompt, strict timeout, configured fallback chain, and static-priority fallback.
- Incorrect qualitative capability metadata can produce poor ranking; mitigate with hard caller constraints, explicit configuration, audit details, and future external feedback rather than hidden adaptation.
- Automatic fallback may duplicate costly work; mitigate by retrying only classified technical/contract failures, limiting attempts, and never retrying unknown side-effect outcomes.
- Cross-provider routing could leak task data; mitigate by giving the Router only a minimized descriptor and recording data-sensitivity constraints.
- Health caches can become stale; mitigate with short bounded TTLs, config-hash invalidation, failure cooldown, task-as-probe updates, and manual Doctor.
- A local `pi-sessions` fork can drift from upstream; mitigate with a narrow injection seam, upstream-style tests, pinned revisions, and a documented rebase/update procedure.
