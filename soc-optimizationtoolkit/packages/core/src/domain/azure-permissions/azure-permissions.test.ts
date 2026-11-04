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
  coreGranted,
  evaluatePermissions,
  hasEffectiveAction,
  missingFeatureActions,
  REQUIRED_ACTIONS,
} from "./index";
import { LEAST_PRIVILEGE_OPERATIONS, leastRoleFor, operationAction } from "../least-privilege";
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
    // RE-PINNED 2026-10-27 (CAP-7a) from allGranted to coreGranted plus an
    // exact missing list. The path now carries the Defender export's
    // automations/write as a `feature` check, which '*/read' cannot grant, so
    // allGranted is false for a Reader who can still do everything the path's
    // core does. The exact list keeps the pin as strong as it was: one denial,
    // and it is that write - not a read the Reader should have.
    const readResults = evaluatePermissions(
      response(READER),
      REQUIRED_ACTIONS["existing-subscription"],
    );
    expect(coreGranted(readResults)).toBe(true);
    expect(missingFeatureActions(readResults).map((r) => r.action)).toEqual([
      "Microsoft.Security/automations/write",
    ]);

    const writeResults = evaluatePermissions(
      response(READER),
      REQUIRED_ACTIONS["existing-rg"],
    );
    expect(allGranted(writeResults)).toBe(false);
    // Every existing-rg action is a write, so none are granted by '*/read'.
    expect(writeResults.every((r) => !r.granted)).toBe(true);
  });

  it("an identity with no Microsoft.Security access is still ready on existing-subscription", () => {
    // CAP-7a. The Defender actions are measured on this path and reported, and
    // must never turn the path's readiness false: an operator who can read DCRs
    // and workspaces but has no Security role is exactly as ready as before.
    const discoveryOnly = permSet({
      actions: [
        "Microsoft.Insights/dataCollectionRules/read",
        "Microsoft.OperationalInsights/workspaces/read",
      ],
    });
    const results = evaluatePermissions(
      response(discoveryOnly),
      REQUIRED_ACTIONS["existing-subscription"],
    );
    expect(coreGranted(results)).toBe(true);
    expect(missingFeatureActions(results).map((r) => r.action)).toEqual([
      "Microsoft.Security/pricings/read",
      "Microsoft.Security/automations/read",
      "Microsoft.Security/automations/write",
    ]);
  });

  it("Contributor satisfies the CORE actions of existing-rg, and NOT of lab-byo-rg", () => {
    // RE-PINNED (AZR-61 audit, medium): lab-byo-rg's roleAssignments/write is
    // CORE now. The lab assigns its TTL identity Contributor in both
    // resource-group modes and aborts when it cannot, so Contributor alone
    // cannot deploy a byo lab - the preflight used to say it could.
    // RE-PINNED 2026-08-11 from allGranted to coreGranted, deliberately. Both
    // paths gained a `feature` check for roleAssignments/write, which
    // Contributor explicitly denies (see the next pin) - so allGranted is now
    // false for a role that can still deploy everything these paths deploy.
    // Widening the claim to allGranted would say Contributor is insufficient,
    // which is exactly the blunt answer the core/feature split exists to avoid.
    expect(
      coreGranted(
        evaluatePermissions(
          response(CONTRIBUTOR),
          REQUIRED_ACTIONS["existing-rg"],
        ),
      ),
    ).toBe(true);
    expect(
      coreGranted(
        evaluatePermissions(
          response(CONTRIBUTOR),
          REQUIRED_ACTIONS["lab-byo-rg"],
        ),
      ),
    ).toBe(false);
  });

  it("Contributor is DENIED the DCR ingestion grant on existing-rg", () => {
    // The other half of the re-pin above, and the fact that made the checks
    // worth adding: Contributor cannot assign roles at any scope, so data never
    // flows through a deployed DCR until someone else grants Cribl's identity
    // Monitoring Metrics Publisher on it. Reported, never gating.
    for (const path of ["existing-rg"] as const) {
      const results = evaluatePermissions(
        response(CONTRIBUTOR),
        REQUIRED_ACTIONS[path],
      );
      const missing = missingFeatureActions(results);
      expect(missing.map((r) => r.action), path).toContain(
        "Microsoft.Authorization/roleAssignments/write",
      );
      // Missing an optional action must never read as "not deployable".
      expect(coreGranted(results), path).toBe(true);
    }
  });

  it("Contributor DOES satisfy the Sentinel content actions on existing-rg", () => {
    // Contributor is '*' minus Microsoft.Authorization writes, so it covers
    // Microsoft.SecurityInsights - which is why the change-request plan does not
    // ask a Contributor-holding path for Sentinel Contributor on top.
    const results = evaluatePermissions(
      response(CONTRIBUTOR),
      REQUIRED_ACTIONS["existing-rg"],
    );
    const byAction = new Map(results.map((r) => [r.action, r.granted]));
    expect(byAction.get("Microsoft.SecurityInsights/alertRules/write")).toBe(true);
    expect(byAction.get("Microsoft.SecurityInsights/onboardingStates/write")).toBe(
      true,
    );
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
        { action: "a", label: "A", granted: true, necessity: "core" },
        { action: "b", label: "B", granted: false, necessity: "core" },
      ]),
    ).toBe(false);
  });
});

describe("AZR-61 - REQUIRED_ACTIONS reads the least-privilege registry", () => {
  const registryActions = new Set(
    Object.values(LEAST_PRIVILEGE_OPERATIONS).map((op) => op.operation),
  );

  it("checks only actions some registry operation needs, apart from one deferred row", () => {
    // deployments/write: nothing in the app calls it (audit, medium). It stays
    // until the arm.deploy capability the Labs route is gated on has another
    // measurement - removing it today would leave that capability unmeasured.
    const allowed = new Set(["Microsoft.Resources/deployments/write"]);
    for (const [path, actions] of Object.entries(REQUIRED_ACTIONS)) {
      for (const { action } of actions) {
        expect(registryActions.has(action) || allowed.has(action), `${path}: ${action}`).toBe(true);
      }
    }
  });

  it("names, in a label, only the role the registry gives for that action", () => {
    for (const actions of Object.values(REQUIRED_ACTIONS)) {
      for (const { action, label } of actions) {
        const named = /\(([^,)]+)/.exec(label)?.[1];
        if (named === undefined) {
          continue;
        }
        const roles = Object.values(LEAST_PRIVILEGE_OPERATIONS)
          .filter((op) => op.operation === action)
          .map((op) => op.leastRole);
        // onboardingStates/write is the deliberate exception, reported: the
        // audit names subscription Contributor (Microsoft documents it) but
        // flags Sentinel Contributor at the resource group as untested, so the
        // label keeps the role the ticket asks for until it is measured live.
        const sentinel = leastRoleFor("sentinel.alertRule.write");
        const onboarding = action === operationAction("sentinel.onboardingState.write");
        expect(roles.includes(named) || (onboarding && named === sentinel), `${action}: ${named}`).toBe(true);
      }
    }
  });

  it("gates lab-byo-rg on the TTL role assignment (audit, medium)", () => {
    const grant = REQUIRED_ACTIONS["lab-byo-rg"].find(
      (a) => a.action === operationAction("lab.roleAssignment.write"),
    );
    expect(grant?.necessity ?? "core").toBe("core");
    expect(grant?.label).toContain("TTL");
  });
});
