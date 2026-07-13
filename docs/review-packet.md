<!-- markdownlint-disable MD013 -->

# Dynamic Agent Router V1 — Developer Review Packet

## Decision requested

After reading and rerunning the evidence below, choose one:

- **Accept** the public Git-distributed implementation and current local activation.
- **Request changes** with the criterion, behavior, or file that must change.
- **Reject** the approach and restore the pinned npm `pi-sessions@0.8.0` settings backup.

Machine verification does not imply developer acceptance. Explicit local activation and public GitHub source publication are part of the current reviewed outcome; npm publication, GitHub Releases, installed-package mutation, and paid acceptance requests are not.

## Reading order

1. [`README.md`](../README.md) — package purpose, invariants, starter targets, and scope.
2. [`docs/operations.md`](operations.md) — admission, deadlines, fallback, health, Doctor, privacy, and recovery.
3. [`docs/api.md`](api.md) — caller/executor/event/feedback interfaces.
4. [`src/runtime/runtime.ts`](../src/runtime/runtime.ts) — configured-only assembly.
5. [`src/routing/filter.ts`](../src/routing/filter.ts) and [`src/routing/router.ts`](../src/routing/router.ts) — hard constraints and decision fallback.
6. [`src/execution/orchestrator.ts`](../src/execution/orchestrator.ts) and [`src/execution/pi-sdk.ts`](../src/execution/pi-sdk.ts) — safe retries, deadlines, and fresh sessions.
7. `../pi-sessions/extensions/session-ask/routed-agent.ts` — first production caller and privacy boundary.
8. OpenSpec [`proposal.md`](../openspec/changes/add-dynamic-agent-router/proposal.md), [`design.md`](../openspec/changes/add-dynamic-agent-router/design.md), [`tasks.md`](../openspec/changes/add-dynamic-agent-router/tasks.md), and [`verification.md`](../openspec/changes/add-dynamic-agent-router/verification.md).

## Commitment-to-evidence map

| Commitment | Implementation | Evidence |
| --- | --- | --- |
| Configuration is the only admission authority | config loader/schema, runtime snapshots | config/routing/runtime tests; missing-config integration |
| Foreground model/thinking is never inherited | task/payload split and exact execution target | root `sol@max` routed tests select mini/luna@medium |
| Router input excludes raw session/private prompt | bounded task and private `createPayload` | sentinel absent from task, judge prompt, and events; private read sees it |
| Hard constraints precede model judgment | `filterCandidates` | capability/tool/modality/context/sensitivity tests |
| Router is fixed and non-recursive | `PiSdkRouteJudge` fixed target chain | judge target tests and static fallback tests |
| Attempts/deadlines/cancellation are bounded | linked deadlines and orchestrator | attempt/overall timeout and cancellation tests |
| Fallback is safe and technical only | stable failure taxonomy/output registry | normal/unknown outcomes stop; timeout/output contract may advance |
| Every candidate attempt is fresh | `PiSdkExecutor` session factory per call | cross-package mini timeout then fresh luna success/disposal |
| Health has no hidden probes | passive store and explicit Doctor | health/Doctor tests; disposable static Doctor |
| Audit is useful but redacted | sinks/redactor/audit renderer | observability tests and session_ask compact/expanded assertions |
| Learning is outside Router | feedback seam only | no mutation actuator exists; API docs state boundary |
| Rollback preserves session data | explicit legacy runner and npm path | legacy regressions, package-load evidence, operations docs |

## Repeatable machine verification

```powershell
cd C:\Users\GF\Documents\pi-agent-router
npm ci
npm run check
npm audit --audit-level=high

cd C:\Users\GF\Documents\pi-sessions
npm ci
npm run check
npm audit --audit-level=high
```

Expected test totals at review time:

- Router: 9 files, 56 tests.
- pi-sessions: 27 files, 163 tests.

Strict OpenSpec validation must pass in both repositories. LSP and Pi Lens must report no blocking diagnostics. A disposable `PI_CODING_AGENT_DIR` package install/RPC load and static Doctor must complete without extension errors.

## Manual acceptance checks after restarting Pi

1. Back up `~/.pi/agent/settings.json`.
2. Generate and review `agent-router.json`; verify no candidate admits `max`.
3. Run static Doctor. Decide explicitly whether active Doctor probes are acceptable.
4. Replace the npm `pi-sessions` package entry with the local sibling entries described in the integration guide; do not load both copies.
5. Start Pi at foreground `openai-codex/gpt-5.6-sol@max`.
6. Run a focused `session_ask` against a known indexed session.
7. Verify answer compatibility, selected configured child target, bounded elapsed time, and compact/expanded route audit.
8. Exercise rollback and confirm the same session index/transcripts remain usable.

## Known limitations and deferred scope

- Public Git sibling packaging is the supported V1 form; npm publication and GitHub Releases are neither prepared nor authorized.
- Only the in-process Pi SDK executor ships.
- No independent quality evaluator, learned policy, or self-iteration actuator exists.
- Active Doctor can incur model cost and remains opt-in.
- Router semantic ranking can be imperfect; static configured fallback remains deterministic.
- Auto-title and handoff are not routed by this change.
- Real explicit activation and fresh-process static verification are complete; paid routed-answer and active-Doctor checks remain optional explicit human acceptance steps.
