<!-- checkpoint-id: 98e37b54-7ee4-475e-a33a-55f3d468464f -->
# Current Handoff

> Keep this file concise and overwrite it at each checkpoint. Git preserves history.

- **Last checkpoint:** 2026-07-13T09:58:18.435Z
- **Branch / HEAD:** `main` / `3933dcf5c4e6`
- **Progress:** 5/25 acceptance criteria verified
- **Task progress:** 5/17 implementation tasks complete
- **Working tree:** `package.json`, `src/config/index.ts`, `src/config/loader.ts`, `src/config/schema.ts`, `src/config/starter.ts`, `src/config/validate.ts`, `src/contracts/index.ts`, `src/index.ts`, `src/service/client.ts`, `src/service/contracts.ts`, `tests/config.test.ts`, `tests/service.test.ts`, … +9

## Current Focus

Turn worker termination and ephemeral cleanup into a single-flight barrier before any terminal success or fallback.

## Next Exact Action

Execute T106 only: implement cooperative cancellation plus grace/escalation, PID/nonce process-tree ownership and exit confirmation, single-flight finalizer, temp-root deletion retry, cleanup quarantine/janitor/degraded state, cleanup_failed terminal override, and fallback-after-cleanup gating with real child fault fixtures.

## Blockers / Questions

- None.

## Completed Since Previous Checkpoint

- T105 V1 worker protocol
- Fresh real child-local Pi AgentSession
- Fresh isolated completion
- Selected-target and auth fail-closed resolution
- Capability-scoped proxy tools with parent schema/active/deadline checks
- Malformed/disconnect/identity/oversize protocol tests
- Private lifecycle event boundary
- Full check 17 files/100 tests
- Zero LSP/Lens findings and no temp residue
- Refreshed Heavy permit 100853c2-b1c2-4e17-9bd6-bc4512d1327f

## Relevant Files

- `src/worker/protocol.ts`
- `src/worker/client.ts`
- `src/worker/agent-worker.mjs`
- `src/worker/index.ts`
- `src/contracts/jobs.ts`
- `src/config/schema.ts`
- `src/config/starter.ts`
- `src/config/validate.ts`
- `tests/worker-execution.test.ts`
- `tests/worker-protocol.test.ts`
- `tests/helpers/worker-fixtures.ts`

## Recent Decisions / Discoveries

- pi-coding-agent may own a nested pi-ai module instance; completion compat must resolve relative to coding-agent with a deduped-layout fallback.
- Ambient PI_AGENT_ROUTER_TEST_MODE/FAULT variables are scrubbed; deterministic/fault controls require explicit client injection.
- The parent waits for child exit on success and protocol rejection, but T106 still owns uncooperative process-tree escalation and cleanup deadlines.
- IPC defaults are protocol V1, 4 MiB frame, 3 MiB run payload, 256 KiB arguments, 1 MiB result, 16 pending calls and 128 total calls.
- AC-035 remains unverified until completion/control-plane consumers are registered through the V2 service.
