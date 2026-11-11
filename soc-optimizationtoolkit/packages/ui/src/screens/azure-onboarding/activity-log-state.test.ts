/**
 * AZR-98: the Activity Log section's pure decisions - the Deploy gate's one
 * reason in its fixed priority, and the outcome message for every outcome.
 */

import { describe, expect, it } from "vitest";
import { ACTIVITY_LOG_CATEGORIES, defaultSelection, parseDiagnosticSettings } from "@soc/core";
import type { ActivityLogDeployOutcome, ActivityLogState, CoverageSelection } from "@soc/core";
import { findHistoryInCopy } from "../../components/copy-rules";
import {
  ACTIVITY_LOG_DELIVERY_NOT_VERIFIED,
  ACTIVITY_LOG_UNCONFIRMED_ABSENT_NOTE,
  activityLogDeployDisabledReason,
  activityLogOutcomeMessage,
  activityLogStateNote,
} from "./activity-log-state";
import type { ActivityLogDeployGate } from "./activity-log-state";

const SUB = "sub-1";
const NS = { subscriptionId: SUB, resourceGroup: "rg-eh", name: "ns-a" };
const NS_PATH = `/subscriptions/${SUB}/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns-a`;
const MANAGE = { name: "DiagManage", rights: ["Listen", "Manage", "Send"] };
const TICKED: CoverageSelection = { ...defaultSelection(), enabled: ["activityLog"] };
const ELSEWHERE = "/subscriptions/s/resourceGroups/r/providers/Microsoft.EventHub/namespaces/o/authorizationRules/R";

function setting(name: string, ruleId: string): unknown {
  return {
    id: `/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings/${name}`,
    name,
    properties: {
      eventHubAuthorizationRuleId: ruleId,
      logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true })),
    },
  };
}

function listed(...items: unknown[]): ActivityLogState {
  const listing = parseDiagnosticSettings(items);
  return {
    settings: { kind: "listed", listing },
    ours: { kind: "absent", measured: listing.kind !== "empty" },
    deployed: [],
  };
}

const READY: ActivityLogDeployGate = {
  running: false,
  selection: TICKED,
  state: listed(),
  subscriptionId: SUB,
  namespace: NS,
  rule: MANAGE,
};

describe("activityLogDeployDisabledReason", () => {
  it("is null when everything is in place, including an empty (unconfirmed) list", () => {
    expect(activityLogDeployDisabledReason(READY)).toBeNull();
  });

  it("names one reason, in priority order", () => {
    expect(activityLogDeployDisabledReason({ ...READY, running: true })).toBe("A deploy is already running.");
    expect(activityLogDeployDisabledReason({ ...READY, subscriptionId: "" })).toMatch(/No Azure subscription/);
    expect(activityLogDeployDisabledReason({ ...READY, selection: null })).toMatch(/has not loaded/);
    expect(activityLogDeployDisabledReason({ ...READY, selection: { ...TICKED, enabled: [] } })).toBe(
      "Tick the Azure Activity Log to deploy it.",
    );
    expect(activityLogDeployDisabledReason({ ...READY, state: null })).toBe(
      "Read the subscription's diagnostic settings first.",
    );
    expect(activityLogDeployDisabledReason({ ...READY, namespace: null })).toBe(
      "Choose the Event Hub namespace the Activity Log goes to.",
    );
    expect(activityLogDeployDisabledReason({ ...READY, rule: null })).toBe(
      "Choose the namespace authorization rule the setting sends with.",
    );
    expect(activityLogDeployDisabledReason({ ...READY, rule: { name: "SendOnly", rights: ["Send"] } })).toMatch(
      /has Send\. A diagnostic setting needs a rule with Manage rights/,
    );
  });

  it("an unreadable list is its own reason, with Azure's words", () => {
    const state: ActivityLogState = {
      settings: {
        kind: "unread",
        failure: { kind: "denied", status: 403, code: "AuthorizationFailed", message: "List: HTTP 403 - no" },
      },
      ours: { kind: "unknown", reason: "List: HTTP 403 - no" },
      deployed: [],
      unknownReason: "List: HTTP 403 - no",
    };
    expect(activityLogDeployDisabledReason({ ...READY, state })).toBe(
      "The subscription's diagnostic settings could not be read - List: HTTP 403 - no",
    );
  });

  it("ours matching the chosen rule, ours with another rule, a duplicate and a full subscription each refuse", () => {
    const ours = (rule: string) => listed(setting("cribl-activity-log", `${NS_PATH}/authorizationRules/${rule}`));
    expect(activityLogDeployDisabledReason({ ...READY, state: ours("DiagManage") })).toMatch(/already exists/);
    expect(activityLogDeployDisabledReason({ ...READY, state: ours("Other") })).toMatch(
      /exists but differs from what this app writes: eventHubAuthorizationRuleId: expected .*DiagManage, found .*Other\. Repairing it from here is not available yet\./,
    );
    expect(
      activityLogDeployDisabledReason({ ...READY, state: listed(setting("legacy", `${NS_PATH}/authorizationRules/Root`)) }),
    ).toMatch(/already sends this subscription's Activity Log to this namespace: legacy\./);
    const five = listed(...[1, 2, 3, 4, 5].map((n) => setting(`s${n}`, ELSEWHERE)));
    expect(activityLogDeployDisabledReason({ ...READY, state: five })).toMatch(/already has 5 diagnostic settings/);
    const four = listed(...[1, 2, 3, 4].map((n) => setting(`s${n}`, ELSEWHERE)));
    expect(activityLogDeployDisabledReason({ ...READY, state: four })).toBeNull();
  });
});

describe("activityLogStateNote", () => {
  it("only an unmeasured absence carries the caveat", () => {
    expect(activityLogStateNote(listed())).toEqual({ tone: "warning", text: ACTIVITY_LOG_UNCONFIRMED_ABSENT_NOTE });
    expect(activityLogStateNote(listed(setting("other", "")))).toBeNull();
    expect(activityLogStateNote(null)).toBeNull();
  });
});

describe("activityLogOutcomeMessage", () => {
  const OUTCOMES: readonly ActivityLogDeployOutcome[] = [
    { kind: "written-and-read-back", settingId: "x" },
    { kind: "accepted-not-verified", settingId: "x", reasons: ["logs: expected all, found some."] },
    { kind: "already-exists", settingId: "x" },
    { kind: "present-differs", settingId: "x", diffs: [{ field: "eventHubName", expected: "(none)", actual: "h" }] },
    { kind: "possible-duplicate", names: ["legacy"] },
    { kind: "limit-reached", limit: 5, names: ["a", "b", "c", "d", "e"] },
    { kind: "denied", step: "setting-list", status: 403, code: "AuthorizationFailed", message: "List: HTTP 403 - no" },
    { kind: "unregistered", step: "setting-list", status: 409, code: "MissingSubscriptionRegistration", message: "m" },
    { kind: "failed", step: "setting-put", status: null, code: "", message: "Create: dns" },
  ];
  const message = (kind: ActivityLogDeployOutcome["kind"]) => {
    const o = OUTCOMES.find((x) => x.kind === kind);
    if (o === undefined) throw new Error(kind);
    return activityLogOutcomeMessage(o);
  };

  it("only a write carries the delivery caveat, and every refusal says nothing was written", () => {
    for (const o of OUTCOMES) {
      const m = activityLogOutcomeMessage(o);
      const wrote = o.kind === "written-and-read-back" || o.kind === "accepted-not-verified";
      expect(m.text.includes(ACTIVITY_LOG_DELIVERY_NOT_VERIFIED), o.kind).toBe(wrote);
      const refused = ["already-exists", "present-differs", "possible-duplicate", "limit-reached"].includes(o.kind);
      expect(m.text.startsWith("Nothing was written:"), o.kind).toBe(refused);
    }
  });

  it("says each outcome in plain words", () => {
    expect(message("written-and-read-back").tone).toBe("info");
    expect(message("accepted-not-verified").text).toContain("did not confirm it: logs: expected all, found some.");
    expect(message("present-differs").text).toContain("eventHubName: expected (none), found h.");
    expect(message("possible-duplicate").text).toContain("every event would arrive twice: legacy.");
    expect(message("limit-reached").text).toContain("already has 5 diagnostic settings, the most Azure allows (a, b, c, d, e).");
    expect(message("denied")).toEqual({
      tone: "error",
      text: "Deploy stopped at listing the subscription's diagnostic settings. List: HTTP 403 - no",
    });
    expect(message("failed").text).toBe("Deploy stopped at creating the diagnostic setting. Create: dns");
  });

  it("carries no project history", () => {
    const texts = OUTCOMES.map((o) => activityLogOutcomeMessage(o).text);
    expect(findHistoryInCopy(texts.map((text, i) => ({ where: `outcome#${i}`, text })))).toEqual([]);
  });
});
