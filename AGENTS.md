# Agent Guide

## Supervisor Single-Agent Continuation

The developer explicitly selected a sequential single-Agent continuation for the global Supervisor work.

1. Use `SUPERVISOR-WORK-LEDGER.md` as the operational source of truth for facts, completed work, remaining tasks, evidence, and the next exact action.
2. Work only in the current continuation branch and worktree. Do not create additional worktrees, leases, claims, workflow candidates, or integration batches.
3. Execute one task at a time in dependency order, beginning with T107. Keep hypotheses bounded and stop when evidence contradicts the approach.
4. Preserve `openspec/changes/add-global-agent-supervisor/` and its HANDOFF/verification files as read-only historical evidence unless the developer explicitly re-enables that workflow.
5. Run focused diagnostics and tests after each independently verifiable slice, then update the ledger with concrete evidence.
6. Local commits are allowed after verification. Merge, push, paid smoke tests, publication, remote mutation, force operations, broad deletion, and history rewriting remain prohibited without separate developer authorization.
7. Never report automated verification as human acceptance.
