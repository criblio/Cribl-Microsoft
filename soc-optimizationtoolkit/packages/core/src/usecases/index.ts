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
// DBT-152: create-or-update a named text secret, updating only one that is ours.
export * from "./ensure-secret";
export * from "./permission-preflight";
export * from "./capability-audit";
export * from "./workspace-tables";
export * from "./workspace-inventory";
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
// AZR-19: the Azure Logging Map read (READ-ONLY), with its own verdict pager.
export * from "./read-logging-map";
// AZR-34: plan (read-only) then apply the app-created Cribl source, create-only.
export * from "./create-cribl-source";
// AZR-32: the READ-ONLY Validate of an onboarding plan's Azure side.
export * from "./validate-azure-onboarding";
// AZR-33 / AZR-30: the live-flow metrics read and the onboarding Cribl side.
export * from "./read-source-flow";
