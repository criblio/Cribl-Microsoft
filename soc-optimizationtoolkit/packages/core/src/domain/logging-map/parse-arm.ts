/**
 * Tolerant parsers for the ARM bodies the Azure Logging Map reads (AZR-19).
 *
 * LAYERING. This is DOMAIN code and imports nothing from `usecases/`. The rule
 * is stated at `domain/log-type-catalog/merge.ts` ("domain may not import
 * usecases") and `usecases/arm-http.ts` itself says domain modules keep their
 * own tiny local coercions by design - so `isRecord`, `getProp` and `str` are
 * defined here, and `arm-http.ts` (is2xx, httpErrorText...) is used only by the
 * usecase that sends these requests. A pin in parse-arm.test.ts reads every
 * shipped file in this folder and fails if any of them imports, re-exports or
 * dynamically imports a specifier that reaches `usecases/` (a prose mention,
 * like this one, does not trip it).
 *
 * TOLERANT, AND COUNTED. Each list parser takes the `value` items a pager
 * returned and gives back `{ rows, malformedCount }`: an item that cannot be a
 * row (not an object, or no id) is skipped and COUNTED, never crashed on and
 * never silently lost. A single-resource body goes through the same parser as
 * a one-item list.
 *
 * Pure: no IO, no Date, no randomness.
 */

import type {
  AssignmentIdentity,
  DefinitionKind,
  DefinitionParameter,
  ManagementGroupWithPath,
  PolicyAssignment,
  PolicyDefinition,
  PolicyExemption,
  PolicySetDefinition,
  PolicySetMember,
  ResourceSelector,
  ResourceSelectorClause,
  RoleDefinitionInfo,
  RoleGrant,
  ScopeEntry,
  SubscriptionEntry,
  UserAssignedIdentityRef,
} from "./logging-map-types";

/** What every list parser returns. */
export interface Parsed<T> {
  readonly rows: readonly T[];
  /** Items skipped because they could not be a row. */
  readonly malformedCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProp(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseList<T>(items: readonly unknown[], one: (item: unknown) => T | null): Parsed<T> {
  const rows: T[] = [];
  let malformedCount = 0;
  for (const item of items) {
    const row = one(item);
    if (row === null) malformedCount += 1;
    else rows.push(row);
  }
  return { rows, malformedCount };
}

/** `{ name: { value } }` -> `{ name: value }`; entries without `value` omitted. */
function unwrapValues(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record(value))) {
    if (isRecord(v) && "value" in v) out[k] = v["value"];
  }
  return out;
}

function definitionParameters(value: unknown): Record<string, DefinitionParameter> {
  const out: Record<string, DefinitionParameter> = {};
  for (const [k, v] of Object.entries(record(value))) {
    if (!isRecord(v)) continue;
    out[k] = { type: str(v["type"]), hasDefault: "defaultValue" in v, defaultValue: v["defaultValue"] };
  }
  return out;
}

/** The kind of definition an id names, from its path. */
export function definitionKindOf(policyDefinitionId: string): DefinitionKind {
  const lower = policyDefinitionId.toLowerCase();
  if (lower.includes("/policysetdefinitions/")) return "set";
  if (lower.includes("/policydefinitions/")) return "policy";
  return "unknown";
}

// ---------------------------------------------------------------- hierarchy

/**
 * Descendants rows (`managementGroups/{id}/descendants`): management groups
 * and subscriptions, each naming its parent in `properties.parent.id`.
 */
export function parseDescendants(items: readonly unknown[]): Parsed<ScopeEntry> {
  return parseList(items, (item) => {
    const id = str(getProp(item, "id"));
    if (id === "") return null;
    const props = getProp(item, "properties");
    return {
      id,
      name: str(getProp(item, "name")),
      displayName: str(getProp(props, "displayName")),
      parentId: strOrNull(getProp(getProp(props, "parent"), "id")),
    };
  });
}

/**
 * Management groups read with `$expand=path`. The parent comes from
 * `properties.details.parent.id`; when that is absent the last ancestor in
 * `properties.details.path` (or, tolerated, `properties.path`) that is not the
 * group itself is used.
 */
export function parseManagementGroups(items: readonly unknown[]): Parsed<ManagementGroupWithPath> {
  return parseList(items, (item) => {
    const id = str(getProp(item, "id"));
    if (id === "") return null;
    const name = str(getProp(item, "name"));
    const props = getProp(item, "properties");
    // ARM puts the ancestor path at properties.details.path (ManagementGroupDetails:
    // version, updatedTime, updatedBy, parent, path). properties.path is kept only
    // as a secondary tolerance. Unconfirmed against a captured body: live item 3a/3b.
    const detailsPath = getProp(getProp(props, "details"), "path");
    const path = Array.isArray(detailsPath) ? detailsPath : getProp(props, "path");
    const pathNames = Array.isArray(path)
      ? path.map((p) => str(getProp(p, "name"))).filter((p) => p !== "")
      : [];
    let parentId = strOrNull(getProp(getProp(getProp(props, "details"), "parent"), "id"));
    if (parentId === null) {
      const ancestors = pathNames.filter((p) => p.toLowerCase() !== name.toLowerCase());
      const nearest = ancestors[ancestors.length - 1];
      if (nearest !== undefined) parentId = `/providers/Microsoft.Management/managementGroups/${nearest}`;
    }
    return { id, name, displayName: str(getProp(props, "displayName")), parentId, pathNames };
  });
}

/**
 * GET /subscriptions rows. That list does NOT say where a subscription sits,
 * so `parentId` is always null here; the tree places it from the hierarchy
 * read or under the parent-unknown holder.
 */
export function parseSubscriptions(items: readonly unknown[]): Parsed<SubscriptionEntry> {
  return parseList(items, (item) => {
    const subscriptionId = str(getProp(item, "subscriptionId"));
    const id = str(getProp(item, "id")) || (subscriptionId !== "" ? `/subscriptions/${subscriptionId}` : "");
    if (id === "") return null;
    return {
      id,
      name: subscriptionId !== "" ? subscriptionId : (id.split("/").pop() ?? ""),
      displayName: str(getProp(item, "displayName")),
      parentId: null,
      subscriptionId,
      state: str(getProp(item, "state")),
    };
  });
}

// ---------------------------------------------------------------- policy

function parseIdentity(value: unknown): AssignmentIdentity {
  const type = str(getProp(value, "type")) || "None";
  const userAssigned: UserAssignedIdentityRef[] = [];
  for (const [k, v] of Object.entries(record(getProp(value, "userAssignedIdentities")))) {
    userAssigned.push({ id: k, principalId: strOrNull(getProp(v, "principalId")) });
  }
  return { type, principalId: strOrNull(getProp(value, "principalId")), userAssigned };
}

function parseSelectors(value: unknown): ResourceSelector[] {
  if (!Array.isArray(value)) return [];
  const out: ResourceSelector[] = [];
  for (const s of value) {
    if (!isRecord(s)) continue;
    const raw = s["selectors"];
    const selectors: ResourceSelectorClause[] = Array.isArray(raw)
      ? raw.filter(isRecord).map((c) => ({ kind: str(c["kind"]), in: strArray(c["in"]), notIn: strArray(c["notIn"]) }))
      : [];
    out.push({ name: str(s["name"]), selectors });
  }
  return out;
}

/** Policy assignment rows. A row with no id is malformed. */
export function parseAssignments(items: readonly unknown[]): Parsed<PolicyAssignment> {
  return parseList(items, (item) => {
    const id = str(getProp(item, "id"));
    if (id === "") return null;
    const props = getProp(item, "properties");
    const name = str(getProp(item, "name"));
    const policyDefinitionId = str(getProp(props, "policyDefinitionId"));
    return {
      id,
      name,
      displayName: str(getProp(props, "displayName")) || name,
      scope: str(getProp(props, "scope")),
      policyDefinitionId,
      definitionKind: definitionKindOf(policyDefinitionId),
      notScopes: strArray(getProp(props, "notScopes")),
      parameters: unwrapValues(getProp(props, "parameters")),
      metadata: record(getProp(props, "metadata")),
      identity: parseIdentity(getProp(item, "identity")),
      enforcementMode: str(getProp(props, "enforcementMode")) || "Default",
      resourceSelectors: parseSelectors(getProp(props, "resourceSelectors")),
    };
  });
}

const EXEMPTION_SEGMENT = "/providers/microsoft.authorization/policyexemptions/";

/**
 * The scope an exemption is placed at: everything in its id before
 * `/providers/Microsoft.Authorization/policyExemptions/`. '' if absent.
 */
export function exemptionScopeOf(exemptionId: string): string {
  const at = exemptionId.toLowerCase().lastIndexOf(EXEMPTION_SEGMENT);
  return at <= 0 ? "" : exemptionId.slice(0, at);
}

/** Policy exemption rows. A row with no id is malformed. */
export function parseExemptions(items: readonly unknown[]): Parsed<PolicyExemption> {
  return parseList(items, (item) => {
    const id = str(getProp(item, "id"));
    if (id === "") return null;
    const props = getProp(item, "properties");
    return {
      id,
      name: str(getProp(item, "name")),
      scope: exemptionScopeOf(id),
      policyAssignmentId: str(getProp(props, "policyAssignmentId")),
      category: str(getProp(props, "exemptionCategory")),
      expiresOn: strOrNull(getProp(props, "expiresOn")),
      policyDefinitionReferenceIds: strArray(getProp(props, "policyDefinitionReferenceIds")),
    };
  });
}

/** Policy definitions (single). A row with no id is malformed. */
export function parseDefinitions(items: readonly unknown[]): Parsed<PolicyDefinition> {
  return parseList(items, (item) => {
    const id = str(getProp(item, "id"));
    if (id === "") return null;
    const props = getProp(item, "properties");
    const policyRule = getProp(props, "policyRule");
    const then = getProp(policyRule, "then");
    const name = str(getProp(item, "name"));
    return {
      id,
      name,
      displayName: str(getProp(props, "displayName")) || name,
      policyType: str(getProp(props, "policyType")),
      mode: str(getProp(props, "mode")),
      parameters: definitionParameters(getProp(props, "parameters")),
      thenEffect: getProp(then, "effect"),
      thenDetailsType: str(getProp(getProp(then, "details"), "type")),
      policyRule,
    };
  });
}

/** Policy set definitions. A row with no id is malformed; a member with no definition id is dropped. */
export function parseSetDefinitions(items: readonly unknown[]): Parsed<PolicySetDefinition> {
  return parseList(items, (item) => {
    const id = str(getProp(item, "id"));
    if (id === "") return null;
    const props = getProp(item, "properties");
    const raw = getProp(props, "policyDefinitions");
    const members: PolicySetMember[] = [];
    if (Array.isArray(raw)) {
      for (const m of raw) {
        const policyDefinitionId = str(getProp(m, "policyDefinitionId"));
        if (policyDefinitionId === "") continue;
        members.push({
          policyDefinitionId,
          referenceId: str(getProp(m, "policyDefinitionReferenceId")),
          parameters: unwrapValues(getProp(m, "parameters")),
        });
      }
    }
    const name = str(getProp(item, "name"));
    return {
      id,
      name,
      displayName: str(getProp(props, "displayName")) || name,
      policyType: str(getProp(props, "policyType")),
      parameters: definitionParameters(getProp(props, "parameters")),
      members,
    };
  });
}

// ---------------------------------------------------------------- roles

/**
 * Role assignment rows, as grants. `roleName` is null: the role definition is
 * a separate read. A row with no roleDefinitionId is malformed.
 */
export function parseRoleAssignments(items: readonly unknown[]): Parsed<RoleGrant> {
  return parseList(items, (item) => {
    const props = getProp(item, "properties");
    const roleDefinitionId = str(getProp(props, "roleDefinitionId"));
    if (roleDefinitionId === "") return null;
    return { scope: str(getProp(props, "scope")), roleDefinitionId, roleName: null };
  });
}

/** Role definitions. A row with no id or no roleName is malformed. */
export function parseRoleDefinitions(items: readonly unknown[]): Parsed<RoleDefinitionInfo> {
  return parseList(items, (item) => {
    const id = str(getProp(item, "id"));
    const roleName = str(getProp(getProp(item, "properties"), "roleName"));
    if (id === "" || roleName === "") return null;
    return { id, roleName };
  });
}
