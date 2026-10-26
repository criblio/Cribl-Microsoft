// Pins for the ownership recogniser (AZR-19, U1b). Ownership is ranked
// evidence; createdBy is never evidence (ADR 0006).

import { describe, expect, it } from "vitest";

import type { PolicyAssignment } from "./logging-map-types";
import {
  LEGACY_WRITER,
  TOOLKIT_MARKER_KEY,
  assignmentScopeKind,
  definitionMatches,
  recogniseOwner,
} from "./ownership";

const MG = "/providers/Microsoft.Management/managementGroups/mg-alpha";
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000001";
const ALLLOGS = LEGACY_WRITER.builtInSetIds.allLogs;
const AUDIT = LEGACY_WRITER.builtInSetIds.audit;
const ACTIVITY = LEGACY_WRITER.activityLogBuiltInId;
const LEGACY_UAI =
  `${SUB}/resourceGroups/rg-cribl/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cribl-diag-policy-identity`;

function assignment(over: Partial<PolicyAssignment> = {}): PolicyAssignment {
  return {
    id: `${MG}/providers/Microsoft.Authorization/policyAssignments/${over.name ?? "x"}`,
    name: "x",
    displayName: "",
    scope: MG,
    policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/aaaa",
    definitionKind: "policy",
    notScopes: [],
    parameters: {},
    metadata: {},
    identity: { type: "None", principalId: null, userAssigned: [] },
    enforcementMode: "Default",
    resourceSelectors: [],
    ...over,
  };
}

const kinds = (a: PolicyAssignment): string[] => recogniseOwner(a).evidence.map((e) => e.kind);

describe("recogniseOwner", () => {
  it("does not treat metadata.createdBy as ownership (the card default it corrects)", () => {
    const a = assignment({
      name: "Deploy-Diag-Team",
      metadata: { createdBy: "11111111-2222-3333-4444-555555555555", createdOn: "2026-01-01T00:00:00Z" },
    });
    const o = recogniseOwner(a);
    expect(o.owner).toBe("other");
    expect(o.strength).toBe("none");
    expect(o.evidence).toEqual([]);
  });

  it("Cribl-AL-Central at a management group with the AllLogs set is legacy-strong", () => {
    const o = recogniseOwner(assignment({ name: "Cribl-AL-Central", policyDefinitionId: ALLLOGS, definitionKind: "set" }));
    expect(o.owner).toBe("ours");
    expect(o.strength).toBe("legacy-strong");
    expect(o.evidence.map((e) => [e.kind, e.family])).toEqual([["legacy-strong", "built-in-alllogs"]]);
  });

  it("the same name set on a subscription is name-only plus a shape mismatch", () => {
    const o = recogniseOwner(
      assignment({ name: "Cribl-AL-Central", scope: SUB, policyDefinitionId: ALLLOGS, definitionKind: "set" }),
    );
    expect(o.strength).toBe("name-only");
    expect(kinds(assignment({ name: "Cribl-AL-Central", scope: SUB, policyDefinitionId: ALLLOGS }))).toEqual([
      "name-only",
      "legacy-shape-mismatch",
    ]);
    expect(o.evidence[1]?.detail).toContain("subscription scope");
  });

  it("a legacy name carrying notScopes is capped at name-only", () => {
    const o = recogniseOwner(
      assignment({ name: "Cribl-AL-Central", policyDefinitionId: ALLLOGS, notScopes: [SUB] }),
    );
    expect(o.strength).toBe("name-only");
    expect(kinds(assignment({ name: "Cribl-AL-Central", policyDefinitionId: ALLLOGS, notScopes: [SUB] }))).toEqual([
      "name-only",
      "legacy-shape-mismatch",
    ]);
  });

  it("pairs AL with AllLogs and AU with Audit, not crosswise", () => {
    expect(recogniseOwner(assignment({ name: "Cribl-AU-eastus", policyDefinitionId: AUDIT })).strength).toBe(
      "legacy-strong",
    );
    expect(recogniseOwner(assignment({ name: "Cribl-AU-eastus", policyDefinitionId: ALLLOGS })).strength).toBe(
      "name-only",
    );
  });

  it("Cribl-ActivityLog with the 4dabf6eb built-in at a management group is legacy-strong", () => {
    const o = recogniseOwner(assignment({ name: "Cribl-ActivityLog", policyDefinitionId: ACTIVITY }));
    expect(o.strength).toBe("legacy-strong");
    expect(o.evidence[0]?.family).toBe("supplemental-activity-log");
  });

  it("Cribl-ActivityLog with the community definition at the MG is legacy-strong", () => {
    const def = `${MG}/providers/Microsoft.Authorization/policyDefinitions/Cribl-Community-ActivityLog-DiagSettings-EventHub`;
    expect(recogniseOwner(assignment({ name: "Cribl-ActivityLog", policyDefinitionId: def })).strength).toBe(
      "legacy-strong",
    );
  });

  it("Cribl-ActivityLog with an unrelated definition is not strong", () => {
    expect(
      recogniseOwner(
        assignment({
          name: "Cribl-ActivityLog",
          policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/2465583e-4e78-4c15-b6be-a36cbc7c8b0f",
        }),
      ).strength,
    ).toBe("name-only");
  });

  it("community initiative and storage families are recognised with their MG definitions", () => {
    const set = `${MG}/providers/Microsoft.Authorization/policySetDefinitions/Cribl-DiagSettings-EventHub`;
    expect(recogniseOwner(assignment({ name: "Cribl-Diag-EH-Central", policyDefinitionId: set })).strength).toBe(
      "legacy-strong",
    );
    const blob = `${MG}/providers/Microsoft.Authorization/policyDefinitions/Cribl-BlobServices-DiagSettings-EventHub`;
    expect(recogniseOwner(assignment({ name: "Cribl-Blob-Central", policyDefinitionId: blob })).strength).toBe(
      "legacy-strong",
    );
    // A built-in-located id with the custom NAME is not the legacy definition.
    const misplaced = "/providers/Microsoft.Authorization/policyDefinitions/Cribl-BlobServices-DiagSettings-EventHub";
    expect(recogniseOwner(assignment({ name: "Cribl-Blob-Central", policyDefinitionId: misplaced })).strength).toBe(
      "name-only",
    );
  });

  it("the toolkit marker outranks everything, and evidence order is exact", () => {
    const a = assignment({
      name: "Cribl-Diag-EH-Central",
      scope: SUB,
      parameters: { profileName: "setbycriblpolicy" },
      metadata: { [TOOLKIT_MARKER_KEY]: { version: "1.13.0" }, createdBy: "someone" },
      identity: { type: "UserAssigned", principalId: null, userAssigned: [{ id: LEGACY_UAI, principalId: "p" }] },
    });
    const o = recogniseOwner(a);
    expect(o.strength).toBe("toolkit-marker");
    expect(o.evidence.map((e) => e.kind)).toEqual([
      "toolkit-marker",
      "legacy-identity",
      "name-only",
      "legacy-shape-mismatch",
      "diagnostic-setting-name-hint",
    ]);
  });

  it("a malformed marker (no version) is not evidence", () => {
    const o = recogniseOwner(assignment({ name: "Other", metadata: { [TOOLKIT_MARKER_KEY]: { v: 1 } } }));
    expect(o.owner).toBe("other");
  });

  it("the legacy identity alone makes it ours at legacy-identity strength", () => {
    const o = recogniseOwner(
      assignment({
        name: "Team-Diag-Legacy",
        identity: {
          type: "UserAssigned",
          principalId: null,
          userAssigned: [{ id: LEGACY_UAI.toUpperCase(), principalId: null }],
        },
      }),
    );
    expect(o.owner).toBe("ours");
    expect(o.strength).toBe("legacy-identity");
  });

  it("a wrong-scope legacy name with the legacy identity is still capped at name-only", () => {
    const o = recogniseOwner(
      assignment({
        name: "Cribl-AL-Central",
        scope: SUB,
        policyDefinitionId: ALLLOGS,
        definitionKind: "set",
        identity: { type: "UserAssigned", principalId: null, userAssigned: [{ id: LEGACY_UAI, principalId: "p" }] },
      }),
    );
    expect(o.owner).toBe("ours");
    expect(o.strength).toBe("name-only");
    // The identity stays visible as evidence; only the strength is capped.
    expect(o.evidence.map((e) => e.kind)).toEqual(["legacy-identity", "name-only", "legacy-shape-mismatch"]);
  });

  it("the setbycriblpolicy hint alone is never enough", () => {
    const o = recogniseOwner(assignment({ name: "Team-Diag", parameters: { diagnosticSettingName: "SetByCriblPolicy" } }));
    expect(o.owner).toBe("other");
    expect(o.evidence.map((e) => e.kind)).toEqual(["diagnostic-setting-name-hint"]);
  });

  it("an unrecognised Cribl-* name is a case-insensitive name match", () => {
    const o = recogniseOwner(assignment({ name: "cribl-something-else" }));
    expect(o.strength).toBe("name-only");
    expect(o.evidence.map((e) => [e.kind, e.family])).toEqual([["name-only", null]]);
  });
});

describe("assignmentScopeKind and definitionMatches", () => {
  it("classifies scope ids", () => {
    expect(assignmentScopeKind(MG.toUpperCase())).toBe("management-group");
    expect(assignmentScopeKind(SUB)).toBe("subscription");
    expect(assignmentScopeKind(`${SUB}/resourceGroups/rg1`)).toBe("resource-group");
    expect(assignmentScopeKind(`${SUB}/resourceGroups/rg1/providers/Microsoft.Web/sites/a`)).toBe("resource");
    expect(assignmentScopeKind("")).toBe("unknown");
  });

  it("a set matcher does not match a single-definition id with the same name", () => {
    const m = LEGACY_WRITER.families[0]!.definitions[0]!;
    expect(definitionMatches(m, ALLLOGS)).toBe(true);
    expect(definitionMatches(m, ALLLOGS.replace("policySetDefinitions", "policyDefinitions"))).toBe(false);
    expect(definitionMatches(m, `${MG}${ALLLOGS}`)).toBe(false);
  });
});
