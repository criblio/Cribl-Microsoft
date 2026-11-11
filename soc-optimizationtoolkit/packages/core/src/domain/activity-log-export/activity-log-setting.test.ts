import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_CATEGORIES,
  ACTIVITY_LOG_SETTING_NAME,
  MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS,
  SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
  activityLogSettingDiffs,
  activityLogSettingPath,
  buildActivityLogSettingGetRequest,
  buildActivityLogSettingPutRequest,
  buildSubscriptionDiagnosticSettingsListRequest,
  classifyOursSetting,
  describeSettingDiff,
  expectedActivityLogSetting,
  findSameNamespaceSettings,
  subscriptionSettingsFull,
} from "./activity-log-setting";
import { parseDiagnosticSettings, readDiagnosticSetting, settingTargetsNamespace } from "./diagnostic-setting";

const SUB = "00000000-0000-0000-0000-000000000001";
const NS = { subscriptionId: SUB, resourceGroup: "eh-rg", name: "cribl-ns" };
const NS_PATH = `/subscriptions/${SUB}/resourceGroups/eh-rg/providers/Microsoft.EventHub/namespaces/cribl-ns`;
const RULE_ID = `${NS_PATH}/authorizationRules/DiagManage`;
const INPUT = { subscriptionId: SUB, namespace: NS, ruleName: "DiagManage" };

function setting(opts: { name: string; ruleId?: string; hub?: string; categories?: readonly string[] }): unknown {
  return {
    id: `/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings/${opts.name}`,
    name: opts.name,
    properties: {
      eventHubAuthorizationRuleId: opts.ruleId ?? RULE_ID,
      ...(opts.hub !== undefined ? { eventHubName: opts.hub } : {}),
      logs: (opts.categories ?? ACTIVITY_LOG_CATEGORIES).map((category) => ({ category, enabled: true })),
    },
  };
}

describe("the Activity Log setting requests", () => {
  it("PUTs exactly the rule id, every category enabled and NO eventHubName, at our fixed name", () => {
    const put = buildActivityLogSettingPutRequest(INPUT);
    expect(put.method).toBe("PUT");
    expect(put.path).toBe(`/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings/cribl-activity-log`);
    expect(put.apiVersion).toBe("2021-05-01-preview");
    expect(put.body).toEqual({
      properties: {
        eventHubAuthorizationRuleId: RULE_ID,
        logs: [
          { category: "Administrative", enabled: true },
          { category: "Security", enabled: true },
          { category: "ServiceHealth", enabled: true },
          { category: "Alert", enabled: true },
          { category: "Recommendation", enabled: true },
          { category: "Policy", enabled: true },
          { category: "Autoscale", enabled: true },
          { category: "ResourceHealth", enabled: true },
        ],
      },
    });
    expect(put.body.properties).not.toHaveProperty("eventHubName");
    // No secret field of any kind: a diagnostic setting takes the rule id.
    expect(JSON.stringify(put.body)).not.toMatch(/connectionString|SharedAccessKey/i);
  });

  it("lists and reads back at the subscription scope with the same api-version Validate uses", () => {
    expect(buildSubscriptionDiagnosticSettingsListRequest(SUB)).toEqual({
      method: "GET",
      path: `/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings`,
      apiVersion: SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
    });
    expect(buildActivityLogSettingGetRequest(SUB)).toEqual({
      method: "GET",
      path: activityLogSettingPath(SUB),
      apiVersion: SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
    });
    expect(ACTIVITY_LOG_SETTING_NAME).toBe("cribl-activity-log");
    expect(MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS).toBe(5);
  });
});

describe("readDiagnosticSetting", () => {
  it("reads rule, hub and enabled categories (or category groups), dropping disabled ones", () => {
    const read = readDiagnosticSetting({
      id: "/x/diagnosticSettings/a",
      name: "a",
      properties: {
        eventHubAuthorizationRuleId: RULE_ID,
        eventHubName: "hub",
        logs: [
          { category: "Administrative", enabled: true },
          { category: "Policy", enabled: false },
          { categoryGroup: "allLogs", enabled: true },
        ],
      },
    });
    expect(read).toEqual({ id: "/x/diagnosticSettings/a", name: "a", ruleId: RULE_ID, hub: "hub", enabled: ["Administrative", "allLogs"] });
  });

  it("takes the name from the id when the item omits it; a non-object reads as an empty setting", () => {
    expect(readDiagnosticSetting({ id: activityLogSettingPath(SUB) }).name).toBe("cribl-activity-log");
    expect(readDiagnosticSetting("nope")).toEqual({ id: "", name: "", ruleId: "", hub: "", enabled: [] });
  });

  it("parseDiagnosticSettings drops nameless id-less items; zero items is the unverified empty", () => {
    expect(parseDiagnosticSettings([{}, 3]).kind).toBe("empty");
    const listing = parseDiagnosticSettings([{}, setting({ name: "a" })]);
    expect(listing.kind).toBe("rows");
    expect(listing.kind === "rows" ? listing.rows.map((s) => s.name) : []).toEqual(["a"]);
  });

  it("settingTargetsNamespace matches a rule inside the namespace only, case-insensitively", () => {
    const s = readDiagnosticSetting(setting({ name: "a", ruleId: RULE_ID.toUpperCase() }));
    expect(settingTargetsNamespace(s, NS_PATH)).toBe(true);
    // A sibling namespace whose name starts the same is not the namespace.
    expect(settingTargetsNamespace(s, `${NS_PATH.slice(0, -2)}`)).toBe(false);
    expect(settingTargetsNamespace(readDiagnosticSetting(setting({ name: "b", ruleId: "" })), NS_PATH)).toBe(false);
  });
});

describe("activityLogSettingDiffs", () => {
  const expected = expectedActivityLogSetting(INPUT);

  it("a setting written as the PUT writes it matches", () => {
    expect(activityLogSettingDiffs(expected, readDiagnosticSetting(setting({ name: ACTIVITY_LOG_SETTING_NAME })))).toEqual([]);
  });

  it("names the rule, the hub and the categories that fall short, as the ARM body names them", () => {
    const observed = readDiagnosticSetting(
      setting({ name: ACTIVITY_LOG_SETTING_NAME, ruleId: `${NS_PATH}/authorizationRules/Other`, hub: "mine", categories: ["Administrative"] }),
    );
    const diffs = activityLogSettingDiffs(expected, observed);
    expect(diffs.map((d) => d.field)).toEqual(["eventHubAuthorizationRuleId", "eventHubName", "logs"]);
    expect(diffs[2]?.actual).toBe("not enabled: Security, ServiceHealth, Alert, Recommendation, Policy, Autoscale, ResourceHealth");
    const hubDiff = diffs.find((d) => d.field === "eventHubName");
    expect(hubDiff === undefined ? "" : describeSettingDiff(hubDiff)).toBe(
      "eventHubName: expected (none: Azure writes to insights-activity-logs), found mine.",
    );
  });

  it("without an expected rule, any namespace rule is enough, and no rule is a difference", () => {
    const other = readDiagnosticSetting(setting({ name: "x", ruleId: `/subscriptions/s/resourceGroups/r/providers/Microsoft.EventHub/namespaces/n/authorizationRules/R` }));
    expect(activityLogSettingDiffs(undefined, other)).toEqual([]);
    const none = readDiagnosticSetting(setting({ name: "x", ruleId: "" }));
    expect(activityLogSettingDiffs(undefined, none).map((d) => d.field)).toEqual(["eventHubAuthorizationRuleId"]);
  });
});

describe("classifyOursSetting / findSameNamespaceSettings / subscriptionSettingsFull", () => {
  it("absent over an empty list is unmeasured; over rows without ours it is measured", () => {
    expect(classifyOursSetting(parseDiagnosticSettings([]))).toEqual({ kind: "absent", measured: false });
    expect(classifyOursSetting(parseDiagnosticSettings([setting({ name: "other" })]))).toEqual({ kind: "absent", measured: true });
  });

  it("finds ours by name case-insensitively, matching or differing", () => {
    const matching = classifyOursSetting(parseDiagnosticSettings([setting({ name: "CRIBL-Activity-Log" })]));
    expect(matching.kind).toBe("present-matching");
    const differs = classifyOursSetting(
      parseDiagnosticSettings([setting({ name: ACTIVITY_LOG_SETTING_NAME, categories: ["Administrative"] })]),
    );
    expect(differs.kind).toBe("present-differs");
  });

  it("another setting in the chosen namespace is a duplicate; ours and other namespaces are not", () => {
    const listing = parseDiagnosticSettings([
      setting({ name: ACTIVITY_LOG_SETTING_NAME }),
      setting({ name: "legacy", ruleId: `${NS_PATH}/authorizationRules/RootManageSharedAccessKey` }),
      setting({ name: "elsewhere", ruleId: `/subscriptions/${SUB}/resourceGroups/x/providers/Microsoft.EventHub/namespaces/other/authorizationRules/R` }),
      setting({ name: "to-workspace", ruleId: "" }),
    ]);
    expect(findSameNamespaceSettings(listing, NS).map((s) => s.name)).toEqual(["legacy"]);
  });

  it("is full at five listed settings, not at four, and never over an unverified empty list", () => {
    const four = parseDiagnosticSettings([1, 2, 3, 4].map((n) => setting({ name: `s${n}`, ruleId: "" })));
    const five = parseDiagnosticSettings([1, 2, 3, 4, 5].map((n) => setting({ name: `s${n}`, ruleId: "" })));
    expect(subscriptionSettingsFull(four)).toBe(false);
    expect(subscriptionSettingsFull(five)).toBe(true);
    expect(subscriptionSettingsFull(parseDiagnosticSettings([]))).toBe(false);
  });
});
