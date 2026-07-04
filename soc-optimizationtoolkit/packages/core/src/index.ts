// @soc/core: pure domain logic and port interfaces. Zero IO, zero fetch, zero React.
//
// Layout (see docs/feature-catalog.md, "Proposed architecture: dual-target"):
//   ports/    port interfaces both app shells bind adapters against
//   testing/  in-memory fakes for every port (unit tests only; never bind in a shell)
//   domain/   pure domain modules (dcr-naming, schema-mapping; more per roadmap)
//   assets/   bundled data shipped inside the package (vendor schema library)
//   usecases/ orchestration over the ports (onboard-table walking skeleton)

export * from "./ports";
export * from "./testing";
export * from "./domain/app-mode";
export * from "./domain/app-theme";
export * from "./domain/dcr-naming";
export * from "./domain/poll-scheduler";
export * from "./domain/schema-mapping";
export * from "./domain/azure-permissions";
export * from "./domain/azure-config";
export * from "./domain/azure-resource-id";
export * from "./domain/azure-profiles";
export * from "./domain/connection-invalidation";
export * from "./domain/dataflow-diagram";
export * from "./domain/log-model";
export * from "./domain/change-request";
export * from "./domain/role-plan";
export * from "./domain/dcr-request";
export * from "./domain/dce-request";
export * from "./domain/option-forms";
export * from "./domain/sentinel-destination";
export * from "./domain/custom-table";
export * from "./domain/journey-state";
export * from "./assets/vendor-schemas";
export * from "./usecases";
