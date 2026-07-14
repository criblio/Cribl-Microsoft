/**
 * DCR ARM request builders (Direct and DCE-based) and deployment-response
 * parser.
 *
 * The request shapes are mined from the legacy automation:
 *   - Azure/CustomDeploymentTemplates/DCR-Automation/core/dcr-template-direct.json
 *     (the ARM template the legacy engine deploys in Direct mode: kind
 *     "Direct", apiVersion "2023-03-11", properties.streamDeclarations /
 *     destinations.logAnalytics / dataFlows with transformKql "source")
 *   - Azure/CustomDeploymentTemplates/DCR-Automation/core/dcr-template-with-dce.json
 *     (the DCE-mode template: SAME apiVersion 2023-03-11 and properties
 *     fragment, plus properties.dataCollectionEndpointId, and NO kind
 *     property - DCE-based DCRs are NOT Kind:Direct)
 *   - Create-TableDCRs.ps1 line 1652 (api-version 2023-03-11 is required to
 *     read endpoints.logsIngestion on Direct DCRs - March 2024 ARM update)
 *   - Create-TableDCRs.ps1 lines 2841-2850: stream naming is IDENTICAL in
 *     both modes (input always "Custom-{table}"; output "Microsoft-{table}"
 *     native / "Custom-{table}" custom)
 *   - Get-DirectDCRIngestionEndpoint in Generate-CriblDestinations.ps1
 *     (the endpoint fallback paths replayed by {@link parseDcrDeployment})
 *
 * Column mapping is NOT re-implemented here: the column set and the
 * stream/dataFlow fragment come from ../schema-mapping (buildDcrColumnSet +
 * buildStreamDeclaration, the legacy compatibility contract). The DCR resource
 * name is an input - generate it with ../dcr-naming at the call site (mode
 * "direct" for {@link buildDirectDcrRequest}, mode "dce" - the 64-char limit -
 * for {@link buildDceDcrRequest}). The DCE resource itself is built and parsed
 * by ../dce-request.
 *
 * Pure: no IO, no fetch, no React, no Date/Math.random/crypto.
 */

import { parseResourceId } from "../azure-resource-id";
import {
  buildDcrColumnSet,
  buildStreamDeclaration,
  LOG_ANALYTICS_DESTINATION_NAME,
} from "../schema-mapping";
import type {
  DcrColumn,
  DcrDataFlow,
  DroppedColumn,
  LogAnalyticsColumn,
  TableMode,
  UnknownTypeColumn,
} from "../schema-mapping";

/**
 * ARM api-version for Microsoft.Insights/dataCollectionRules. The legacy
 * engine pins 2023-03-11 both in dcr-template-direct.json and for the REST GET
 * that reads endpoints.logsIngestion (Create-TableDCRs.ps1 line 1652); older
 * versions do not expose the Direct-DCR ingestion endpoint.
 */
export const DIRECT_DCR_API_VERSION = "2023-03-11";

/** Input for {@link buildDirectDcrRequest}. */
export interface DirectDcrRequestInput {
  /** Table name, e.g. "SecurityEvent" or "CloudFlare_CL" (custom mode). */
  table: string;
  /**
   * Log Analytics schema columns for the table (the column array selected via
   * schema-mapping selectSchemaColumns from the workspace tables GET). System
   * and guid-typed columns are filtered here via buildDcrColumnSet.
   */
  columns: readonly LogAnalyticsColumn[];
  /**
   * "native" (default) or "custom" (_CL tables). Drives the schema-mapping
   * drop list (18-name native vs 6-name custom) and the output stream
   * ("Microsoft-{table}" native vs "Custom-{table}" custom) - Unit 5 wires
   * the custom path through the SAME builder, never a duplicate.
   */
  tableMode?: TableMode;
  /** Azure region for the DCR resource, e.g. "eastus". */
  location: string;
  /**
   * Full ARM resource id of the Log Analytics workspace. The DCR is deployed
   * into the same subscription and resource group (legacy behavior).
   */
  workspaceResourceId: string;
  /** DCR resource name - generate with dcr-naming (mode "direct"). */
  dcrName: string;
}

/** The `properties` fragment of a Direct DCR resource body. */
export interface DirectDcrProperties {
  streamDeclarations: Record<string, { columns: DcrColumn[] }>;
  destinations: {
    logAnalytics: Array<{ workspaceResourceId: string; name: string }>;
  };
  dataFlows: DcrDataFlow[];
}

/** The full PUT body for a Kind:Direct DCR. */
export interface DirectDcrRequestBody {
  kind: "Direct";
  location: string;
  properties: DirectDcrProperties;
}

/** The complete ARM request for deploying a Direct DCR. */
export interface DirectDcrRequest {
  method: "PUT";
  /**
   * ARM path (no host, no api-version):
   * /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/dataCollectionRules/{dcrName}
   */
  path: string;
  /** {@link DIRECT_DCR_API_VERSION}. */
  apiVersion: string;
  body: DirectDcrRequestBody;
  /** Input stream name: "Custom-{table}" (also the streamDeclarations key). */
  streamName: string;
  /** Output stream: "Microsoft-{table}" (native) / "Custom-{table}" (custom). */
  outputStream: string;
  /** Columns removed by the schema-mapping filter (diagnostics; legacy logs these). */
  droppedColumns: DroppedColumn[];
  /** Columns whose LA type fell back to string (diagnostics; legacy warns). */
  unknownTypeColumns: UnknownTypeColumn[];
}

/** Error thrown when a valid ARM request cannot be composed from the input. */
export class DcrRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DcrRequestError";
  }
}

/**
 * Everything both DCR builders share: input validation, the schema-mapping
 * composition, and the ARM path. Exactly ONE implementation of the common
 * shape (the legacy repo had two drifted deploy implementations; porting-plan
 * Unit 6 pins a single one).
 */
function composeDcrRequestCore(input: DirectDcrRequestInput): {
  path: string;
  properties: DirectDcrProperties;
  streamName: string;
  outputStream: string;
  droppedColumns: DroppedColumn[];
  unknownTypeColumns: UnknownTypeColumn[];
} {
  const { table, columns, location, workspaceResourceId, dcrName } = input;
  const tableMode: TableMode = input.tableMode ?? "native";

  if (table.trim() === "") {
    throw new DcrRequestError("table must be a non-empty string");
  }
  if (location.trim() === "") {
    throw new DcrRequestError("location must be a non-empty string");
  }
  if (dcrName.trim() === "") {
    throw new DcrRequestError("dcrName must be a non-empty string");
  }

  const { subscriptionId, resourceGroup } = parseResourceId(workspaceResourceId);
  if (subscriptionId === "" || resourceGroup === "") {
    throw new DcrRequestError(
      `workspaceResourceId '${workspaceResourceId}' does not contain a ` +
        "subscription id and resource group; expected " +
        "/subscriptions/{sub}/resourceGroups/{rg}/providers/" +
        "Microsoft.OperationalInsights/workspaces/{name}",
    );
  }

  // Compatibility contract: column filtering/mapping and the stream/dataFlow
  // fragment come from schema-mapping, never re-implemented here.
  const columnSet = buildDcrColumnSet(columns, tableMode);
  const declaration = buildStreamDeclaration(
    table,
    columnSet.columns,
    tableMode,
  );

  const path =
    `/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionRules/${dcrName}`;

  return {
    path,
    properties: {
      streamDeclarations: declaration.streamDeclarations,
      destinations: {
        logAnalytics: [
          { workspaceResourceId, name: LOG_ANALYTICS_DESTINATION_NAME },
        ],
      },
      dataFlows: declaration.dataFlows,
    },
    streamName: declaration.streamName,
    outputStream: declaration.outputStreamName,
    droppedColumns: columnSet.dropped,
    unknownTypeColumns: columnSet.unknownTypes,
  };
}

/**
 * Build the complete ARM PUT request for a Kind:Direct DCR. Mirrors what the
 * legacy engine deploys through dcr-template-direct.json: a single
 * "Custom-{table}" stream declaration, a single logAnalytics destination
 * named "logAnalyticsWorkspace", and one dataFlow with transformKql "source"
 * into "Microsoft-{table}" (native) or "Custom-{table}" (custom _CL tables,
 * tableMode "custom").
 *
 * @throws DcrRequestError when workspaceResourceId lacks a subscription or
 *   resource group, or when a required input string is empty.
 * @throws SchemaMappingError (from buildStreamDeclaration) when every input
 *   column is filtered away - the legacy engine fails the table then too.
 */
export function buildDirectDcrRequest(
  input: DirectDcrRequestInput,
): DirectDcrRequest {
  const core = composeDcrRequestCore(input);
  return {
    method: "PUT",
    path: core.path,
    apiVersion: DIRECT_DCR_API_VERSION,
    body: {
      kind: "Direct",
      location: input.location,
      properties: core.properties,
    },
    streamName: core.streamName,
    outputStream: core.outputStream,
    droppedColumns: core.droppedColumns,
    unknownTypeColumns: core.unknownTypeColumns,
  };
}

// ---------------------------------------------------------------------------
// DCE-based variant (porting-plan Unit 6)
// ---------------------------------------------------------------------------

/**
 * ARM api-version for DCE-based DCRs - the same 2023-03-11 the legacy DCE
 * template pins (dcr-template-with-dce.json, resources[0].apiVersion).
 */
export const DCE_DCR_API_VERSION = DIRECT_DCR_API_VERSION;

/** Input for {@link buildDceDcrRequest}. */
export interface DceDcrRequestInput extends DirectDcrRequestInput {
  /**
   * Full ARM resource id of the Data Collection Endpoint the DCR routes
   * through (the legacy template's endpointResourceId parameter, wired as
   * properties.dataCollectionEndpointId). Deploy the DCE first with
   * ../dce-request and take DceDeploymentInfo.id. The DCR name for this
   * variant comes from dcr-naming mode "dce" (64-char limit).
   */
  dataCollectionEndpointId: string;
}

/**
 * The `properties` fragment of a DCE-based DCR resource body: the shared
 * fragment plus dataCollectionEndpointId (dcr-template-with-dce.json line
 * "dataCollectionEndpointId": "[parameters('endpointResourceId')]").
 */
export interface DceDcrProperties extends DirectDcrProperties {
  dataCollectionEndpointId: string;
}

/**
 * The full PUT body for a DCE-based DCR. Deliberately has NO `kind`
 * property: the legacy dcr-template-with-dce.json declares none (DCE-based
 * DCRs are NOT Kind:Direct - only dcr-template-direct.json carries
 * "kind": "Direct").
 */
export interface DceDcrRequestBody {
  location: string;
  properties: DceDcrProperties;
}

/** The complete ARM request for deploying a DCE-based DCR. */
export interface DceDcrRequest {
  method: "PUT";
  /** Same ARM path shape as the Direct variant. */
  path: string;
  /** {@link DCE_DCR_API_VERSION}. */
  apiVersion: string;
  body: DceDcrRequestBody;
  /** Input stream name: "Custom-{table}" (also the streamDeclarations key). */
  streamName: string;
  /** Output stream: "Microsoft-{table}" (native) / "Custom-{table}" (custom). */
  outputStream: string;
  /** Columns removed by the schema-mapping filter (diagnostics; legacy logs these). */
  droppedColumns: DroppedColumn[];
  /** Columns whose LA type fell back to string (diagnostics; legacy warns). */
  unknownTypeColumns: UnknownTypeColumn[];
}

/**
 * Build the complete ARM PUT request for a DCE-based DCR. Mirrors what the
 * legacy engine deploys through dcr-template-with-dce.json: the SAME
 * streamDeclarations / destinations / dataFlows fragment as the Direct
 * variant (stream naming is identical in both modes - Create-TableDCRs.ps1
 * lines 2841-2850), plus properties.dataCollectionEndpointId, and NO kind.
 *
 * @throws DcrRequestError under the same conditions as
 *   {@link buildDirectDcrRequest}, and additionally when
 *   dataCollectionEndpointId is blank.
 * @throws SchemaMappingError (from buildStreamDeclaration) when every input
 *   column is filtered away.
 */
export function buildDceDcrRequest(input: DceDcrRequestInput): DceDcrRequest {
  if (input.dataCollectionEndpointId.trim() === "") {
    throw new DcrRequestError(
      "dataCollectionEndpointId must be a non-empty string",
    );
  }
  const core = composeDcrRequestCore(input);
  return {
    method: "PUT",
    path: core.path,
    apiVersion: DCE_DCR_API_VERSION,
    body: {
      location: input.location,
      properties: {
        dataCollectionEndpointId: input.dataCollectionEndpointId,
        ...core.properties,
      },
    },
    streamName: core.streamName,
    outputStream: core.outputStream,
    droppedColumns: core.droppedColumns,
    unknownTypeColumns: core.unknownTypeColumns,
  };
}

/** What {@link parseDcrDeployment} extracts from a DCR GET/PUT response body. */
export interface DcrDeploymentInfo {
  /** properties.immutableId, or null when absent. */
  immutableId: string | null;
  /**
   * The Direct-DCR logs-ingestion endpoint URL, or null when absent. Primary
   * path: properties.endpoints.logsIngestion (api-version 2023-03-11).
   * Legacy fallbacks (from Get-DirectDCRIngestionEndpoint): properties
   * .logsIngestion.endpoint, then properties.destinations.logAnalytics[0]
   * .endpoint.
   */
  logsIngestionEndpoint: string | null;
  /** properties.provisioningState verbatim (e.g. "Succeeded"), or null. */
  provisioningState: string | null;
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Narrow an unknown value to a non-empty string, else null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Extract the deployment outputs of a Kind:Direct DCR from an ARM GET or PUT
 * response body. TOLERANT and TOTAL: accepts any value, never throws, and
 * returns null for every part it cannot find (callers decide whether a
 * missing part is an error).
 */
export function parseDcrDeployment(responseBody: unknown): DcrDeploymentInfo {
  const properties = prop(responseBody, "properties");

  const immutableId = asString(prop(properties, "immutableId"));
  const provisioningState = asString(prop(properties, "provisioningState"));

  // Endpoint fallback order mirrors Get-DirectDCRIngestionEndpoint's
  // $possiblePaths in Generate-CriblDestinations.ps1.
  let logsIngestionEndpoint = asString(
    prop(prop(properties, "endpoints"), "logsIngestion"),
  );
  if (logsIngestionEndpoint === null) {
    logsIngestionEndpoint = asString(
      prop(prop(properties, "logsIngestion"), "endpoint"),
    );
  }
  if (logsIngestionEndpoint === null) {
    const logAnalytics = prop(prop(properties, "destinations"), "logAnalytics");
    if (Array.isArray(logAnalytics) && logAnalytics.length > 0) {
      logsIngestionEndpoint = asString(prop(logAnalytics[0], "endpoint"));
    }
  }

  return { immutableId, logsIngestionEndpoint, provisioningState };
}
