# New-machine handoff — Global Agent Supervisor

## Recover this exact work

```bash
git clone https://github.com/LovelyLoong/pi-agent-router.git
cd pi-agent-router
git fetch origin
git switch --track origin/work/add-global-agent-supervisor-continuation
```

If the branch already exists locally:

```bash
git switch work/add-global-agent-supervisor-continuation
git pull --ff-only origin work/add-global-agent-supervisor-continuation
```

Then read `AGENTS.md` and `SUPERVISOR-WORK-LEDGER.md`. The project-local `.pi/settings.json` intentionally disables `pi-repo-workflow`; continue with one Agent, one branch, and ordinary local commits.

## Stable facts

- Stable `main` baseline remains `3933dcf5c4e6b87a118dc1eebe3e4b23a843dbc1`.
- T101–T106 are complete; T106's exact full gate previously passed 19 files / 111 tests.
- T107 is **in progress**, not complete.
- This pushed branch contains the current V2 service/domain, lifecycle, cancellation/drain, control-plane Worker routing, redacted audit/inspection, janitor, commands/status, and focused tests.
- Do not merge to `main`, publish, run paid probes, or begin T108 without a new explicit decision.

## Verification state at handoff

- `npm run lint` passed (84 files).
- `npx tsc --noEmit` passed.
- In the latest combined focused run, 29 tests passed and one newly added assertion failed only because it expected absent optional keys to exist as `undefined`; that assertion was corrected, and its suite then passed 2/2.
- Earlier T107 focused runs passed real Worker success/cancellation/forced Windows tree kill/reload drain/cleanup-before-fallback, service lifecycle, extension, discovery, audit, and janitor tests.
- The exact post-fix combined focused suite and full package gate still need to be rerun on the new machine.

## First commands on the new machine

```bash
git status --short --branch
npm install
npm test -- --run tests/service.test.ts tests/service-v2-lifecycle.test.ts tests/service-v2-worker-e2e.test.ts tests/extension.test.ts tests/worker-cleanup.test.ts tests/supervisor-registry.test.ts
npm run check
npm audit --audit-level=high
git diff --check
```

Also run project LSP/Lens diagnostics and verify no new Router Worker process, attempt root, active job, timer, or listener remains after teardown.

## Exact next task

Finish T107 only: review/refactor the new V2 orchestration complexity warnings, resolve any full-gate failures, rerun residue checks, update the ledger with exact evidence, and create the next verified local commit. Do not start T108 yet.
