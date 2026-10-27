/**
 * Who owns a policy assignment, for the Azure Logging Map (AZR-19).
 *
 * "Ours" is shown as RANKED EVIDENCE, never collapsed to a boolean, because no
 * single fact proves it:
 *
 * - `metadata.createdBy` is NOT evidence. Azure stamps createdBy / createdOn /
 *   updatedBy / updatedOn on every policy assignment, whoever wrote it, so it
 *   cannot tell the toolkit from anyone else (ADR 0006, which corrects the
 *   AZR-19 card default).
 * - The toolkit writes no policy yet. {@link TOOLKIT_MARKER_KEY} is RESERVED:
 *   `metadata.criblSocToolkit = { version }` is what a future writer (AZR-4)
 *   must set, and the strongest evidence once it does. The How-to steps tell
 *   an operator who creates an assignment by hand to set it too
 *   (onboarding-howto-steps/policy-steps.ts, `version: "manual"`).
 * - The legacy PowerShell writer passed no `-Metadata` to any
 *   New-AzPolicyAssignment call (frozen copies in `./legacy/`), so its
 *   assignments are recognised by SHAPE: name family + definition + the scope
 *   kind it wrote them at. {@link LEGACY_WRITER} is that shape, ported - not
 *   invented - from those files and pinned against them by
 *   `legacy-provenance.test.ts`.
 *
 * Evidence ranks, strongest first: toolkit-marker > legacy-strong >
 * legacy-identity > name-only. `legacy-shape-mismatch` and the diagnostic
 * setting name hint are recorded beside them but never make an assignment ours.
 *
 * The cap: when `legacy-shape-mismatch` is recorded (a legacy name at the
 * wrong scope kind, with the wrong definition, or carrying notScopes) and no
 * toolkit marker is present, strength is capped at `name-only` - even if the
 * legacy identity is also present. The evidence array still lists every item
 * found, so the identity stays visible; only the strength is capped.
 *
 * Pure: no IO, no Date, no randomness. Domain - imports no usecase.
 */

import type { PolicyAssignment } from "./logging-map-types";
import { isManagementGroupId, isSubscriptionId, normaliseScopeId } from "./scope-tree";

/** The reserved metadata key a toolkit writer must set (ADR 0006, Accepted 2026-10-27). */
export const TOOLKIT_MARKER_KEY = "criblSocToolkit";

/** The scope kinds an assignment can be set at. */
export type AssignmentScopeKind =
  | "management-group"
  | "subscription"
  | "resource-group"
  | "resource"
  | "unknown";

/** A definition the legacy writer assigned under one name family. */
export interface LegacyDefinitionMatcher {
  /** `policy` for a single definition, `set` for an initiative. */
  readonly kind: "policy" | "set";
  /**
   * `built-in`: the id is exactly `/providers/Microsoft.Authorization/...`.
   * `management-group`: a custom definition saved at a management group.
   */
  readonly location: "built-in" | "management-group";
  /** Matches the definition NAME (the last id segment), case-insensitively. */
  readonly name: RegExp;
  /** Where in the frozen copies (or the coverage-model copy) this comes from. */
  readonly source: string;
}

/** One family of assignment names the legacy writer created. */
export interface LegacyNameFamily {
  readonly id: string;
  /** Matches the assignment `name`, case-insensitively (ARM names are). */
  readonly name: RegExp;
  readonly definitions: readonly LegacyDefinitionMatcher[];
  /** The scope kind the legacy wrote this family at. */
  readonly scopeKind: AssignmentScopeKind;
  readonly source: string;
}

/** A role the legacy writer granted its managed identity. */
export interface LegacyIdentityRole {
  readonly roleName: string;
  /** The role definition GUID, where a legacy file names it; null otherwise. */
  readonly roleDefinitionGuid: string | null;
  /** Where it was granted, in words. */
  readonly grantedAt: "management-group" | "event-hub-namespace";
  readonly source: string;
}

/** The legacy writer, as data. Frozen. */
export const LEGACY_WRITER = Object.freeze({
  /**
   * The two built-in Event Hub initiatives (BuiltIn:64-81). AllLogs is
   * assigned under Cribl-AL-*, Audit under Cribl-AU-* (BuiltIn:262-301).
   */
  builtInSetIds: Object.freeze({
    allLogs: "/providers/Microsoft.Authorization/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531",
    audit: "/providers/Microsoft.Authorization/policySetDefinitions/1020d527-2764-4230-92cc-7035e4fcf8a7",
  }),
  /**
   * The built-in Activity Log definition declared by resource-coverage.json
   * (`supplementalPolicies.activityLog.policyId`, its line 53). The
   * Supplemental script itself assigns Cribl-ActivityLog with a COMMUNITY
   * definition it imports at the management group (Supplemental:1011-1058,
   * 1164-1169), so both are accepted for that family.
   */
  activityLogBuiltInId:
    "/providers/Microsoft.Authorization/policyDefinitions/4dabf6eb-0764-4049-82c1-c6d5d781e739",
  /** The user-assigned identity every legacy assignment used (BuiltIn:343, Community:461, Supplemental:1566). */
  identityName: "cribl-diag-policy-identity",
  /** Default diagnostic setting name (BuiltIn:689, Community:1132, Supplemental:1982). A configurable HINT, never proof. */
  diagnosticSettingNameHint: "setbycriblpolicy",
  /** The community initiative's name (Community:131), saved at the management group. */
  communitySetName: "Cribl-DiagSettings-EventHub",
  families: Object.freeze<readonly LegacyNameFamily[]>([
    {
      id: "built-in-alllogs",
      name: /^Cribl-AL-.+$/i,
      definitions: [
        { kind: "set", location: "built-in", name: /^85175a36-2f12-419a-96b4-18d5b0096531$/i, source: "BuiltIn:64-72" },
      ],
      scopeKind: "management-group",
      source: "BuiltIn:262-301 (name), BuiltIn:560 and 779-790 (scope)",
    },
    {
      id: "built-in-audit",
      name: /^Cribl-AU-.+$/i,
      definitions: [
        { kind: "set", location: "built-in", name: /^1020d527-2764-4230-92cc-7035e4fcf8a7$/i, source: "BuiltIn:73-80" },
      ],
      scopeKind: "management-group",
      source: "BuiltIn:262-301 (name), BuiltIn:560 and 779-790 (scope)",
    },
    {
      id: "community-initiative",
      name: /^Cribl-Diag-EH-.+$/i,
      definitions: [
        { kind: "set", location: "management-group", name: /^Cribl-DiagSettings-EventHub$/i, source: "Community:131" },
      ],
      scopeKind: "management-group",
      source: "Community:401-415 (name), Community:1120 and 1177-1188 (scope)",
    },
    {
      id: "supplemental-storage",
      name: /^Cribl-(Blob|File|Queue|Table)-.+$/i,
      definitions: [
        {
          kind: "policy",
          location: "management-group",
          name: /^Cribl-Community-(Blob|File|Queue|Table)Services-DiagSettings-EventHub$/i,
          source: "Supplemental:413 and 2044",
        },
        {
          kind: "policy",
          location: "management-group",
          name: /^Cribl-(Blob|File|Queue|Table)Services-DiagSettings-EventHub$/i,
          source: "Supplemental:601 and 2045",
        },
      ],
      scopeKind: "management-group",
      source: "Supplemental:1126-1156 and 1954-1966 (name), Supplemental:1979 and 2092-2112 (scope)",
    },
    {
      id: "supplemental-activity-log",
      name: /^Cribl-ActivityLog$/i,
      definitions: [
        {
          kind: "policy",
          location: "built-in",
          name: /^4dabf6eb-0764-4049-82c1-c6d5d781e739$/i,
          source: "coverage-model/legacy/resource-coverage.json:53",
        },
        {
          kind: "policy",
          location: "management-group",
          name: /^Cribl-Community-ActivityLog-DiagSettings-EventHub$/i,
          source: "Supplemental:1019-1020 and 1058 (Cribl-Community-$serviceType-... with ActivityLog)",
        },
      ],
      scopeKind: "management-group",
      source: "Supplemental:1168 (name), Supplemental:2130 and 2176-2186 (scope)",
    },
  ]),
  /**
   * The resource-type `AssignmentPrefix` values of the Supplemental table
   * (Supplemental:214-277). They are carried into ImportedPolicies
   * (Supplemental:993) but no assignment name in the frozen files is built
   * from them - the only builder, Get-StorageAssignmentName
   * (Supplemental:1954), reads the storage table - so a name under one of
   * them is a NAME match only. The storage prefixes are listed too: those are
   * also covered, more strongly, by the `supplemental-storage` family.
   */
  resourceTypePrefixes: Object.freeze([
    "Cribl-Blob", "Cribl-File", "Cribl-Queue", "Cribl-Table", "Cribl-Storage",
    "Cribl-AKS", "Cribl-Firewall", "Cribl-NSG", "Cribl-AppGW", "Cribl-ExpRoute", "Cribl-VNet",
    "Cribl-Cosmos", "Cribl-ADF", "Cribl-MySQL", "Cribl-PgSQL", "Cribl-PgFlex", "Cribl-MariaDB",
    "Cribl-Synapse", "Cribl-SynSpark", "Cribl-SynSQL", "Cribl-ADX", "Cribl-Databricks",
    "Cribl-Analysis", "Cribl-TSI",
    "Cribl-AppSvc", "Cribl-Func", "Cribl-Batch", "Cribl-ML", "Cribl-AppIns", "Cribl-Scale", "Cribl-DevCtr",
    "Cribl-Logic", "Cribl-ISE", "Cribl-EGTopic", "Cribl-EGSys", "Cribl-Relay",
    "Cribl-LB", "Cribl-TM", "Cribl-CDN",
    "Cribl-AVDHost", "Cribl-AVDApp", "Cribl-AVDWks", "Cribl-AVDScale",
    "Cribl-RSV", "Cribl-FHIR", "Cribl-PBI",
    "Cribl-Activity",
  ] as const),
  /**
   * The legacy's own "is this ours" rule: `$_.Name -like "Cribl-*"`
   * (Run-AzureLogCollection.ps1:1963). `-like` is case-insensitive.
   */
  nameRule: /^Cribl-/i,
  /** The roles the legacy granted its identity (BuiltIn:419-453, Supplemental:1645-1677, Community:530-576). */
  identityRoles: Object.freeze<readonly LegacyIdentityRole[]>([
    {
      roleName: "Monitoring Contributor",
      roleDefinitionGuid: "749f88d5-cbae-40b8-bcfc-e573ddc772fa",
      grantedAt: "management-group",
      source: "BuiltIn:419-436, Supplemental:1645-1661, Community:530-531",
    },
    {
      roleName: "Azure Event Hubs Data Owner",
      roleDefinitionGuid: "f526a384-b230-433a-b45c-95f59c4a2dec",
      grantedAt: "event-hub-namespace",
      source: "BuiltIn:438-453, Supplemental:1663-1677, Community:554-556",
    },
  ]),
});

/** The roles the legacy granted its identity, as display text for the panel. */
export const LEGACY_IDENTITY_ROLES = LEGACY_WRITER.identityRoles;

/** One piece of ownership evidence. */
export type OwnershipEvidenceKind =
  | "toolkit-marker"
  | "legacy-strong"
  | "legacy-identity"
  | "name-only"
  | "legacy-shape-mismatch"
  | "diagnostic-setting-name-hint";

export interface OwnershipEvidence {
  readonly kind: OwnershipEvidenceKind;
  /** What matched, in words, for the panel. */
  readonly detail: string;
  /** The legacy family, when the evidence is about one. */
  readonly family: string | null;
}

/** How strongly an assignment is ours; `none` means another owner's. */
export type OwnershipStrength =
  | "toolkit-marker"
  | "legacy-strong"
  | "legacy-identity"
  | "name-only"
  | "none";

export interface Ownership {
  readonly owner: "ours" | "other";
  /** The strongest evidence that made it ours, or `none`. */
  readonly strength: OwnershipStrength;
  /** All evidence, in rank order. */
  readonly evidence: readonly OwnershipEvidence[];
}

const RANK: Readonly<Record<OwnershipEvidenceKind, number>> = {
  "toolkit-marker": 0,
  "legacy-strong": 1,
  "legacy-identity": 2,
  "name-only": 3,
  "legacy-shape-mismatch": 4,
  "diagnostic-setting-name-hint": 5,
};

const AUTHZ = "/providers/microsoft.authorization/";

/** The kind of scope an assignment is set at. */
export function assignmentScopeKind(scope: string): AssignmentScopeKind {
  const n = normaliseScopeId(scope);
  if (n === "") return "unknown";
  if (isManagementGroupId(n)) return "management-group";
  if (isSubscriptionId(n)) return "subscription";
  if (/^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+$/.test(n)) return "resource-group";
  if (n.startsWith("/subscriptions/")) return "resource";
  return "unknown";
}

/** True when a definition id is one the matcher describes. */
export function definitionMatches(matcher: LegacyDefinitionMatcher, definitionId: string): boolean {
  const n = normaliseScopeId(definitionId);
  const collection = matcher.kind === "set" ? "policysetdefinitions" : "policydefinitions";
  const tail = `${AUTHZ}${collection}/`;
  const at = n.lastIndexOf(tail);
  if (at < 0) return false;
  const name = n.slice(at + tail.length);
  if (name === "" || name.includes("/")) return false;
  const prefix = n.slice(0, at);
  const placed =
    matcher.location === "built-in" ? prefix === "" : isManagementGroupId(prefix);
  return placed && matcher.name.test(name);
}

function hasMarker(metadata: Readonly<Record<string, unknown>>): string | null {
  const v = metadata[TOOLKIT_MARKER_KEY];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const version = (v as Record<string, unknown>)["version"];
  return typeof version === "string" && version.trim() !== "" ? version : null;
}

function legacyIdentityKey(assignment: PolicyAssignment): string | null {
  const suffix = `/userassignedidentities/${LEGACY_WRITER.identityName}`;
  for (const ua of assignment.identity.userAssigned) {
    if (normaliseScopeId(ua.id).endsWith(suffix)) return ua.id;
  }
  return null;
}

function hintValue(assignment: PolicyAssignment): string | null {
  for (const [k, v] of Object.entries(assignment.parameters)) {
    const key = k.toLowerCase();
    if (
      (key === "profilename" || key === "diagnosticsettingname") &&
      typeof v === "string" &&
      v.toLowerCase() === LEGACY_WRITER.diagnosticSettingNameHint
    ) {
      return k;
    }
  }
  return null;
}

/**
 * Recognise who owns an assignment. `createdBy` is never consulted.
 */
export function recogniseOwner(assignment: PolicyAssignment): Ownership {
  const evidence: OwnershipEvidence[] = [];

  const version = hasMarker(assignment.metadata);
  if (version !== null) {
    evidence.push({
      kind: "toolkit-marker",
      detail: `metadata.${TOOLKIT_MARKER_KEY}.version = ${version}`,
      family: null,
    });
  }

  const family = LEGACY_WRITER.families.find((f) => f.name.test(assignment.name)) ?? null;
  if (family !== null) {
    const defOk = family.definitions.some((d) => definitionMatches(d, assignment.policyDefinitionId));
    const kind = assignmentScopeKind(assignment.scope);
    const scopeOk = kind === family.scopeKind;
    const notScopesOk = assignment.notScopes.length === 0;
    if (defOk && scopeOk && notScopesOk) {
      evidence.push({
        kind: "legacy-strong",
        detail: `legacy name, definition and ${family.scopeKind} scope (${family.id})`,
        family: family.id,
      });
    } else {
      const why: string[] = [];
      if (!defOk) why.push("definition is not the one the legacy assigned under this name");
      if (!scopeOk) why.push(`set at ${kind} scope; the legacy wrote it at ${family.scopeKind} scope`);
      if (!notScopesOk) why.push(`carries ${assignment.notScopes.length} notScopes; the legacy wrote none`);
      evidence.push({ kind: "legacy-shape-mismatch", detail: why.join("; "), family: family.id });
    }
  }

  const identity = legacyIdentityKey(assignment);
  if (identity !== null) {
    evidence.push({
      kind: "legacy-identity",
      detail: `uses the legacy identity ${LEGACY_WRITER.identityName}`,
      family: null,
    });
  }

  const strong = evidence.some((e) => e.kind === "legacy-strong");
  if (!strong && LEGACY_WRITER.nameRule.test(assignment.name)) {
    evidence.push({ kind: "name-only", detail: "name match (Cribl-*)", family: family?.id ?? null });
  }

  const hint = hintValue(assignment);
  if (hint !== null) {
    evidence.push({
      kind: "diagnostic-setting-name-hint",
      detail: `${hint} = ${LEGACY_WRITER.diagnosticSettingNameHint}, the legacy default name (a hint only)`,
      family: null,
    });
  }

  evidence.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  const top = evidence[0];
  const strength: OwnershipStrength =
    top !== undefined &&
    (top.kind === "toolkit-marker" ||
      top.kind === "legacy-strong" ||
      top.kind === "legacy-identity" ||
      top.kind === "name-only")
      ? top.kind
      : "none";
  // The cap: a legacy name in the wrong shape is at most a name match, even
  // when the legacy identity is also present. The identity is shared by every
  // assignment the legacy wrote, so it cannot vouch for one whose own shape
  // contradicts the writer; only the toolkit marker lifts the cap.
  const capped: OwnershipStrength =
    strength !== "none" &&
    strength !== "toolkit-marker" &&
    evidence.some((e) => e.kind === "legacy-shape-mismatch")
      ? "name-only"
      : strength;
  return { owner: capped === "none" ? "other" : "ours", strength: capped, evidence };
}
