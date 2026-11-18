import { describe, expect, it } from "vitest";
import { entraCategoriesFor } from "../../domain/onboarding-howto-steps/entra-activity-steps";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { ENTRA_ITEM_ID, deployEntraSetting, readEntraSettingState, removeEntraSetting } from "./entra-diagnostic-export";
import type { EntraDeployInput } from "./entra-diagnostic-export";

const EH_SUB = "11111111-1111-1111-1111-111111111111";
const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const NS = { subscriptionId: EH_SUB, resourceGroup: "eh-rg", name: "cribl-ns" };
const NS_PATH = `/subscriptions/${EH_SUB}/resourceGroups/eh-rg/providers/Microsoft.EventHub/namespaces/cribl-ns`;
const RULE_ID = `${NS_PATH}/authorizationRules/send`;
const CATEGORIES = entraCategoriesFor(["SecurityOnly"]);
const INPUT: EntraDeployInput = { namespace: NS, ruleName: "send", categories: CATEGORIES };
const LIST_PATH = "/providers/microsoft.aadiam/diagnosticSettings";
const OUR_PATH = `${LIST_PATH}/CriblEntraIDLogs`;
const API = "2017-04-01";
const RECORD = { tenantId: TENANT, settingName: "CriblEntraIDLogs", ruleId: RULE_ID };

function setting(opts: { name: string; ruleId?: string; categories?: readonly string[] }): unknown {
  return {
    id: `${LIST_PATH}/${opts.name}`,
    name: opts.name,
    properties: {
      eventHubAuthorizationRuleId: opts.ruleId ?? RULE_ID,
      eventHubName: "",
      logs: (opts.categories ?? CATEGORIES).map((category) => ({ category, enabled: true })),
    },
  };
}
const list = (...items: unknown[]) => ({ status: 200, body: { value: items } });
const ok = (body: unknown) => ({ status: 200, body });
const forbidden = { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } };
const notFound = { status: 404, body: { code: "ResourceNotFound" } };

describe("readEntraSettingState", () => {
  it("reads the tenant list once; ours matching is deployed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(setting({ name: "CriblEntraIDLogs" })));
    const state = await readEntraSettingState(azure);
    expect(state.ours.kind).toBe("present-matching");
    expect(state.deployed).toEqual([ENTRA_ITEM_ID]);
    expect(azure.calls).toEqual([{ method: "GET", path: LIST_PATH, apiVersion: API }]);
  });

  it("a 403 (no directory role) is unknown with its reason, never absent", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden);
    const state = await readEntraSettingState(azure);
    expect(state.ours.kind).toBe("unknown");
    expect(state.unknownReason).toBe("List the tenant's Entra ID diagnostic settings: HTTP 403 - no");
    expect(state.deployed).toEqual([]);
  });

  it("a second page is unread, never listed with the first", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [], nextLink: "https://next" } });
    const state = await readEntraSettingState(azure);
    expect(state.settings.kind).toBe("unread");
    expect(state.unknownReason).toBe(
      "List the tenant's Entra ID diagnostic settings: Azure returned more than one page, which a tenant's Entra settings should not need - stopped reading.",
    );
  });
});

describe("deployEntraSetting", () => {
  it("re-lists, PUTs the How-to body at the tenant path, then GETs it back - nothing else", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), ok(null), ok(setting({ name: "CriblEntraIDLogs" })));
    const outcome = await deployEntraSetting(azure, INPUT);
    expect(outcome).toEqual({ kind: "written-and-read-back", settingId: OUR_PATH });
    expect(azure.calls.map((c) => [c.method, c.path, c.apiVersion])).toEqual([
      ["GET", LIST_PATH, API],
      ["PUT", OUR_PATH, API],
      ["GET", OUR_PATH, API],
    ]);
    const body = azure.calls[1]?.body as {
      properties: { eventHubAuthorizationRuleId: string; eventHubName: string; logs: { category: string; enabled: boolean }[] };
    };
    expect(body.properties.eventHubAuthorizationRuleId).toBe(RULE_ID);
    expect(body.properties.eventHubName).toBe("");
    expect(body.properties.logs.filter((l) => l.enabled).map((l) => l.category)).toEqual([...CATEGORIES]);
  });

  it("ours already matching is 'already applied': nothing is written", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(setting({ name: "CriblEntraIDLogs" })));
    expect(await deployEntraSetting(azure, INPUT)).toEqual({ kind: "already-exists", settingId: OUR_PATH });
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("ours differing (made by someone else, another way) is refused, never overwritten", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(setting({ name: "CriblEntraIDLogs", ruleId: `${NS_PATH}/authorizationRules/RootManageSharedAccessKey` })));
    const outcome = await deployEntraSetting(azure, INPUT);
    expect(outcome.kind).toBe("present-differs");
    expect(outcome.kind === "present-differs" ? outcome.diffs.map((d) => d.field) : []).toEqual(["eventHubAuthorizationRuleId"]);
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("another setting already sending a chosen category to the namespace is refused by name", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(setting({ name: "sentinel-entra", categories: ["SignInLogs"] })));
    expect(await deployEntraSetting(azure, INPUT)).toEqual({ kind: "possible-duplicate", names: ["sentinel-entra"] });
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a category the app cannot express is refused by name before any call", async () => {
    const azure = new FakeAzureManagement();
    const outcome = await deployEntraSetting(azure, { ...INPUT, categories: ["SignInLogs", "BogusLogs"] });
    expect(outcome).toEqual({ kind: "unknown-categories", names: ["BogusLogs"] });
    expect(azure.calls).toEqual([]);
  });

  it("a 403 at the PUT is denied at that step, as Azure said it", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), forbidden);
    expect(await deployEntraSetting(azure, INPUT)).toEqual({
      kind: "denied",
      step: "setting-put",
      status: 403,
      code: "AuthorizationFailed",
      message: "Create the Entra ID setting CriblEntraIDLogs: HTTP 403 - no",
    });
  });

  it("a read-back missing a chosen category (an unlicensed one) names it", async () => {
    const azure = new FakeAzureManagement();
    const without = CATEGORIES.filter((c) => c !== "RiskyServicePrincipals");
    azure.respondWith(list(), ok(null), ok(setting({ name: "CriblEntraIDLogs", categories: without })));
    expect(await deployEntraSetting(azure, INPUT)).toEqual({
      kind: "accepted-not-verified",
      settingId: OUR_PATH,
      reasons: [`logs: expected exactly ${CATEGORIES.join(", ")}, found not enabled: RiskyServicePrincipals.`],
    });
  });

  it("never throws on a transport rejection", async () => {
    const azure = new FakeAzureManagement();
    azure.request = () => Promise.reject(new Error("socket hang up"));
    const outcome = await deployEntraSetting(azure, INPUT);
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.step : "").toBe("setting-list");
  });
});

describe("removeEntraSetting", () => {
  it("reads it by name, deletes it, and confirms the 404 - in that order and nothing else", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ok(setting({ name: "CriblEntraIDLogs" })), ok(null), notFound);
    expect(await removeEntraSetting(azure, { tenantId: TENANT, record: RECORD })).toEqual({
      kind: "removed",
      settingId: OUR_PATH,
    });
    expect(azure.calls).toEqual([
      { method: "GET", path: OUR_PATH, apiVersion: API },
      { method: "DELETE", path: OUR_PATH, apiVersion: API },
      { method: "GET", path: OUR_PATH, apiVersion: API },
    ]);
  });

  it("a setting with no record (made by hand from the How-to) is never deleted", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ok(setting({ name: "CriblEntraIDLogs" })));
    const outcome = await removeEntraSetting(azure, { tenantId: TENANT, record: null });
    expect(outcome.kind).toBe("not-proven");
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a record for another tenant proves nothing here", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ok(setting({ name: "CriblEntraIDLogs" })));
    const outcome = await removeEntraSetting(azure, { tenantId: "other-tenant", record: RECORD });
    expect(outcome.kind).toBe("not-proven");
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a setting that now sends with another rule is not provably ours", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ok(setting({ name: "CriblEntraIDLogs", ruleId: `${NS_PATH}/authorizationRules/other` })));
    const outcome = await removeEntraSetting(azure, { tenantId: TENANT, record: RECORD });
    expect(outcome.kind === "not-proven" ? outcome.detail : "").toContain(`not the rule this app wrote (${RULE_ID})`);
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a 404 at the first read is already gone, never an error", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(notFound);
    expect(await removeEntraSetting(azure, { tenantId: TENANT, record: RECORD })).toEqual({
      kind: "already-gone",
      settingId: OUR_PATH,
    });
  });

  it("a DELETE accepted but still reading back is removed-not-confirmed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(ok(setting({ name: "CriblEntraIDLogs" })), ok(null), ok(setting({ name: "CriblEntraIDLogs" })));
    expect(await removeEntraSetting(azure, { tenantId: TENANT, record: RECORD })).toEqual({
      kind: "removed-not-confirmed",
      settingId: OUR_PATH,
      reason: "Azure accepted the removal, but the setting still reads back.",
    });
  });
});
