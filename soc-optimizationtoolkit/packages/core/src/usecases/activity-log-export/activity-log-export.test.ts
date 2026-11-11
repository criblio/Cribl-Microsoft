import { describe, expect, it } from "vitest";
import { ACTIVITY_LOG_CATEGORIES } from "../../domain/activity-log-export/activity-log-setting";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeLogger } from "../../testing/fake-logger";
import { ACTIVITY_LOG_ITEM_ID, deployActivityLogExport, readActivityLogState } from "./activity-log-export";
import type { ActivityLogDeployInput } from "./activity-log-export";

const SUB = "00000000-0000-0000-0000-000000000001";
const NS = { subscriptionId: SUB, resourceGroup: "eh-rg", name: "cribl-ns" };
const NS_PATH = `/subscriptions/${SUB}/resourceGroups/eh-rg/providers/Microsoft.EventHub/namespaces/cribl-ns`;
const RULE_ID = `${NS_PATH}/authorizationRules/DiagManage`;
const INPUT: ActivityLogDeployInput = { subscriptionId: SUB, namespace: NS, ruleName: "DiagManage" };
const SETTINGS_PATH = `/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings`;
const OUR_ID = `${SETTINGS_PATH}/cribl-activity-log`;

function setting(opts: { name: string; ruleId?: string; hub?: string; categories?: readonly string[] }): unknown {
  return {
    id: `${SETTINGS_PATH}/${opts.name}`,
    name: opts.name,
    properties: {
      eventHubAuthorizationRuleId: opts.ruleId ?? RULE_ID,
      ...(opts.hub !== undefined ? { eventHubName: opts.hub } : {}),
      logs: (opts.categories ?? ACTIVITY_LOG_CATEGORIES).map((category) => ({ category, enabled: true })),
    },
  };
}

const OTHER_NS_RULE = `/subscriptions/${SUB}/resourceGroups/x/providers/Microsoft.EventHub/namespaces/other/authorizationRules/R`;
const list = (...items: unknown[]) => ({ status: 200, body: { value: items } });
const ok = (body: unknown) => ({ status: 200, body });
const forbidden = { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } };
const unregistered = {
  status: 409,
  body: { error: { code: "MissingSubscriptionRegistration", message: "register microsoft.insights" } },
};

function methods(azure: FakeAzureManagement): string[] {
  return azure.calls.map((c) => c.method);
}

describe("readActivityLogState", () => {
  it("our matching setting is deployed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(setting({ name: "cribl-activity-log" })));
    const state = await readActivityLogState(azure, SUB);
    expect(state.ours.kind).toBe("present-matching");
    expect(state.deployed).toEqual([ACTIVITY_LOG_ITEM_ID]);
    expect(state.unknownReason).toBeUndefined();
    expect(azure.calls).toEqual([
      { method: "GET", path: SETTINGS_PATH, apiVersion: "2021-05-01-preview" },
    ]);
  });

  it("a differing setting of ours is not deployed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(setting({ name: "cribl-activity-log", categories: ["Administrative"] })));
    const state = await readActivityLogState(azure, SUB);
    expect(state.ours.kind).toBe("present-differs");
    expect(state.deployed).toEqual([]);
  });

  it("an empty list is an UNMEASURED absent, never a refusal and never unknown", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list());
    const state = await readActivityLogState(azure, SUB);
    expect(state.ours).toEqual({ kind: "absent", measured: false });
    expect(state.settings.kind).toBe("listed");
  });

  it("a 403 list is unknown with its reason, never absent", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(forbidden);
    const state = await readActivityLogState(azure, SUB);
    expect(state.ours.kind).toBe("unknown");
    expect(state.unknownReason).toBe("List the subscription's diagnostic settings: HTTP 403 - no");
    expect(state.deployed).toEqual([]);
  });

  it("never throws on a transport rejection", async () => {
    const azure = new FakeAzureManagement();
    azure.request = () => Promise.reject(new Error("socket hang up"));
    const state = await readActivityLogState(azure, SUB);
    expect(state.settings.kind).toBe("unread");
    expect(state.unknownReason).toBe("List the subscription's diagnostic settings: socket hang up");
  });
});

describe("deployActivityLogExport - the write", () => {
  it("re-lists, then PUTs exactly the rule, every category and no hub, then GETs it back", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(setting({ name: "to-elsewhere", ruleId: OTHER_NS_RULE })), ok({}), ok(setting({ name: "cribl-activity-log" })));
    const logger = new FakeLogger();
    const outcome = await deployActivityLogExport(azure, INPUT, logger);
    expect(outcome).toEqual({ kind: "written-and-read-back", settingId: OUR_ID });
    expect(methods(azure)).toEqual(["GET", "PUT", "GET"]);
    expect(azure.calls[0]?.path).toBe(SETTINGS_PATH);
    expect(azure.calls[1]).toEqual({
      method: "PUT",
      path: OUR_ID,
      apiVersion: "2021-05-01-preview",
      body: {
        properties: {
          eventHubAuthorizationRuleId: RULE_ID,
          logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true })),
        },
      },
    });
    expect(azure.calls[2]).toEqual({ method: "GET", path: OUR_ID, apiVersion: "2021-05-01-preview" });
    // No listKeys: a diagnostic setting takes the rule id, never a key.
    expect(azure.calls.some((c) => c.path.toLowerCase().includes("listkeys"))).toBe(false);
  });

  it("an empty list does not refuse: it is the normal answer for a fresh subscription", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), ok({}), ok(setting({ name: "cribl-activity-log" })));
    expect((await deployActivityLogExport(azure, INPUT)).kind).toBe("written-and-read-back");
  });

  it("a read-back that differs is accepted-not-verified, naming the fields", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), ok({}), ok(setting({ name: "cribl-activity-log", categories: ["Administrative"] })));
    const outcome = await deployActivityLogExport(azure, INPUT);
    expect(outcome.kind).toBe("accepted-not-verified");
    if (outcome.kind === "accepted-not-verified") {
      expect(outcome.reasons).toEqual([
        "logs: expected every Activity Log category enabled, found not enabled: Security, ServiceHealth, Alert, Recommendation, Policy, Autoscale, ResourceHealth.",
      ]);
    }
  });

  it("a read-back that fails, or holds no setting, is accepted-not-verified - never a failure", async () => {
    const failed = new FakeAzureManagement();
    failed.respondWith(list(), ok({}), { status: 404, body: { error: { message: "gone" } } });
    expect(await deployActivityLogExport(failed, INPUT)).toEqual({
      kind: "accepted-not-verified",
      settingId: OUR_ID,
      reasons: ["Read the setting back: HTTP 404 - gone"],
    });
    const blank = new FakeAzureManagement();
    blank.respondWith(list(), ok({}), ok(null));
    const outcome = await deployActivityLogExport(blank, INPUT);
    expect(outcome).toEqual({
      kind: "accepted-not-verified",
      settingId: OUR_ID,
      reasons: ["The read-back did not contain a diagnostic setting."],
    });
  });

  it("a refused PUT is denied at setting-put, with no read-back", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(list(), forbidden);
    const outcome = await deployActivityLogExport(azure, INPUT);
    expect(outcome).toEqual({
      kind: "denied",
      step: "setting-put",
      status: 403,
      code: "AuthorizationFailed",
      message: "Create the Activity Log setting: HTTP 403 - no",
    });
    expect(methods(azure)).toEqual(["GET", "PUT"]);
  });

  it("a PUT that rejects in transport is failed at setting-put, and nothing throws", async () => {
    const azure = new FakeAzureManagement();
    let n = 0;
    azure.request = (opts) => {
      azure.calls.push(opts);
      n += 1;
      return n === 1 ? Promise.resolve(list()) : Promise.reject(new Error("reset"));
    };
    const outcome = await deployActivityLogExport(azure, INPUT);
    expect(outcome).toMatchObject({ kind: "failed", step: "setting-put", status: null });
  });
});

describe("deployActivityLogExport - refusals send no PUT", () => {
  async function refused(...responses: { status: number; body: unknown }[]) {
    const azure = new FakeAzureManagement();
    azure.respondWith(...responses);
    const outcome = await deployActivityLogExport(azure, INPUT);
    expect(methods(azure)).toEqual(["GET"]);
    return outcome;
  }

  it("already-exists when ours matches the chosen rule", async () => {
    expect(await refused(list(setting({ name: "cribl-activity-log" })))).toEqual({
      kind: "already-exists",
      settingId: OUR_ID,
    });
  });

  it("present-differs when ours sends with another rule, naming the field", async () => {
    const outcome = await refused(
      list(setting({ name: "cribl-activity-log", ruleId: `${NS_PATH}/authorizationRules/Other` })),
    );
    expect(outcome).toEqual({
      kind: "present-differs",
      settingId: OUR_ID,
      diffs: [{ field: "eventHubAuthorizationRuleId", expected: RULE_ID, actual: `${NS_PATH}/authorizationRules/Other` }],
    });
  });

  it("possible-duplicate when another setting already sends to the chosen namespace", async () => {
    const outcome = await refused(
      list(setting({ name: "cribl-activitylog-test", ruleId: `${NS_PATH}/authorizationRules/RootManageSharedAccessKey` })),
    );
    expect(outcome).toEqual({ kind: "possible-duplicate", names: ["cribl-activitylog-test"] });
  });

  it("limit-reached when the subscription already holds five settings, none ours or in this namespace", async () => {
    const five = [1, 2, 3, 4, 5].map((n) => setting({ name: `s${n}`, ruleId: OTHER_NS_RULE }));
    expect(await refused(list(...five))).toEqual({
      kind: "limit-reached",
      limit: 5,
      names: ["s1", "s2", "s3", "s4", "s5"],
    });
  });

  it("four settings elsewhere do not refuse", async () => {
    const azure = new FakeAzureManagement();
    const four = [1, 2, 3, 4].map((n) => setting({ name: `s${n}`, ruleId: OTHER_NS_RULE }));
    azure.respondWith(list(...four), ok({}), ok(setting({ name: "cribl-activity-log" })));
    expect((await deployActivityLogExport(azure, INPUT)).kind).toBe("written-and-read-back");
  });

  it("an unreadable list refuses at setting-list: 403 denied, registration unregistered", async () => {
    expect(await refused(forbidden)).toMatchObject({ kind: "denied", step: "setting-list", status: 403 });
    expect(await refused(unregistered)).toMatchObject({
      kind: "unregistered",
      step: "setting-list",
      code: "MissingSubscriptionRegistration",
    });
  });

  it("a 2xx that is not a listing, or one with a nextLink, refuses rather than half-reads", async () => {
    for (const body of [{}, null, "<html>Sign in</html>", { value: "x" }]) {
      expect(await refused({ status: 200, body })).toMatchObject({ kind: "failed", step: "setting-list" });
    }
    const paged = await refused({ status: 200, body: { value: [], nextLink: "https://management.azure.com/next" } });
    expect(paged).toMatchObject({ kind: "failed", step: "setting-list" });
  });

  it("a transport rejection on the list refuses at setting-list with a null status", async () => {
    const azure = new FakeAzureManagement();
    azure.request = (opts) => {
      azure.calls.push(opts);
      return Promise.reject(new Error("dns"));
    };
    const outcome = await deployActivityLogExport(azure, INPUT);
    expect(outcome).toEqual({
      kind: "failed",
      step: "setting-list",
      status: null,
      code: "",
      message: "List the subscription's diagnostic settings: dns",
    });
    expect(methods(azure)).toEqual(["GET"]);
  });

  it("the re-check happens AFTER the confirm: a setting that appeared since the screen's read refuses", async () => {
    const azure = new FakeAzureManagement();
    // The screen read an empty list...
    azure.respondWith(list());
    const before = await readActivityLogState(azure, SUB);
    expect(before.ours.kind).toBe("absent");
    // ...then someone created a setting into the namespace before the confirm.
    azure.respondWith(list(setting({ name: "made-meanwhile", ruleId: `${NS_PATH}/authorizationRules/R` })));
    const outcome = await deployActivityLogExport(azure, INPUT);
    expect(outcome).toEqual({ kind: "possible-duplicate", names: ["made-meanwhile"] });
    expect(methods(azure)).toEqual(["GET", "GET"]);
  });
});
