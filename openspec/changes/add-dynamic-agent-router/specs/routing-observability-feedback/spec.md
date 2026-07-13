<!-- markdownlint-disable MD013 -->

# Routing Observability and Feedback Specification Delta

## ADDED Requirements

### Requirement: AC-011 Routing decisions are compact, inspectable, and redacted

The system SHALL expose a compact default audit view containing task kind, selected executor/model/thinking, decision source, health freshness, elapsed time, and fallback count, with expanded candidate reasons and attempt failure classes. It SHALL not display raw task payloads or secrets.

#### Scenario: Routing succeeds without fallback

- **WHEN** one approved target completes
- **THEN** the default UI shows one compact route card and expanded details expose the ordered candidates and concise selection reason

#### Scenario: Routing falls back

- **WHEN** a classified first-attempt failure advances to another target
- **THEN** the compact card shows the fallback count and expanded details identify the failed target and stable failure class

### Requirement: AC-012 Versioned events support external evaluation

The system SHALL emit redacted, versioned request, decision, attempt, outcome, and feedback contracts through typed sinks and an optional Pi event-bus bridge, and SHALL allow an external package to attach later feedback without granting it implicit authority to rewrite configuration or prompts.

#### Scenario: A future evaluator records a score

- **WHEN** an authorized external evaluator submits feedback for a completed route id
- **THEN** the Router records a versioned feedback event linked to the task, decision, and outcome while leaving current policy unchanged in V1

### Requirement: AC-013 Health and audit state are recoverable and disposable

The system SHALL persist bounded health state atomically, tolerate missing/corrupt cache by rebuilding from unknown state, and keep admission configuration separate from runtime cache and audit telemetry.

#### Scenario: The health cache is deleted or corrupt

- **WHEN** the Router starts with a valid configuration but unusable health state
- **THEN** it reports the cache diagnostic, rebuilds unknown health, and does not expand or alter approved candidates
