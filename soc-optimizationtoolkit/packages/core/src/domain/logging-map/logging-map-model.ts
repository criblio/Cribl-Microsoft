/**
 * The assembled Azure Logging Map (AZR-19, phase 1, READ-ONLY): one value the
 * screen renders, built from the scope tree, the per-scope reads, and the
 * judgements other modules made (logging class, owner, roles).
 *
 * WHAT IT GUARANTEES.
 * - Each assignment appears ONCE in `setHere` (at its origin) and once in
 *   `inherited` per scope it reaches, however many scope reads returned it.
 * - Per-scope assignment and exemption figures are a {@link Listing} minted by
 *   `toListingFromRead`: a `read` list of zero rows is a stated `none`, a
 *   refused list is `empty` with a NULL count - never 0.
 * - Roles are a `ListRead`: a refused role read stays refused, it never
 *   becomes "no roles".
 * - Every count of what could not be read is derived from the reads, not kept
 *   beside them (`refusalsOf`).
 *
 * The classification and owner shapes belong to `logging-classifier.ts` and
 * `ownership.ts`; this module takes them as opaque values (generic `C` and `O`)
 * with the two predicates it needs, so it does not depend on their internals.
 *
 * Pure: no IO, no clock, no randomness. Domain - imports no usecase.
 */

import type { Listing } from "../inventory-listing";
import { refusalsOf, toListingFromRead, type ListRead } from "./list-read";
import type {
  AssignmentIdentity,
  PolicyAssignment,
  PolicyExemption,
  RoleGrant,
  ScopeNode,
  ScopeRead,
} from "./logging-map-types";
import {
  coverageOf,
  placementsFor,
  traceSummary,
  type AssignmentCoverage,
  type CoverageState,
  type TraceSummary,
} from "./coverage";
import { ensureOriginScopes, normaliseScopeId, PARENT_UNKNOWN_ID, type ScopeTree } from "./scope-tree";

/** A role the legacy writer granted its identity, shown as text for legacy-owned assignments. */
export interface LegacyGrantedRole {
  readonly roleName: string;
  /** Where the legacy granted it, in words: "management group", "Event Hub namespace". */
  readonly at: string;
}

/**
 * The key a role read is stored under: the scope it was read at plus the
 * principal, both normalised. The usecase dedupes role reads by this key.
 */
export function principalKey(scope: string, principalId: string): string {
  return `${normaliseScopeId(scope)}|${principalId.trim().toLowerCase()}`;
}

/** The principal ids an assignment's identity carries, system-assigned first, each once. */
export function principalIdsOf(identity: AssignmentIdentity): readonly string[] {
  const out: string[] = [];
  const add = (p: string | null): void => {
    if (p === null || p.trim() === "") return;
    if (!out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
  };
  add(identity.principalId);
  for (const u of identity.userAssigned) add(u.principalId);
  return out;
}

/**
 * Why an assignment has no roles value:
 * - `no-identity`: the assignment has no managed identity.
 * - `principal-not-given`: it has one, but ARM gave no principal id.
 * - `not-read`: a principal exists, but no role read was made for it (an
 *   assignment the default view does not show). Not a refusal; not counted.
 * - `some-not-read`: the identity carries several principals and a role read
 *   was made for some but not all. `roles` holds the grants of the principals
 *   that WERE read and `principalsNotRead` names the rest, so a partial list
 *   is never rendered as the whole one.
 */
export type RolesNote = "no-identity" | "principal-not-given" | "not-read" | "some-not-read";

/** One assignment, with everything the details panel shows about it. */
export interface MapAssignment<C, O> {
  readonly assignment: PolicyAssignment;
  readonly assignmentKey: string;
  readonly originId: string;
  /** The logging classification, or null when none was supplied. */
  readonly classification: C | null;
  readonly unclassified: boolean;
  /** The owner recognition, or null when none was supplied. */
  readonly ownership: O | null;
  readonly identity: AssignmentIdentity;
  readonly principalIds: readonly string[];
  /** Merged role reads over every principal; null with a `rolesNote` when there is none. */
  readonly roles: ListRead<RoleGrant> | null;
  readonly rolesNote: RolesNote | null;
  /** Principals with no role read made (`some-not-read`, `not-read`); else []. */
  readonly principalsNotRead: readonly string[];
  /** The roles the legacy writer granted, for legacy-owned assignments; else []. */
  readonly legacyGrantedRoles: readonly LegacyGrantedRole[];
  readonly coverage: AssignmentCoverage;
  readonly summary: TraceSummary;
}

/** An assignment reaching a scope from elsewhere. */
export interface InheritedRef {
  readonly assignmentKey: string;
  readonly originId: string;
  readonly coverage: CoverageState;
}

/** A gap one assignment has at one scope: anything other than covered or not-reached. */
export interface GapRef {
  readonly assignmentKey: string;
  readonly coverage: CoverageState;
}

/** One scope node with what is set, inherited and missing there. */
export interface MapNode {
  readonly node: ScopeNode;
  /** Keys of the assignments set at this scope. */
  readonly setHere: readonly string[];
  readonly inherited: readonly InheritedRef[];
  readonly gaps: readonly GapRef[];
  /** The scope's assignments list: `none` is a verified zero, `empty` is UNKNOWN. */
  readonly assignments: Listing<PolicyAssignment>;
  readonly exemptions: Listing<PolicyExemption>;
  /** Row counts, or null when the list was not read. Never 0 for unknown. */
  readonly assignmentCount: number | null;
  readonly exemptionCount: number | null;
}

/** Counts of the map and of everything it could not read. */
export interface MapCounts {
  /** Real scopes (placeholders excluded). */
  readonly scopes: number;
  readonly assignmentsRefused: number;
  readonly exemptionsRefused: number;
  readonly unreadOrigin: number;
  /** Subscriptions hung under the parent-unknown holder. */
  readonly parentUnknown: number;
  readonly assignmentsUnclassified: number;
  /**
   * Refused role READS, counted once per distinct {@link principalKey} that
   * a counted assignment uses - not per assignment. Legacy Cribl-AL-* and
   * Cribl-AU-* at one management group share cribl-diag-policy-identity, so
   * one refused read is one unread, however many assignments show it.
   */
  readonly rolesUnread: number;
  readonly malformedRows: number;
}

export interface LoggingMap<C, O> {
  /** The tree with every unread origin materialised. */
  readonly tree: ScopeTree;
  /** In tree order. */
  readonly nodes: readonly MapNode[];
  readonly nodesById: ReadonlyMap<string, MapNode>;
  /** In first-seen order. */
  readonly assignments: readonly MapAssignment<C, O>[];
  readonly assignmentsByKey: ReadonlyMap<string, MapAssignment<C, O>>;
  readonly counts: MapCounts;
}

export interface BuildLoggingMapOptions<C, O> {
  /** True when a supplied classification still means "unclassified" (definition unread). */
  readonly isUnclassified?: (classification: C) => boolean;
  /** True when the owner is the legacy writer, which earns `legacyGrantedRoles`. */
  readonly isLegacyOwner?: (owner: O) => boolean;
  readonly legacyGrantedRoles?: readonly LegacyGrantedRole[];
  /** Rows the parsers dropped as malformed, summed by the caller. */
  readonly malformedRows?: number;
}

function lookup<V>(map: ReadonlyMap<string, V>, rawKey: string, key: string): V | undefined {
  return map.get(key) ?? map.get(rawKey);
}

function mergeRoles(
  scope: string,
  principalIds: readonly string[],
  roles: ReadonlyMap<string, ListRead<RoleGrant>>,
): {
  roles: ListRead<RoleGrant> | null;
  note: RolesNote | null;
  notRead: string[];
  refusedKeys: string[];
} {
  const found: ListRead<RoleGrant>[] = [];
  const notRead: string[] = [];
  const refusedKeys: string[] = [];
  for (const p of principalIds) {
    const k = principalKey(scope, p);
    const r = roles.get(k);
    if (r === undefined) notRead.push(p);
    else {
      found.push(r);
      if (r.state === "refused") refusedKeys.push(k);
    }
  }
  if (found.length === 0) return { roles: null, note: "not-read", notRead, refusedKeys };
  const refused = found.find((r) => r.state === "refused");
  // A refusal outranks a missing read: the list is unknown either way.
  if (refused !== undefined) return { roles: refused, note: null, notRead, refusedKeys };
  const rows: RoleGrant[] = [];
  for (const r of found) if (r.state === "read") rows.push(...r.rows);
  return {
    roles: { state: "read", rows },
    note: notRead.length > 0 ? "some-not-read" : null,
    notRead,
    refusedKeys,
  };
}

function countOf<T>(listing: Listing<T>): number | null {
  if (listing.kind === "rows") return listing.rows.length;
  if (listing.kind === "none") return 0;
  return null;
}

const EMPTY_LISTING = { kind: "empty" } as const;

/**
 * Assemble the map.
 *
 * - `classifications` and `owners` are keyed by assignment id (normalised, or
 *   as ARM spelled it); a missing classification counts as unclassified.
 * - `roles` is keyed by {@link principalKey}(assignment.scope, principalId).
 * - `now` is an ISO string, used only to judge exemption expiry.
 */
export function buildLoggingMap<C, O>(
  treeIn: ScopeTree,
  scopeReads: readonly ScopeRead[],
  classifications: ReadonlyMap<string, C>,
  owners: ReadonlyMap<string, O>,
  roles: ReadonlyMap<string, ListRead<RoleGrant>>,
  now: string,
  options: BuildLoggingMapOptions<C, O> = {},
): LoggingMap<C, O> {
  const placements = placementsFor(scopeReads);
  const tree = ensureOriginScopes(treeIn, placements.map((p) => p.assignment.scope));
  const readByScope = new Map<string, ScopeRead>();
  for (const sr of scopeReads) readByScope.set(normaliseScopeId(sr.scopeId), sr);

  const assignments: MapAssignment<C, O>[] = [];
  const assignmentsByKey = new Map<string, MapAssignment<C, O>>();
  let unclassifiedCount = 0;
  const refusedRoleReads = new Set<string>();
  for (const p of placements) {
    const a = p.assignment;
    const classification = lookup(classifications, a.id, p.assignmentKey) ?? null;
    const unclassified = classification === null
      || (options.isUnclassified !== undefined && options.isUnclassified(classification));
    if (unclassified) unclassifiedCount += 1;
    const ownership = lookup(owners, a.id, p.assignmentKey) ?? null;
    const principalIds = principalIdsOf(a.identity);
    const hasIdentity = a.identity.type !== "" && a.identity.type.toLowerCase() !== "none";
    let roleValue: ListRead<RoleGrant> | null = null;
    let note: RolesNote | null = null;
    let principalsNotRead: readonly string[] = [];
    if (!hasIdentity && principalIds.length === 0) note = "no-identity";
    else if (principalIds.length === 0) note = "principal-not-given";
    else {
      const merged = mergeRoles(a.scope, principalIds, roles);
      roleValue = merged.roles;
      note = merged.note;
      principalsNotRead = merged.notRead;
      for (const k of merged.refusedKeys) refusedRoleReads.add(k);
    }
    const isLegacy = ownership !== null
      && options.isLegacyOwner !== undefined
      && options.isLegacyOwner(ownership);
    const coverage = coverageOf(tree, a, scopeReads, now);
    const entry: MapAssignment<C, O> = {
      assignment: a,
      assignmentKey: p.assignmentKey,
      originId: p.originId,
      classification,
      unclassified,
      ownership,
      identity: a.identity,
      principalIds,
      roles: roleValue,
      rolesNote: note,
      principalsNotRead,
      legacyGrantedRoles: isLegacy ? (options.legacyGrantedRoles ?? []) : [],
      coverage,
      summary: traceSummary(coverage),
    };
    assignments.push(entry);
    assignmentsByKey.set(p.assignmentKey, entry);
  }

  const nodes: MapNode[] = [];
  const nodesById = new Map<string, MapNode>();
  for (const node of tree.nodes) {
    const setHere: string[] = [];
    const inherited: InheritedRef[] = [];
    const gaps: GapRef[] = [];
    for (const entry of assignments) {
      const sc = entry.coverage.byScope.get(node.id);
      if (sc === undefined) continue;
      const state = sc.coverage.state;
      if (sc.isOrigin) setHere.push(entry.assignmentKey);
      else if (state !== "not-reached" && state !== "excluded" && state !== "unknown") {
        inherited.push({ assignmentKey: entry.assignmentKey, originId: entry.originId, coverage: sc.coverage });
      }
      if (state !== "covered" && state !== "not-reached") {
        gaps.push({ assignmentKey: entry.assignmentKey, coverage: sc.coverage });
      }
    }
    const sr = readByScope.get(node.id);
    const assignmentListing: Listing<PolicyAssignment> = sr === undefined
      ? EMPTY_LISTING
      : toListingFromRead(sr.assignments);
    const exemptionListing: Listing<PolicyExemption> = sr === undefined
      ? EMPTY_LISTING
      : toListingFromRead(sr.exemptions);
    const mapNode: MapNode = {
      node,
      setHere,
      inherited,
      gaps,
      assignments: assignmentListing,
      exemptions: exemptionListing,
      assignmentCount: countOf(assignmentListing),
      exemptionCount: countOf(exemptionListing),
    };
    nodes.push(mapNode);
    nodesById.set(node.id, mapNode);
  }

  const counts: MapCounts = {
    scopes: tree.nodes.filter((n) => n.kind !== "placeholder").length,
    assignmentsRefused: refusalsOf(scopeReads.map((r) => r.assignments)).length,
    exemptionsRefused: refusalsOf(scopeReads.map((r) => r.exemptions)).length,
    unreadOrigin: tree.nodes.filter((n) => n.treeRole === "unread-origin").length,
    parentUnknown: tree.childrenOf.get(PARENT_UNKNOWN_ID)?.length ?? 0,
    assignmentsUnclassified: unclassifiedCount,
    rolesUnread: refusedRoleReads.size,
    malformedRows: options.malformedRows ?? 0,
  };

  return { tree, nodes, nodesById, assignments, assignmentsByKey, counts };
}
