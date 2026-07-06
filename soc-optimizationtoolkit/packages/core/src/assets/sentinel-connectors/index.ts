/**
 * Vendored Sentinel connector / solution fixtures - porting-plan Unit 14
 * fixture-rescue (section 3: "connector JSONs covering all four schema
 * formats", "CrowdStrikeCustomDCR.json ... also feeds Unit 18").
 *
 * PROVENANCE (recorded before porting while the legacy mirror still existed on
 * disk at %APPDATA%/.cribl-microsoft/sentinel-repo/Azure-Sentinel):
 *
 *   CrowdStrikeCustomDCR.json        BYTE-FAITHFUL from
 *     Solutions/CrowdStrike Falcon Endpoint Protection/Data Connectors/
 *     CrowdstrikeReplicatorCLv2/Data Collection Rules/CrowdStrikeCustomDCR.json
 *     (decoder Format 2: resources[].streamDeclarations with Custom- streams;
 *      8 streams, Process stream 144 cols; also the Unit 18 gap-analysis feed
 *      and the nested-discovery target).
 *   AIShieldConnector.json           BYTE-FAITHFUL from
 *     Solutions/AIShield AI Security Monitoring/Data Connectors/
 *     AIShieldConnector.json (decoder Format 3: top-level dataTypes[]).
 *   OnePassword_DataConnectorDefinition.json   BYTE-FAITHFUL from
 *     Solutions/1Password/Data Connectors/1Password_ccpv2/
 *     1Password_DataConnectorDefinition.json (decoder Format 4:
 *     properties.connectorUiConfig.dataTypes[]). Renamed 1Password_* ->
 *     OnePassword_* so the file name is a valid, digit-free identifier.
 *   Solution_Aruba.json              BYTE-FAITHFUL from
 *     Solutions/Aruba ClearPass/Data/Solution_Aruba.json (deprecation layer 2:
 *     "about to be deprecated").
 *
 *   connector-format1-tables.json    SYNTHESIZED. No connector in the entire
 *     Azure/Azure-Sentinel repo uses a top-level tables[] array with columns
 *     (Format 1 was a defensive path; the tables[]-with-columns structure lives
 *     only in separate *_tables.json files as properties.schema.columns). This
 *     minimal fixture exercises Format 1 and BOTH column-key variants
 *     (name/type AND columnName/columnType). Documented as synthesized in the
 *     file's own _note field.
 *
 * The .json files import as JSON modules (resolveJsonModule); the decoder takes
 * the parsed object. Pure: no IO, no fetch.
 */

import crowdStrikeCustomDcr from "./CrowdStrikeCustomDCR.json";
import aiShieldConnector from "./AIShieldConnector.json";
import onePasswordConnectorDefinition from "./OnePassword_DataConnectorDefinition.json";
import solutionAruba from "./Solution_Aruba.json";
import format1Tables from "./connector-format1-tables.json";

/** Provenance of a vendored fixture. */
export type FixtureProvenance = "byte-faithful" | "synthesized";

/** One vendored connector/solution fixture. */
export interface ConnectorFixture {
  /** Stable id. */
  id: string;
  /** The decoder format(s) it exercises, or "solution" for a Solution_*.json. */
  covers: string;
  provenance: FixtureProvenance;
  /** The parsed JSON object. */
  json: unknown;
}

export const CROWDSTRIKE_CUSTOM_DCR: unknown = crowdStrikeCustomDcr;
export const AISHIELD_CONNECTOR: unknown = aiShieldConnector;
export const ONEPASSWORD_CONNECTOR_DEFINITION: unknown =
  onePasswordConnectorDefinition;
export const SOLUTION_ARUBA: unknown = solutionAruba;
export const CONNECTOR_FORMAT1_TABLES: unknown = format1Tables;

/** All vendored connector/solution fixtures. */
export const CONNECTOR_FIXTURES: readonly ConnectorFixture[] = Object.freeze([
  {
    id: "format1-tables",
    covers: "decoder Format 1 (tables[] with columns; name/type + columnName/columnType)",
    provenance: "synthesized",
    json: format1Tables,
  },
  {
    id: "crowdstrike-custom-dcr",
    covers: "decoder Format 2 (streamDeclarations, Custom- streams); Unit 18 feed",
    provenance: "byte-faithful",
    json: crowdStrikeCustomDcr,
  },
  {
    id: "aishield-connector",
    covers: "decoder Format 3 (top-level dataTypes[])",
    provenance: "byte-faithful",
    json: aiShieldConnector,
  },
  {
    id: "onepassword-connector-definition",
    covers: "decoder Format 4 (connectorUiConfig.dataTypes[])",
    provenance: "byte-faithful",
    json: onePasswordConnectorDefinition,
  },
  {
    id: "solution-aruba",
    covers: "solution deprecation (Solution_*.json layer 2 marker)",
    provenance: "byte-faithful",
    json: solutionAruba,
  },
]);
