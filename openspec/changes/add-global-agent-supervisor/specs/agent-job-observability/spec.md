<!-- markdownlint-disable MD013 -->

# Agent Job Observability Specification Delta

## ADDED Requirements

### Requirement: AC-036 Operators can inspect live jobs, ownership, dependencies, and cleanup

The Router SHALL expose typed inspection snapshots and Pi commands for aggregate status, active/queued jobs, one job, owner trees, dependency state, terminal audit, and cleanup degradation. A lightweight indicator SHALL show active, queued, and degraded counts without exposing task content.

#### Scenario: A job is draining after cancellation

- **WHEN** the operator inspects that job
- **THEN** the snapshot shows owner, parent/dependencies, selected attempt, deadline, cancellation reason, process state, and current cleanup phase

#### Scenario: No jobs are active

- **WHEN** the operator runs `/agent-router jobs`
- **THEN** it reports zero active/queued jobs and any outstanding quarantine count without creating model work

### Requirement: AC-037 Every accepted job has complete redacted lifecycle evidence

Audit SHALL correlate job, route, attempt, owner class, dependency outcome, queue timing, selected target, failure class, cancellation/escalation, process exit, deletion, release, and final cleanup status. It SHALL NOT persist raw prompts, session entries, tool arguments/results, secrets, raw temporary paths, or hidden reasoning.

#### Scenario: A caller cancels a running job

- **WHEN** cancellation reaches the supervisor
- **THEN** one terminal audit records cancellation and cleanup completion even if the caller no longer awaits the result

#### Scenario: A tool bridge handles restricted session content

- **WHEN** private content passes between parent and selected worker
- **THEN** event and JSONL audit contain only bounded metadata and hashes permitted by the redaction policy

### Requirement: AC-038 Supervisor policy is strict, versioned, and explicit

The Router configuration SHALL strictly validate supervisor limits, priorities, cancellation/cleanup deadlines, retention/debug TTL, ownership-transfer allowlist, compliance settings, and isolation classes. Unsafe or unknown values SHALL fail closed with migration/setup guidance. No admitted model or foreground thinking state SHALL be inferred from supervisor defaults.

#### Scenario: A V1 config is loaded by a V2 service

- **WHEN** required V2 supervisor fields are absent
- **THEN** execution remains unavailable until an explicit backed-up migration writes and validates V2 configuration

#### Scenario: A limit combination is unsafe

- **WHEN** per-owner or provider limits exceed incompatible global bounds, or cleanup grace exceeds the overall cleanup deadline
- **THEN** validation rejects the file with stable field-level diagnostics
