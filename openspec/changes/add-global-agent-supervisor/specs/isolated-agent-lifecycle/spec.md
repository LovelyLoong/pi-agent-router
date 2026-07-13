<!-- markdownlint-disable MD013 -->

# Isolated Agent Lifecycle Specification Delta

## ADDED Requirements

### Requirement: AC-028 Full Agent attempts run in fresh isolated processes

Each full Agent attempt SHALL execute in a dedicated short-lived child process with an in-memory Pi Session and an explicit selected model/thinking target. The worker SHALL load no ambient extensions, skills, templates, or tools beyond the execution capsule.

#### Scenario: Two attempts target the same model

- **WHEN** two attempts use the same configured target
- **THEN** they still have different process identities, AgentSessions, temporary roots, and capability namespaces

### Requirement: AC-029 Tool access is capability-scoped and private

The selected worker SHALL access consumer-owned tools only through a versioned IPC bridge. The parent SHALL validate job, attempt, capability, tool name, schema, size, active state, and deadline for every call. Raw private payloads and tool results SHALL NOT enter Router ranking or persisted audit.

#### Scenario: A session-analysis worker reads evidence

- **WHEN** the selected attempt invokes its granted session-read capability
- **THEN** the parent executes that bounded tool and returns only its result to that attempt

#### Scenario: A worker calls an ungranted tool

- **WHEN** a worker sends an unknown or revoked capability id
- **THEN** the call is rejected, the attempt is failed as a protocol/capability violation, and no consumer closure runs

### Requirement: AC-030 Cancellation and timeout escalate to confirmed process exit

Cancellation SHALL be idempotent and valid before queueing, during routing, process creation, execution, tool calls, and cleanup. A running worker SHALL first receive cooperative cancellation; after the configured grace period the supervisor SHALL terminate its process tree and confirm exit before release.

#### Scenario: Provider ignores abort

- **WHEN** an Agent request ignores the cooperative abort signal beyond the grace period
- **THEN** the supervisor kills the owned process tree, records escalation, and does not leave the job active

#### Scenario: Cancellation races with process creation

- **WHEN** owner cancellation occurs while a child is spawning
- **THEN** either spawn is prevented or the created process is immediately claimed and terminated, with exactly one finalizer

### Requirement: AC-031 Cleanup is a barrier and default execution data is deleted

A job SHALL NOT report success, failure suitable for fallback, cancellation, or timeout until its current attempt has completed the cleanup barrier: worker exit, Agent idle/dispose, capability revocation, listener/timer removal, temporary Session/root deletion, registry release, and terminal audit. Default execution SHALL persist no transcript.

#### Scenario: First candidate times out and second can succeed

- **WHEN** a safely retryable first attempt times out
- **THEN** the second attempt does not start until the first process is confirmed gone and its temporary resources are removed

#### Scenario: A normal job succeeds

- **WHEN** valid output is produced
- **THEN** the output is delivered only after cleanup and no attempt directory or active lease remains

### Requirement: AC-032 Cleanup failure is terminal and recoverable

If a critical temporary resource cannot be removed after bounded retry, the Router SHALL mark the job `cleanup_failed`, withhold success, quarantine only validated Router-owned paths when possible, set service health degraded, and expose a bounded startup/manual janitor. Audit SHALL store no raw path or task content.

#### Scenario: Windows locks an attempt file

- **WHEN** deletion retries expire after the worker process exits
- **THEN** the job is `cleanup_failed`, the item is quarantined or safely retained for janitor, and the original result is not reported as successful

#### Scenario: Janitor later reclaims the item

- **WHEN** startup or manual janitor removes the validated quarantine entry
- **THEN** degraded cleanup state clears when no other item remains and the recovery is auditable

### Requirement: AC-034 Fallback waits for cleanup and remains side-effect safe

The V1 safe-retry taxonomy SHALL remain in force, and every retry SHALL additionally require the prior attempt's cleanup barrier to pass. Cleanup failure, cancellation, unknown failure, and uncertain side effects SHALL stop the route.

#### Scenario: Output contract failure on read-only work

- **WHEN** a read-only attempt returns invalid structured output and cleans successfully
- **THEN** the next approved candidate may start within the remaining budget

#### Scenario: Cleanup itself fails

- **WHEN** a retryable model failure is followed by `cleanup_failed`
- **THEN** no fallback starts and the route ends with cleanup remediation

### Requirement: AC-035 Auxiliary completions use the same lifecycle contracts

Compaction, branch summary, title, memory review, web summary, and Router control-plane model work SHALL be registered jobs with owner, queue, dependency, deadline, cancellation, cleanup, and audit semantics. Consumer plugins SHALL NOT call Pi completion APIs directly. Router control-plane work SHALL be explicit and non-recursive.

#### Scenario: Router judge selects a target

- **WHEN** route selection requires its fixed judge model
- **THEN** a supervised `router-control-plane` job runs without recursively invoking route selection and releases all resources before execution begins
