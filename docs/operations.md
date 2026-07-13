<!-- markdownlint-disable MD013 -->

# Agent Router Operations

## Files and authority

| File | Purpose | Recovery |
| --- | --- | --- |
| `~/.pi/agent/agent-router.json` | Sole execution/Router target admission policy | Review and repair explicitly; never auto-expanded |
| `~/.pi/agent/agent-router-health.json` | Passive availability/latency/cooldown cache keyed by config hash | Safe to delete; rebuilt from real work or Doctor |
| `~/.pi/agent/agent-router-events.jsonl` | Redacted route/attempt/feedback events when the JSONL sink is enabled | Rotate or delete under local retention policy |

Configuration loading is fail-closed. Missing files, invalid JSON, unknown schema fields, duplicate ids, empty Router chains, invalid model names/thinking levels, unknown executors, and unsafe budgets produce diagnostics instead of foreground fallback.

## Starter configuration

Run `/agent-router setup` from a Pi process that loads this package. It refuses to overwrite an existing file. The generated V1 starter contains:

- executor `pi` (`pi-sdk`);
- fixed Router targets mini/low and luna/low;
- execution candidates mini, luna, terra, and sol;
- only explicitly listed thinking levels (`medium|high` or `high|xhigh`), never `max`;
- analysis/coding/retrieval/structured-output capability labels;
- read-only and sensitive-data admission;
- `read`, `grep`, `find`, `ls`, `bash`, `session_search`, `session_read`, and `provide_results` tool admission;
- bounded routing, execution, health, and Doctor policy.

Treat this as a reviewed starting point, not automatic discovery. Removing a candidate removes its authority immediately. Adding a model is a security, data, cost, and quality decision.

## Routing lifecycle

1. Validate and bound the caller's `TaskContractV1` against configuration.
2. Resolve configured executor/model metadata and passive health snapshots.
3. Reject candidates that fail deterministic capability, modality, context, reasoning, tool, side-effect, sensitivity, thinking-level, availability, or cooldown checks.
4. If one candidate survives, bypass semantic routing.
5. Otherwise call the fixed Router primary and backup under the routing budget. The judge receives minimized task/candidate metadata only.
6. If both Router targets fail technically or violate `rank_routes.v1`, use configured static priority among valid candidates.
7. Create a fresh private payload and Pi session for each execution attempt.
8. Stop on contract-valid output, cancellation, unknown failure, uncertain side effects, attempt exhaustion, or overall deadline.
9. Advance only for safe classified technical failures or read-only output-contract failure.
10. Persist passive health and emit redacted audit/events.

## Failure and fallback policy

| Outcome | Automatic next candidate? |
| --- | --- |
| Valid normal output | No |
| Missing/invalid required structured output on read-only work | Yes, within budget |
| Model/executor unavailable, auth, rate limit, provider/transport failure | Yes, within budget |
| Attempt deadline timeout | Yes, within budget |
| Caller cancellation | No |
| Unknown failure | No |
| Potentially committed side effect with uncertain result | No |
| No valid configured candidate | No; fail closed |
| Missing/invalid config | No; fail closed with setup guidance |

A fallback is not a quality rerun. V1 has no independent answer evaluator.

## Deadlines and cancellation

The effective task budget is bounded by both the task contract and configuration. The starter maxima are:

- Router attempt: 30 seconds;
- Router overall: 60 seconds;
- execution attempt: 180 seconds;
- execution overall: 420 seconds;
- execution attempts: 3;
- active Doctor probe: 30 seconds per target and 180 seconds overall.

The caller signal, routing deadline, candidate deadline, and overall deadline are linked. When an attempt deadline fires, `PiSdkExecutor` aborts and disposes that attempt's session before safe fallback. A caller abort is terminal and is never reclassified as a candidate timeout.

## Health behavior

Normal work acts as the probe. Success records latency and a 15-minute success TTL. Classified failures apply cooldown; rate limits honor bounded retry timing between one and 30 minutes. Config hash changes invalidate prior health authority.

Static Doctor checks configuration, registration, model resolution, and credentials without inference. Active Doctor is opt-in and bounded to two concurrent probes. There are no background timers or hidden paid probes.

## Privacy and audit

Route events and `RouteAuditRecord` may contain:

- task id/kind and aggregate size/count metrics;
- configured executor/model/thinking ids;
- decision source, rank/confidence/reason;
- health state/age, timing, usage/cost, and stable failure class;
- fallback count and attempt order.

They must not contain raw source sessions, complete prompts, project instructions, tool closures/results, secrets, or unredacted private payloads. Event sinks apply key/value redaction and size limits, but callers remain responsible for constructing a minimized task.

## Recovery playbook

1. Run `/agent-router status`.
2. Run static `/agent-router doctor`.
3. Inspect config diagnostics and verify target credentials in Pi.
4. If health appears stale or corrupted, back up then delete `agent-router-health.json`; do not delete configuration to "fix" admission.
5. Use active Doctor only when a live request is explicitly acceptable.
6. Reproduce with the compact route audit expanded to inspect candidate order and failure classes.
7. For `session_ask`, switch to the explicit legacy runner or pinned npm package only as the documented rollback; never fall back implicitly inside Router.

## Git installation, compatibility, and activation state

Source is published at `https://github.com/LovelyLoong/pi-agent-router` and is distributed from Git rather than npm. Clone it beside `https://github.com/LovelyLoong/pi-sessions` so the fork's `file:../pi-agent-router` dependency resolves, then run `npm ci` and `npm run check` in both repositories.

The verified baseline is Windows, Node.js 24, and Pi 0.80.6. Real explicit setup created `~/.pi/agent/agent-router.json` equal to the reviewed starter, and real package settings select one local Router plus the filtered local maintained fork. Fresh-process RPC observed exactly one configured V1 service and registered `session_ask`; static Doctor passed without active probes. Existing Pi processes require restart after changing package selection.

GitHub source publication does not publish npm packages or create Releases. Clean sibling-clone verification is the portability gate for new computers.
