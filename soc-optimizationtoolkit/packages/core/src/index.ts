// @soc/core: pure domain logic and port interfaces. Zero IO, zero fetch, zero React.
//
// Layout (see docs/feature-catalog.md, "Proposed architecture: dual-target"):
//   ports/    port interfaces both app shells bind adapters against
//   testing/  in-memory fakes for every port (unit tests only; never bind in a shell)
//   domain/   pure domain modules (dcr-naming, schema-mapping; more per roadmap)

export * from "./ports";
export * from "./testing";
export * from "./domain/dcr-naming";
export * from "./domain/schema-mapping";
export * from "./domain/azure-permissions";
export * from "./domain/azure-config";
export * from "./domain/azure-resource-id";
export * from "./domain/azure-profiles";
export * from "./domain/connection-invalidation";
export * from "./domain/dataflow-diagram";
export * from "./domain/change-request";
export * from "./domain/role-plan";
