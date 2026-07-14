import { describe, expect, it } from "vitest";
import {
  AMPLS_SCOPED_RESOURCE_API_VERSION,
  buildAmplsAssociationRequest,
  buildDceRequest,
  DCE_API_VERSION,
  DceRequestError,
  parseDceDeployment,
} from "./dce-request";

const DCE_ID =
  "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
  "Microsoft.Insights/dataCollectionEndpoints/dce-CloudFlare-eastus";

const AMPLS_ID =
  "/subscriptions/sub-123/resourceGroups/rg-network/providers/" +
  "Microsoft.Insights/privateLinkScopes/ampls-prod";

describe("buildDceRequest", () => {
  it("pins the exact ARM PUT request with public network access enabled", () => {
    // Legacy shape: New-AzDataCollectionEndpoint -ResourceGroupName -Name
    // -Location -NetworkAclsPublicNetworkAccess (Create-TableDCRs.ps1 lines
    // 2711-2720); api-version 2023-03-11 is the version the PS engine reads
    // DCEs with over REST (Generate-CriblDestinations.ps1 line 468).
    expect(
      buildDceRequest({
        subscriptionId: "sub-123",
        resourceGroup: "rg-sec",
        dceName: "dce-CloudFlare-eastus",
        location: "eastus",
        publicNetworkAccess: true,
      }),
    ).toEqual({
      method: "PUT",
      path:
        "/subscriptions/sub-123/resourceGroups/rg-sec/providers/" +
        "Microsoft.Insights/dataCollectionEndpoints/dce-CloudFlare-eastus",
      apiVersion: "2023-03-11",
      body: {
        location: "eastus",
        properties: {
          networkAcls: { publicNetworkAccess: "Enabled" },
        },
      },
    });
    expect(DCE_API_VERSION).toBe("2023-03-11");
  });

  it("maps the Unit 4 boolean false to publicNetworkAccess 'Disabled'", () => {
    // Legacy carried "Enabled"/"Disabled" strings through
    // operationParams.privateLink.dcePublicNetworkAccess
    // (Create-TableDCRs.ps1 lines 2705-2709); the boolean option replaces
    // that pair.
    const request = buildDceRequest({
      subscriptionId: "sub-123",
      resourceGroup: "rg-sec",
      dceName: "dce-CloudFlare-eastus",
      location: "eastus",
      publicNetworkAccess: false,
    });
    expect(request.body.properties.networkAcls.publicNetworkAccess).toBe(
      "Disabled",
    );
  });

  it("throws DceRequestError on any blank input string", () => {
    const base = {
      subscriptionId: "sub-123",
      resourceGroup: "rg-sec",
      dceName: "dce-CloudFlare-eastus",
      location: "eastus",
      publicNetworkAccess: true,
    };
    expect(() => buildDceRequest({ ...base, subscriptionId: " " })).toThrow(
      DceRequestError,
    );
    expect(() => buildDceRequest({ ...base, resourceGroup: "" })).toThrow(
      DceRequestError,
    );
    expect(() => buildDceRequest({ ...base, dceName: "" })).toThrow(
      DceRequestError,
    );
    expect(() => buildDceRequest({ ...base, location: "  " })).toThrow(
      DceRequestError,
    );
  });
});

describe("parseDceDeployment", () => {
  it("extracts id, provisioningState, and the logs-ingestion endpoint", () => {
    // Field paths: top-level id ($dce.Id, Create-TableDCRs.ps1 lines
    // 2699/2722) and properties.logsIngestion.endpoint
    // (Generate-CriblDestinations.ps1 line 475; IS/azure-deploy.ts line 588).
    expect(
      parseDceDeployment({
        id: DCE_ID,
        name: "dce-CloudFlare-eastus",
        properties: {
          provisioningState: "Succeeded",
          logsIngestion: {
            endpoint:
              "https://dce-cloudflare-eastus-abcd.eastus-1.ingest.monitor.azure.com",
          },
        },
      }),
    ).toEqual({
      id: DCE_ID,
      provisioningState: "Succeeded",
      logsIngestionEndpoint:
        "https://dce-cloudflare-eastus-abcd.eastus-1.ingest.monitor.azure.com",
    });
  });

  it("is tolerant and total: nulls for junk, partial, and non-object bodies", () => {
    const empty = {
      id: null,
      provisioningState: null,
      logsIngestionEndpoint: null,
    };
    expect(parseDceDeployment(undefined)).toEqual(empty);
    expect(parseDceDeployment(null)).toEqual(empty);
    expect(parseDceDeployment("garbage")).toEqual(empty);
    expect(parseDceDeployment({})).toEqual(empty);
    expect(
      parseDceDeployment({ id: DCE_ID, properties: { logsIngestion: {} } }),
    ).toEqual({ ...empty, id: DCE_ID });
  });
});

describe("buildAmplsAssociationRequest", () => {
  it("pins the exact scoped-resource PUT, addressed at the AMPLS's own scope", () => {
    // Legacy shape: New-AzInsightsPrivateLinkScopedResource
    // -ResourceGroupName {amplsRg} -ScopeName {amplsName}
    // -Name "{dceName}-ampls-connection" -LinkedResourceId {dceId}
    // (Create-TableDCRs.ps1 lines 224-229 and 252-257). The AMPLS lives in
    // rg-network while the DCE lives in rg-sec - the path follows the AMPLS.
    expect(
      buildAmplsAssociationRequest({
        dceResourceId: DCE_ID,
        amplsResourceId: AMPLS_ID,
      }),
    ).toEqual({
      method: "PUT",
      path:
        "/subscriptions/sub-123/resourceGroups/rg-network/providers/" +
        "Microsoft.Insights/privateLinkScopes/ampls-prod/scopedResources/" +
        "dce-CloudFlare-eastus-ampls-connection",
      apiVersion: AMPLS_SCOPED_RESOURCE_API_VERSION,
      body: {
        properties: {
          linkedResourceId: DCE_ID,
        },
      },
    });
  });

  it("throws DceRequestError when the AMPLS id is missing required parts", () => {
    expect(() =>
      buildAmplsAssociationRequest({
        dceResourceId: DCE_ID,
        amplsResourceId: "garbage",
      }),
    ).toThrow(DceRequestError);
    expect(() =>
      buildAmplsAssociationRequest({
        dceResourceId: DCE_ID,
        amplsResourceId: "/subscriptions/sub-123",
      }),
    ).toThrow(DceRequestError);
  });

  it("throws DceRequestError when the DCE id has no resource name", () => {
    expect(() =>
      buildAmplsAssociationRequest({
        dceResourceId: "",
        amplsResourceId: AMPLS_ID,
      }),
    ).toThrow(DceRequestError);
  });
});
