/**
 * Where one policy assignment reaches, for the Azure Logging Map (AZR-19,
 * phase 1, READ-ONLY): inheritance down the scope tree, the gaps cut into it
 * (notScopes, exemptions, resource selectors), and an HONEST unknown wherever
 * a refused read leaves the answer open.
 *
 * THE RULE THIS MODULE KEEPS. A scope whose reads were refused is `unknown`,
 * never `not-reached` and never `covered`. The legacy gap analysis this map
 * replaces answered a failed read with an empty list (`catch { return @() }`,
 * Analyze-ComplianceGaps.ps1:232-244), so "unreadable" and "not covered" came
 * out the same. `traceSummary` therefore counts `unknown` on its own and never
 * folds it into `notReached`.
 *
 * How a scope S is judged for an assignment A set at origin O:
 *
 * THE CHAIN of S is the scopes A must pass through to reach S, highest first,
 * ending at S. When the tree links S under O it is the tree path from O down
 * to S. When it does not (O is an unread origin, such as an unreadable Tenant
 * Root, or the tree above S is incomplete) it is every KNOWN ancestor of S
 * plus S: an `atScope()` read lists what applies at a scope and above it,
 * never below, so a known ancestor whose read carries A sits beneath O.
 *
 * 1. REACHED when S is O or a tree descendant of O, or any scope on S's chain
 *    has a `read` assignments list that carries A (an `atScope()` read lists
 *    what applies at that scope, which is direct evidence even when the tree
 *    never linked it under O, and what applies at an ancestor applies at S).
 * 2. A reached scope is PROVEN when some scope on its chain has a `read`
 *    assignments list that carries A. Reached but unproven is `unknown`
 *    (`assignments-unread`). The same evidence therefore gives the same
 *    verdict whether or not O itself could be read.
 * 3. NOT REACHED is only stated when it is known: S's own assignments list was
 *    `read` and lacks A, or S's ancestry is complete up to the Tenant Root and
 *    O is not on it. Otherwise `unknown` (`ancestry-unknown`).
 * 4. On a proven scope, in precedence order:
 *    - `excluded`: a scope on S's chain is in A's notScopes (`by` is the
 *      highest such scope).
 *    - `exempt` / `partially-exempt`: an unexpired exemption for A placed at S
 *      or above it, found in the `read` exemptions of S or an ancestor. An
 *      exemption naming policyDefinitionReferenceIds exempts only those members
 *      of an initiative, so it is `partially-exempt`.
 *    - `covered-exemptions-unknown`: S's exemptions read was refused. Never
 *      plain `covered`: an exemption might be hiding there. The facts known
 *      without the exemptions read ride along as SECONDARY fields: `belowCount`
 *      (notScopes beneath a subscription, read from the assignment itself - a
 *      lower bound) and `regions` (from resourceSelectors). Each is present
 *      only when non-empty.
 *    - `partial` (subscriptions only): notScopes or unexpired exemptions on a
 *      resource group or resource beneath S, with their count; `regions` rides
 *      along when A also carries resourceSelectors.
 *    - `conditional`: A carries resourceSelectors; the regions come from the
 *      selectors themselves, never from the assignment's name (the legacy
 *      MultiRegion assignments dropped their selectors,
 *      Deploy-CommunityPolicyInitiative.ps1:1162-1188).
 *    - `covered`.
 *    One scope has one state, so the secondary fields are how a gap pill the
 *    mockup draws separately ("N below excluded", "regions:") survives a
 *    higher-precedence state.
 * 5. An EXPIRED exemption is information only and does not change the state.
 *    "Expired" is judged against an injected `now` (an ISO string), never a
 *    clock. `expiredExemptions` lists those applying at S or above, and, for a
 *    subscription, those on resource groups or resources beneath it.
 *
 * Placeholder nodes (the parent-unknown holder) are not Azure scopes and get
 * no coverage entry.
 *
 * Pure: no IO, no clock, no randomness. Domain - imports no usecase.
 */

import type { ListRead } from "./list-read";
import type { PolicyAssignment, PolicyExemption, ScopeKind, ScopeRead } from "./logging-map-types";
import { ancestorsOf, normaliseScopeId, type ScopeTree } from "./scope-tree";

/** One distinct assignment and where it was seen. */
export interface Placement {
  readonly assignment: PolicyAssignment;
  /** Normalised assignment id - the dedupe key. */
  readonly assignmentKey: string;
  /** Normalised `properties.scope`: where the assignment is set. */
  readonly originId: string;
  /** Normalised ids of the scopes whose `read` assignments list carried it. */
  readonly seenAt: readonly string[];
}

/** Why a scope's coverage could not be judged. */
export type UnknownWhy =
  /** Reached by the tree, but no read on the path proves the assignment. */
  | "assignments-unread"
  /** Not linked under the origin, and the tree above is incomplete. */
  | "ancestry-unknown";

/** The judged coverage of one scope for one assignment. */
export type CoverageState =
  | { readonly state: "covered" }
  | { readonly state: "conditional"; readonly regions: readonly string[] }
  | {
      readonly state: "partial";
      readonly belowCount: number;
      /** Present when A also carries resourceSelectors. */
      readonly regions?: readonly string[];
    }
  | {
      readonly state: "covered-exemptions-unknown";
      /** notScopes beneath this subscription (a lower bound); present when > 0. */
      readonly belowCount?: number;
      /** Present when A carries resourceSelectors. */
      readonly regions?: readonly string[];
    }
  | { readonly state: "exempt"; readonly exemptionIds: readonly string[] }
  | {
      readonly state: "partially-exempt";
      readonly exemptionIds: readonly string[];
      readonly referenceIds: readonly string[];
    }
  | { readonly state: "excluded"; readonly by: string }
  | { readonly state: "unknown"; readonly why: UnknownWhy }
  | { readonly state: "not-reached" };

export type CoverageStateName = CoverageState["state"];

/** One scope's coverage entry. */
export interface ScopeCoverage {
  readonly scopeId: string;
  readonly kind: ScopeKind;
  readonly coverage: CoverageState;
  /** True when this scope is where the assignment is set. */
  readonly isOrigin: boolean;
  /** Exemptions for this assignment that applied here but have expired. Info only. */
  readonly expiredExemptions: readonly PolicyExemption[];
}

/** An assignment's coverage over every non-placeholder scope in the tree. */
export interface AssignmentCoverage {
  readonly assignmentKey: string;
  readonly originId: string;
  /** Keyed by normalised scope id. */
  readonly byScope: ReadonlyMap<string, ScopeCoverage>;
}

/** Subscription counts for a trace. `unknown` is never folded into `notReached`. */
export interface TraceSummary {
  /** Plain `covered`. */
  readonly subscriptionsCovered: number;
  /** Covered, but the exemptions read was refused. Counted apart from covered. */
  readonly coveredExemptionsUnknown: number;
  readonly excluded: number;
  /** `exempt` plus `partially-exempt`. */
  readonly exempt: number;
  readonly partial: number;
  readonly conditional: number;
  readonly unknown: number;
  readonly notReached: number;
}

function rowsOf<T>(read: ListRead<T> | undefined): readonly T[] | null {
  return read !== undefined && read.state === "read" ? read.rows : null;
}

/**
 * Every distinct assignment across the scope reads, deduped by normalised id
 * (an inherited assignment comes back from every scope beneath its origin).
 * First-seen order; refused reads contribute nothing.
 */
export function placementsFor(scopeReads: readonly ScopeRead[]): readonly Placement[] {
  const order: string[] = [];
  const byKey = new Map<string, { assignment: PolicyAssignment; seenAt: string[] }>();
  for (const sr of scopeReads) {
    const rows = rowsOf(sr.assignments);
    if (rows === null) continue;
    const at = normaliseScopeId(sr.scopeId);
    for (const a of rows) {
      const key = normaliseScopeId(a.id);
      if (key === "") continue;
      const rec = byKey.get(key);
      if (rec === undefined) {
        order.push(key);
        byKey.set(key, { assignment: a, seenAt: [at] });
      } else if (!rec.seenAt.includes(at)) {
        rec.seenAt.push(at);
      }
    }
  }
  return order.map((key) => {
    const rec = byKey.get(key) as { assignment: PolicyAssignment; seenAt: string[] };
    return {
      assignment: rec.assignment,
      assignmentKey: key,
      originId: normaliseScopeId(rec.assignment.scope),
      seenAt: rec.seenAt,
    };
  });
}

/** True when the ISO `expiresOn` is at or before the ISO `now`. Unparseable: not expired. */
export function isExpired(expiresOn: string | null, now: string): boolean {
  if (expiresOn === null) return false;
  const e = Date.parse(expiresOn);
  const n = Date.parse(now);
  if (Number.isNaN(e) || Number.isNaN(n)) return false;
  return e <= n;
}

/** The regions a set of resource selectors limits the assignment to. */
export function selectorRegions(assignment: PolicyAssignment): readonly string[] {
  const out: string[] = [];
  for (const sel of assignment.resourceSelectors) {
    for (const clause of sel.selectors) {
      if (clause.kind.toLowerCase() !== "resourcelocation") continue;
      for (const r of clause.in) if (!out.includes(r)) out.push(r);
      for (const r of clause.notIn) {
        const label = `not ${r}`;
        if (!out.includes(label)) out.push(label);
      }
    }
  }
  return out;
}

function isBeneath(id: string, scopeId: string): boolean {
  return id.startsWith(`${scopeId}/`);
}

/**
 * Judge an assignment's coverage at every non-placeholder scope of the tree.
 * See the module header for the rules, in order.
 */
export function coverageOf(
  tree: ScopeTree,
  assignment: PolicyAssignment,
  scopeReads: readonly ScopeRead[],
  now: string,
): AssignmentCoverage {
  const key = normaliseScopeId(assignment.id);
  const originId = normaliseScopeId(assignment.scope);
  const notScopes = assignment.notScopes.map(normaliseScopeId).filter((s) => s !== "");
  const readByScope = new Map<string, ScopeRead>();
  for (const sr of scopeReads) readByScope.set(normaliseScopeId(sr.scopeId), sr);

  const listsIt = (scopeId: string): boolean => {
    const rows = rowsOf(readByScope.get(scopeId)?.assignments);
    return rows !== null && rows.some((a) => normaliseScopeId(a.id) === key);
  };
  const assignmentsRead = (scopeId: string): boolean =>
    readByScope.get(scopeId)?.assignments.state === "read";
  const forThis = (ex: PolicyExemption): boolean =>
    normaliseScopeId(ex.policyAssignmentId) === key;

  const regions = selectorRegions(assignment);
  const byScope = new Map<string, ScopeCoverage>();

  for (const node of tree.nodes) {
    if (node.kind === "placeholder") continue;
    const id = node.id;
    const ancestors = ancestorsOf(tree, id);
    const ancestorIds = ancestors.map((a) => a.id);
    const originIndex = ancestorIds.indexOf(originId);
    const inSubtree = id === originId || originIndex >= 0;
    // The chain, highest first, ending at S (module header): the tree path
    // from the origin down to S when linked, else every known ancestor and S.
    const chain = id === originId
      ? [id]
      : originIndex >= 0
        ? [...ancestorIds.slice(0, originIndex + 1).reverse(), id]
        : [...[...ancestorIds].reverse(), id];
    const proven = chain.some(listsIt);
    const reached = inSubtree || proven;
    const atAndAbove = new Set<string>([id, ...ancestorIds]);

    // Expired exemptions are gathered whatever the state, as information.
    const exemptionPool: PolicyExemption[] = [];
    const poolKeys = new Set<string>();
    for (const sid of [id, ...ancestorIds]) {
      for (const ex of rowsOf(readByScope.get(sid)?.exemptions) ?? []) {
        const exKey = normaliseScopeId(ex.id);
        if (!forThis(ex) || poolKeys.has(exKey)) continue;
        poolKeys.add(exKey);
        exemptionPool.push(ex);
      }
    }
    const applying = exemptionPool.filter((ex) => atAndAbove.has(normaliseScopeId(ex.scope)));
    const active = applying.filter((ex) => !isExpired(ex.expiresOn, now));
    // Beneath a subscription: resource groups and resources. A subscription-
    // level fact, as `partial` is.
    const isSub = node.kind === "subscription";
    const beneath = isSub
      ? exemptionPool.filter((ex) => isBeneath(normaliseScopeId(ex.scope), id))
      : [];
    const expired = [...applying, ...beneath].filter((ex) => isExpired(ex.expiresOn, now));
    const notScopesBelow = isSub ? notScopes.filter((n) => isBeneath(n, id)).length : 0;
    const exemptionsBelow = beneath.filter((ex) => !isExpired(ex.expiresOn, now)).length;
    const hasSelectors = assignment.resourceSelectors.length > 0;

    let coverage: CoverageState;
    if (!reached) {
      const top = ancestors.length > 0 ? ancestors[ancestors.length - 1] : node;
      const ancestryComplete = top !== undefined && top.kind === "tenant-root";
      coverage = assignmentsRead(id) || ancestryComplete
        ? { state: "not-reached" }
        : { state: "unknown", why: "ancestry-unknown" };
    } else if (!proven) {
      coverage = { state: "unknown", why: "assignments-unread" };
    } else {
      const excludedBy = chain.find((p) => notScopes.includes(p));
      if (excludedBy !== undefined) {
        coverage = { state: "excluded", by: excludedBy };
      } else if (active.length > 0) {
        const whole = active.filter((ex) => ex.policyDefinitionReferenceIds.length === 0);
        if (whole.length > 0) {
          coverage = { state: "exempt", exemptionIds: whole.map((ex) => ex.id) };
        } else {
          const refs: string[] = [];
          for (const ex of active) {
            for (const r of ex.policyDefinitionReferenceIds) if (!refs.includes(r)) refs.push(r);
          }
          coverage = {
            state: "partially-exempt",
            exemptionIds: active.map((ex) => ex.id),
            referenceIds: refs,
          };
        }
      } else if (readByScope.get(id)?.exemptions.state !== "read") {
        // The notScopes count is read from the assignment itself, so it is
        // known without the exemptions read; carry it, and the regions.
        coverage = {
          state: "covered-exemptions-unknown",
          ...(notScopesBelow + exemptionsBelow > 0 ? { belowCount: notScopesBelow + exemptionsBelow } : {}),
          ...(hasSelectors ? { regions } : {}),
        };
      } else {
        const below = notScopesBelow + exemptionsBelow;
        if (below > 0) {
          coverage = { state: "partial", belowCount: below, ...(hasSelectors ? { regions } : {}) };
        } else if (hasSelectors) coverage = { state: "conditional", regions };
        else coverage = { state: "covered" };
      }
    }

    byScope.set(id, {
      scopeId: id,
      kind: node.kind,
      coverage,
      isOrigin: id === originId,
      expiredExemptions: expired,
    });
  }

  return { assignmentKey: key, originId, byScope };
}

/** Subscription counts for one assignment's coverage. */
export function traceSummary(coverage: AssignmentCoverage): TraceSummary {
  let subscriptionsCovered = 0;
  let coveredExemptionsUnknown = 0;
  let excluded = 0;
  let exempt = 0;
  let partial = 0;
  let conditional = 0;
  let unknown = 0;
  let notReached = 0;
  for (const sc of coverage.byScope.values()) {
    if (sc.kind !== "subscription") continue;
    switch (sc.coverage.state) {
      case "covered": subscriptionsCovered += 1; break;
      case "covered-exemptions-unknown": coveredExemptionsUnknown += 1; break;
      case "excluded": excluded += 1; break;
      case "exempt":
      case "partially-exempt": exempt += 1; break;
      case "partial": partial += 1; break;
      case "conditional": conditional += 1; break;
      case "unknown": unknown += 1; break;
      case "not-reached": notReached += 1; break;
    }
  }
  return {
    subscriptionsCovered,
    coveredExemptionsUnknown,
    excluded,
    exempt,
    partial,
    conditional,
    unknown,
    notReached,
  };
}
