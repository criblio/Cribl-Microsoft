/**
 * Pins for the ARM deployment-template envelope (DBT-33).
 *
 * The defect being closed is a HONESTY one - the air-gap README told operators
 * to Portal-deploy files that carried no template envelope - so these pins
 * assert the properties a deployment actually depends on: the envelope is
 * present and well-formed, the type and name are the FULL nested ones ARM
 * needs, and dependsOn states edges ARM would otherwise get wrong. Asserting
 * "a template was produced" would pass on every broken shape.
 */
import { describe, expect, it } from "vitest";
import {
  ARM_TEMPLATE_CONTENT_VERSION,
  ARM_TEMPLATE_SCHEMA,
  buildArmTemplate,
  resourceIdExpression,
} from "./arm-template";
import type { ArmTemplateRequest } from "./arm-template";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-soc";
const BASE = `/subscriptions/${SUB}/resourceGroups/${RG}/providers`;

const DCE_PATH = `${BASE}/Microsoft.Insights/dataCollectionEndpoints/dce-soc`;
const TABLE_PATH = `${BASE}/Microsoft.OperationalInsights/workspaces/ws-soc/tables/Vendor_CL`;
const DCR_PATH = `${BASE}/Microsoft.Insights/dataCollectionRules/dcr-Vendor-eastus`;
const AMPLS_PATH = `${BASE}/Microsoft.Insights/privateLinkScopes/ampls-soc/scopedResources/dce-soc-connection`;

const TABLE: ArmTemplateRequest = {
  path: TABLE_PATH,
  apiVersion: "2022-10-01",
  kind: "custom-table",
  table: "Vendor_CL",
  body: { properties: { schema: { name: "Vendor_CL", columns: [] } } },
};

const DCE: ArmTemplateRequest = {
  path: DCE_PATH,
  apiVersion: "2023-03-11",
  kind: "dce",
  table: null,
  body: { location: "eastus", properties: { networkAcls: {} } },
};

const DCR: ArmTemplateRequest = {
  path: DCR_PATH,
  apiVersion: "2023-03-11",
  kind: "dcr",
  table: "Vendor_CL",
  body: {
    kind: "Direct",
    location: "eastus",
    properties: {
      dataCollectionEndpointId: DCE_PATH,
      dataFlows: [{ outputStream: "Custom-Vendor_CL" }],
    },
  },
};

const AMPLS: ArmTemplateRequest = {
  path: AMPLS_PATH,
  apiVersion: "2021-07-01-preview",
  kind: "ampls-association",
  table: null,
  body: { properties: { linkedResourceId: DCE_PATH } },
};

describe("buildArmTemplate envelope", () => {
  it("emits the deployment-template envelope the README's two commands require", () => {
    const { template } = buildArmTemplate([DCE]);
    // The three keys that separate a template from the bare REST body we used
    // to ship. All three, because Portal rejects a file missing any of them.
    expect(template.$schema).toBe(ARM_TEMPLATE_SCHEMA);
    expect(template.$schema).toContain("deploymentTemplate.json#");
    expect(template.contentVersion).toBe(ARM_TEMPLATE_CONTENT_VERSION);
    expect(Array.isArray(template.resources)).toBe(true);
  });

  it("carries the body's own fields through verbatim, keeping kind and location", () => {
    const [resource] = buildArmTemplate([DCR]).template.resources;
    expect(resource.kind).toBe("Direct");
    expect(resource.location).toBe("eastus");
    expect(resource.properties).toEqual({
      dataCollectionEndpointId: DCE_PATH,
      dataFlows: [{ outputStream: "Custom-Vendor_CL" }],
    });
    // Mutation check: a body field the builder does not know about must still
    // survive, or a new request kind silently loses configuration.
    const withExtra = buildArmTemplate([
      { ...DCR, body: { ...(DCR.body as object), identity: { type: "None" } } },
    ]);
    expect(withExtra.template.resources[0].identity).toEqual({ type: "None" });
  });

  it("uses the FULL nested type and name, not the leaf pair", () => {
    const [table] = buildArmTemplate([TABLE]).template.resources;
    expect(table.type).toBe("Microsoft.OperationalInsights/workspaces/tables");
    expect(table.name).toBe("ws-soc/Vendor_CL");

    const [ampls] = buildArmTemplate([AMPLS]).template.resources;
    expect(ampls.type).toBe("Microsoft.Insights/privateLinkScopes/scopedResources");
    expect(ampls.name).toBe("ampls-soc/dce-soc-connection");

    // Mutation check: the leaf-only answer parseResourceId gives would be
    // 'tables' / 'Vendor_CL'. Neither may appear.
    expect(table.type).not.toBe("tables");
    expect(table.name).not.toBe("Vendor_CL");
  });

  it("reports the one scope the template must be deployed to", () => {
    const build = buildArmTemplate([DCE, TABLE, DCR]);
    expect(build.subscriptionId).toBe(SUB);
    expect(build.resourceGroup).toBe(RG);
    expect(build.scopeConflicts).toEqual([]);
    expect(build.unparseable).toEqual([]);
  });
});

describe("buildArmTemplate dependencies", () => {
  it("derives the DCE edge from a resource id inside the body", () => {
    const build = buildArmTemplate([DCE, DCR]);
    const dcr = build.template.resources[1];
    expect(dcr.dependsOn).toEqual([
      "[resourceId('Microsoft.Insights/dataCollectionEndpoints', 'dce-soc')]",
    ]);
    // Mutation check: the edge must come from the REFERENCE, not from the DCE
    // merely being present. Drop the reference and the edge must go.
    const noReference = buildArmTemplate([
      DCE,
      { ...DCR, body: { kind: "Direct", location: "eastus", properties: {} } },
    ]);
    expect(noReference.template.resources[1].dependsOn).toBeUndefined();
  });

  it("derives the AMPLS edge the same way", () => {
    const build = buildArmTemplate([DCE, AMPLS]);
    expect(build.template.resources[1].dependsOn).toEqual([
      "[resourceId('Microsoft.Insights/dataCollectionEndpoints', 'dce-soc')]",
    ]);
  });

  it("makes a DCR wait for its own custom table, which no resource id states", () => {
    const build = buildArmTemplate([TABLE, DCR]);
    const dcr = build.template.resources[1];
    expect(dcr.dependsOn).toContain(
      "[resourceId('Microsoft.OperationalInsights/workspaces/tables', 'ws-soc', 'Vendor_CL')]",
    );
    // Mutation check: it is THIS table, not any table. A DCR for another table
    // must not inherit the edge.
    const otherTable = buildArmTemplate([TABLE, { ...DCR, table: "Other_CL" }]);
    expect(otherTable.template.resources[1].dependsOn).toBeUndefined();
  });

  it("carries both edges when a DCE-based DCR also creates its table", () => {
    const build = buildArmTemplate([DCE, TABLE, DCR, AMPLS]);
    const dcr = build.template.resources[2];
    expect(dcr.dependsOn).toHaveLength(2);
    expect(new Set(dcr.dependsOn)).toEqual(
      new Set([
        "[resourceId('Microsoft.Insights/dataCollectionEndpoints', 'dce-soc')]",
        "[resourceId('Microsoft.OperationalInsights/workspaces/tables', 'ws-soc', 'Vendor_CL')]",
      ]),
    );
    // The independent resources stay independent - over-declaring dependsOn
    // serialises a deployment that ARM could otherwise parallelise.
    expect(build.template.resources[0].dependsOn).toBeUndefined();
    expect(build.template.resources[1].dependsOn).toBeUndefined();
  });

  it("never points dependsOn at a resource it excluded", () => {
    // The DCE is in another resource group, so it cannot be in this
    // deployment - and the DCR that references it must not claim it can.
    const foreignDce: ArmTemplateRequest = {
      ...DCE,
      path: `/subscriptions/${SUB}/resourceGroups/other-rg/providers/Microsoft.Insights/dataCollectionEndpoints/dce-soc`,
    };
    const build = buildArmTemplate([DCR, foreignDce]);
    expect(build.scopeConflicts).toEqual([foreignDce.path]);
    expect(build.template.resources).toHaveLength(1);
    expect(build.template.resources[0].dependsOn).toBeUndefined();
  });
});

describe("buildArmTemplate refusals", () => {
  it("excludes a path that names no resource and says which", () => {
    const junk: ArmTemplateRequest = {
      path: "/subscriptions/S/resourceGroups/R/providers/Microsoft.Insights/dataCollectionRules",
      apiVersion: "2023-03-11",
      body: { properties: {} },
    };
    const build = buildArmTemplate([DCE, junk]);
    expect(build.unparseable).toEqual([junk.path]);
    expect(build.template.resources).toHaveLength(1);
  });

  it("returns an empty template rather than throwing on no requests", () => {
    const build = buildArmTemplate([]);
    expect(build.template.resources).toEqual([]);
    expect(build.subscriptionId).toBe("");
    expect(build.template.$schema).toBe(ARM_TEMPLATE_SCHEMA);
  });
});

describe("resourceIdExpression", () => {
  it("quotes one argument per name segment", () => {
    expect(resourceIdExpression("Microsoft.Insights/dataCollectionRules", ["a"])).toBe(
      "[resourceId('Microsoft.Insights/dataCollectionRules', 'a')]",
    );
    expect(
      resourceIdExpression("Microsoft.OperationalInsights/workspaces/tables", [
        "ws",
        "T_CL",
      ]),
    ).toBe("[resourceId('Microsoft.OperationalInsights/workspaces/tables', 'ws', 'T_CL')]");
  });
});
