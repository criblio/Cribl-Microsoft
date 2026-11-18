import { describe, expect, it } from "vitest";
import { entraCategoriesFor, parseDiagnosticSettings } from "@soc/core";
import type { EntraSettingState } from "@soc/core";
import {
  entraDeployDisabledReason,
  entraOutcomeMessage,
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
};

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
