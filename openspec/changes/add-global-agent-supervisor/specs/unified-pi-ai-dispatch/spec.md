<!-- markdownlint-disable MD013 -->

# Unified Pi AI Dispatch Specification Delta

## ADDED Requirements

### Requirement: AC-041 All pi-sessions Agent and completion paths use service V2

The maintained pi-sessions fork SHALL route session ask, handoff extraction, and auto-title generation through the configured Router supervisor while preserving each public command/tool/result contract. It SHALL remove executable/exported direct Agent legacy fallback. Missing/incompatible Router SHALL fail closed.

#### Scenario: Session ask runs under a foreground max session

- **WHEN** the foreground Pi Agent is `sol/max`
- **THEN** session ask uses only a configured Router-selected target, bridges its session navigation tools privately, and cleans before returning

#### Scenario: Router service is missing

- **WHEN** handoff or auto-title requires model work without one compatible configured V2 service
- **THEN** the operation returns actionable Router setup diagnostics and does not call the foreground model

### Requirement: AC-042 Compaction and branch summary are supplied through Router hooks

The Router extension SHALL provide Pi-compatible results from `session_before_compact` and `session_before_tree` using private selected-attempt payloads and minimized task contracts. Manual, automatic, context-resilience, and workflow-triggered compaction SHALL NOT invoke the foreground summarizer when Router execution is required.

#### Scenario: Context pressure triggers compaction

- **WHEN** Pi or context-resilience calls `ctx.compact()`
- **THEN** the hook routes a bounded summary job, returns summary/first-kept/tokens/details, and records from-extension evidence

#### Scenario: All configured candidates fail

- **WHEN** Router cannot produce a valid compaction result
- **THEN** compaction fails visibly and preserves the existing session rather than bypassing to the foreground model

### Requirement: AC-043 The maintained Hermes fork routes background review

A public provenance-preserving Hermes memory fork SHALL replace direct Pi completion calls used by background review with Router service jobs. Ordinary review SHALL remain owner-bound; any service-owner transfer SHALL use the configured allowlist/TTL/budget. Memory parsing/application semantics and non-model tools SHALL remain compatible.

#### Scenario: Background review is cancelled at session shutdown

- **WHEN** an owner-bound review is active
- **THEN** it is cancelled and cleaned without applying partial operations

#### Scenario: An allowlisted review is transferred

- **WHEN** policy explicitly allows service-owned completion
- **THEN** it may finish within TTL and apply operations only after a valid structured Router result

### Requirement: AC-044 The maintained web-access fork routes only Pi-model summary work

A public provenance-preserving pi-web-access fork SHALL route summary/curator draft generation that selects a Pi model through Router service V2. Provider-native search, extraction, URL context, and video APIs MAY remain direct only under enumerated `external-provider-exempt` declarations. Existing search/fetch tool contracts and source citations SHALL remain compatible.

#### Scenario: Auto-summary is requested

- **WHEN** web results require a model-generated summary draft
- **THEN** the summary is a Router completion job and no direct `complete()` call selects the foreground Pi model

#### Scenario: Gemini video analysis runs

- **WHEN** the tool invokes its provider-native video API
- **THEN** the compliance report identifies the narrow exemption without treating it as a reusable Pi Agent path

### Requirement: AC-046 Real Pi operation proves routing and cleanup without foreground inheritance

After activation and reload/restart, the system SHALL pass a real routed session-ask smoke test and a real compaction smoke test. Evidence SHALL show configured selected targets, no `max` inheritance, bounded attempts/fallback, complete terminal audit, and zero active leases/default Session artifacts after each operation.

#### Scenario: Live session ask falls back

- **WHEN** the first configured target has a safely classified failure
- **THEN** audit proves its cleanup barrier completed before the fresh fallback attempt started
