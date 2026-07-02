# CONTEXT: @soc/core

Purpose: pure domain logic and the port interfaces both app shells bind against.

Boundaries: imports nothing from ui or apps. Zero IO, zero fetch, zero React. Everything here must be unit-testable with plain vitest and fakes.

Invariants:
- Port interfaces are the only seam between shared code and the two shells (cloud platform adapters vs local Node host).
- DCR/DCE name generation must reproduce legacy output exactly (compatibility contract; characterization tests mandatory).
- assets/cribl-openapi.json is the vendored Cribl API spec (pinned per Cribl version); typed API client shapes are written against it.

Status: Phase 1 foundation in place. src/ports/ defines the six port interfaces (SecretsStore, UserContext, ArtifactSink, JobStore, AzureManagement, CriblClient) plus shared HTTP types; src/testing/ provides in-memory fakes for all six; src/domain/dcr-naming/ and src/domain/schema-mapping/ implement the legacy compatibility contracts with characterization tests pinned to legacy vectors/fixtures. All are re-exported from src/index.ts. Remaining domain modules (pipeline-generation, field-matcher, pack-assembly, reduction-rules, sample-parsing) and the GraphClient port land per the implementation roadmap.
