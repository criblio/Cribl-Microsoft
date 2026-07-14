/**
 * Unit tests for the Azure RBAC effective-permission preflight, organized by
 * the rule each group pins:
 *   - glob matching semantics (anchoring, '*' crossing '/', case-insensitivity)
 *   - the additive-across / subtractive-within effective-permission rule
 *   - the real-world role shapes the preflight must distinguish (Owner,
 *     Contributor, Reader) against the four setup paths' required actions
 *
 * The Contributor case is load-bearing: Contributor denies
 * Microsoft.Authorization/roleAssignments/write, which is exactly why the
 * lab-new-rg path additionally requires RBAC Administrator/Owner.
 */
import { describe, expect, it } from "vitest";
import {
  actionMatchesGlob,
  allGranted,
  evaluatePermissions,
  hasEffectiveAction,
  REQUIRED_ACTIONS,
} from "./index";
import type { PermissionSet, PermissionsResponse } from "./index";

/** Build a PermissionSet, defaulting the fields a test does not care about. */
function permSet(partial: Partial<PermissionSet>): PermissionSet {
  return {
    actions: [],
    notActions: [],
    dataActions: [],
    notDataActions: [],
    ...partial,
  };
}

/** Wrap one or more permission sets as a full API response. */
function response(...sets: PermissionSet[]): PermissionsResponse {
  return { value: sets };
}

// Canonical role shapes, modeled on Azure's built-in roles.
const OWNER = permSet({ actions: ["*"], notActions: [] });
const READER = permSet({ actions: ["*/read"], notActions: [] });
const CONTRIBUTOR = permSet({
  actions: ["*"],
  notActions: [
    "Microsoft.Authorization/*/Write",
    "Microsoft.Authorization/*/Delete",
    "Microsoft.Authorization/elevateAccess/Action",
    "Microsoft.Blueprint/blueprintAssignments/write",
    "Microsoft.Blueprint/blueprintAssignments/delete",
  ],
});
// A narrow custom role that grants only role-assignment writes (e.g. RBAC
// Administrator scoped down), used to prove additivity across elements.
const ROLE_ASSIGNMENT_WRITER = permSet({
  actions: ["Microsoft.Authorization/roleAssignments/write"],
  notActions: [],
});

describe("actionMatchesGlob", () => {
  it("matches literally when there is no wildcard", () => {
    expect(
      actionMatchesGlob(
        "Microsoft.Insights/dataCollectionRules/read",
        "Microsoft.Insights/dataCollectionRules/read",
      ),
    ).toBe(true);
  });

  it("is anchored (full string), not a prefix or substring match", () => {
    expect(
      actionMatchesGlob(
        "Microsoft.Insights/dataCollectionRules",
        "Microsoft.Insights/dataCollectionRules/read",
      ),
    ).toBe(false);
    // Trailing wildcard would be needed to cover the suffix.
    expect(
      actionMatchesGlob(
        "Microsoft.Insights/dataCollectionRules/writ",
        "Microsoft.Insights/dataCollectionRules/write",
      ),
    ).toBe(false);
  });

  it("'*' matches any run of characters INCLUDING '/'", () => {
    expect(actionMatchesGlob("*", "Anything/at/all/goes")).toBe(true);
    expect(
      actionMatchesGlob(
        "Microsoft.Insights/*",
        "Microsoft.Insights/dataCollectionRules/read",
      ),
    ).toBe(true);
    // '*/read' must match a multi-segment resource path.
    expect(
      actionMatchesGlob(
        "*/read",
        "Microsoft.OperationalInsights/workspaces/read",
      ),
    ).toBe(true);
    // Interior wildcard crossing '/'.
    expect(
      actionMatchesGlob(
        "Microsoft.Authorization/*/Write",
        "Microsoft.Authorization/roleAssignments/write",
      ),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      actionMatchesGlob(
        "Microsoft.Authorization/*/Write",
        "microsoft.authorization/roleassignments/write",
      ),
    ).toBe(true);
    expect(
      actionMatchesGlob(
        "MICROSOFT.INSIGHTS/DATACOLLECTIONRULES/READ",
        "Microsoft.Insights/dataCollectionRules/read",
      ),
    ).toBe(true);
  });

  it("treats '.' as a literal, not a regex any-char", () => {
    // The '.' in the glob must not match an arbitrary character.
    expect(
      actionMatchesGlob("MicrosoftXInsights/*", "Microsoft.Insights/read"),
    ).toBe(false);
    expect(
      actionMatchesGlob("Microsoft.Insights/read", "MicrosoftXInsights/read"),
    ).toBe(false);
  });

  it("'*/read' does not match a write action", () => {
    expect(
      actionMatchesGlob(
        "*/read",
        "Microsoft.Insights/dataCollectionRules/write",
      ),
    ).toBe(false);
  });
});

describe("hasEffectiveAction - additive across, subtractive within", () => {
  it("Owner-like ['*'] grants any action", () => {
    expect(
      hasEffectiveAction(
        response(OWNER),
        "Microsoft.Authorization/roleAssignments/write",
      ),
    ).toBe(true);
  });

  it("notActions in the SAME element subtracts from actions", () => {
    expect(
      hasEffectiveAction(
        response(CONTRIBUTOR),
        "Microsoft.Authorization/roleAssignments/write",
      ),
    ).toBe(false);
    // ...but other writes remain granted by the same '*'.
    expect(
      hasEffectiveAction(
        response(CONTRIBUTOR),
        "Microsoft.Resources/deployments/write",
      ),
    ).toBe(true);
  });

  it("a notActions denial in one element does NOT cancel a grant in another", () => {
    // Contributor denies roleAssignments/write, but a second assignment
    // grants it explicitly -> effective permission is granted (additive).
    expect(
      hasEffectiveAction(
        response(CONTRIBUTOR, ROLE_ASSIGNMENT_WRITER),
        "Microsoft.Authorization/roleAssignments/write",
      ),
    ).toBe(true);
  });

  it("returns false for an empty response", () => {
    expect(
      hasEffectiveAction(response(), "Microsoft.Resources/deployments/write"),
    ).toBe(false);
  });
});

describe("evaluatePermissions / allGranted per setup path", () => {
  it("Owner grants every required action of every path", () => {
    for (const required of Object.values(REQUIRED_ACTIONS)) {
      const results = evaluatePermissions(response(OWNER), required);
      expect(results).toHaveLength(required.length);
      expect(allGranted(results)).toBe(true);
    }
  });

  it("Reader grants the read-only path but denies any write path", () => {
    const readResults = evaluatePermissions(
      response(READER),
      REQUIRED_ACTIONS["existing-subscription"],
    );
    expect(allGranted(readResults)).toBe(true);

    const writeResults = evaluatePermissions(
      response(READER),
      REQUIRED_ACTIONS["existing-rg"],
    );
    expect(allGranted(writeResults)).toBe(false);
    // Every existing-rg action is a write, so none are granted by '*/read'.
    expect(writeResults.every((r) => !r.granted)).toBe(true);
  });

  it("Contributor satisfies existing-rg and lab-byo-rg", () => {
    expect(
      allGranted(
        evaluatePermissions(
          response(CONTRIBUTOR),
          REQUIRED_ACTIONS["existing-rg"],
        ),
      ),
    ).toBe(true);
    expect(
      allGranted(
        evaluatePermissions(
          response(CONTRIBUTOR),
          REQUIRED_ACTIONS["lab-byo-rg"],
        ),
      ),
    ).toBe(true);
  });

  it("Contributor grants RG/deployment writes but DENIES roleAssignments/write for lab-new-rg (case-insensitive)", () => {
    const results = evaluatePermissions(
      response(CONTRIBUTOR),
      REQUIRED_ACTIONS["lab-new-rg-subscription"],
    );
    const byAction = new Map(results.map((r) => [r.action, r.granted]));

    // Contributor CAN create resource groups and deploy ARM.
    expect(
      byAction.get("Microsoft.Resources/subscriptions/resourceGroups/write"),
    ).toBe(true);
    expect(byAction.get("Microsoft.Resources/deployments/write")).toBe(true);

    // But the notAction 'Microsoft.Authorization/*/Write' (capital W) denies
    // the lowercase roleAssignments/write action -> this is why lab-new-rg
    // additionally requires RBAC Administrator / Owner.
    expect(
      byAction.get("Microsoft.Authorization/roleAssignments/write"),
    ).toBe(false);
    expect(allGranted(results)).toBe(false);
  });

  it("Contributor + a role-assignment writer together satisfy lab-new-rg (additivity)", () => {
    const results = evaluatePermissions(
      response(CONTRIBUTOR, ROLE_ASSIGNMENT_WRITER),
      REQUIRED_ACTIONS["lab-new-rg-subscription"],
    );
    expect(allGranted(results)).toBe(true);
  });

  it("evaluatePermissions preserves order and carries labels through", () => {
    const required = REQUIRED_ACTIONS["existing-rg"];
    const results = evaluatePermissions(response(OWNER), required);
    expect(results.map((r) => r.action)).toEqual(
      required.map((r) => r.action),
    );
    expect(results.map((r) => r.label)).toEqual(required.map((r) => r.label));
  });
});

describe("allGranted", () => {
  it("is vacuously true for an empty result list", () => {
    expect(allGranted([])).toBe(true);
  });

  it("is false when any single result is denied", () => {
    expect(
      allGranted([
        { action: "a", label: "A", granted: true },
        { action: "b", label: "B", granted: false },
      ]),
    ).toBe(false);
  });
});
