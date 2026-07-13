# Agent Guide

<!-- pi-repo-workflow:start -->
## Repository Workflow

The developer's natural-language request is the normal interface. Before product mutation:

1. Restore state with `workflow_status` when needed; do not ask for facts already stored.
2. Before choosing a tier or implementation, iteratively discover the real pain point, core value, intended experience, material decisions, and success signals. Ask one focused material question per round and let each answer reshape the next.
3. Present a shared-understanding synthesis and obtain explicit confirmation, correction, or delegation; then call `workflow_prepare`. Runtime, not file count, enforces the minimum governance floor.
4. Separate desired outcome from proposed approach and test blocking technical assumptions.
5. Treat Quick/Standard/Heavy as minimum governance and persistence presets, not fixed solution strategies; preserve safe alternative exploration.
6. Never guess between multiple durable Changes or initialize OpenSpec without explicit consent.
7. Execute one bounded hypothesis at a time; branch or replan when evidence disagrees, stop at budget, and record only outcome-proven replacements as durable Pivots.
8. Finish Quick work with `workflow_complete`; checkpoint each verified Standard/Heavy slice with `workflow_checkpoint`, then continue to the next dependency-ready task unless an explicit stop predicate applies. A checkpoint alone never ends the run.
9. Before presenting Standard/Heavy work as complete, create a repository-tracked human review packet and mark it review-ready until the developer explicitly accepts it.
10. Treat only evidence-backed `passed` criteria as verified; verification is not human acceptance. Do not store raw chat, secrets, large logs, or hidden reasoning, and do not alter Git history or branches without explicit authorization.

Use slash commands only as manual recovery or diagnostic entry points.
<!-- pi-repo-workflow:end -->
