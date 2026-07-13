# Recovery facts: pi-agent-router

- Base remote/HEAD at snapshot start: `3933dcf5c4e6b87a118dc1eebe3e4b23a843dbc1`.
- Active Change: `add-global-agent-supervisor`.
- T101–T104 were previously complete.
- T105 was implemented and verified: full `npm run check` passed 17 test files / 98 tests; strict OpenSpec, diff check, LSP, and Lens passed.
- At the latest observed session state, T105 still needed its workflow checkpoint/HANDOFF update before T106 authority could be prepared.
- T106 then began changing worker process-tree/cleanup behavior; files continued changing through the snapshot time, so this archive is an emergency point-in-time WIP capture, not a verified candidate.
- Resume from the repository's newest pushed branch if the owning session later checkpointed and pushed. Use this patch/tar only if newer remote work is absent. Never claim T106 complete solely from this archive.
