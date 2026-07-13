<!-- markdownlint-disable MD013 -->

# Routed Agent Execution Specification Delta

## ADDED Requirements

### Requirement: AC-006 Execution is bounded and fail-closed

The system SHALL enforce linked Router, per-attempt, and overall deadlines; propagate abort signals; cap attempts; and return structured terminal diagnostics when no valid route succeeds. It SHALL never silently fall back to the foreground model.

#### Scenario: Every approved candidate times out

- **WHEN** each bounded attempt exceeds its configured deadline
- **THEN** the Router stops at the overall budget, reports each timeout and recovery action, and does not start an unapproved target

### Requirement: AC-007 Health checks avoid duplicate paid inference

The system SHALL combine zero-inference static checks, versioned TTL health cache, configuration-hash invalidation, failure cooldown, and real-task outcome updates. Normal routing SHALL NOT issue a separate model prompt solely to test health.

#### Scenario: A recently successful target is reused

- **WHEN** cached health is within TTL and static configuration remains unchanged
- **THEN** the Router proceeds without a paid preflight request and records the health age

#### Scenario: Configuration changes

- **WHEN** the approved candidate or relevant target options change
- **THEN** stale health is invalidated by configuration hash before routing

### Requirement: AC-008 Doctor provides explicit active verification

The system SHALL expose a manual Doctor that validates config, executor installation, model registration/auth, thinking support, cache state, and optional bounded active probes, without starting periodic background requests.

#### Scenario: The developer requests active Doctor checks

- **WHEN** active probing is explicitly requested
- **THEN** the Doctor tests only configured targets under a bounded budget and reports per-target evidence without changing admission configuration

### Requirement: AC-009 Automatic fallback is limited to classified safe failures

The system SHALL advance to the next ranked target only for unavailable executor/model, authentication, rate-limit/provider transport, bounded timeout, or required output-contract failures. A normal result SHALL end V1 execution without subjective quality retries, and an unknown side-effect outcome SHALL stop.

#### Scenario: First target is unavailable

- **WHEN** the highest-ranked configured target returns a classified model-unavailable failure
- **THEN** health records the failure and the next ranked approved target is attempted exactly once within budget

#### Scenario: A target returns a valid but possibly weak answer

- **WHEN** execution satisfies the required output contract without a technical failure
- **THEN** the Router returns it and leaves quality scoring to the future feedback package

### Requirement: AC-010 Executor adapters normalize capability and outcomes

The system SHALL define a stable `ExecutorAdapter` contract for static availability, capability reporting, optional Doctor probe, execution, cancellation, usage, and failure classification, and SHALL ship a Pi SDK implementation in V1.

#### Scenario: A future CLI adapter is registered

- **WHEN** an adapter implements the versioned interface and is explicitly enabled by configuration
- **THEN** the routing core can filter, rank, execute, and audit it without Pi-specific branching in core policy
