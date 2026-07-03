/**
 * Direct (Kind:Direct) DCR ARM request builder and deployment-response parser.
 *
 * The request shape is mined from the legacy automation:
 *   - Azure/CustomDeploymentTemplates/DCR-Automation/core/dcr-template-direct.json
 *     (the ARM template the legacy engine deploys: kind "Direct", apiVersion
 *     "2023-03-11", properties.streamDeclarations / destinations.logAnalytics /
 *     dataFlows with transformKql "source")
 *   - Create-TableDCRs.ps1 line 1652 (api-version 2023-03-11 is required to
 *     read endpoints.logsIngestion on Direct DCRs - March 2024 ARM update)
 *   - Get-DirectDCRIngestionEndpoint in Generate-CriblDestinations.ps1
 *     (the endpoint fallback paths replayed by {@link parseDcrDeployment})
 *
 * Column mapping is NOT re-implemented here: the column set and the
 * stream/dataFlow fragment come from ../schema-mapping (buildDcrColumnSet +
 * buildStreamDeclaration, the legacy compatibility contract). The DCR resource
 * name is an input - generate it with ../dcr-naming at the call site.
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
  /** Native table name, e.g. "SecurityEvent". */
  table: string;
  /**
   * Log Analytics schema columns for the table (the column array selected via
   * schema-mapping selectSchemaColumns from the workspace tables GET). System
   * and guid-typed columns are filtered here via buildDcrColumnSet.
   */
  columns: readonly LogAnalyticsColumn[];
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
  /** Output stream name: "Microsoft-{table}" (native tables). */
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
 * Build the complete ARM PUT request for a Kind:Direct DCR targeting a NATIVE
 * table. Mirrors what the legacy engine deploys through
 * dcr-template-direct.json: a single "Custom-{table}" stream declaration, a
 * single logAnalytics destination named "logAnalyticsWorkspace", and one
 * dataFlow with transformKql "source" into "Microsoft-{table}".
 *
 * @throws DcrRequestError when workspaceResourceId lacks a subscription or
 *   resource group, or when a required input string is empty.
 * @throws SchemaMappingError (from buildStreamDeclaration) when every input
 *   column is filtered away - the legacy engine fails the table then too.
 */
export function buildDirectDcrRequest(
  input: DirectDcrRequestInput,
): DirectDcrRequest {
  const { table, columns, location, workspaceResourceId, dcrName } = input;

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
  const columnSet = buildDcrColumnSet(columns, "native");
  const declaration = buildStreamDeclaration(table, columnSet.columns, "native");

  const path =
    `/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionRules/${dcrName}`;

  return {
    method: "PUT",
    path,
    apiVersion: DIRECT_DCR_API_VERSION,
    body: {
      kind: "Direct",
      location,
      properties: {
        streamDeclarations: declaration.streamDeclarations,
        destinations: {
          logAnalytics: [
            { workspaceResourceId, name: LOG_ANALYTICS_DESTINATION_NAME },
          ],
        },
        dataFlows: declaration.dataFlows,
      },
    },
    streamName: declaration.streamName,
    outputStream: declaration.outputStreamName,
    droppedColumns: columnSet.dropped,
    unknownTypeColumns: columnSet.unknownTypes,
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
