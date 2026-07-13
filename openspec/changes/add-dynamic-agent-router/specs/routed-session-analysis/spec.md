<!-- markdownlint-disable MD013 -->

# Routed Session Analysis Specification Delta

## ADDED Requirements

### Requirement: AC-014 session_ask uses routed targets without changing its public result

The maintained `pi-sessions` fork SHALL submit a read-only session-analysis task contract to `pi-agent-router`, execute its existing navigation Agent with the selected model and thinking level, preserve the existing `session_ask` answer/relevant-files result, and add redacted route audit details.

#### Scenario: Foreground reasoning is max

- **WHEN** a root Pi session at `max` calls `session_ask`
- **THEN** the child uses the Router-selected configured thinking level and the audit proves it did not inherit `max`

### Requirement: AC-015 session_ask fallback preserves navigation and bounded execution

The integration SHALL create a fresh bounded in-memory AgentSession for each safe candidate attempt, reuse only immutable local navigation inputs, preserve `session_search`, `session_read`, and `provide_results` behavior, and retry only classified technical or structured-output failures.

#### Scenario: The preferred session-analysis model is unavailable

- **WHEN** the first selected target fails before producing a valid `provide_results` payload
- **THEN** the next approved target receives a fresh session, completes navigation, and the returned audit records both attempts

### Requirement: AC-016 routed session analysis fails visibly when routing is unavailable

The integration SHALL return a clear tool error and setup/Doctor guidance when Router configuration is missing, no approved target satisfies the task, or all bounded attempts fail; it SHALL not call `ctx.model` as a hidden fallback.

#### Scenario: No agent-router configuration exists

- **WHEN** `session_ask` is invoked
- **THEN** it terminates within a bounded time with an actionable configuration error and does not create a child AgentSession

### Requirement: AC-017 package installation and rollback are reproducible

The system SHALL document and verify local installation of `pi-agent-router` plus the forked session-ask extension, keep session hooks/index/search behavior unchanged, and provide a rollback path to pinned npm `pi-sessions@0.8.0` without session-data migration.

#### Scenario: A fresh Pi process loads the integration

- **WHEN** the configured local packages and valid Router config are loaded
- **THEN** Pi reports no extension registration errors, session search remains available, and a routed session ask completes with audit evidence
