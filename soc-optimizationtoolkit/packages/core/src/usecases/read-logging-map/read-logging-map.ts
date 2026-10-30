/**
 * readLoggingMap - the ONE usecase behind the Azure Logging Map (AZR-19,
 * phase 1, READ-ONLY). Every request is a GET; nothing is written.
 *
 * WHAT IT READS, in order, sequentially (paced through
 * `paceAzureManagement` when the shell supplies pacing):
 *
 * 1. THE TREE. `managementGroups/{tenantId}/descendants`. When that read is
 *    refused (a 403 or 404 for a caller without Tenant Root access, or any
 *    other refusal), it falls back: list the visible management groups, GET
 *    each with `$expand=path` to learn its parent, and let the groups whose
 *    parent is not visible become roots; then read each such root's OWN
 *    descendants, which is what places subscriptions under the groups that
 *    were read (`$expand=path` names ancestors only). `start.notRead` names
 *    what above was not read, so the screen can say it in words.
 * 2. GET /subscriptions. PERMISSION-FILTERED: it is wrapped with `toListing`,
 *    so an empty answer is UNKNOWN and never "no subscriptions". Subscriptions
 *    no hierarchy read placed hang under the one parent-unknown holder.
 * 3. PER SCOPE (every management group and subscription in the tree):
 *    policyAssignments `atScope()` and policyExemptions, each through
 *    {@link readAllPages}, so a 403 at one scope is that scope's refused
 *    `ListRead` and never fails the map.
 * 4. DEFINITIONS. Each distinct definition the assignments name, except the
 *    confirmed built-ins the classifier short-circuits, then set members, up
 *    to `maxDefinitionReads` GETs in all. A definition not read - over the cap
 *    or refused - leaves its assignment classified `unknown`, which is always
 *    shown and counted, never "not logging".
 * 5. ROLES. For each assignment SHOWN by default ({@link isShownByDefault})
 *    whose identity carries a principal id: one `assignedTo()` role read per
 *    distinct (assignment scope, principal), then one GET per distinct role
 *    definition for its name. Both kinds share `maxRoleReads`; a role read
 *    over the cap is refused "role read cap reached" (counted as rolesUnread),
 *    never "no roles". A role-definition GET over the cap is also a cap
 *    refusal, and a principal left with an unnamed grant (skipped or refused
 *    definition) is counted in rolesUnread too.
 * 6. JUDGE AND ASSEMBLE: classify, recognise owners, `buildLoggingMap`.
 *
 * NEVER THROWS for an ARM answer or a transport failure: those become
 * refusals. (A bad `pacing.maxRequestsPerMinute` is a programming error and
 * does throw, from `paceAzureManagement`.)
 *
 * No clock: `now` (ISO) is an argument, used only for exemption expiry.
 */

import type { AzureManagement } from "../../ports/azure-management";
import { toListing, type Listing } from "../../domain/inventory-listing";
import {
  readRefused,
  readRows,
  refusalsOf,
  type ListRead,
  type Refusal,
} from "../../domain/logging-map/list-read";
import type {
  PolicyAssignment,
  PolicyDefinition,
  PolicyExemption,
  PolicySetDefinition,
  RoleGrant,
  ScopeEntry,
  ScopeRead,
  SubscriptionEntry,
} from "../../domain/logging-map/logging-map-types";
import {
  assignmentsAtScopeRequest,
  definitionRequest,
  descendantsRequest,
  exemptionsRequest,
  listManagementGroupsRequest,
  listSubscriptionsRequest,
  managementGroupRequest,
  roleAssignmentsForPrincipalRequest,
  roleDefinitionRequest,
} from "../../domain/logging-map/logging-map-requests";
import {
  buildScopeTree,
  lastSegment,
  managementGroupId,
  normaliseScopeId,
  rootsFromVisible,
} from "../../domain/logging-map/scope-tree";
import {
  definitionKindOf,
  parseAssignments,
  parseDefinitions,
  parseDescendants,
  parseExemptions,
  parseManagementGroups,
  parseRoleAssignments,
  parseRoleDefinitions,
  parseSetDefinitions,
  parseSubscriptions,
} from "../../domain/logging-map/parse-arm";
import {
  LEGACY_IDENTITY_ROLES,
  recogniseOwner,
  type Ownership,
} from "../../domain/logging-map/ownership";
import {
  classifyAssignment,
  definitionKey,
  isShortCircuited,
  type LoggingClass,
} from "../../domain/logging-map/logging-classifier";
import {
  buildLoggingMap,
  principalIdsOf,
  principalKey,
  type LegacyGrantedRole,
  type LoggingMap,
} from "../../domain/logging-map/logging-map-model";
import { placementsFor } from "../../domain/logging-map/coverage";
import { paceAzureManagement, type BatchPacing } from "../onboard-batch";
import { readAllPages, readSingle } from "./arm-pager";

/** Distinct definition GETs (single and set) per map read, by default. */
export const DEFAULT_MAX_DEFINITION_READS = 60;
/** Role-assignment reads plus role-definition GETs per map read, by default. */
export const DEFAULT_MAX_ROLE_READS = 40;

/** The Tenant Root Group's portal name; descendants does not return the root itself. */
const TENANT_ROOT_DISPLAY_NAME = "Tenant Root Group";

export type LoggingMapPhase = "hierarchy" | "subscriptions" | "scopes" | "definitions" | "roles";

export interface LoggingMapProgress {
  /** Requests completed so far (every page counts). */
  readonly done: number;
  /** Best current estimate of all requests; grows as pages and caps become known. Never below `done`. */
  readonly total: number;
  readonly phase: LoggingMapPhase;
}

/**
 * Where the tree starts.
 * - `tenant-root`: the descendants read of the Tenant Root succeeded.
 * - `highest-readable`: it did not; the visible management groups whose
 *   parent is not visible are the roots.
 * - `subscriptions-only`: no management group could be read at all.
 */
export type LoggingMapStartKind = "tenant-root" | "highest-readable" | "subscriptions-only";

export interface LoggingMapStart {
  readonly kind: LoggingMapStartKind;
  /** Normalised ids of scopes ABOVE the tree that were not read (the Tenant Root, when refused). */
  readonly notRead: readonly string[];
}

export interface ReadLoggingMapInput {
  readonly azure: AzureManagement;
  /** The Entra tenant id - the Tenant Root Group's name. Blank: the tree starts from what is visible. */
  readonly tenantId: string;
  /** ISO timestamp, injected (no clock in core); judges exemption expiry only. */
  readonly now: string;
  /** Shell-owned pacing; when given every ARM call goes through `paceAzureManagement`. */
  readonly pacing?: BatchPacing;
  readonly onProgress?: (progress: LoggingMapProgress) => void;
  readonly maxDefinitionReads?: number;
  readonly maxRoleReads?: number;
}

export interface ReadLoggingMapResult {
  readonly map: LoggingMap<LoggingClass, Ownership>;
  readonly start: LoggingMapStart;
  /** GET /subscriptions, PERMISSION-FILTERED: `empty` is unknown, never "none". */
  readonly subscriptions: Listing<SubscriptionEntry>;
  /**
   * Every refusal: the per-scope reads (`refusalsOf`) first, then the tree,
   * subscription, definition and role reads, in the order they happened.
   */
  readonly refusals: readonly Refusal[];
  /** Definitions skipped by `maxDefinitionReads` (their assignments are unclassified). */
  readonly definitionsSkipped: number;
  /** Role-definition GETs skipped by `maxRoleReads` (those grants show no role name; each is also a cap refusal). */
  readonly roleDefinitionsSkipped: number;
  /**
   * Principals (per principalKey) whose grants were read but at least one role
   * name was not. Already folded into `map.counts.rolesUnread`.
   */
  readonly roleNamesUnread: number;
  /** Requests made, every page counted. */
  readonly requests: number;
}

/**
 * The default view's rule, which also decides who gets a role read: ours,
 * any logging-related assignment, and any assignment whose definition could
 * not be classified (unknown is always shown).
 */
export function isShownByDefault(owner: Ownership, classification: LoggingClass): boolean {
  return owner.owner === "ours" || classification.verdict === "yes" || classification.verdict === "unknown";
}

/** The roles the legacy writer granted its identity, as the panel's text rows. */
export const LEGACY_GRANTED_ROLES_TEXT: readonly LegacyGrantedRole[] = Object.freeze(
  LEGACY_IDENTITY_ROLES.map((r) => ({
    roleName: r.roleName,
    at: r.grantedAt === "management-group" ? "management group" : "Event Hub namespace",
  })),
);

/** Ownership strengths that identify the LEGACY writer specifically (not a bare name match). */
function isLegacyOwner(owner: Ownership): boolean {
  return owner.owner === "ours" && (owner.strength === "legacy-strong" || owner.strength === "legacy-identity");
}

function capRefusal(request: string, text: string): Refusal {
  return { request, status: null, code: "", text, reason: "too-many-pages" };
}

/** Read the Azure Logging Map. See the module header. Never rejects for ARM or transport failures. */
export async function readLoggingMap(input: ReadLoggingMapInput): Promise<ReadLoggingMapResult> {
  const maxDefinitionReads = input.maxDefinitionReads ?? DEFAULT_MAX_DEFINITION_READS;
  const maxRoleReads = input.maxRoleReads ?? DEFAULT_MAX_ROLE_READS;
  const tenantId = input.tenantId.trim();
  const base = input.pacing !== undefined ? paceAzureManagement(input.azure, input.pacing) : input.azure;

  // Progress: a counting view over the (paced) port.
  let done = 0;
  let planned = 0;
  let phase: LoggingMapPhase = "hierarchy";
  const report = (): void => {
    input.onProgress?.({ done, total: Math.max(done, planned), phase });
  };
  const counted = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } finally {
        done += 1;
        report();
      }
    };
  const azure: AzureManagement = { request: counted((o) => base.request(o)) };
  const baseUrl = base.requestUrl?.bind(base);
  if (baseUrl !== undefined) azure.requestUrl = counted((o) => baseUrl(o));
  const plan = (n: number): void => {
    planned = Math.max(planned, done) + n;
  };

  const otherRefusals: Refusal[] = [];
  let malformedRows = 0;
  const rowsOf = <T>(read: ListRead<unknown>, parse: (items: readonly unknown[]) => { rows: readonly T[]; malformedCount: number }): ListRead<T> => {
    if (read.state === "refused") return readRefused(read.refusal);
    const parsed = parse(read.rows);
    malformedRows += parsed.malformedCount;
    return readRows(parsed.rows);
  };

  // ---------------------------------------------------------- 1. hierarchy
  const entries: ScopeEntry[] = [];
  let start: LoggingMapStart;
  let descendantsRead = false;
  plan(2);
  if (tenantId !== "") {
    const rootId = managementGroupId(tenantId);
    const descendants = rowsOf(
      await readAllPages(azure, descendantsRequest(tenantId), `descendants of Tenant Root ${tenantId}`),
      parseDescendants,
    );
    if (descendants.state === "read") {
      descendantsRead = true;
      entries.push({ id: rootId, name: tenantId, displayName: TENANT_ROOT_DISPLAY_NAME, parentId: null });
      entries.push(...descendants.rows);
    } else {
      otherRefusals.push(descendants.refusal);
    }
  }
  if (descendantsRead) {
    start = { kind: "tenant-root", notRead: [] };
  } else {
    const groups = rowsOf(
      await readAllPages(azure, listManagementGroupsRequest(), "visible management groups"),
      parseDescendants,
    );
    let anyGroup = false;
    const groupEntries: ScopeEntry[] = [];
    if (groups.state === "refused") {
      otherRefusals.push(groups.refusal);
    } else {
      plan(groups.rows.length);
      for (const g of groups.rows) {
        const name = g.name !== "" ? g.name : lastSegment(g.id);
        const one = rowsOf(
          await readSingle(azure, managementGroupRequest(name, true), `management group ${name}`),
          parseManagementGroups,
        );
        const withPath = one.state === "read" ? one.rows[0] : undefined;
        if (one.state === "refused") otherRefusals.push(one.refusal);
        // A group whose own GET failed is still visible; it just becomes a root.
        groupEntries.push(withPath ?? { ...g, parentId: null });
        anyGroup = true;
      }
      entries.push(...groupEntries);
      // `$expand=path` names ANCESTORS only, and GET /subscriptions carries no
      // parent, so without this no subscription could be placed under a group
      // that WAS read. Each highest-readable root's own descendants read
      // returns the groups and subscriptions beneath it with their parents.
      // A refused one is a refusal; only ITS subscriptions stay parent-unknown.
      const nameById = new Map<string, string>();
      for (const e of groupEntries) {
        const n = normaliseScopeId(e.id);
        if (!nameById.has(n)) nameById.set(n, e.name !== "" ? e.name : lastSegment(e.id));
      }
      const roots = rootsFromVisible(groupEntries);
      plan(roots.length);
      for (const rootIdNorm of roots) {
        const name = nameById.get(rootIdNorm) ?? lastSegment(rootIdNorm);
        const below = rowsOf(
          await readAllPages(azure, descendantsRequest(name), `descendants of management group ${name}`),
          parseDescendants,
        );
        if (below.state === "read") entries.push(...below.rows);
        else otherRefusals.push(below.refusal);
      }
    }
    start = {
      kind: anyGroup ? "highest-readable" : "subscriptions-only",
      notRead: tenantId !== "" ? [normaliseScopeId(managementGroupId(tenantId))] : [],
    };
  }

  // ------------------------------------------------------ 2. subscriptions
  phase = "subscriptions";
  const subsRead = rowsOf(
    await readAllPages(azure, listSubscriptionsRequest(), "visible subscriptions"),
    parseSubscriptions,
  );
  let subscriptions: Listing<SubscriptionEntry> = { kind: "empty" };
  if (subsRead.state === "read") {
    subscriptions = toListing(subsRead.rows);
    entries.push(...subsRead.rows);
  } else {
    otherRefusals.push(subsRead.refusal);
  }

  const tree = buildScopeTree({ tenantId, entries });

  // ----------------------------------------------------- 3. per-scope reads
  phase = "scopes";
  // The request uses ARM's own spelling of the id when an entry gave one.
  const spelled = new Map<string, string>();
  for (const e of entries) {
    const n = normaliseScopeId(e.id);
    if (!spelled.has(n)) spelled.set(n, e.id);
  }
  const scopes = tree.nodes.filter((n) => n.kind !== "placeholder");
  plan(scopes.length * 2);
  const scopeReads: ScopeRead[] = [];
  for (const node of scopes) {
    const scope = spelled.get(node.id) ?? node.id;
    const assignments: ListRead<PolicyAssignment> = rowsOf(
      await readAllPages(azure, assignmentsAtScopeRequest(scope), `policy assignments at ${scope}`),
      parseAssignments,
    );
    const exemptions: ListRead<PolicyExemption> = rowsOf(
      await readAllPages(azure, exemptionsRequest(scope), `policy exemptions at ${scope}`),
      parseExemptions,
    );
    scopeReads.push({ scopeId: node.id, assignments, exemptions });
  }

  // -------------------------------------------------------- 4. definitions
  phase = "definitions";
  const placements = placementsFor(scopeReads);
  const definitions = new Map<string, PolicyDefinition>();
  const sets = new Map<string, PolicySetDefinition>();
  const queue: { key: string; id: string }[] = [];
  const queued = new Set<string>();
  const enqueue = (id: string): void => {
    const key = definitionKey(id);
    if (key === "" || queued.has(key) || isShortCircuited(id)) return;
    queued.add(key);
    queue.push({ key, id });
  };
  for (const p of placements) enqueue(p.assignment.policyDefinitionId);
  plan(Math.min(queue.length, maxDefinitionReads));
  let definitionReads = 0;
  let definitionsSkipped = 0;
  // Assignment-level definitions first (so each assignment's own definition is
  // read before any set's members), then members as sets reveal them.
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]!;
    if (definitionReads >= maxDefinitionReads) {
      definitionsSkipped += 1;
      continue;
    }
    definitionReads += 1;
    const isSet = definitionKindOf(item.id) === "set";
    const read = await readSingle(azure, definitionRequest(item.id), `policy ${isSet ? "set " : ""}definition ${item.id}`);
    if (read.state === "refused") {
      otherRefusals.push(read.refusal);
      continue;
    }
    if (isSet) {
      const parsed = parseSetDefinitions(read.rows);
      malformedRows += parsed.malformedCount;
      const set = parsed.rows[0];
      if (set === undefined) continue;
      sets.set(item.key, set);
      const before = queue.length;
      for (const m of set.members) enqueue(m.policyDefinitionId);
      if (queue.length > before) plan(Math.min(queue.length - before, Math.max(0, maxDefinitionReads - definitionReads)));
    } else {
      const parsed = parseDefinitions(read.rows);
      malformedRows += parsed.malformedCount;
      const def = parsed.rows[0];
      if (def !== undefined) definitions.set(item.key, def);
    }
  }

  // ------------------------------------------------- classify and own
  const lookup = { definitions, sets };
  const classifications = new Map<string, LoggingClass>();
  const owners = new Map<string, Ownership>();
  for (const p of placements) {
    classifications.set(p.assignmentKey, classifyAssignment(p.assignment, lookup));
    owners.set(p.assignmentKey, recogniseOwner(p.assignment));
  }

  // -------------------------------------------------------------- 5. roles
  phase = "roles";
  const roles = new Map<string, ListRead<RoleGrant>>();
  const roleTargets: { key: string; scope: string; principalId: string }[] = [];
  for (const p of placements) {
    const owner = owners.get(p.assignmentKey);
    const cls = classifications.get(p.assignmentKey);
    if (owner === undefined || cls === undefined || !isShownByDefault(owner, cls)) continue;
    for (const pid of principalIdsOf(p.assignment.identity)) {
      const key = principalKey(p.assignment.scope, pid);
      if (roleTargets.some((t) => t.key === key)) continue;
      roleTargets.push({ key, scope: p.assignment.scope, principalId: pid });
    }
  }
  plan(Math.min(roleTargets.length, maxRoleReads));
  let roleReads = 0;
  let roleDefinitionsSkipped = 0;
  // Role names by role-definition GUID: the same built-in role has one name at every scope.
  const roleNames = new Map<string, string | null>();
  /** principalKeys whose grants were read but at least one role NAME was not. */
  const roleNamesUnreadKeys = new Set<string>();
  for (const t of roleTargets) {
    const request = roleAssignmentsForPrincipalRequest(t.scope, t.principalId);
    if (roleReads >= maxRoleReads) {
      const refused = capRefusal(request.path, `role assignments of ${t.principalId} at ${t.scope}: role read cap reached`);
      roles.set(t.key, readRefused(refused));
      otherRefusals.push(refused);
      continue;
    }
    roleReads += 1;
    const grants = rowsOf(
      await readAllPages(azure, request, `role assignments of ${t.principalId} at ${t.scope}`),
      parseRoleAssignments,
    );
    if (grants.state === "refused") {
      roles.set(t.key, grants);
      otherRefusals.push(grants.refusal);
      continue;
    }
    for (const g of grants.rows) {
      const guid = lastSegment(g.roleDefinitionId).toLowerCase();
      if (guid === "" || roleNames.has(guid)) continue;
      if (roleReads >= maxRoleReads) {
        roleDefinitionsSkipped += 1;
        roleNames.set(guid, null);
        otherRefusals.push(
          capRefusal(roleDefinitionRequest(g.roleDefinitionId).path, `role definition ${g.roleDefinitionId}: role read cap reached`),
        );
        continue;
      }
      roleReads += 1;
      plan(1);
      const def = rowsOf(
        await readSingle(azure, roleDefinitionRequest(g.roleDefinitionId), `role definition ${g.roleDefinitionId}`),
        parseRoleDefinitions,
      );
      if (def.state === "refused") otherRefusals.push(def.refusal);
      roleNames.set(guid, def.state === "read" ? (def.rows[0]?.roleName ?? null) : null);
    }
    const named = grants.rows.map((g) => ({
      ...g,
      roleName: roleNames.get(lastSegment(g.roleDefinitionId).toLowerCase()) ?? null,
    }));
    // A grant whose role definition was skipped by the cap or refused has no
    // name: the principal's roles are not fully known, so it counts as unread.
    if (named.some((g) => g.roleName === null)) roleNamesUnreadKeys.add(t.key);
    roles.set(t.key, readRows(named));
  }

  // ----------------------------------------------------------- 6. assemble
  const built = buildLoggingMap(tree, scopeReads, classifications, owners, roles, input.now, {
    isUnclassified: (c) => c.verdict === "unknown",
    isLegacyOwner,
    legacyGrantedRoles: LEGACY_GRANTED_ROLES_TEXT,
    malformedRows,
  });
  // counts.rolesUnread from the model counts refused role-assignment READS per
  // principalKey. A principal whose grants were read but whose role names were
  // not (definition GET over the cap or refused) is just as unread to the
  // operator, so it is added here; a key cannot be in both sets (a refused
  // read has no grants).
  const map: LoggingMap<LoggingClass, Ownership> = {
    ...built,
    counts: { ...built.counts, rolesUnread: built.counts.rolesUnread + roleNamesUnreadKeys.size },
  };

  return {
    map,
    start,
    subscriptions,
    refusals: [...refusalsOf(scopeReads), ...otherRefusals],
    definitionsSkipped,
    roleDefinitionsSkipped,
    roleNamesUnread: roleNamesUnreadKeys.size,
    requests: done,
  };
}
