import { describe, expect, it } from "vitest";
import { ENTRA_ITEM_ID, entraCategoriesFor, namespaceRuleResourceId, parseDiagnosticSettings } from "@soc/core";
import type { EntraSettingState } from "@soc/core";
import {
  ENTRA_DIFFERS_FOREIGN_ADVICE,
  ENTRA_DIFFERS_OURS_ADVICE,
  entraDeployDisabledReason,
  entraDeployedItems,
  entraOutcomeMessage,
  entraReadDisprovesRecord,
  entraRemoveDisabledReason,
  entraRemoveMessage,
  planRuleRights,
} from "./entra-setting-state";
import type { EntraDeployGate } from "./entra-setting-state";

const NS = { subscriptionId: "eh-sub", resourceGroup: "eh-rg", name: "ns" };
const INPUT = { namespace: NS, ruleName: "send", categories: entraCategoriesFor(["Standard"]) };
const LISTED_EMPTY: EntraSettingState = {
  settings: { kind: "listed", listing: parseDiagnosticSettings([]) },
  ours: { kind: "absent", measured: false },
  deployed: [],
};
const GATE: EntraDeployGate = {
  running: false,
  choice: { kind: "chosen", mode: "automate" },
  state: LISTED_EMPTY,
  tenantId: "t1",
  target: { input: INPUT, missing: [] },
  ruleRights: ["Manage", "Send", "Listen"],
  record: null,
};

/** CriblEntraIDLogs sending with the plan's rule, the chosen categories plus one extra. */
const RULE_ID = namespaceRuleResourceId(NS, "send");
const WIDER: EntraSettingState = {
  settings: {
    kind: "listed",
    listing: parseDiagnosticSettings([
      {
        id: "/providers/microsoft.aadiam/diagnosticSettings/CriblEntraIDLogs",
        name: "CriblEntraIDLogs",
        properties: {
          eventHubAuthorizationRuleId: RULE_ID,
          eventHubName: "",
          logs: [...INPUT.categories, "MicrosoftGraphActivityLogs"].map((category) => ({ category, enabled: true })),
        },
      },
    ]),
  },
  ours: { kind: "absent", measured: true },
  // The read's own target-free answer: a CriblEntraIDLogs to a namespace rule.
  deployed: [ENTRA_ITEM_ID],
};
const OUR_RECORD = { tenantId: "t1", settingName: "CriblEntraIDLogs", ruleId: RULE_ID.toUpperCase() };
const DIFFERS_PREFIX =
  "CriblEntraIDLogs exists in this tenant but differs from what this app writes: ";

describe("a differing setting: whose advice", () => {
  it("names the in-app Remove when this tenant's record names the rule the setting sends with", () => {
    const reason = entraDeployDisabledReason({ ...GATE, state: WIDER, record: OUR_RECORD });
    expect(reason?.startsWith(DIFFERS_PREFIX)).toBe(true);
    expect(reason?.endsWith(` ${ENTRA_DIFFERS_OURS_ADVICE}`)).toBe(true);
    expect(reason).not.toContain("Microsoft Entra admin center");
  });

  it("keeps the admin-center advice with no record, or a record of another rule", () => {
    for (const record of [null, { ...OUR_RECORD, ruleId: namespaceRuleResourceId(NS, "other") }]) {
      const reason = entraDeployDisabledReason({ ...GATE, state: WIDER, record });
      expect(reason?.endsWith(` ${ENTRA_DIFFERS_FOREIGN_ADVICE}`)).toBe(true);
    }
  });

  it("the deploy outcome gives the same advice", () => {
    const outcome = {
      kind: "present-differs" as const,
      settingId: "s",
      ruleId: RULE_ID,
      diffs: [{ field: "logs" as const, expected: "exactly x", actual: "enabled but not chosen: y" }],
    };
    expect(entraOutcomeMessage(outcome, OUR_RECORD).text.endsWith(` ${ENTRA_DIFFERS_OURS_ADVICE}`)).toBe(true);
    expect(entraOutcomeMessage(outcome).text.endsWith(` ${ENTRA_DIFFERS_FOREIGN_ADVICE}`)).toBe(true);
  });
});

describe("entraDeployedItems (the row label)", () => {
  it("judges against the plan's target once there is one, as the Deploy gate does", () => {
    expect(entraDeployedItems(WIDER, INPUT)).toEqual([]);
    expect(entraDeployDisabledReason({ ...GATE, state: WIDER })?.startsWith(DIFFERS_PREFIX)).toBe(true);
    const exact = { ...INPUT, categories: [...INPUT.categories, "MicrosoftGraphActivityLogs"] };
    expect(entraDeployedItems(WIDER, exact)).toEqual([ENTRA_ITEM_ID]);
  });

  it("before a target exists it is the read's own answer; unread is null", () => {
    expect(entraDeployedItems(WIDER, null)).toEqual([ENTRA_ITEM_ID]);
    expect(entraDeployedItems(null, INPUT)).toBeNull();
  });
});

describe("entraReadDisprovesRecord (forgetting a stale record)", () => {
  const RECORD = { tenantId: "t1", settingName: "CriblEntraIDLogs", ruleId: RULE_ID };
  it("a list without ours disproves a record, empty or not", () => {
    expect(entraReadDisprovesRecord(LISTED_EMPTY, RECORD)).toBe(true);
    const others: EntraSettingState = { ...LISTED_EMPTY, ours: { kind: "absent", measured: true } };
    expect(entraReadDisprovesRecord(others, RECORD)).toBe(true);
  });

  it("ours listed, an unreadable list, or no record never drops anything", () => {
    expect(entraReadDisprovesRecord(WIDER, RECORD)).toBe(false);
    expect(entraReadDisprovesRecord(LISTED_EMPTY, null)).toBe(false);
    const unread: EntraSettingState = {
      settings: { kind: "unread", failure: { kind: "denied", status: 403, code: "AuthorizationFailed", message: "no" } },
      ours: { kind: "unknown", reason: "no" },
      deployed: [],
      unknownReason: "no",
    } as unknown as EntraSettingState;
    expect(entraReadDisprovesRecord(unread, RECORD)).toBe(false);
  });
});

describe("entraDeployDisabledReason", () => {
  it("is null only when everything is in place", () => {
    expect(entraDeployDisabledReason(GATE)).toBeNull();
    // Rights not read (the operator's own names) never block: Azure decides.
    expect(entraDeployDisabledReason({ ...GATE, ruleRights: null })).toBeNull();
  });

  it("gives one reason in its fixed priority", () => {
    expect(entraDeployDisabledReason({ ...GATE, running: true, tenantId: "" })).toBe("A deploy is already running.");
    expect(entraDeployDisabledReason({ ...GATE, tenantId: " " })).toBe("No Azure tenant is configured for this connection.");
    expect(entraDeployDisabledReason({ ...GATE, choice: { kind: "chosen", mode: "manual" } })).toBe(
      "The Entra ID diagnostic setting is set to How-to, so the app does not deploy it.",
    );
    expect(entraDeployDisabledReason({ ...GATE, target: null })).toBe("The Event Hub plan values are still loading.");
    expect(entraDeployDisabledReason({ ...GATE, target: { input: null, missing: ["sendRule"] } })).toBe(
      "The plan does not name the Send rule yet. Choose them in the Event Hub section, or set them under How to set it up yourself.",
    );
    expect(entraDeployDisabledReason({ ...GATE, state: null })).toBe("Read the tenant's Entra ID diagnostic settings first.");
    expect(entraDeployDisabledReason({ ...GATE, ruleRights: ["Send"] })).toBe(
      "The rule send has Send. An Entra ID diagnostic setting needs a rule with Manage rights, because Azure creates one hub per category itself.",
    );
  });
});

describe("planRuleRights", () => {
  const picked = { namespace: NS, hubName: "h", rule: { name: "SEND", rights: ["Send"] } };
  it("reads the picked rule's rights only when it is the plan's rule on the plan's namespace", () => {
    expect(planRuleRights(picked as never, INPUT)).toEqual(["Send"]);
    expect(planRuleRights({ ...picked, namespace: { ...NS, resourceGroup: "other" } } as never, INPUT)).toBeNull();
    expect(planRuleRights({ ...picked, rule: { name: "other", rights: ["Send"] } } as never, INPUT)).toBeNull();
    expect(planRuleRights(picked as never, null)).toBeNull();
  });
});

describe("messages", () => {
  it("a denial names the directory role the app cannot check", () => {
    expect(
      entraOutcomeMessage({ kind: "denied", step: "setting-put", status: 403, code: "AuthorizationFailed", message: "x: HTTP 403 - no" }),
    ).toEqual({
      tone: "error",
      text: "Deploy stopped at creating the diagnostic setting. x: HTTP 403 - no Writing an Entra ID diagnostic setting needs the Security Administrator or Global Administrator directory role; the app cannot check that before it runs.",
    });
    expect(entraRemoveMessage({ kind: "already-gone", settingId: "s" })).toEqual({
      tone: "info",
      text: "Nothing was removed: CriblEntraIDLogs is not in this tenant.",
    });
  });

  it("Remove is off without the app's own record, and says where to remove it instead", () => {
    expect(entraRemoveDisabledReason({ running: false, tenantId: "t1", record: null })).toBe(
      "This app has no record of creating CriblEntraIDLogs in this tenant, so it does not remove it from here. Remove it in the Microsoft Entra admin center if it should go. Unchoosing Entra ID does not remove it.",
    );
    expect(entraRemoveDisabledReason({ running: false, tenantId: "t1", record: { tenantId: "t1", settingName: "CriblEntraIDLogs", ruleId: "r" } })).toBeNull();
  });
});
