/**
 * logging-map-state - the pure view state of the Azure Logging Map screen
 * (AZR-19, phase 1, READ-ONLY): a reducer plus the selectors the canvas,
 * outline, panel and toolbar render from. No React, no DOM, no IO, no clock.
 *
 * What it owns, per the approved mockup's interaction model:
 * - OVERVIEW: management groups open two levels deep, deeper ones collapsed
 *   to a count ({@link initialCollapsed}); above 60 visible scopes, each
 *   scope's direct SUBSCRIPTIONS fold into one count card while its
 *   management-group children stay drawn ({@link initialFolded},
 *   {@link MAX_VISIBLE_SCOPES}). Folding never hides a management group, so
 *   the Tenant Root - where Azure puts new subscriptions by default - stays
 *   open however large the tenant is.
 * - SHOWN: ours plus other owners' logging-related assignments by default;
 *   "All policy" reveals the rest; an UNCLASSIFIED assignment (its definition
 *   could not be read) is always shown, because hiding it would turn "could
 *   not tell" into "not logging" ({@link shownAssignments}).
 * - TRACE: one assignment's reach as a per-scope mark. A scope the map could
 *   not judge is `unknown`, never `dimmed` - unknown is not "not reached"
 *   ({@link traceView}).
 * - OUTLINE: the same visible rows, navigated by arrow keys, Home and End;
 *   selection is one value shared with the canvas ({@link outlineKey}).
 * - COUNTS: a figure the map could not read is the UNKNOWN token, never 0
 *   ({@link formatCount}).
 *
 * Tree traversal is done here over the map's own `ScopeTree` data rather than
 * by importing core helpers, so this module depends on core TYPES only.
 */

import type {
  CoverageState,
  LoggingClass,
  LoggingMap,
  MapAssignment,
  MapNode,
  Ownership,
  ScopeCoverage,
  ScopeNode,
} from "@soc/core";

/** The map as this screen reads it: logging classes and owner recognitions. */
export type UiLoggingMap = LoggingMap<LoggingClass, Ownership>;
export type UiMapAssignment = MapAssignment<LoggingClass, Ownership>;

/** Management groups at this depth (roots are depth 1) start collapsed. */
export const COLLAPSE_MG_DEPTH = 3;
/** Above this many visible scopes, subscriptions collapse into their parent's count. */
export const MAX_VISIBLE_SCOPES = 60;
/** What a count reads as when the list behind it could not be read. */
export const UNKNOWN_COUNT = "unknown";

export interface LoggingMapUiState {
  readonly selectedScope: string | null;
  /** The traced assignment's key (normalised id), or null. */
  readonly tracedAssignment: string | null;
  readonly showInherited: boolean;
  readonly showAll: boolean;
  /** Ids of nodes whose children are hidden behind a count. */
  readonly collapsed: ReadonlySet<string>;
  /**
   * Ids of nodes whose direct SUBSCRIPTION children are folded into one count
   * card; their management-group children stay visible. Ignored on a node
   * that is also collapsed (collapse hides everything anyway).
   */
  readonly folded: ReadonlySet<string>;
  readonly search: string;
}

export type LoggingMapAction =
  | { readonly type: "reset"; readonly map: UiLoggingMap }
  | { readonly type: "select"; readonly scopeId: string | null }
  | { readonly type: "trace"; readonly assignmentKey: string | null; readonly map: UiLoggingMap }
  | { readonly type: "set-show-inherited"; readonly value: boolean }
  | { readonly type: "set-show-all"; readonly value: boolean }
  | { readonly type: "toggle-collapsed"; readonly scopeId: string; readonly map: UiLoggingMap }
  /** Fold or unfold a node's direct subscriptions (the scale rule's count card). */
  | { readonly type: "toggle-folded"; readonly scopeId: string; readonly map: UiLoggingMap }
  | { readonly type: "expand-path"; readonly scopeId: string; readonly map: UiLoggingMap }
  | { readonly type: "search"; readonly query: string; readonly map: UiLoggingMap }
  | { readonly type: "outline-key"; readonly key: string; readonly map: UiLoggingMap };

// ---------------------------------------------------------------- tree walks

function childrenOf(map: UiLoggingMap, id: string): readonly string[] {
  return map.tree.childrenOf.get(id) ?? [];
}

function nodeOf(map: UiLoggingMap, id: string): ScopeNode | undefined {
  return map.tree.byId.get(id);
}

/** Ancestor ids, nearest first. Cycle-safe; unknown id gives []. */
export function ancestorIds(map: UiLoggingMap, id: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let current = nodeOf(map, id);
  while (current !== undefined && current.parentId !== null) {
    const parent = nodeOf(map, current.parentId);
    if (parent === undefined || seen.has(parent.id)) break;
    out.push(parent.id);
    seen.add(parent.id);
    current = parent;
  }
  return out;
}

/** Every node id in tree (depth-first, pre-order) order with its depth; roots are depth 1. */
function walkAll(map: UiLoggingMap): { id: string; depth: number }[] {
  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, depth });
    for (const c of childrenOf(map, id)) visit(c, depth + 1);
  };
  for (const r of map.tree.roots) visit(r, 1);
  return out;
}

function subscriptionChildren(map: UiLoggingMap, id: string): readonly string[] {
  return childrenOf(map, id).filter((c) => nodeOf(map, c)?.kind === "subscription");
}

function descendantCount(map: UiLoggingMap, id: string): { managementGroups: number; subscriptions: number } {
  let managementGroups = 0;
  let subscriptions = 0;
  const seen = new Set<string>([id]);
  const queue = [...childrenOf(map, id)];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    const n = nodeOf(map, next);
    if (n?.kind === "subscription") subscriptions += 1;
    else if (n?.kind === "management-group" || n?.kind === "tenant-root") managementGroups += 1;
    queue.push(...childrenOf(map, next));
  }
  return { managementGroups, subscriptions };
}

// ---------------------------------------------------------------- overview

/** A row the outline and the canvas draw: one scope, at its depth. */
export interface VisibleScope {
  readonly id: string;
  readonly node: ScopeNode;
  readonly depth: number;
  readonly parentId: string | null;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  /** What a collapsed node hides, for its count card; zeros when expanded. */
  readonly hidden: { readonly managementGroups: number; readonly subscriptions: number };
  /** Direct subscriptions folded into a count card (0 when not folded, or when collapsed). */
  readonly foldedSubscriptions: number;
}

const NO_FOLDS: ReadonlySet<string> = new Set<string>();

/**
 * The visible rows: tree order, skipping the children of collapsed nodes and
 * the direct subscription children of folded ones.
 */
export function visibleScopes(
  map: UiLoggingMap,
  collapsed: ReadonlySet<string>,
  folded: ReadonlySet<string> = NO_FOLDS,
): readonly VisibleScope[] {
  const out: VisibleScope[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = nodeOf(map, id);
    if (node === undefined) return;
    const kids = childrenOf(map, id);
    const isCollapsed = kids.length > 0 && collapsed.has(id);
    const foldedSubs = !isCollapsed && folded.has(id) ? subscriptionChildren(map, id) : [];
    out.push({
      id,
      node,
      depth,
      parentId: node.parentId,
      hasChildren: kids.length > 0,
      collapsed: isCollapsed,
      hidden: isCollapsed ? descendantCount(map, id) : { managementGroups: 0, subscriptions: 0 },
      foldedSubscriptions: foldedSubs.length,
    });
    if (isCollapsed) return;
    for (const c of kids) if (!foldedSubs.includes(c)) visit(c, depth + 1);
  };
  for (const r of map.tree.roots) visit(r, 1);
  return out;
}

/** Real scopes among the rows; the parent-unknown holder is not an Azure scope. */
function scopeCount(rows: readonly VisibleScope[]): number {
  return rows.filter((r) => r.node.kind !== "placeholder").length;
}

/**
 * The opening collapse set: every management group at depth
 * {@link COLLAPSE_MG_DEPTH} or deeper that has children ("expanded two levels
 * deep"). Size never collapses a node - that is {@link initialFolded}'s job,
 * and it folds only subscriptions.
 */
export function initialCollapsed(map: UiLoggingMap): ReadonlySet<string> {
  const collapsed = new Set<string>();
  for (const { id, depth } of walkAll(map)) {
    const n = nodeOf(map, id);
    const isGroup = n?.kind === "management-group" || n?.kind === "tenant-root";
    if (isGroup && depth >= COLLAPSE_MG_DEPTH && childrenOf(map, id).length > 0) collapsed.add(id);
  }
  return collapsed;
}

/**
 * The opening fold set (the scale rule): when more than
 * {@link MAX_VISIBLE_SCOPES} real scopes would be visible under `collapsed`,
 * every visible node with subscription children folds them into its count.
 * Management groups are never folded away, so a mixed node - the Tenant Root
 * holding both subscriptions and groups - stays drawn with its groups.
 */
export function initialFolded(map: UiLoggingMap, collapsed: ReadonlySet<string>): ReadonlySet<string> {
  const folded = new Set<string>();
  const rows = visibleScopes(map, collapsed);
  if (scopeCount(rows) <= MAX_VISIBLE_SCOPES) return folded;
  for (const r of rows) {
    if (!r.collapsed && subscriptionChildren(map, r.id).length > 0) folded.add(r.id);
  }
  return folded;
}

export function initialState(map: UiLoggingMap): LoggingMapUiState {
  const collapsed = initialCollapsed(map);
  return {
    selectedScope: map.tree.roots[0] ?? null,
    tracedAssignment: null,
    showInherited: true,
    showAll: false,
    collapsed,
    folded: initialFolded(map, collapsed),
    search: "",
  };
}

/** Uncollapse exactly the ancestors of `scopeId`; nothing else changes. */
export function expandPathTo(map: UiLoggingMap, collapsed: ReadonlySet<string>, scopeId: string): ReadonlySet<string> {
  const ancestors = ancestorIds(map, scopeId);
  if (!ancestors.some((a) => collapsed.has(a))) return collapsed;
  const next = new Set(collapsed);
  for (const a of ancestors) next.delete(a);
  return next;
}

/** Unfold the parent of `scopeId` when `scopeId` is a subscription folded into it. */
export function unfoldPathTo(map: UiLoggingMap, folded: ReadonlySet<string>, scopeId: string): ReadonlySet<string> {
  const node = nodeOf(map, scopeId);
  if (node?.kind !== "subscription" || node.parentId === null || !folded.has(node.parentId)) return folded;
  const next = new Set(folded);
  next.delete(node.parentId);
  return next;
}

/** Both halves of "make this scope visible": open collapsed ancestors and unfold its parent. */
function revealPath(
  map: UiLoggingMap,
  state: Pick<LoggingMapUiState, "collapsed" | "folded">,
  scopeId: string,
): Pick<LoggingMapUiState, "collapsed" | "folded"> {
  return {
    collapsed: expandPathTo(map, state.collapsed, scopeId),
    folded: unfoldPathTo(map, state.folded, scopeId),
  };
}

// ---------------------------------------------------------------- shown

/** True when the assignment is in the default view (or showAll is on). */
export function isShown(entry: UiMapAssignment, showAll: boolean): boolean {
  if (showAll) return true;
  // Could not classify: always shown, never silently filed as "not logging".
  if (entry.unclassified || entry.classification === null || entry.classification.verdict === "unknown") return true;
  if (entry.ownership?.owner === "ours") return true;
  return entry.classification.verdict === "yes";
}

/** The assignments the current view shows, in the map's order. */
export function shownAssignments(map: UiLoggingMap, state: Pick<LoggingMapUiState, "showAll">): readonly UiMapAssignment[] {
  return map.assignments.filter((a) => isShown(a, state.showAll));
}

/** One assignment drawn on a scope card. */
export interface ScopeChip {
  readonly entry: UiMapAssignment;
  readonly inherited: boolean;
  /** Where it is set (normalised scope id). */
  readonly originId: string;
  /** The assignment's coverage at this scope, when the map judged it. */
  readonly coverage: CoverageState | null;
}

/** What a scope card shows: set-here chips first, then (when on) inherited ones. */
export function scopeChips(
  map: UiLoggingMap,
  state: Pick<LoggingMapUiState, "showAll" | "showInherited">,
  scopeId: string,
): readonly ScopeChip[] {
  const node: MapNode | undefined = map.nodesById.get(scopeId);
  if (node === undefined) return [];
  const out: ScopeChip[] = [];
  for (const key of node.setHere) {
    const entry = map.assignmentsByKey.get(key);
    if (entry === undefined || !isShown(entry, state.showAll)) continue;
    out.push({
      entry,
      inherited: false,
      originId: entry.originId,
      coverage: entry.coverage.byScope.get(scopeId)?.coverage ?? null,
    });
  }
  if (state.showInherited) {
    for (const ref of node.inherited) {
      const entry = map.assignmentsByKey.get(ref.assignmentKey);
      if (entry === undefined || !isShown(entry, state.showAll)) continue;
      out.push({ entry, inherited: true, originId: ref.originId, coverage: ref.coverage });
    }
  }
  return out;
}

// ---------------------------------------------------------------- trace

/** How a scope is drawn while one assignment is traced. */
export type TraceMark =
  /** The assigning scope, covered clean. A gap or unknown at the origin wins over this. */
  | "origin"
  | "covered"
  /** Covered, but the exemptions read was refused: never drawn as covered-clean. */
  | "covered-exemptions-unknown"
  | "gap-excluded"
  | "gap-exempt"
  | "partial"
  | "conditional"
  | "unknown"
  | "dimmed";

/**
 * The coverage state decides the mark; `origin` only names a CLEAN origin.
 * Following the approved mockup's relation(): unread is unknown first, then
 * excluded, then exempt, and origin only when none apply. So an exemption, a
 * refused exemptions read, an unread origin or resourceSelectors at the
 * assigning scope are drawn as that gap, never as a plain ringed origin.
 */
function markOf(sc: ScopeCoverage): TraceMark {
  switch (sc.coverage.state) {
    case "covered":
      return sc.isOrigin ? "origin" : "covered";
    case "covered-exemptions-unknown":
      return "covered-exemptions-unknown";
    case "excluded":
      return "gap-excluded";
    case "exempt":
    case "partially-exempt":
      return "gap-exempt";
    case "partial":
      return "partial";
    case "conditional":
      return "conditional";
    case "unknown":
      return "unknown";
    case "not-reached":
      return "dimmed";
  }
}

/**
 * The per-scope marks of the traced assignment, or null when nothing is
 * traced (or the key is unknown). Core's coverageOf judges every
 * non-placeholder node, so the unread cases (a refused assignments read, an
 * unread origin) arrive as core state `unknown` and map through
 * {@link markOf}. The only node core leaves out is the parent-unknown holder,
 * which is not an Azure scope and is drawn `dimmed`.
 */
export function traceView(
  map: UiLoggingMap,
  state: Pick<LoggingMapUiState, "tracedAssignment">,
): ReadonlyMap<string, TraceMark> | null {
  if (state.tracedAssignment === null) return null;
  const entry = map.assignmentsByKey.get(state.tracedAssignment);
  if (entry === undefined) return null;
  const out = new Map<string, TraceMark>();
  for (const n of map.nodes) {
    const sc = entry.coverage.byScope.get(n.node.id);
    if (sc !== undefined) {
      out.set(n.node.id, markOf(sc));
      continue;
    }
    // DEFENSIVE ONLY: core never omits a real scope. Should one ever be
    // missing, say unknown rather than claim it was not reached.
    out.set(n.node.id, n.node.kind === "placeholder" ? "dimmed" : "unknown");
  }
  return out;
}

// ---------------------------------------------------------------- counts

/** A count for display: the UNKNOWN token for a list that was not read, never 0. */
export function formatCount(count: number | null): string {
  return count === null ? UNKNOWN_COUNT : String(count);
}

export interface ToolbarCounts {
  readonly scopes: number;
  /** Reads that were refused: the usecase's refusal list when given, else the map's own. */
  readonly couldNotRead: number;
  readonly unclassified: number;
  readonly rolesUnread: number;
  readonly unreadOrigin: number;
  readonly parentUnknown: number;
  /** Assignments the current view shows. */
  readonly shown: number;
  /** Assignments set or inherited at the selected scope, or null when its list was not read. */
  readonly selectedAssignments: number | null;
}

export function toolbarCounts(
  map: UiLoggingMap,
  state: Pick<LoggingMapUiState, "showAll" | "selectedScope">,
  refusals?: readonly unknown[],
): ToolbarCounts {
  const c = map.counts;
  const selected = state.selectedScope === null ? undefined : map.nodesById.get(state.selectedScope);
  return {
    scopes: c.scopes,
    couldNotRead: refusals !== undefined ? refusals.length : c.assignmentsRefused + c.exemptionsRefused,
    unclassified: c.assignmentsUnclassified,
    rolesUnread: c.rolesUnread,
    unreadOrigin: c.unreadOrigin,
    parentUnknown: c.parentUnknown,
    shown: shownAssignments(map, state).length,
    selectedAssignments: selected === undefined ? null : selected.assignmentCount,
  };
}

// ---------------------------------------------------------------- search

/**
 * Scope ids matching the query, in tree order: a scope whose name, display
 * name or id contains it, or that has a set-here assignment whose name or
 * display name contains it. Case-insensitive; a blank query matches nothing.
 */
export function searchMatches(map: UiLoggingMap, query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: string[] = [];
  for (const { id } of walkAll(map)) {
    const n = nodeOf(map, id);
    if (n === undefined) continue;
    const scopeHit = [n.name, n.displayName, n.id].some((s) => s.toLowerCase().includes(q));
    const assignmentHit = (map.nodesById.get(id)?.setHere ?? []).some((k) => {
      const a = map.assignmentsByKey.get(k)?.assignment;
      return a !== undefined && [a.name, a.displayName].some((s) => s.toLowerCase().includes(q));
    });
    if (scopeHit || assignmentHit) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------- outline

/**
 * Outline (role=tree) keyboard navigation over the visible rows.
 * ArrowDown / ArrowUp move; Home / End jump; ArrowRight expands a collapsed
 * node, else unfolds its folded subscriptions, else moves to its first
 * visible child; ArrowLeft collapses an expanded node, else moves to its
 * parent. A key with nothing to do returns the same state.
 */
export function outlineKey(map: UiLoggingMap, state: LoggingMapUiState, key: string): LoggingMapUiState {
  const rows = visibleScopes(map, state.collapsed, state.folded);
  if (rows.length === 0) return state;
  const i = rows.findIndex((r) => r.id === state.selectedScope);
  const select = (id: string | undefined): LoggingMapUiState =>
    id === undefined || id === state.selectedScope ? state : { ...state, selectedScope: id };
  if (i < 0) return key === "End" ? select(rows[rows.length - 1]?.id) : select(rows[0]?.id);
  const row = rows[i];
  if (row === undefined) return state;
  switch (key) {
    case "ArrowDown":
      return select(rows[i + 1]?.id);
    case "ArrowUp":
      return select(rows[i - 1]?.id);
    case "Home":
      return select(rows[0]?.id);
    case "End":
      return select(rows[rows.length - 1]?.id);
    case "ArrowRight":
      if (row.collapsed) return setCollapsed(state, row.id, false);
      if (row.foldedSubscriptions > 0) return setFolded(state, row.id, false);
      // The first VISIBLE child is the next row, when that row is a child.
      return rows[i + 1]?.parentId === row.id ? select(rows[i + 1]?.id) : state;
    case "ArrowLeft":
      if (row.hasChildren && !row.collapsed) return setCollapsed(state, row.id, true);
      return row.parentId !== null && nodeOf(map, row.parentId) !== undefined ? select(row.parentId) : state;
    default:
      return state;
  }
}

function setFolded(state: LoggingMapUiState, id: string, value: boolean): LoggingMapUiState {
  if (state.folded.has(id) === value) return state;
  const next = new Set(state.folded);
  if (value) next.add(id);
  else next.delete(id);
  return { ...state, folded: next };
}

function setCollapsed(state: LoggingMapUiState, id: string, value: boolean): LoggingMapUiState {
  if (state.collapsed.has(id) === value) return state;
  const next = new Set(state.collapsed);
  if (value) next.add(id);
  else next.delete(id);
  return { ...state, collapsed: next };
}

// ---------------------------------------------------------------- reducer

export function loggingMapReducer(state: LoggingMapUiState, action: LoggingMapAction): LoggingMapUiState {
  switch (action.type) {
    case "reset":
      return initialState(action.map);
    case "select":
      return state.selectedScope === action.scopeId ? state : { ...state, selectedScope: action.scopeId };
    case "trace": {
      if (action.assignmentKey === null) return { ...state, tracedAssignment: null };
      const entry = action.map.assignmentsByKey.get(action.assignmentKey);
      if (entry === undefined) return { ...state, tracedAssignment: null };
      return {
        ...state,
        tracedAssignment: action.assignmentKey,
        selectedScope: entry.originId,
        ...revealPath(action.map, state, entry.originId),
      };
    }
    case "set-show-inherited":
      return { ...state, showInherited: action.value };
    case "set-show-all":
      return { ...state, showAll: action.value };
    case "toggle-collapsed":
      // A leaf has nothing to hide: collapsing it is a no-op.
      if (childrenOf(action.map, action.scopeId).length === 0) return state;
      return setCollapsed(state, action.scopeId, !state.collapsed.has(action.scopeId));
    case "toggle-folded":
      // Nothing to fold without subscription children.
      if (subscriptionChildren(action.map, action.scopeId).length === 0) return state;
      return setFolded(state, action.scopeId, !state.folded.has(action.scopeId));
    case "expand-path":
      return { ...state, ...revealPath(action.map, state, action.scopeId) };
    case "search": {
      const matches = searchMatches(action.map, action.query);
      let view: Pick<LoggingMapUiState, "collapsed" | "folded"> = state;
      for (const m of matches) view = revealPath(action.map, view, m);
      return {
        ...state,
        search: action.query,
        collapsed: view.collapsed,
        folded: view.folded,
        selectedScope: matches[0] ?? state.selectedScope,
      };
    }
    case "outline-key":
      return outlineKey(action.map, state, action.key);
  }
}

// ---------------------------------------------------------------- diagram graph

/** A card the layout places: a scope, or the count card standing in for a collapsed group. */
export interface DiagramCard {
  readonly id: string;
  readonly kind: "scope" | "count";
  /**
   * For a count card, what opens it: `collapsed` -> dispatch toggle-collapsed;
   * `folded` -> dispatch toggle-folded. Null on a scope card.
   */
  readonly countOf: "collapsed" | "folded" | null;
  /** The scope this card is (or, for a count card, the collapsed parent). */
  readonly scopeId: string;
  readonly title: string;
  /** Chips the card draws (capped by the layout). */
  readonly chipCount: number;
}

export interface DiagramGraph {
  readonly cards: readonly DiagramCard[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}

/** Id prefix of a count card; never a valid ARM scope id. */
export const COUNT_CARD_PREFIX = "count:";

/** The words on a count card, e.g. "4 subscriptions, 1 management group". */
export function hiddenLabel(hidden: VisibleScope["hidden"]): string {
  const parts: string[] = [];
  if (hidden.managementGroups > 0) {
    parts.push(`${hidden.managementGroups} management group${hidden.managementGroups === 1 ? "" : "s"}`);
  }
  if (hidden.subscriptions > 0) {
    parts.push(`${hidden.subscriptions} subscription${hidden.subscriptions === 1 ? "" : "s"}`);
  }
  return parts.length === 0 ? "Nothing below" : parts.join(", ");
}

/** The cards and parent-child edges the canvas lays out for the current view. */
export function diagramGraph(map: UiLoggingMap, state: LoggingMapUiState): DiagramGraph {
  const rows = visibleScopes(map, state.collapsed, state.folded);
  const shownIds = new Set(rows.map((r) => r.id));
  const cards: DiagramCard[] = [];
  const edges: { from: string; to: string }[] = [];
  for (const r of rows) {
    cards.push({
      id: r.id,
      kind: "scope",
      countOf: null,
      scopeId: r.id,
      title: r.node.displayName,
      chipCount: scopeChips(map, state, r.id).length,
    });
    if (r.parentId !== null && shownIds.has(r.parentId)) edges.push({ from: r.parentId, to: r.id });
    // A node is either collapsed or folded on screen, never both, so one
    // count-card id per scope is unique.
    if (r.collapsed || r.foldedSubscriptions > 0) {
      const id = `${COUNT_CARD_PREFIX}${r.id}`;
      const title = r.collapsed
        ? hiddenLabel(r.hidden)
        : hiddenLabel({ managementGroups: 0, subscriptions: r.foldedSubscriptions });
      cards.push({
        id,
        kind: "count",
        countOf: r.collapsed ? "collapsed" : "folded",
        scopeId: r.id,
        title,
        chipCount: 0,
      });
      edges.push({ from: r.id, to: id });
    }
  }
  return { cards, edges };
}
