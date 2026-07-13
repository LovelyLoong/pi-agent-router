<!-- markdownlint-disable MD013 -->

# pi-agent-router

`pi-agent-router` is a Git-distributed Pi package and TypeScript library for selecting and executing bounded child Agents without inheriting the foreground model or thinking level.

Public source: `https://github.com/LovelyLoong/pi-agent-router`. The package is currently distributed from Git rather than npm.

V1 provides:

- strict configured-only target admission;
- deterministic capability, tool, modality, context, side-effect, sensitivity, and health filtering;
- a fixed, non-recursive Router Agent with configured backup and static-priority fallback;
- fresh isolated Pi sessions with linked routing, attempt, and overall deadlines;
- safe failure classification and structured-output validation;
- passive health, explicit static/active Doctor modes, redacted events, route audit, and a feedback seam;
- a production integration in the sibling maintained `pi-sessions@0.8.0` fork.

Node.js 24 and Pi 0.80.6 are the verified Windows baseline. Real explicit configuration and local-package activation have been verified; existing Pi processes must restart after changing package selection.

## Core invariants

1. `~/.pi/agent/agent-router.json` is the sole admission authority. A model known to Pi but absent from this file is ineligible.
2. A caller supplies a minimized `TaskContractV1`; raw prompts, source sessions, project instructions, tool closures, and private payloads are created only for a selected attempt.
3. Hard constraints run before semantic ranking. The Router Agent never routes itself.
4. Normal contract-valid output, caller cancellation, unknown failures, and uncertain side effects stop execution. Only classified safe technical or read-only output-contract failures may advance.
5. Every candidate attempt receives a fresh Pi session and exact configured model/thinking level.
6. Static Doctor makes no paid inference requests. Active Doctor runs only when explicitly requested and remains bounded.
7. Feedback is recorded through a versioned interface; V1 never rewrites policy or configuration automatically.

## Clone and set up

Clone Router beside the maintained `pi-sessions` fork so its sibling dependency resolves on every computer:

```powershell
mkdir pi-packages
cd pi-packages
git clone https://github.com/LovelyLoong/pi-agent-router.git
git clone https://github.com/LovelyLoong/pi-sessions.git

cd pi-agent-router
npm ci
npm run check

cd ..\pi-sessions
npm ci
npm run check
```

Try Router without changing normal Pi package settings:

```powershell
pi --no-extensions -e C:\path\to\pi-packages\pi-agent-router
```

Inside that disposable Pi process:

```text
/agent-router setup
/agent-router status
/agent-router doctor
```

`setup` writes an explicit starter file only when one does not already exist. Review it before activation. `doctor` is static and free of model probes; use `/agent-router doctor active` only when you explicitly want bounded live probes.

The starter configuration admits these execution candidates, with no `max` thinking level:

| Priority | Candidate | Allowed thinking |
| --- | --- | --- |
| 10 | `openai-codex/gpt-5.4-mini` | `medium`, `high` |
| 20 | `openai-codex/gpt-5.6-luna` | `medium`, `high` |
| 30 | `openai-codex/gpt-5.6-terra` | `high`, `xhigh` |
| 40 | `openai-codex/gpt-5.6-sol` | `high`, `xhigh` |

The fixed Router chain is mini/low then luna/low. Defaults are 30 seconds per Router target, 60 seconds for routing, 180 seconds per execution attempt, 420 seconds overall, and at most three execution attempts.

## Commands

```text
/agent-router setup
/agent-router status
/agent-router doctor
/agent-router doctor active
```

- `status` reports config, candidate availability, and cached health.
- static `doctor` uses registry/auth availability only.
- active `doctor` performs explicitly requested probes with per-target/overall limits and bounded concurrency.
- health state is cache data at `~/.pi/agent/agent-router-health.json`; deleting it does not change admission policy.

## Library entry points

```ts
import {
  AgentRouterRuntime,
  OutputContractRegistry,
  type PiSdkExecutionPayload,
  type TaskContract,
} from "pi-agent-router";
```

Subpath exports are available for `config`, `contracts`, `execution`, `health`, `observability`, `routing`, and `runtime`.

A caller constructs a minimized task, registers its output contract, and supplies a factory for the private per-attempt payload:

```ts
const runtime = await AgentRouterRuntime.create({ modelRegistry, cwd });
const result = await runtime.execute<MyResult, PiSdkExecutionPayload<MyResult>>({
  task,
  outputContracts,
  createPayload: (target, attempt, signal) => createPrivatePayload(target, signal),
  signal: callerSignal,
});
```

Do not capture raw data in `task`, event metadata, or audit labels. Private data belongs only in `createPayload()` and its attempt-local tools.

## Documentation

- [Operations, configuration, deadlines, health, and recovery](docs/operations.md)
- [Caller, executor, event, audit, and feedback APIs](docs/api.md)
- pi-sessions installation, activation, maintenance, and rollback: `../pi-sessions/docs/agent-router.md`
- [Developer review packet](docs/review-packet.md)

## Development

```powershell
npm ci
npm run check
npm audit --audit-level=high
```

The complete check currently covers 9 test files and 56 tests. The sibling `pi-sessions` check covers 27 files and 163 tests, including an actual service-backed `AgentRouterRuntime`/`PiSdkExecutor` timeout-to-fallback integration. GitHub CI repeats the Node.js 24 check for every `main` push and pull request.

## Scope

V1 includes only the in-process Pi SDK executor. External CLI/process executors, answer grading, learned policies, evaluator loops, and automatic configuration proposals are deferred to separate packages and reviewed changes. npm publication and GitHub Releases are not part of the current distribution model.
