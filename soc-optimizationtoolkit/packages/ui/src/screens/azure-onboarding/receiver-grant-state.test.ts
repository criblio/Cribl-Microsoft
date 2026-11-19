/**
 * AZR-103: the Data Receiver grant panel's pure decisions. Exact strings,
 * because the confirm is the operator's only description of the write.
 */

import { describe, expect, it } from "vitest";
import { defaultPlanValues } from "@soc/core";
import type { ApplyReceiverGrantOutcome, PlanValues, ReadyReceiverGrant } from "@soc/core";
import {
  RECEIVER_GRANT_PROPAGATION_NOTE,
  receiverGrantArmKey,
  receiverGrantConfirmText,
  receiverGrantOutcomeMessage,
  receiverGrantPlanMessages,
  receiverGrantScopeOptions,
  receiverGrantToRerecord,
} from "./receiver-grant-state";

const NS = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns1";
const HUB = `${NS}/eventhubs/hub1`;
const P = "0f1e2d3c-4b5a-4968-8776-655443322110";

function values(over: Partial<PlanValues> = {}): PlanValues {
  return { ...defaultPlanValues({ subscriptionId: "s", resourceGroup: "rg" }), namespace: "ns1", hubName: "hub1", ...over };
}

function ready(over: Partial<ReadyReceiverGrant> = {}): ReadyReceiverGrant {
  return {
    scopeChoice: "hub",
    scopeId: HUB,
    namespace: { subscriptionId: "s", resourceGroup: "rg", name: "ns1" },
    hubName: "hub1",
    principal: { objectId: P, source: "typed-matched", displayName: "cribl-reader", clientId: "client-1" },
    roleName: "Azure Event Hubs Data Receiver",
    roleDefinitionGuid: "a638d3c7-ab3a-418d-83e6-5f17a39d4fde",
    assignmentName: "9b1c0f2e-1111-5222-8333-444444444444",
    description: "d",
    existing: { kind: "read" },
    notes: [],
    ...over,
  };
}

describe("receiverGrantScopeOptions", () => {
  it("offers the hub first and the namespace second; the hub is off when the plan names none", () => {
    expect(receiverGrantScopeOptions(values()).map((o) => [o.value, o.label, o.disabledReason])).toEqual([
      ["hub", "The hub hub1 (least privilege)", null],
      [
        "namespace",
        "The namespace ns1: every hub in it, including the hubs Azure creates itself (choose this for the diagnostic-settings sources)",
        null,
      ],
    ]);
    expect(receiverGrantScopeOptions(values({ hubName: " " }))[0]?.disabledReason).toBe("The plan names no hub.");
  });
});

describe("receiverGrantArmKey", () => {
  it("changes with the scope, every value the grant reads, and the read counter - not with an unrelated value", () => {
    const base = receiverGrantArmKey("hub", values(), 1);
    expect(receiverGrantArmKey("namespace", values(), 1)).not.toBe(base);
    expect(receiverGrantArmKey("hub", values(), 2)).not.toBe(base);
    expect(receiverGrantArmKey("hub", values({ criblPrincipalObjectId: P }), 1)).not.toBe(base);
    expect(receiverGrantArmKey("hub", values({ criblClientId: "x" }), 1)).not.toBe(base);
    expect(receiverGrantArmKey("hub", values({ hubName: "hub2" }), 1)).not.toBe(base);
    expect(receiverGrantArmKey("hub", values({ consumerGroup: "other" }), 1)).toBe(base);
  });
});

describe("receiverGrantConfirmText", () => {
  it("quotes the role and its GUID, the principal, the scope id and the assignment name", () => {
    expect(receiverGrantConfirmText(ready())).toBe(
      "Assign the role Azure Event Hubs Data Receiver (role definition a638d3c7-ab3a-418d-83e6-5f17a39d4fde) to the service principal " +
        `object ID ${P} (cribl-reader), which the directory confirms is client ID client-1, at the hub hub1 in namespace ns1: ` +
        `scope ${HUB}? The assignment is named 9b1c0f2e-1111-5222-8333-444444444444. This creates one role assignment in Azure.`,
    );
  });

  it("names the namespace scope and an unconfirmed principal plainly", () => {
    const text = receiverGrantConfirmText(
      ready({
        scopeChoice: "namespace",
        scopeId: NS,
        hubName: "",
        principal: { objectId: P, source: "typed-not-cross-checked", displayName: "", clientId: "" },
      }),
    );
    expect(text).toContain(`object ID ${P}, as typed in the plan values (not checked against a client ID), at the namespace ns1 (every hub in it): scope ${NS}?`);
  });
});

describe("receiverGrantPlanMessages", () => {
  it("says already granted, and whether this app made it, with nothing else to do", () => {
    const lines = receiverGrantPlanMessages({
      kind: "already-granted",
      scopeId: HUB,
      principal: ready().principal,
      existing: { roleName: "Azure Event Hubs Data Receiver", scope: NS, assignmentName: "n", madeByThisApp: false },
      notes: [],
    });
    expect(lines).toEqual([
      {
        tone: "info",
        text: `Already granted: the principal holds Azure Event Hubs Data Receiver at ${NS}, which covers this scope. There is nothing to grant.`,
      },
    ]);
  });

  it("warns that an unread listing cannot see an inherited grant", () => {
    const lines = receiverGrantPlanMessages({ kind: "ready", ready: ready({ existing: { kind: "unread", message: "403" } }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tone).toBe("warning");
    expect(lines[0]?.text).toContain("could not be read (403)");
  });

  it("prefixes a refusal", () => {
    expect(receiverGrantPlanMessages({ kind: "refused", reason: "no-hub", detail: "D." })).toEqual([
      { tone: "warning", text: "Nothing can be granted yet. D." },
    ]);
  });
});

describe("receiverGrantOutcomeMessage", () => {
  const record = { scopeId: HUB, principalId: P, assignmentName: "n" };
  it("reports a grant with the propagation caveat, and says when the record was not saved", () => {
    const granted: ApplyReceiverGrantOutcome = { kind: "granted", record };
    expect(receiverGrantOutcomeMessage(granted, true)).toEqual({
      tone: "info",
      text: `The role assignment was created and read back from Azure. ${RECEIVER_GRANT_PROPAGATION_NOTE}`,
    });
    const unsaved = receiverGrantOutcomeMessage(granted, false);
    expect(unsaved.tone).toBe("warning");
    expect(unsaved.text).toContain("will not offer to remove it");
  });

  it("reports a refusal as an error with Azure's message", () => {
    expect(
      receiverGrantOutcomeMessage({ kind: "denied", step: "assignment-put", status: 403, code: "AuthorizationFailed", message: "M" }, true),
    ).toEqual({ tone: "error", text: "The grant stopped: M" });
  });
});

describe("receiverGrantToRerecord", () => {
  const made = (over: { scope?: string; madeByThisApp?: boolean } = {}) =>
    ({
      kind: "already-granted",
      scopeId: HUB,
      principal: ready().principal,
      existing: { roleName: "Azure Event Hubs Data Receiver", scope: over.scope ?? HUB, assignmentName: "n1", madeByThisApp: over.madeByThisApp ?? true },
      notes: [],
    }) as const;

  it("returns the record for this app's assignment at exactly this scope when none is held", () => {
    expect(receiverGrantToRerecord(made(), [])).toEqual({ scopeId: HUB, principalId: P, assignmentName: "n1" });
    // A record for another principal at the same scope does not count.
    expect(receiverGrantToRerecord(made(), [{ scopeId: HUB, principalId: "other", assignmentName: "x" }])).toEqual({
      scopeId: HUB,
      principalId: P,
      assignmentName: "n1",
    });
  });

  it("returns null when the record is held (case and trailing slash ignored), above the scope, someone else's, or not already granted", () => {
    expect(receiverGrantToRerecord(made(), [{ scopeId: `${HUB.toUpperCase()}/`, principalId: P.toUpperCase(), assignmentName: "n1" }])).toBeNull();
    expect(receiverGrantToRerecord(made({ scope: NS }), [])).toBeNull();
    expect(receiverGrantToRerecord(made({ madeByThisApp: false }), [])).toBeNull();
    expect(receiverGrantToRerecord({ kind: "ready", ready: ready() }, [])).toBeNull();
  });
});
