/**
 * crowdstrike-fdr sample corpus - vendored test assets (porting-plan Unit 11
 * fixture-rescue, section 3: "packs/vendor-samples/crowdstrike-fdr/ corpus
 * (272KB, 10 files)"). Copied BYTE-FAITHFULLY from the legacy
 * Cribl-Microsoft_IntegrationSolution/packs/vendor-samples/crowdstrike-fdr/ so
 * the characterization suite runs against the exact bytes customers deployed.
 *
 * The `.json` files hold NDJSON (one JSON object per line), so they are NOT
 * importable as JSON modules - the characterization test reads them as text via
 * fs. This manifest exports only the table-name list (pure string constants) so
 * the test can iterate them without hardcoding filenames.
 */

/** The 10 CrowdStrike FDR corpus table names (each maps to `<name>.json`). */
export const CROWDSTRIKE_FDR_CORPUS: readonly string[] = Object.freeze([
  "CrowdStrike_Additional_Events_CL",
  "CrowdStrike_Audit_Events_CL",
  "CrowdStrike_Auth_Events_CL",
  "CrowdStrike_DNS_Events_CL",
  "CrowdStrike_File_Events_CL",
  "CrowdStrike_Network_Events_CL",
  "CrowdStrike_Process_Events_CL",
  "CrowdStrike_Registry_Events_CL",
  "CrowdStrike_Secondary_Data_CL",
  "CrowdStrike_User_Events_CL",
]);
