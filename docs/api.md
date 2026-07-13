<!-- markdownlint-disable MD013 -->

# Agent Router API

## Public modules

| Import | Main surface |
| --- | --- |
| `pi-agent-router` | All stable V1 exports |
| `pi-agent-router/config` | schema, validation, canonical hash, loader, starter generation |
| `pi-agent-router/contracts` | task, route, executor, event, feedback, diagnostics contracts |
| `pi-agent-router/routing` | hard filter, judge interfaces, route planning |
| `pi-agent-router/execution` | registry, orchestrator, output contracts, Pi SDK executor/judge, deadlines |
| `pi-agent-router/health` | health schema/store and Doctor |
| `pi-agent-router/observability` | redaction, sinks, audit builders/rendering |
| `pi-agent-router/runtime` | configured `AgentRouterRuntime` assembly |

All persisted or cross-package contracts carry an explicit V1 discriminator/version. Breaking contract changes require a new version rather than silent reinterpretation.

## Task contract

`TaskContractV1` contains only routing-safe metadata:

- stable task id and kind;
- minimized goal summary;
- required/preferred capabilities;
- allowed tools and input modalities;
- minimum context and reasoning requirement;
- side-effect and data-sensitivity classes;
- required output kind/contract name;
- aggregate context bytes, estimated tokens, and item count;
- route, attempt, overall, and attempt-count budgets;
- quality/cost/latency preferences.

Do not put the execution prompt, source documents/session entries, project instruction bodies, credentials, or tool closures in this object. The Router judge receives a minimized view derived from it.

## Runtime execution

```ts
const runtime = await AgentRouterRuntime.create({
  modelRegistry,
  cwd,
  eventSink,
});

const contracts = new OutputContractRegistry();
contracts.register<MyResult>({
  name: "my-result.v1",
  validate(value) {
    return isMyResult(value)
      ? { ok: true, value }
      : { ok: false, message: "Invalid my-result.v1 payload." };
  },
});

const execution = await runtime.execute<MyResult, PiSdkExecutionPayload<MyResult>>({
  task,
  outputContracts: contracts,
  createPayload(target, attempt, signal) {
    return {
      cwd,
      prompt: buildPrivatePrompt(target),
      tools: ["read"],
      customTools: createAttemptLocalTools(),
      captureResult: captureAttemptLocalResult,
    };
  },
  signal,
  onProgress(message) {
    // Message is bounded route/attempt status, not raw model output.
  },
});
```

`createPayload` is called separately for each selected attempt. Any mutable result capture, custom tools, resource loader, and persistence callback must be newly allocated there.

`RuntimeExecutionResult` returns planning evidence, normalized outcome/attempts/usage, diagnostics, event-sink errors, passive health state, and a compact/expandable `RouteAuditRecord`.

## Output contracts

A structured/tool task names its output contract in `task.requirements.output.contractName`. The same name must be registered before execution. Missing registrations fail before model execution.

A validator returns either `{ ok: true, value }` or `{ ok: false, message }`. On read-only work, contract failure is a safe fallback class. On potentially mutating work, callers must not assume replay is safe.

## Executor adapter

An `ExecutorAdapter` publishes:

- executor id/type and capabilities;
- static `checkAvailability(target)`;
- optional bounded `probe(target, signal)`;
- `execute({ task, target, payload, signal, onProgress })` returning normalized success/failure/usage.

Adapters are registered explicitly in `ExecutorRegistry`. V1 ships `PiSdkExecutor` only. External CLI/process adapters must implement isolation, authentication, cancellation, output parsing, side-effect safety, and stable failure classification in a later reviewed package/change.

`PiSdkExecutionPayload` supports exact prompt/system prompt, built-in/custom tools, optional persisted-session directory, session-created callback, and structured result capture. The executor resolves the exact configured model and thinking level, creates a new session, links abort, aggregates usage, and always unsubscribes/disposes.

## Route judge

A `RouteJudge` receives only `RouterJudgeInputV1`: minimized task metadata plus already-valid candidate metadata. It returns strict `rank_routes.v1` ordering, candidate id, admitted thinking level, confidence, and reason.

`PiSdkRouteJudge` runs at a fixed configured target and does not call `AgentRouterRuntime.execute()`, preventing recursive routing. Technical/contract failure advances to configured Router backup, then static configured priority.

## Events and audit

`RouteEventSink` receives redacted versioned events:

- `route.requested`;
- `route.decided`;
- `attempt.started`;
- `attempt.finished`;
- `route.finished`;
- `feedback.recorded`.

Available sinks include JSONL, Pi event bus, and composite fan-out. Sink failures are captured as diagnostics and do not rewrite execution policy.

`renderRouteAudit(record, expanded)` renders the selected target, decision source, health, elapsed time, and fallback count; expanded output adds ranked candidates and attempt/failure details.

## Feedback boundary

`recordFeedback()` accepts versioned external observations and emits/stores them through the configured sink. Router V1 does not score its own answers, mutate configuration, change priority, or trigger retries from feedback. Evaluator, scoring, iteration, and policy-proposal behavior belongs to a separate package with separate governance.

## Configuration API

- `loadRouterConfig(path?)` validates without inventing defaults.
- `writeStarterRouterConfig(path?)` creates but refuses overwrite.
- `createStarterRouterConfig()` returns the explicit reviewed starter object.
- `hashRouterConfig(config)` uses canonical normalized content.

Callers should use `AgentRouterRuntime.create()` unless they are testing a lower-level pure component.
