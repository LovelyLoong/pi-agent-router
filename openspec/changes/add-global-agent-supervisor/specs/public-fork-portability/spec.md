<!-- markdownlint-disable MD013 -->

# Public Fork Portability Specification Delta

## ADDED Requirements

### Requirement: AC-047 Router and maintained consumers are publicly reproducible without upstream impersonation

Router, pi-sessions, Hermes memory, and pi-web-access maintained repositories SHALL preserve upstream provenance, use public `LovelyLoong` origins, configure official upstream remotes as fetch-only with disabled push URLs, enforce LF text checkout, use SHA-pinned credential-minimized CI, and document sibling clone/install/activation/sync. Consumer package metadata SHALL prevent accidental publication under upstream npm names.

#### Scenario: A new Windows computer installs the stack

- **WHEN** all four repositories are cloned as documented siblings and dependencies are installed from clean lockfiles
- **THEN** checks, audits, compliance scan, disposable configuration, and offline exactly-one-service loading pass without copying old local directories

#### Scenario: An official upstream release is reviewed

- **WHEN** the maintainer fetches an upstream update
- **THEN** the documented process compares and semantically ports changes while preserving Router client, privacy, cancellation, cleanup, and fail-closed behavior

#### Scenario: Publication automation runs

- **WHEN** CI executes on a maintained fork
- **THEN** it cannot publish the upstream npm package, create unapproved release tags, or persist checkout credentials
