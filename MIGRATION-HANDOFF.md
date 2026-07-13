# Recovered Agent Router handoff

## Authority and provenance

- Source session: `019f568b-f615-7920-8de3-fd47f63d3a3f`.
- Stable base: `3933dcf5c4e6b87a118dc1eebe3e4b23a843dbc1`.
- Preserved recovery commit: `46a9ae88751f3ad7cdf08d182df09b0c1f746c17`.
- Lawful continuation branch/worktree: `work/add-global-agent-supervisor-continuation` at `C:\PiWorkbench\worktrees\pi-agent-router-supervisor-continuation`.
- The stable installed `main` worktree remains unchanged. The emergency recovery branch is evidence, not a merge candidate.

## Recovery decision

A read-only audit proved that the recovery commit is a linear descendant of current `main`, its OpenSpec Change is strict-valid, T101–T105 evidence is coherent, and its architecture remains compatible with the independent optional `pi-repo-workflow` Agent-provider boundary. The developer explicitly authorized continuation in an isolated worktree and one verified local candidate commit. Merge, push, broad destructive deletion, history rewrite, Release/npm publication, new repositories, and paid smoke tests remain outside authority.

## T106 resolution

The two interrupted TypeScript contract gaps are closed. T106 now provides:

- one idempotent async finalizer for success, failure, cancellation, timeout, protocol rejection, and exit races;
- cooperative cancellation followed by PID/nonce-checked Windows process-tree escalation and confirmed exit;
- capability revocation, listener/timer release, and attempt-root cleanup before any result/rejection;
- bounded deletion retry, redacted path-hash quarantine state, `cleanup_failed` output override, and janitor recovery;
- real child fixtures for creation/tool cancellation, ignored cancellation with descendants, cleanup failure, and cleanup-before-fallback ordering.

Final T106 verification passed `npm run check` (19 files / 111 tests), focused lifecycle tests (27/27), strict OpenSpec, npm audit (0 vulnerabilities), project LSP, Lens complexity checks, and `git diff --check`. The successful default-concurrency run left no new Router worker process or attempt root.

A pre-fix audit run with the old 5-second test harness timeout was terminated by Vitest before its parent finalizer could finish and left sandbox-owned diagnostic residue that Windows denied this session permission to terminate. It is explicitly separate from the successful post-fix zero-new-residue evidence and remains a T114 clean-environment stress/recovery observation; no uncertain parent process was targeted.

## Exact next action

Stop after the verified local T106 candidate and report it to the developer. If the developer explicitly authorizes the next slice, execute T107 only: bind `AgentJobSupervisorCore` and `AgentWorkerClient` behind one service V2 owner, connect caller/session/connection cancellation, implement admission stop plus bounded drain/reload/shutdown, complete redacted terminal audit and jobs/tree/audit/janitor/Doctor inspection surfaces, and prove no active jobs/processes/listeners remain after lifecycle teardown.
