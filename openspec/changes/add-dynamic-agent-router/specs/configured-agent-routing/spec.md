<!-- markdownlint-disable MD013 -->

# Configured Agent Routing Specification Delta

## ADDED Requirements

### Requirement: AC-001 User configuration is the sole admission authority

The system SHALL load a versioned `~/.pi/agent/agent-router.json`, reject invalid or ambiguous configuration with actionable diagnostics, and consider only explicitly enabled executors, models, and thinking levels eligible for routing.

#### Scenario: An available but unconfigured model exists

- **WHEN** Pi ModelRegistry reports a model that is absent from `agent-router.json`
- **THEN** the Router excludes it from every candidate set and audit record

#### Scenario: Configuration is missing or invalid

- **WHEN** a caller requests routing without one valid approved candidate configuration
- **THEN** the Router fails closed without inheriting the foreground model and reports the exact setup or Doctor action

### Requirement: AC-002 Callers submit a versioned task contract

The system SHALL require a `TaskContractV1` containing a minimized goal summary plus hard capability, tool, modality, context, output, side-effect, sensitivity, deadline, and attempt constraints, while keeping the full execution payload separate.

#### Scenario: A session-analysis caller submits work

- **WHEN** `session_ask` requests routed execution
- **THEN** the Router receives only the task contract and minimized summary, while raw session entries remain private to the selected executor

### Requirement: AC-003 Hard constraints precede dynamic ranking

The system SHALL deterministically filter candidates for configuration, executor/model availability, capability, modality, context, tool, side-effect, sensitivity, health, thinking-level support, deadline, and output compatibility before invoking the Router Agent.

#### Scenario: The Router prefers an incompatible target

- **WHEN** a target fails any hard requirement
- **THEN** it is never shown to the Router Agent and cannot be selected regardless of semantic preference

### Requirement: AC-004 A dedicated non-recursive Router ranks valid candidates

The system SHALL use a user-configured Router primary and fixed backup chain to return a structured ordered list of valid executor/model/thinking targets, without consulting or inheriting the foreground Agent configuration.

#### Scenario: The root session uses max reasoning

- **WHEN** the foreground Pi Agent is configured with `max`
- **THEN** the Router uses its configured fixed target and selects only thinking levels approved for the child candidates

#### Scenario: All Router judge targets fail

- **WHEN** the configured Router primary and backups fail technically or violate the ranking output contract
- **THEN** the system uses configured static candidate priority and records that decision source, or fails closed if no valid candidate exists

### Requirement: AC-005 Router visibility is minimized

The system SHALL provide the Router Agent only the normalized task descriptor, aggregate metrics, approved candidate metadata, and health summaries needed for ranking; raw code, session history, secrets, execution payloads, and hidden reasoning SHALL be excluded by default.

#### Scenario: Privacy diagnostics inspect a route request

- **WHEN** audit tests capture the Router-model request
- **THEN** it contains no raw target-session entry body or execution prompt and includes the declared data-sensitivity class
