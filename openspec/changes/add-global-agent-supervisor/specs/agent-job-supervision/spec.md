<!-- markdownlint-disable MD013 -->

# Agent Job Supervision Specification Delta

## ADDED Requirements

### Requirement: AC-023 One singleton supervisor owns every managed job

The loaded Router service SHALL own one long-lived supervisor, queue, active registry, and lifecycle domain. Every managed Agent, completion, and Router control-plane invocation SHALL have a unique job and attempt identity. Fallback attempts SHALL use fresh workers and SHALL NOT reuse Agent state.

#### Scenario: Two plugins submit work concurrently

- **WHEN** two compliant plugins submit jobs through the Router service
- **THEN** both jobs appear in the same supervisor snapshot with distinct owners, deadlines, attempts, and queue/running states

#### Scenario: A route falls back

- **WHEN** an attempt ends with a safely retryable failure
- **THEN** the next candidate receives a new attempt id, process/session, tool namespace, and temporary root

### Requirement: AC-024 Consumers cannot retain raw Agent resources

The service SHALL expose only structured run, stream, and scoped callback APIs. It SHALL NOT return an `AgentSession`, worker process, mutable executor, or manual borrow/release handle to a consumer.

#### Scenario: A plugin runs an Agent job

- **WHEN** the plugin awaits the structured job API
- **THEN** it receives typed progress/result data while the Router exclusively owns and finalizes the Agent resource

### Requirement: AC-025 Ownership is explicit and cancellation is structured

Every job SHALL have exactly one current owner. Ordinary jobs SHALL be cancelled when their owner releases, disconnects, reloads, or shuts down. Ownership transfer SHALL be atomic and allowed only for configured task kinds with a bounded service-owner TTL, budget, and audit reason.

#### Scenario: Session owner shuts down

- **WHEN** a Pi session closes with queued and running session-owned jobs
- **THEN** queued jobs never start, running jobs are cancelled and drained, and no child remains owned by that session

#### Scenario: An allowlisted memory review transfers ownership

- **WHEN** the caller explicitly transfers an eligible job before release
- **THEN** the service becomes the sole owner under the configured TTL and the transfer is visible in audit

### Requirement: AC-026 Dependencies form an acyclic readiness graph

The supervisor SHALL validate dependency ids and reject cycles. A job SHALL NOT enter the runnable queue until every required dependency succeeds. Failure, cancellation, or timeout SHALL mark ordinary dependents `dependency_failed` without starting model work; only an explicit configured failure-input policy may continue.

#### Scenario: A prerequisite fails

- **WHEN** job B depends on job A and A fails
- **THEN** B reaches `dependency_failed`, consumes no route/model attempt, and identifies A as the blocking dependency

#### Scenario: A cycle is submitted

- **WHEN** submitted dependencies would create a cycle
- **THEN** admission fails before queueing with a stable validation diagnostic

### Requirement: AC-027 Admission uses a bounded priority queue and quotas

The supervisor SHALL enforce configured global, per-owner, per-provider/model, control-plane, and queue-capacity limits. Queue ordering SHALL be stable within priority. Queue time SHALL consume the caller's overall deadline. A full queue SHALL fail closed without model work.

#### Scenario: Interactive work arrives behind background work

- **WHEN** capacity frees and an interactive job is waiting behind lower-priority background jobs
- **THEN** the interactive job starts first while FIFO order is preserved within each priority class

#### Scenario: Queue capacity is exhausted

- **WHEN** a new job arrives while thirty-two jobs are queued under the balanced default
- **THEN** it returns `queue_full` without invoking the Router judge or an executor

### Requirement: AC-033 Reload and shutdown drain all owned work

The service SHALL stop new admission, cancel queued and running jobs, await a bounded cleanup drain, escalate remaining workers, finalize terminal audits, dispose subscriptions, and only then unregister service discovery.

#### Scenario: Extension reload occurs during an Agent tool call

- **WHEN** the Router extension reloads while a worker is waiting on a bridged tool
- **THEN** the capability is revoked, the worker is cancelled or killed, cleanup completes, and the old service exposes no active job or listener afterward
