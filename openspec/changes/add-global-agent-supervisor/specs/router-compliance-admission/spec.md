<!-- markdownlint-disable MD013 -->

# Router Compliance Admission Specification Delta

## ADDED Requirements

### Requirement: AC-039 Package compliance is classified and bound to exact source

The Router SHALL classify active package/extension sources as `router-internal`, `router-client`, `no-pi-ai-dispatch`, or a narrowly enumerated `external-provider-exempt`. Compliance evidence SHALL bind package source, version/revision, relevant file hashes, extension filters, scanner rule version, reviewer/tool evidence, and permitted exemptions.

#### Scenario: A safe npm package contains no Agent dispatch

- **WHEN** source scanning and review find no Pi Agent/completion path
- **THEN** an attestation may admit that exact installed version without maintaining a fork

#### Scenario: The admitted package upgrades

- **WHEN** source/version/hash or active extension filters differ from the attestation
- **THEN** the attestation is stale and activation fails until the new source is audited

### Requirement: AC-040 Violating, unknown, or stale plugins fail managed activation

Managed setup/activation SHALL refuse any active extension package with unknown classification, stale evidence, direct unmanaged Pi Agent/completion calls, or an overbroad exemption. Startup verification SHALL surface a blocking compliance state and exact remediation. Warning-only continuation SHALL NOT be the default.

#### Scenario: A new plugin directly calls `createAgentSession`

- **WHEN** admission scanning detects the call outside Router-internal source
- **THEN** the plugin is not added to active settings and the diagnostic requires a Router migration/fork or feature disablement

#### Scenario: A manually edited settings file loads unapproved source

- **WHEN** startup detects active source absent from the lock
- **THEN** Router service work fails closed, the TUI reports compliance degradation, and operations guidance restores the last compliant settings backup

### Requirement: AC-045 The complete controlled source inventory has no unmanaged dispatch

Before activation, the project SHALL inventory every active package and maintained controlled repository for Pi Agent and auxiliary Pi-model dispatch. Every finding SHALL be Router-internal, migrated to the client API, or covered by a specific external-provider exemption. Executable legacy bypasses SHALL NOT remain.

#### Scenario: The final compliance scan runs

- **WHEN** Router, pi-sessions, Hermes, web-access, context-resilience, workflow, and all active npm package sources are scanned
- **THEN** the report lists no unknown or direct unmanaged Pi Agent/completion paths and identifies each provider-native exemption by file and purpose
