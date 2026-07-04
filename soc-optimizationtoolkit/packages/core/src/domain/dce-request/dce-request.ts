/**
 * Data Collection Endpoint (DCE) ARM request builders and deployment-response
 * parser (porting-plan Unit 6, DCE/Private Link modes).
 *
 * The request shapes are mined from the legacy automation:
 *   - Create-TableDCRs.ps1 lines 2694-2723: New-AzDataCollectionEndpoint with
 *     ResourceGroupName/Name/Location/NetworkAclsPublicNetworkAccess - the
 *     cmdlet's REST equivalent is a PUT on
 *     Microsoft.Insights/dataCollectionEndpoints with
 *     properties.networkAcls.publicNetworkAccess.
 *   - Create-TableDCRs.ps1 lines 2705-2709: network access is the configured
 *     "Enabled"/"Disabled" string when Private Link is on, else "Enabled".
 *     The Unit 4 boolean dcePublicNetworkAccess replaces that string pair:
 *     true -> "Enabled", false -> "Disabled".
 *   - Generate-CriblDestinations.ps1 line 468: the legacy PS engine reads
 *     DCEs over REST at api-version 2023-03-11 (line 475 reads
 *     properties.logsIngestion.endpoint from the response).
 *   - IS/azure-deploy.ts line 586 reads the same resource at api-version
 *     2022-06-01 - the two legacy implementations drifted. ONE version is
 *     pinned here: 2023-03-11, matching the PS engine (the source of truth
 *     for deployed environments) and the DCR api-version.
 *   - Create-TableDCRs.ps1 lines 194-267 (Add-DCEToAMPLS): the AMPLS
 *     association is a privateLinkScopes/{scope}/scopedResources/{name}
 *     child resource (New-AzInsightsPrivateLinkScopedResource) named
 *     "{dceName}-ampls-connection" (line 225) whose only property is
 *     linkedResourceId (line 256, -LinkedResourceId). The AMPLS resource
 *     group and scope name are parsed out of the AMPLS resource id
 *     (lines 228-229).
 *
 * Pure: no IO, no fetch, no React, no Date/Math.random/crypto.
 */

import { parseResourceId } from "../azure-resource-id";

/**
 * ARM api-version for Microsoft.Insights/dataCollectionEndpoints. Pinned to
 * 2023-03-11: the version the legacy PS engine used for DCE REST reads
 * (Generate-CriblDestinations.ps1 line 468) and the same version dcr-request
 * pins for dataCollectionRules. (The legacy Integration Solution used
 * 2022-06-01 in azure-deploy.ts line 586 - a drifted second implementation;
 * exactly one version ships here.)
 */
export const DCE_API_VERSION = "2023-03-11";

/**
 * ARM api-version for Microsoft.Insights/privateLinkScopes scopedResources.
 * The legacy automation went through the Az.Monitor cmdlets
 * (New-AzInsightsPrivateLinkScopedResource, Create-TableDCRs.ps1 line 252)
 * so no REST version exists in the legacy repo to mine; 2021-07-01-preview
 * is the version that cmdlet generation targets and the documented ARM
 * version for scopedResources.
 */
export const AMPLS_SCOPED_RESOURCE_API_VERSION = "2021-07-01-preview";

/**
 * Scoped-resource name suffix for DCE-to-AMPLS associations - the legacy
 * naming rule "$dceName-ampls-connection" (Create-TableDCRs.ps1 line 225).
 */
export const AMPLS_CONNECTION_NAME_SUFFIX = "-ampls-connection";

/** Input for {@link buildDceRequest}. */
export interface DceRequestInput {
  /** Azure subscription id the DCE deploys into. */
  subscriptionId: string;
  /** Resource group the DCE deploys into (legacy: same RG as the DCRs). */
  resourceGroup: string;
  /** DCE resource name - generate with dcr-naming (mode "dce-endpoint"). */
  dceName: string;
  /** Azure region for the DCE resource, e.g. "eastus". */
  location: string;
  /**
   * The Unit 4 dcePublicNetworkAccess boolean: true -> "Enabled", false ->
   * "Disabled" (AMPLS/private-link only; Create-TableDCRs.ps1 lines
   * 2705-2709 carried the same pair as strings).
   */
  publicNetworkAccess: boolean;
}

/** The full PUT body for a DCE resource. */
export interface DceRequestBody {
  location: string;
  properties: {
    networkAcls: {
      publicNetworkAccess: "Enabled" | "Disabled";
    };
  };
}

/** The complete ARM request for deploying a DCE. */
export interface DceRequest {
  method: "PUT";
  /**
   * ARM path (no host, no api-version):
   * /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/dataCollectionEndpoints/{dceName}
   */
  path: string;
  /** {@link DCE_API_VERSION}. */
  apiVersion: string;
  body: DceRequestBody;
}

/** Error thrown when a valid ARM request cannot be composed from the input. */
export class DceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DceRequestError";
  }
}

/**
 * Build the complete ARM PUT request for a Data Collection Endpoint. The
 * REST equivalent of the legacy New-AzDataCollectionEndpoint call
 * (Create-TableDCRs.ps1 lines 2711-2720): location plus
 * networkAcls.publicNetworkAccess, nothing else - tags stay a shell/usecase
 * concern (the legacy owner tag was applied in a separate Set-AzResource
 * call, lines 2726-2736).
 *
 * @throws DceRequestError when any required input string is blank.
 */
export function buildDceRequest(input: DceRequestInput): DceRequest {
  const { subscriptionId, resourceGroup, dceName, location } = input;

  if (subscriptionId.trim() === "") {
    throw new DceRequestError("subscriptionId must be a non-empty string");
  }
  if (resourceGroup.trim() === "") {
    throw new DceRequestError("resourceGroup must be a non-empty string");
  }
  if (dceName.trim() === "") {
    throw new DceRequestError("dceName must be a non-empty string");
  }
  if (location.trim() === "") {
    throw new DceRequestError("location must be a non-empty string");
  }

  const path =
    `/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionEndpoints/${dceName}`;

  return {
    method: "PUT",
    path,
    apiVersion: DCE_API_VERSION,
    body: {
      location,
      properties: {
        networkAcls: {
          publicNetworkAccess: input.publicNetworkAccess
            ? "Enabled"
            : "Disabled",
        },
      },
    },
  };
}

/** What {@link parseDceDeployment} extracts from a DCE GET/PUT response body. */
export interface DceDeploymentInfo {
  /**
   * The DCE's full ARM resource id (top-level `id`), or null when absent.
   * This is the value the DCE-based DCR wires as
   * properties.dataCollectionEndpointId (Create-TableDCRs.ps1 lines
   * 2699/2722 capture $dce.Id for exactly that purpose).
   */
  id: string | null;
  /** properties.provisioningState verbatim (e.g. "Succeeded"), or null. */
  provisioningState: string | null;
  /**
   * The DCE logs-ingestion endpoint URL
   * (properties.logsIngestion.endpoint - Generate-CriblDestinations.ps1
   * line 475, IS/azure-deploy.ts line 588), or null when absent. This is
   * the ingestion URL Cribl destinations for DCE-based DCRs point at.
   */
  logsIngestionEndpoint: string | null;
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
 * Extract the deployment outputs of a DCE from an ARM GET or PUT response
 * body. TOLERANT and TOTAL: accepts any value, never throws, and returns
 * null for every part it cannot find (callers decide whether a missing part
 * is an error). The endpoint is returned VERBATIM - the legacy
 * handler.control endpoint repair (Generate-CriblDestinations.ps1
 * Fix-HandlerControlEndpoint) is a Cribl-destination composition concern,
 * not a parsing one.
 */
export function parseDceDeployment(responseBody: unknown): DceDeploymentInfo {
  const properties = prop(responseBody, "properties");
  return {
    id: asString(prop(responseBody, "id")),
    provisioningState: asString(prop(properties, "provisioningState")),
    logsIngestionEndpoint: asString(
      prop(prop(properties, "logsIngestion"), "endpoint"),
    ),
  };
}

/** Input for {@link buildAmplsAssociationRequest}. */
export interface AmplsAssociationInput {
  /** Full ARM resource id of the deployed DCE (DceDeploymentInfo.id). */
  dceResourceId: string;
  /**
   * Full ARM resource id of the Azure Monitor Private Link Scope, e.g.
   * /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/privateLinkScopes/{name}
   * (the Unit 4 amplsResourceId option; option-forms validates it is set
   * whenever DCE public network access is disabled).
   */
  amplsResourceId: string;
}

/** The complete ARM request for associating a DCE with an AMPLS. */
export interface AmplsAssociationRequest {
  method: "PUT";
  /**
   * ARM path (no host, no api-version):
   * {amplsResourceId}/scopedResources/{dceName}-ampls-connection
   */
  path: string;
  /** {@link AMPLS_SCOPED_RESOURCE_API_VERSION}. */
  apiVersion: string;
  body: {
    properties: {
      linkedResourceId: string;
    };
  };
}

/**
 * Build the ARM PUT request that associates a DCE with an Azure Monitor
 * Private Link Scope - the REST equivalent of the legacy
 * New-AzInsightsPrivateLinkScopedResource call (Create-TableDCRs.ps1 lines
 * 252-257): a scopedResources child of the AMPLS named
 * "{dceName}-ampls-connection" (line 225) linking back to the DCE via
 * properties.linkedResourceId. The scoped-resource path is composed from
 * the AMPLS id's own subscription/resource group/name (the legacy parsed
 * segments 4 and -1 of the id, lines 228-229) - the AMPLS may live in a
 * DIFFERENT resource group than the DCE.
 *
 * The legacy attempted this association only when network access was
 * "Disabled" (Create-TableDCRs.ps1 line 2739); callers keep that rule.
 *
 * @throws DceRequestError when either resource id cannot be parsed into the
 *   parts the path needs.
 */
export function buildAmplsAssociationRequest(
  input: AmplsAssociationInput,
): AmplsAssociationRequest {
  const { dceResourceId, amplsResourceId } = input;

  const dce = parseResourceId(dceResourceId);
  if (dce.name === "") {
    throw new DceRequestError(
      `dceResourceId '${dceResourceId}' does not contain a resource name; ` +
        "expected /subscriptions/{sub}/resourceGroups/{rg}/providers/" +
        "Microsoft.Insights/dataCollectionEndpoints/{name}",
    );
  }

  const ampls = parseResourceId(amplsResourceId);
  if (
    ampls.subscriptionId === "" ||
    ampls.resourceGroup === "" ||
    ampls.name === ""
  ) {
    throw new DceRequestError(
      `amplsResourceId '${amplsResourceId}' does not contain a subscription ` +
        "id, resource group, and scope name; expected /subscriptions/{sub}/" +
        "resourceGroups/{rg}/providers/Microsoft.Insights/privateLinkScopes/" +
        "{name}",
    );
  }

  const path =
    `/subscriptions/${ampls.subscriptionId}` +
    `/resourceGroups/${ampls.resourceGroup}` +
    `/providers/Microsoft.Insights/privateLinkScopes/${ampls.name}` +
    `/scopedResources/${dce.name}${AMPLS_CONNECTION_NAME_SUFFIX}`;

  return {
    method: "PUT",
    path,
    apiVersion: AMPLS_SCOPED_RESOURCE_API_VERSION,
    body: {
      properties: {
        linkedResourceId: dceResourceId,
      },
    },
  };
}
