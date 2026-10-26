// usecases/: orchestration over the ports - pure against port interfaces,
// unit-tested with the in-memory fakes in src/testing/.
export * from "./onboard-table";
// The creation contract on its own, so a screen can create ONE table with
// Azure alone (TBL-3) - onboardTable's step 2 calls this too.
export * from "./create-custom-table";
export * from "./onboard-batch";
export * from "./assign-dcr-role";
export * from "./azure-discovery";
export * from "./deployment-preview";
export * from "./analyze-samples";
export * from "./coverage-analysis";
export * from "./list-service-principals";
export * from "./discover-event-hubs";
// AZR-11: hubs and Send-capable namespace rules for one chosen namespace.
export * from "./eventhub-target";
// AZR-3: read Defender state subscription-wide; create-only deploy.
export * from "./defender-export";
export * from "./guided-deploy";
export * from "./permission-preflight";
export * from "./capability-audit";
export * from "./workspace-tables";
export * from "./install-pack";
export * from "./dcr-inventory";
export * from "./update-dcr";
export * from "./siem-migration";
export * from "./content-install";
export * from "./discover-sample-sources";
export * from "./capture-samples";
export * from "./query-lake-samples";
export * from "./provision-lab";
export * from "./live-architecture";
