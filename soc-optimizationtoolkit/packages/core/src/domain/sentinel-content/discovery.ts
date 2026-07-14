/**
 * Directory-name variants and connector-file discovery selection (porting-plan
 * Unit 14; from sentinel-repo.ts findDataConnectorsDir/listConnectorFiles and
 * github.ts nested "template_" / "connector_" subdirectory scan).
 *
 * The Azure/Azure-Sentinel repo is inconsistent about directory names, and DCR
 * connector files nest arbitrarily deep (the CrowdStrike custom DCR sits at
 * `Data Connectors/CrowdstrikeReplicatorCLv2/Data Collection Rules/CrowdStrikeCustomDCR.json`
 * - two levels below the connector root). These pure helpers pin the name
 * variants and the RECURSIVE selection rule so both shell adapters agree.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { SolutionFileRef } from "../../ports/sentinel-content";

/** Data-connector directory name variants (sentinel-repo.ts findDataConnectorsDir). */
export const DATA_CONNECTOR_DIR_NAMES: readonly string[] = Object.freeze([
  "Data Connectors",
  "DataConnectors",
  "data_connectors",
]);

/** Analytic-rule directory name variants (sentinel-repo.ts listAnalyticRules). */
export const ANALYTIC_RULE_DIR_NAMES: readonly string[] = Object.freeze([
  "Analytic Rules",
  "Analytics Rules",
  "AnalyticRules",
]);

/** Sample-data directory name variants (github.ts vendor-samples handler). */
export const SAMPLE_DATA_DIR_NAMES: readonly string[] = Object.freeze([
  "SampleData",
  "Sample Data",
  "sample_data",
  "sampledata",
]);

/** The solution-metadata subdirectory holding Solution_*.json. */
export const SOLUTION_DATA_DIR = "Data";

/**
 * A nested subdirectory that may hold more connector JSON (github.ts 362-364):
 * its name contains "template" or "connector" (case-insensitive). The legacy
 * scanned these for additional connector files.
 */
export function isNestedConnectorDir(dirName: string): boolean {
  const lower = dirName.toLowerCase();
  return lower.includes("template") || lower.includes("connector");
}

/**
 * Pick the connector directory name a solution actually uses, given the names
 * present directly under it. Returns the first matching variant, or null when
 * none is present (sentinel-repo.ts findDataConnectorsDir).
 */
export function findConnectorDirName(
  presentDirNames: readonly string[],
): string | null {
  const present = new Set(presentDirNames);
  for (const name of DATA_CONNECTOR_DIR_NAMES) {
    if (present.has(name)) return name;
  }
  return null;
}

/**
 * RECURSIVE connector-file selection - the pure essence of listConnectorFiles
 * (and the target of the re-recorded TEST 10). Given every known repo-relative
 * file path plus a solution name, return the .json files that live at ANY DEPTH
 * under the solution's connector directory (whichever variant it uses), as
 * {@link SolutionFileRef}s sorted by path.
 *
 * Size is 0 unless a `sizeOf` lookup is provided (the flat-path form the fake
 * uses has no sizes; a real adapter can supply them).
 */
export function selectConnectorFiles(
  allPaths: readonly string[],
  solutionName: string,
  sizeOf?: (path: string) => number,
): SolutionFileRef[] {
  const prefixes = DATA_CONNECTOR_DIR_NAMES.map(
    (dir) => `Solutions/${solutionName}/${dir}/`,
  );
  const matched: SolutionFileRef[] = [];
  for (const path of allPaths) {
    if (!path.toLowerCase().endsWith(".json")) continue;
    if (!prefixes.some((p) => path.startsWith(p))) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    matched.push({ name, path, size: sizeOf ? sizeOf(path) : 0 });
  }
  matched.sort((a, b) => a.path.localeCompare(b.path));
  return matched;
}
