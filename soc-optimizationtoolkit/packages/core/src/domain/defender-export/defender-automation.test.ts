// Pins for the Defender continuous-export automation (AZR-3).
//
// The failures these guard against are all silent in the product: a PUT body
// Azure accepts but that targets the wrong thing, a read-back that reports
// "not verified" forever because it compared a secret Azure never returns, an
// existing legacy export missed because it lives in another resource group,
// and a second export onto a hub that already receives the alerts - every
// alert then arrives twice and nothing anywhere says why.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { toListing } from "../inventory-listing/inventory-listing";
import type { Listing } from "../inventory-listing/inventory-listing";
import {
  DEFENDER_EXPORT_DESCRIPTION,
  DEFENDER_EXPORT_NAME,
  SECURITY_AUTOMATIONS_API_VERSION,
  automationMatches,
  buildAutomationGetByIdRequest,
  buildAutomationPutRequest,
  buildSubscriptionAutomationsListRequest,
  classifyOurs,
  expectedExportFor,
  findSameTargetExports,
  parseAutomation,
  parseAutomations,
} from "./defender-automation";
import type { DefenderAutomation, DefenderExportInput, ExpectedExport } from "./defender-automation";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, "legacy", "Deploy-DefenderExport.ps1"), "utf8");

const SUB = "00000000-0000-0000-0000-000000000001";
const NS = { subscriptionId: SUB, resourceGroup: "rg-eh", name: "ns-cribl" };
const NS_ID = `/subscriptions/${SUB}/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns-cribl`;
const HUB_ID = `${NS_ID}/eventhubs/defender-alerts`;
const SECRET = "Endpoint=sb://ns-cribl.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=TOPSECRET";

const INPUT: DefenderExportInput = {
  subscriptionId: SUB,
  resourceGroup: "rg-picked",
  location: "westeurope",
  namespace: NS,
  hubName: "defender-alerts",
  connectionString: SECRET,
};

const EXPECTED: ExpectedExport = expectedExportFor(INPUT);

/** An ARM automations item, healthy unless overridden. */
function item(overrides: {
  name?: string;
  resourceGroup?: string;
  properties?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const name = overrides.name ?? DEFENDER_EXPORT_NAME;
  const rg = overrides.resourceGroup ?? "rg-picked";
  return {
    id: `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Security/automations/${name}`,
    name,
    type: "Microsoft.Security/automations",
    properties: {
      isEnabled: true,
      scopes: [{ description: "x", scopePath: `/subscriptions/${SUB}` }],
      sources: [{ eventSource: "Alerts" }],
      actions: [{ actionType: "EventHub", eventHubResourceId: HUB_ID }],
      ...overrides.properties,
    },
  };
}

function automation(raw: unknown): DefenderAutomation {
  const parsed = parseAutomation(raw);
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
}

function listing(...items: unknown[]): Listing<DefenderAutomation> {
  return parseAutomations(items);
}

describe("verbatim from the legacy script", () => {
  it("keeps the export name, description and api-version legacy used", () => {
    expect(SCRIPT).toContain(`[string]$ExportName = "${DEFENDER_EXPORT_NAME}"`);
    expect(SCRIPT).toContain(`description = "${DEFENDER_EXPORT_DESCRIPTION}"`);
    expect(SCRIPT).toContain(`api-version=${SECURITY_AUTOMATIONS_API_VERSION}`);
  });
});

describe("request builders", () => {
  it("lists automations at SUBSCRIPTION scope, with no resource group in the path", () => {
    const req = buildSubscriptionAutomationsListRequest(SUB);
    expect(req).toEqual({
      method: "GET",
      path: `/subscriptions/${SUB}/providers/Microsoft.Security/automations`,
      apiVersion: SECURITY_AUTOMATIONS_API_VERSION,
    });
    expect(req.path.toLowerCase()).not.toContain("resourcegroups");
  });

  it("reads one automation back by its full id", () => {
    const id = String(item()["id"]);
    expect(buildAutomationGetByIdRequest(id)).toEqual({
      method: "GET",
      path: id,
      apiVersion: SECURITY_AUTOMATIONS_API_VERSION,
    });
  });
});

describe("buildAutomationPutRequest", () => {
  const req = buildAutomationPutRequest(INPUT);

  it("PUTs CriblDefenderExport into the operator's resource group at its location", () => {
    expect(req.method).toBe("PUT");
    expect(req.path).toBe(
      `/subscriptions/${SUB}/resourceGroups/rg-picked/providers/Microsoft.Security/automations/CriblDefenderExport`,
    );
    expect(req.body.location).toBe("westeurope");
  });

  it("exports Alerts only, enabled, watching this subscription as a scope OBJECT", () => {
    expect(req.body.properties.isEnabled).toBe(true);
    expect(req.body.properties.sources).toEqual([{ eventSource: "Alerts" }]);
    expect(req.body.properties.scopes).toHaveLength(1);
    expect(req.body.properties.scopes[0]?.scopePath).toBe(`/subscriptions/${SUB}`);
    expect(typeof req.body.properties.scopes[0]?.description).toBe("string");
  });

  it("targets the HUB id, not the namespace id legacy sent", () => {
    expect(req.body.properties.actions).toHaveLength(1);
    const action = req.body.properties.actions[0];
    expect(action?.actionType).toBe("EventHub");
    expect(action?.eventHubResourceId).toBe(HUB_ID);
    expect(action?.eventHubResourceId.endsWith("/eventhubs/defender-alerts")).toBe(true);
  });

  it("carries the connection string in the body, and only there", () => {
    expect(req.body.properties.actions[0]?.connectionString).toBe(SECRET);
    expect(JSON.stringify(EXPECTED)).not.toContain("TOPSECRET");
    expect(req.path).not.toContain("TOPSECRET");
  });
});

describe("parseAutomation", () => {
  it("never keeps the connection string, even when Azure returns it", () => {
    const parsed = automation(
      item({
        properties: {
          actions: [{ actionType: "EventHub", eventHubResourceId: HUB_ID, connectionString: SECRET }],
        },
      }),
    );
    expect(JSON.stringify(parsed)).not.toContain("TOPSECRET");
    expect(parsed.eventHubTargets).toEqual([HUB_ID]);
  });

  it("reads the resource group from the id and a legacy plain-string scope as its path", () => {
    const parsed = automation(
      item({ resourceGroup: "CriblSecurityExport", properties: { scopes: [`/subscriptions/${SUB}`] } }),
    );
    expect(parsed.resourceGroup).toBe("CriblSecurityExport");
    expect(parsed.scopePaths).toEqual([`/subscriptions/${SUB}`]);
  });

  it("gives an empty listing (unverified), not a measured none, for zero items", () => {
    expect(parseAutomations([])).toEqual({ kind: "empty" });
  });
});

describe("automationMatches - non-secret fields only", () => {
  it("matches when the observed connection string is absent", () => {
    expect(automationMatches(EXPECTED, automation(item()))).toBe(true);
  });

  it("matches when the observed connection string is redacted", () => {
    const redacted = item({
      properties: {
        actions: [{ actionType: "EventHub", eventHubResourceId: HUB_ID, connectionString: "******" }],
      },
    });
    expect(automationMatches(EXPECTED, automation(redacted))).toBe(true);
  });

  it("matches across ARM id casing", () => {
    const upper = item({
      properties: { actions: [{ actionType: "EventHub", eventHubResourceId: HUB_ID.toUpperCase() }] },
    });
    expect(automationMatches(EXPECTED, automation(upper))).toBe(true);
  });

  it("does not match when eventHubResourceId differs", () => {
    const other = item({
      properties: { actions: [{ actionType: "EventHub", eventHubResourceId: `${NS_ID}/eventhubs/other` }] },
    });
    expect(automationMatches(EXPECTED, automation(other))).toBe(false);
  });

  it("does not match when the scope is another subscription", () => {
    const other = item({ properties: { scopes: [{ scopePath: "/subscriptions/someone-else" }] } });
    expect(automationMatches(EXPECTED, automation(other))).toBe(false);
  });

  it("does not match a disabled export, or one without Alerts", () => {
    expect(automationMatches(EXPECTED, automation(item({ properties: { isEnabled: false } })))).toBe(false);
    expect(
      automationMatches(EXPECTED, automation(item({ properties: { sources: [{ eventSource: "Assessments" }] } }))),
    ).toBe(false);
  });

  it("does not match an action that is not an EventHub action", () => {
    const logicApp = item({
      properties: { actions: [{ actionType: "LogicApp", eventHubResourceId: HUB_ID }] },
    });
    expect(automationMatches(EXPECTED, automation(logicApp))).toBe(false);
  });
});

describe("classifyOurs", () => {
  it("finds CriblDefenderExport in CriblSecurityExport when another resource group is expected", () => {
    // Catches an 'ours' check scoped to the operator's resource group: legacy
    // created its export in CriblSecurityExport (Deploy-DefenderExport.ps1:208).
    const legacy = item({ resourceGroup: "CriblSecurityExport" });
    const result = classifyOurs(listing(legacy), EXPECTED);
    expect(result.kind).toBe("present-matching");
    expect(result.kind !== "absent" && result.automation.resourceGroup).toBe("CriblSecurityExport");
  });

  it("matches our name case-insensitively", () => {
    expect(classifyOurs(listing(item({ name: "cribldefenderexport" }))).kind).toBe("present-matching");
  });

  it("gives present-differs naming 'not enabled' for isEnabled:false", () => {
    const result = classifyOurs(listing(item({ properties: { isEnabled: false } })));
    expect(result.kind).toBe("present-differs");
    expect(result.kind === "present-differs" && result.diffs).toEqual(["The export is not enabled."]);
  });

  it("gives present-differs naming the missing alerts source", () => {
    const result = classifyOurs(listing(item({ properties: { sources: [{ eventSource: "SecureScores" }] } })));
    expect(result.kind === "present-differs" && result.diffs).toEqual([
      "The export does not include security alerts.",
    ]);
  });

  it("gives present-differs when the Event Hub target cannot be parsed", () => {
    const result = classifyOurs(
      listing(item({ properties: { actions: [{ actionType: "EventHub", eventHubResourceId: "garbage" }] } })),
    );
    expect(result.kind).toBe("present-differs");
  });

  it("accepts legacy's namespace-id target as parseable when no target is expected", () => {
    const legacy = item({ properties: { actions: [{ actionType: "EventHub", eventHubResourceId: NS_ID }] } });
    expect(classifyOurs(listing(legacy)).kind).toBe("present-matching");
  });

  it("names every resource group when more than one export carries our name", () => {
    const result = classifyOurs(
      listing(item({ resourceGroup: "rg-picked" }), item({ resourceGroup: "CriblSecurityExport" })),
    );
    expect(result.kind).toBe("present-differs");
    const diffs = result.kind === "present-differs" ? result.diffs : [];
    expect(diffs[0]).toContain("rg-picked");
    expect(diffs[0]).toContain("CriblSecurityExport");
  });

  it("gives absent, measured, when the list had rows and none was ours", () => {
    expect(classifyOurs(listing(item({ name: "SomeoneElse" })))).toEqual({ kind: "absent", measured: true });
  });

  it("gives absent, NOT measured, when the list was empty", () => {
    expect(classifyOurs(toListing<DefenderAutomation>([]))).toEqual({ kind: "absent", measured: false });
  });
});

describe("findSameTargetExports", () => {
  it("flags another name targeting the same hub", () => {
    const portal = item({ name: "ExportToEventHub", resourceGroup: "rg-sec" });
    expect(findSameTargetExports(listing(portal), HUB_ID).map((a) => a.name)).toEqual(["ExportToEventHub"]);
  });

  it("flags an export targeting the hub's NAMESPACE id, the legacy form", () => {
    const legacyForm = item({
      name: "OldExport",
      properties: { actions: [{ actionType: "EventHub", eventHubResourceId: NS_ID }] },
    });
    expect(findSameTargetExports(listing(legacyForm), HUB_ID).map((a) => a.name)).toEqual(["OldExport"]);
  });

  it("flags another hub in the same namespace, across id casing", () => {
    const sibling = item({
      name: "Sibling",
      properties: {
        actions: [{ actionType: "EventHub", eventHubResourceId: `${NS_ID.toUpperCase()}/eventhubs/other` }],
      },
    });
    expect(findSameTargetExports(listing(sibling), HUB_ID).map((a) => a.name)).toEqual(["Sibling"]);
  });

  it("does not flag a namespace that merely shares a name prefix", () => {
    const lookalike = item({
      name: "Lookalike",
      properties: { actions: [{ actionType: "EventHub", eventHubResourceId: `${NS_ID}-2/eventhubs/defender-alerts` }] },
    });
    expect(findSameTargetExports(listing(lookalike), HUB_ID)).toEqual([]);
  });

  it("does not flag a non-EventHub action that carries an eventHubResourceId on the hub", () => {
    // Goes through eventHubTargets, which automationMatches does not: a LogicApp
    // or Workspace action is not an export to the hub, so it must not refuse
    // the deploy. The EventHub row beside it proves the listing was read.
    const logicApp = item({
      name: "LogicAppExport",
      resourceGroup: "rg-sec",
      properties: { actions: [{ actionType: "LogicApp", eventHubResourceId: HUB_ID }] },
    });
    const portal = item({ name: "ExportToEventHub", resourceGroup: "rg-sec" });
    expect(automation(logicApp).eventHubTargets).toEqual([]);
    expect(findSameTargetExports(listing(logicApp, portal), HUB_ID).map((a) => a.name)).toEqual([
      "ExportToEventHub",
    ]);
  });

  it("leaves ours out - classifyOurs answers for it", () => {
    expect(findSameTargetExports(listing(item()), HUB_ID)).toEqual([]);
  });
});

describe("classifyExportForPlan (AZR-32 Validate)", () => {
  // Imported through the barrel: Validate reaches it there.
  const verdictFor = async (l: Listing<DefenderAutomation>) =>
    (await import("./index")).classifyExportForPlan(l, EXPECTED);
  const verified = (...items: unknown[]): Listing<DefenderAutomation> => {
    const rows = parseAutomations(items);
    return rows.kind === "rows" ? rows : { kind: "none" };
  };

  it("ours matching the plan is as-expected", async () => {
    expect(await verdictFor(verified(item()))).toEqual({ kind: "as-expected" });
  });

  it("ours targeting another hub is present-differs on eventHubResourceId", async () => {
    const v = await verdictFor(
      verified(item({ properties: { actions: [{ actionType: "EventHub", eventHubResourceId: `${NS_ID}/eventhubs/other` }] } })),
    );
    expect(v.kind).toBe("present-differs");
    expect(v.kind === "present-differs" && v.diffs.map((d) => d.field)).toEqual(["eventHubResourceId"]);
  });

  it("ours disabled and duplicated names both fields", async () => {
    const v = await verdictFor(
      verified(item({ properties: { isEnabled: false } }), item({ resourceGroup: "CriblSecurityExport" })),
    );
    expect(v.kind === "present-differs" && v.diffs.map((d) => d.field)).toEqual(["name", "isEnabled"]);
  });

  it("another name on the plan hub is present-other-name, with that name", async () => {
    const v = await verdictFor(verified(item({ name: "PortalExport" })));
    expect(v).toEqual({ kind: "present-other-name", name: "PortalExport", diffs: [] });
  });

  it("prefers the exact-hub export over one that only shares the namespace", async () => {
    const v = await verdictFor(
      verified(
        item({ name: "NamespaceOnly", properties: { actions: [{ actionType: "EventHub", eventHubResourceId: NS_ID }] } }),
        item({ name: "ExactHub" }),
      ),
    );
    expect(v.kind === "present-other-name" && v.name).toBe("ExactHub");
  });

  it("no target match plus a read listing is absent", async () => {
    const unrelated = item({
      name: "Elsewhere",
      properties: {
        actions: [
          {
            actionType: "EventHub",
            eventHubResourceId: `/subscriptions/${SUB}/resourceGroups/x/providers/Microsoft.EventHub/namespaces/other/eventhubs/h`,
          },
        ],
      },
    });
    expect(await verdictFor(verified(unrelated))).toEqual({ kind: "absent" });
    expect(await verdictFor({ kind: "none" })).toEqual({ kind: "absent" });
  });

  it("a denied (unverified) listing is unknown, never absent", async () => {
    const v = await verdictFor({ kind: "empty" });
    expect(v.kind).toBe("unknown");
    // and a raw toListing of zero rows is unverified too
    expect((await verdictFor(toListing([]))).kind).toBe("unknown");
  });
});
