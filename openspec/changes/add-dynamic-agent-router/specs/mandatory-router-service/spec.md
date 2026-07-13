<!-- markdownlint-disable MD013 -->

# Mandatory Router Service Specification Delta

## ADDED Requirements

### Requirement: AC-018 Router exposes one versioned discoverable service

The loaded Router Pi extension SHALL answer a typed `pi.events` discovery handshake with a versioned service descriptor and controlled execution handle. Discovery SHALL identify service version, package version, configuration state, admission authority, setup/Doctor guidance, and capabilities without creating a runtime, probing models, or exposing private payloads.

#### Scenario: A dependent package discovers Router

- **WHEN** exactly one compatible Router extension is loaded
- **THEN** the client receives one V1 service handle and configuration status within a bounded local timeout without paid model activity

### Requirement: AC-019 Service discovery fails closed when authority is ambiguous

The Router client SHALL reject missing, duplicate, incompatible, malformed, unconfigured, or invalid service responses. It SHALL never fall back to foreground state, in-memory starter defaults, or caller-created Pi runtime in a managed Pi extension path.

#### Scenario: Router is absent or loaded twice

- **WHEN** no compatible provider responds or more than one provider responds
- **THEN** the dependent package stops before child execution and reports install/setup/restart guidance

### Requirement: AC-020 Pi package consumers execute through the Router service

Managed Pi package consumers SHALL call the discovered Router service rather than constructing `AgentRouterRuntime` directly. The service SHALL preserve caller-owned minimized task and private per-attempt payload factories while centralizing runtime creation, configuration, health, event, and diagnostics behavior. External non-Pi CLI/library consumers MAY import the library directly.

#### Scenario: session_ask invokes Router

- **WHEN** local routed `pi-sessions` executes in Pi
- **THEN** it discovers the loaded Router service, delegates execution through it, and fails closed if service discovery or service configuration is unavailable

### Requirement: AC-021 Static package metadata and explicit activation are reproducible

The package SHALL expose machine-readable service metadata in `package.json`, retain explicit starter generation, and document/test replacement of npm `pi-sessions` with the local dependent package. The real starter configuration SHALL be written only through explicit setup, and local activation SHALL preserve unrelated settings plus a rollback backup.

#### Scenario: The local package set is activated

- **WHEN** the developer explicitly approves setup and activation
- **THEN** the reviewed starter config exists, exactly one local Router provider and one local modified pi-sessions package are loaded, the npm pi-sessions entry is removed rather than duplicated, and rollback can restore the prior settings

### Requirement: AC-022 Public Git source is portable without npm publication

The Router SHALL be available from public `LovelyLoong/pi-agent-router` source with repository metadata, Node 24 CI, clone/install documentation, and no npm-release workflow. The maintained fork SHALL remain a sibling consumer, and a fresh pair of GitHub clones SHALL install from committed lockfiles, pass full checks, and expose exactly one configured Router service plus routed `session_ask` in disposable offline Pi without paid model requests.

#### Scenario: A new computer clones the package pair

- **WHEN** the public Router and maintained fork are cloned as siblings and their documented setup is followed
- **THEN** `npm ci`, full checks, and disposable Pi service/tool registration pass without local-only source dependencies, duplicate providers, npm publication, or paid inference
