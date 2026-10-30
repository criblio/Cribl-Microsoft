// Provenance pins for the logging-map port of the legacy writer (AZR-19, U1b).
//
// ownership.ts and logging-classifier.ts claim to be PORTED from the
// deprecated Azure-LogCollection scripts, not invented. These pins read the
// FROZEN copies under ./legacy (the DBT-132 precedent in
// ../coverage-model/coverage-model.test.ts) and prove each ported literal is
// really there. A missing frozen copy throws: a provenance pin that skips when
// its evidence vanishes proves nothing.
//
// Reading the filesystem is fine in a test: @soc/core's purity rule is about
// the shipped module, and the architecture audit exempts *.test.ts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { KNOWN_BUILT_IN_DESTINATIONS } from "./logging-classifier";
import { LEGACY_IDENTITY_ROLES, LEGACY_WRITER } from "./ownership";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = {
  builtIn: "Deploy-BuiltInPolicyInitiatives.ps1",
  community: "Deploy-CommunityPolicyInitiative.ps1",
  supplemental: "Deploy-SupplementalPolicies.ps1",
} as const;
const ORIGINAL_DIR = join(HERE, "..", "..", "..", "..", "..", "..", "deprecated", "Azure", "Azure-LogCollection", "core");
const COVERAGE_JSON = join(HERE, "..", "coverage-model", "legacy", "resource-coverage.json");

function frozen(file: string): string {
  const path = join(HERE, "legacy", file);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `The ported-from source is missing: ${path}\n` +
        "ownership.ts (LEGACY_WRITER) claims to be a port of it (AZR-19). Either restore " +
        "the file, or delete these provenance pins AND the 'ported, not invented' claim " +
        "together - the claim must not outlive its evidence.",
    );
  }
}

const builtIn = frozen(FILES.builtIn);
const community = frozen(FILES.community);
const supplemental = frozen(FILES.supplemental);
const all = `${builtIn}\n${community}\n${supplemental}`;

describe("the frozen legacy copies", () => {
  for (const file of Object.values(FILES)) {
    const original = join(ORIGINAL_DIR, file);
    it.runIf(existsSync(original))(`${file} is byte-for-byte the ported-from file`, () => {
      expect(readFileSync(join(HERE, "legacy", file))).toEqual(readFileSync(original));
    });
  }
});

describe("LEGACY_WRITER literals appear in the frozen files", () => {
  it("the built-in set ids", () => {
    expect(builtIn).toContain(`PolicySetDefinitionId = "${LEGACY_WRITER.builtInSetIds.allLogs}"`);
    expect(builtIn).toContain(`PolicySetDefinitionId = "${LEGACY_WRITER.builtInSetIds.audit}"`);
  });

  it("the name families", () => {
    expect(builtIn).toContain('"AllLogs" { "AL" }');
    expect(builtIn).toContain('"Audit" { "AU" }');
    expect(builtIn).toContain('return "Cribl-$modeAbbrev-Central"');
    expect(community).toContain('return "Cribl-Diag-EH-Central"');
    expect(community).toContain('$prefix = "Cribl-Diag-EH-"');
    expect(supplemental).toContain('AssignmentName = "Cribl-ActivityLog"');
    expect(supplemental).toContain('return "$prefix-Central"');
  });

  it("each family's sample legacy name matches only that family", () => {
    const samples: Record<string, string> = {
      "built-in-alllogs": "Cribl-AL-Central",
      "built-in-audit": "Cribl-AU-Central",
      "community-initiative": "Cribl-Diag-EH-Central",
      "supplemental-storage": "Cribl-Blob-Central",
      "supplemental-activity-log": "Cribl-ActivityLog",
    };
    expect(LEGACY_WRITER.families.map((f) => f.id).sort()).toEqual(Object.keys(samples).sort());
    for (const [id, name] of Object.entries(samples)) {
      expect(LEGACY_WRITER.families.filter((f) => f.name.test(name)).map((f) => f.id)).toEqual([id]);
    }
  });

  it("the community set and definition names", () => {
    expect(community).toContain(`$script:InitiativeName = "${LEGACY_WRITER.communitySetName}"`);
    expect(supplemental).toContain('$policyName = "Cribl-Community-$ServiceType-DiagSettings-EventHub"');
    expect(supplemental).toContain('$policyName = "Cribl-$ServiceType-DiagSettings-EventHub"');
    // The Activity Log community definition is the same template with ActivityLog.
    expect(supplemental).toContain('$serviceType = "ActivityLog"');
    expect(supplemental).toContain('$communityPolicyName = "Cribl-Community-$serviceType-DiagSettings-EventHub"');
  });

  it("every legacy assignment is written at management-group scope, as every family records", () => {
    const mgScope = '"/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"';
    // BuiltIn New-PolicyAssignment, Supplemental storage and Activity Log builders.
    expect(builtIn.split("\n")[559]).toContain(`$scope = ${mgScope}`);
    expect(supplemental.split("\n")[1978]).toContain(`$scope = ${mgScope}`);
    expect(supplemental.split("\n")[2129]).toContain(`$scope = ${mgScope}`);
    expect(community.split("\n")[1119]).toContain('$mgScope = "/providers/Microsoft.Management/managementGroups/$mgId"');
    expect(community).toContain("Scope = $mgScope");
    for (const f of LEGACY_WRITER.families) expect(f.scopeKind).toBe("management-group");
  });

  it("no legacy New-AzPolicyAssignment passes -Metadata (why createdBy-free recognition is needed)", () => {
    // -Metadata appears only on definition / set writes (Community:714, 1028).
    for (const text of [builtIn, supplemental]) expect(/-Metadata\b/.test(text)).toBe(false);
    const lines = community.split("\n");
    const at = lines.flatMap((l, i) => (/-Metadata\b/.test(l) ? [i] : []));
    expect(at.map((i) => i + 1)).toEqual([714, 1028]);
    // Each belongs to the definition / set cmdlet a few lines above it.
    expect(lines.slice(at[0]! - 8, at[0]).join("\n")).toContain("New-AzPolicyDefinition `");
    expect(lines.slice(at[1]! - 8, at[1]).join("\n")).toContain("New-AzPolicySetDefinition `");
    // And no assignment splat carries a Metadata key.
    expect(all.split("\n").filter((l) => /^\s*Metadata\s*=/.test(l))).toEqual([]);
  });

  it("the identity name and the diagnostic-setting hint", () => {
    expect(builtIn).toContain(`$identityName = "${LEGACY_WRITER.identityName}"`);
    expect(community).toContain(`$identityName = "${LEGACY_WRITER.identityName}"`);
    expect(supplemental).toContain(`$identityName = "${LEGACY_WRITER.identityName}"`);
    expect(builtIn).toContain(`else { "${LEGACY_WRITER.diagnosticSettingNameHint}" }`);
  });

  it("the roles granted to the identity", () => {
    expect(LEGACY_IDENTITY_ROLES.map((r) => r.roleName)).toEqual([
      "Monitoring Contributor",
      "Azure Event Hubs Data Owner",
    ]);
    for (const r of LEGACY_IDENTITY_ROLES) {
      expect(builtIn).toContain(`-RoleDefinitionName "${r.roleName}"`);
      expect(supplemental).toContain(`-RoleDefinitionName "${r.roleName}"`);
      if (r.roleDefinitionGuid !== null) expect(community).toContain(`"${r.roleDefinitionGuid}"`);
    }
  });

  it("every Supplemental AssignmentPrefix literal is matched, from a whole-file scan", () => {
    const found = [...supplemental.matchAll(/AssignmentPrefix\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    // 47 in the resource-type table (:214-277) + 4 in the storage table (:1126-1156).
    expect(found.length).toBe(51);
    const distinct = [...new Set(found)];
    expect(distinct.length).toBe(47);
    expect([...LEGACY_WRITER.resourceTypePrefixes].sort()).toEqual([...distinct].sort());
    for (const p of distinct) expect(LEGACY_WRITER.nameRule.test(`${p}-Central`)).toBe(true);
    // The storage prefixes are also in the strong storage family.
    const storage = LEGACY_WRITER.families.find((f) => f.id === "supplemental-storage")!;
    for (const p of ["Cribl-Blob", "Cribl-File", "Cribl-Queue", "Cribl-Table"]) {
      expect(storage.name.test(`${p}-Central`)).toBe(true);
    }
  });

  it("the Cribl-ActivityLog built-in id is the one resource-coverage.json declares", () => {
    const json = JSON.parse(readFileSync(COVERAGE_JSON, "utf8")) as {
      supplementalPolicies: { activityLog: { policyId: string } };
    };
    expect(LEGACY_WRITER.activityLogBuiltInId).toBe(json.supplementalPolicies.activityLog.policyId);
    const fam = LEGACY_WRITER.families.find((f) => f.id === "supplemental-activity-log")!;
    const guid = json.supplementalPolicies.activityLog.policyId.split("/").pop()!;
    expect(fam.definitions.some((d) => d.location === "built-in" && d.name.test(guid))).toBe(true);
  });

  it("the short-circuited built-ins are exactly the legacy Event Hub sets", () => {
    const confirmed = [...KNOWN_BUILT_IN_DESTINATIONS].filter(([, v]) => v.confirmedLive).map(([k]) => k);
    expect(confirmed.sort()).toEqual(
      [LEGACY_WRITER.builtInSetIds.allLogs, LEGACY_WRITER.builtInSetIds.audit].map((s) => s.toLowerCase()).sort(),
    );
    expect(builtIn).toContain("# IMPORTANT: These are the Event Hub-specific initiatives");
  });

  it("the classifier's destination parameter names are the ones the legacy filled", () => {
    for (const name of ["eventHubAuthorizationRuleId", "eventHubName", "dcrResourceId"]) {
      expect(builtIn).toContain(`$paramNames -contains '${name}'`);
    }
  });
});
