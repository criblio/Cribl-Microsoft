/**
 * The management-group / subscription hierarchy for the Azure Logging Map
 * (AZR-19). Where the tree starts is the card's third default: the Tenant Root
 * when it can be read, otherwise the highest management groups that can be
 * (`rootsFromVisible`), with subscriptions whose parent was never read hung
 * under ONE `parent-unknown` holder rather than scattered as fake roots.
 *
 * Ids are compared NORMALISED (lower-case, no trailing slash): ARM itself is
 * case-insensitive about scope ids and returns the same management group as
 * `/providers/Microsoft.Management/managementGroups/x` in one response and
 * `/providers/microsoft.management/managementgroups/x` in another.
 *
 * Pure: no IO, no Date, no randomness. Domain - imports no usecase.
 */

import type { ScopeEntry, ScopeKind, ScopeNode, ScopeTreeRole } from "./logging-map-types";

const MG_PREFIX = "/providers/microsoft.management/managementgroups/";
const SUB_PATTERN = /^\/subscriptions\/[^/]+$/;

/** The id of the synthetic holder for subscriptions with an unread parent. */
export const PARENT_UNKNOWN_ID = "placeholder:parent-unknown";

/** The arranged hierarchy. Every id in here is normalised. */
export interface ScopeTree {
  readonly tenantId: string;
  /** Every node, in first-seen order; placeholders after real scopes. */
  readonly nodes: readonly ScopeNode[];
  readonly byId: ReadonlyMap<string, ScopeNode>;
  /** Child ids per parent id, in first-seen order. Leaves have no entry. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** Ids of the nodes with no parent, in first-seen order. */
  readonly roots: readonly string[];
}

/**
 * Normalise an ARM scope id for comparison: trimmed, a leading slash, no
 * trailing slash, lower-case.
 */
export function normaliseScopeId(id: string): string {
  let s = id.trim();
  if (s === "") return "";
  if (!s.startsWith("/")) s = `/${s}`;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.toLowerCase();
}

/** ARM id of a management group, from its name, in ARM's own casing. */
export function managementGroupId(name: string): string {
  return `/providers/Microsoft.Management/managementGroups/${name}`;
}

/** The last path segment of an id (a management group or subscription name). */
export function lastSegment(id: string): string {
  const parts = id.split("/").filter((p) => p !== "");
  return parts.length === 0 ? "" : (parts[parts.length - 1] ?? "");
}

/** True when the (any-case) id is a management group id. */
export function isManagementGroupId(id: string): boolean {
  const n = normaliseScopeId(id);
  return n.startsWith(MG_PREFIX) && n.length > MG_PREFIX.length && !n.slice(MG_PREFIX.length).includes("/");
}

/** True when the (any-case) id is a subscription id (not something below one). */
export function isSubscriptionId(id: string): boolean {
  return SUB_PATTERN.test(normaliseScopeId(id));
}

/**
 * The tree kind of an Azure scope id, or null when the id is neither a
 * management group nor a subscription (a resource group, a resource).
 */
export function scopeKindOfId(id: string, tenantId: string): ScopeKind | null {
  if (isManagementGroupId(id)) {
    const name = lastSegment(normaliseScopeId(id));
    return tenantId !== "" && name === tenantId.trim().toLowerCase()
      ? "tenant-root"
      : "management-group";
  }
  if (isSubscriptionId(id)) return "subscription";
  return null;
}

function nodeFrom(
  entry: ScopeEntry,
  kind: ScopeKind,
  parentId: string | null,
  treeRole: ScopeTreeRole,
): ScopeNode {
  const id = normaliseScopeId(entry.id);
  const name = entry.name !== "" ? entry.name : lastSegment(entry.id);
  return {
    id,
    kind,
    name,
    displayName: entry.displayName !== "" ? entry.displayName : name,
    parentId,
    treeRole,
  };
}

function assemble(tenantId: string, nodes: readonly ScopeNode[]): ScopeTree {
  const byId = new Map<string, ScopeNode>();
  for (const n of nodes) byId.set(n.id, n);
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of nodes) {
    if (n.parentId === null) {
      roots.push(n.id);
      continue;
    }
    const list = childrenOf.get(n.parentId);
    if (list === undefined) childrenOf.set(n.parentId, [n.id]);
    else list.push(n.id);
  }
  return { tenantId, nodes, byId, childrenOf, roots };
}

/**
 * Arrange hierarchy entries into a tree.
 *
 * - Entries whose id is neither a management group nor a subscription are
 *   dropped (they are not tree scopes).
 * - The same scope in two casings is ONE node (first entry wins; a later
 *   entry may supply a parent the first lacked).
 * - A management group whose parent is not among the entries becomes a root:
 *   it is the highest visible scope on its branch.
 * - A subscription whose parent is absent or not among the entries hangs under
 *   the single {@link PARENT_UNKNOWN_ID} holder, created only when needed.
 */
export function buildScopeTree(input: {
  readonly tenantId: string;
  readonly entries: readonly ScopeEntry[];
}): ScopeTree {
  const { tenantId } = input;
  const order: string[] = [];
  const first = new Map<string, { entry: ScopeEntry; kind: ScopeKind; parent: string | null }>();
  for (const entry of input.entries) {
    const kind = scopeKindOfId(entry.id, tenantId);
    if (kind === null) continue;
    const id = normaliseScopeId(entry.id);
    const parent = entry.parentId === null || entry.parentId.trim() === ""
      ? null
      : normaliseScopeId(entry.parentId);
    const seen = first.get(id);
    if (seen === undefined) {
      order.push(id);
      first.set(id, { entry, kind, parent });
    } else if (seen.parent === null && parent !== null) {
      first.set(id, { ...seen, parent });
    }
  }

  const nodes: ScopeNode[] = [];
  let orphanSubscriptions = 0;
  for (const id of order) {
    const rec = first.get(id);
    if (rec === undefined) continue;
    const parentVisible = rec.parent !== null && rec.parent !== id && first.has(rec.parent);
    if (rec.kind === "subscription") {
      if (parentVisible) {
        nodes.push(nodeFrom(rec.entry, rec.kind, rec.parent, "listed"));
      } else {
        orphanSubscriptions += 1;
        nodes.push(nodeFrom(rec.entry, rec.kind, PARENT_UNKNOWN_ID, "listed"));
      }
    } else {
      nodes.push(nodeFrom(rec.entry, rec.kind, parentVisible ? rec.parent : null, "listed"));
    }
  }
  if (orphanSubscriptions > 0) {
    nodes.push({
      id: PARENT_UNKNOWN_ID,
      kind: "placeholder",
      name: "parent-unknown",
      displayName: "Parent not read",
      parentId: null,
      treeRole: "parent-unknown",
    });
  }
  return assemble(tenantId, nodes);
}

/**
 * The management groups to treat as roots when the Tenant Root cannot be
 * read: those whose parent is absent or is not itself visible. Returns
 * normalised ids, in input order, each once.
 */
export function rootsFromVisible(managementGroups: readonly ScopeEntry[]): readonly string[] {
  const visible = new Set(managementGroups.map((g) => normaliseScopeId(g.id)));
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const g of managementGroups) {
    const id = normaliseScopeId(g.id);
    if (emitted.has(id)) continue;
    const parent = g.parentId === null || g.parentId.trim() === "" ? null : normaliseScopeId(g.parentId);
    if (parent === null || parent === id || !visible.has(parent)) {
      out.push(id);
      emitted.add(id);
    }
  }
  return out;
}

/**
 * Add an `unread-origin` node for every assignment origin that the tree does
 * not already hold. An `atScope()` read at a readable subscription returns the
 * assignments it inherits, each naming the scope it is set at; when that scope
 * was never listed (its management group is unreadable) it still exists, and
 * dropping it would hide where the subscription's policy comes from.
 *
 * Only management-group and subscription origins are materialised; each
 * distinct scope becomes ONE node, placed as a root (its parent is unknown -
 * it was never read). Returns the same tree when nothing is missing.
 */
export function ensureOriginScopes(tree: ScopeTree, originScopeIds: readonly string[]): ScopeTree {
  const added: ScopeNode[] = [];
  const addedIds = new Set<string>();
  for (const raw of originScopeIds) {
    const id = normaliseScopeId(raw);
    if (id === "" || tree.byId.has(id) || addedIds.has(id)) continue;
    const kind = scopeKindOfId(id, tree.tenantId);
    if (kind === null) continue;
    addedIds.add(id);
    added.push(nodeFrom({ id: raw, name: "", displayName: "", parentId: null }, kind, null, "unread-origin"));
  }
  if (added.length === 0) return tree;
  const real = tree.nodes.filter((n) => n.kind !== "placeholder");
  const placeholders = tree.nodes.filter((n) => n.kind === "placeholder");
  return assemble(tree.tenantId, [...real, ...added, ...placeholders]);
}

/** The ancestors of a scope, nearest first. Unknown id: empty. Cycle-safe. */
export function ancestorsOf(tree: ScopeTree, id: string): readonly ScopeNode[] {
  const out: ScopeNode[] = [];
  const seen = new Set<string>();
  let current = tree.byId.get(normaliseScopeId(id)) ?? tree.byId.get(id);
  if (current !== undefined) seen.add(current.id);
  while (current !== undefined && current.parentId !== null) {
    const parent = tree.byId.get(current.parentId);
    if (parent === undefined || seen.has(parent.id)) break;
    out.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return out;
}

/** Every descendant of a scope, breadth-first. Unknown id: empty. Cycle-safe. */
export function descendantsOf(tree: ScopeTree, id: string): readonly ScopeNode[] {
  const start = tree.byId.has(id) ? id : normaliseScopeId(id);
  const out: ScopeNode[] = [];
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const child of tree.childrenOf.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const node = tree.byId.get(child);
      if (node !== undefined) out.push(node);
      queue.push(child);
    }
  }
  return out;
}
