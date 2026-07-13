# Recovery facts: pi-agent-router

- Base remote/HEAD at snapshot start: `3933dcf5c4e6b87a118dc1eebe3e4b23a843dbc1`.
- Active Change: `add-global-agent-supervisor`.
- T101–T104 were previously complete.
- T105 was implemented and verified: full `npm run check` passed 17 test files / 98 tests; strict OpenSpec, diff check, LSP, and Lens passed.
- At the latest observed session state, T105 still needed its workflow checkpoint/HANDOFF update before T106 authority could be prepared.
- T106 then began changing worker process-tree/cleanup behavior; files continued changing through the snapshot time, so this archive is an emergency point-in-time WIP capture, not a verified candidate.
- Resume from the repository's newest pushed branch if the owning session later checkpointed and pushed. Use this branch only if newer remote work is absent. Never claim T106 complete solely from this archive.

## Recovery-branch verification

- `npm ci`: passed; audit reported 0 vulnerabilities.
- Biome lint: passed for 77 files.
- TypeScript: **failed**, as expected for an in-progress T106 slice:
  - `src/worker/client.ts(11,8)`: `AgentWorkerClientOptions` is not yet exported by `./protocol.js`.
  - `src/worker/client.ts(439,5)`: returned terminal result is missing required `cleanup`.
- Full tests did not run because typecheck failed. The exact next repair is to complete the protocol/client cleanup contract, then rerun `npm run check`.
