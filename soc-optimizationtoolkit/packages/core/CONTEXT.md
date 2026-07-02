# CONTEXT: @soc/core

Purpose: pure domain logic and the port interfaces both app shells bind against.

Boundaries: imports nothing from ui or apps. Zero IO, zero fetch, zero React. Everything here must be unit-testable with plain vitest and fakes.

Invariants:
- Port interfaces are the only seam between shared code and the two shells (cloud platform adapters vs local Node host).
- DCR/DCE name generation must reproduce legacy output exactly (compatibility contract; characterization tests mandatory).
- assets/cribl-openapi.json is the vendored Cribl API spec (pinned per Cribl version); typed API client shapes are written against it.

Status: placeholder. Ports and domain modules land per the implementation roadmap.
