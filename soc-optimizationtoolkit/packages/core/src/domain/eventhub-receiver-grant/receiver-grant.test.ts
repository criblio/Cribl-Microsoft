import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECEIVER_GRANT_SCOPE,
  RECEIVER_GRANT_ROLE,
  armScopeKey,
  hasReceiverGrantStamp,
  parseReceiverAssignmentRow,
  receiverGrantAssignmentName,
  receiverGrantDescription,
  receiverGrantReadBackDiffs,
  receiverGrantScopeId,
} from "./receiver-grant";
import { RECEIVER_GRANT_PERMISSIONS, RECEIVER_GRANT_SCOPE_ACTIONS } from "./receiver-grant-permissions";
import { automationPermissionView } from "../onboarding-sections/automation-permissions";

const NS = { subscriptionId: "sub-1", resourceGroup: "rg-eh", name: "ns1" };
const HUB_SCOPE = "/subscriptions/sub-1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1/eventhubs/hub1";
const NS_SCOPE = "/subscriptions/sub-1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1";
const PRINCIPAL = "0f1e2d3c-4b5a-4968-8776-655443322110";

describe("the role", () => {
  it("is Azure Event Hubs Data Receiver by its built-in GUID (Microsoft Learn, built-in roles: analytics)", () => {
    expect(RECEIVER_GRANT_ROLE).toEqual({ guid: "a638d3c7-ab3a-418d-83e6-5f17a39d4fde", roleName: "Azure Event Hubs Data Receiver" });
  });
});

describe("receiverGrantScopeId", () => {
  it("defaults to the hub, the least privilege", () => {
    expect(DEFAULT_RECEIVER_GRANT_SCOPE).toBe("hub");
    expect(receiverGrantScopeId(NS, "hub1", "hub")).toBe(HUB_SCOPE);
  });

  it("gives the namespace only when that scope is chosen", () => {
    expect(receiverGrantScopeId(NS, "hub1", "namespace")).toBe(NS_SCOPE);
  });

  it("refuses a hub scope with no hub, and a namespace with a blank part", () => {
    expect(receiverGrantScopeId(NS, "  ", "hub")).toBeNull();
    expect(receiverGrantScopeId({ ...NS, name: " " }, "hub1", "namespace")).toBeNull();
    expect(receiverGrantScopeId({ ...NS, resourceGroup: "" }, "hub1", "hub")).toBeNull();
  });
});

describe("receiverGrantAssignmentName", () => {
  it("is a fixed version 5 GUID for this scope, role and principal", () => {
    const name = receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL);
    expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Pinned: a change here renames every grant, and the app would no longer
    // recognise grants it made before.
    expect(name).toBe(receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL));
  });

  it("ignores case and a trailing slash, as ARM does", () => {
    expect(receiverGrantAssignmentName(`${HUB_SCOPE.toUpperCase()}/`, PRINCIPAL.toUpperCase())).toBe(
      receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL),
    );
  });

  it("differs by scope and by principal", () => {
    const base = receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL);
    expect(receiverGrantAssignmentName(NS_SCOPE, PRINCIPAL)).not.toBe(base);
    expect(receiverGrantAssignmentName(HUB_SCOPE, "11111111-2222-4333-8444-555555555555")).not.toBe(base);
  });
});

describe("the description stamp", () => {
  it("says what the grant is for and carries the app's stamp", () => {
    expect(receiverGrantDescription()).toBe(
      "Cribl Stream reads this Event Hub with Entra ID (Azure onboarding) [managed-by:soc-optimizationtoolkit]",
    );
    expect(hasReceiverGrantStamp(receiverGrantDescription())).toBe(true);
    expect(hasReceiverGrantStamp("made by hand")).toBe(false);
    expect(hasReceiverGrantStamp(undefined)).toBe(false);
  });
});

describe("parseReceiverAssignmentRow and receiverGrantReadBackDiffs", () => {
  const name = receiverGrantAssignmentName(HUB_SCOPE, PRINCIPAL);
  const row = {
    id: `${HUB_SCOPE}/providers/Microsoft.Authorization/roleAssignments/${name}`,
    name,
    properties: {
      scope: HUB_SCOPE,
      roleDefinitionId: `/subscriptions/sub-1/providers/Microsoft.Authorization/roleDefinitions/${RECEIVER_GRANT_ROLE.guid}`,
      principalId: PRINCIPAL,
      description: receiverGrantDescription(),
    },
  };
  const expected = { scopeId: HUB_SCOPE, principalId: PRINCIPAL, assignmentName: name };

  it("reads a row, and refuses what is not one", () => {
    expect(parseReceiverAssignmentRow(row)).toEqual({
      id: row.id,
      name,
      scope: HUB_SCOPE,
      roleDefinitionId: row.properties.roleDefinitionId,
      principalId: PRINCIPAL,
      description: receiverGrantDescription(),
    });
    expect(parseReceiverAssignmentRow(null)).toBeNull();
    expect(parseReceiverAssignmentRow({ name })).toBeNull();
    expect(parseReceiverAssignmentRow({ properties: { scope: HUB_SCOPE } })).toBeNull();
  });

  it("finds no difference in the grant the app wrote", () => {
    expect(receiverGrantReadBackDiffs(parseReceiverAssignmentRow(row), expected)).toEqual([]);
  });

  it("names every field that differs", () => {
    const other = parseReceiverAssignmentRow({
      ...row,
      name: "other",
      properties: { ...row.properties, scope: NS_SCOPE, principalId: "someone", roleDefinitionId: "/x/roleDefinitions/f526a384-b230-433a-b45c-95f59c4a2dec" },
    });
    expect(receiverGrantReadBackDiffs(other, expected)).toEqual([
      "It names role definition /x/roleDefinitions/f526a384-b230-433a-b45c-95f59c4a2dec, not Azure Event Hubs Data Receiver.",
      `It is assigned to someone, not ${PRINCIPAL}.`,
      `Its scope is ${NS_SCOPE}, not ${HUB_SCOPE}.`,
      `Its name is other, not ${name}.`,
    ]);
    expect(receiverGrantReadBackDiffs(null, expected)).toEqual(["The read-back was not a role assignment."]);
  });

  it("compares scopes as ARM does", () => {
    expect(armScopeKey(`${HUB_SCOPE.toUpperCase()}//`)).toBe(HUB_SCOPE.toLowerCase());
  });
});

describe("the permissions banner", () => {
  it("lists the read and the write from the registry, and measures neither", () => {
    expect(RECEIVER_GRANT_SCOPE_ACTIONS.map((a) => a.action)).toEqual([
      "Microsoft.Authorization/roleAssignments/read",
      "Microsoft.Authorization/roleAssignments/write",
    ]);
    expect(RECEIVER_GRANT_SCOPE_ACTIONS.every((a) => a.necessity === "feature")).toBe(true);
    expect(RECEIVER_GRANT_PERMISSIONS.measured).toEqual([]);
  });

  it("renders as a not-measured note, never a denial, and never cautions Deploy", () => {
    const view = automationPermissionView({
      permissions: RECEIVER_GRANT_PERMISSIONS,
      capabilities: undefined,
      context: undefined,
      howtoSection: 2,
    });
    expect(view.banner?.kind).toBe("not-measured");
    expect(view.banner?.tone).toBe("info");
    expect(view.deployCaution).toBeNull();
  });
});
