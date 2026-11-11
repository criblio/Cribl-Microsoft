/**
 * A worker group's routing table, and inserting new routes into it - PURE
 * (DBT-301; reused by AZR-35's route-to-Sentinel with an operator-chosen
 * position).
 *
 * WHY THIS EXISTS. wire-source.ts used to read `body.routes` from GET /routes
 * and PUT `{id, routes}` back. The leader answers GET /m/<g>/routes with
 * `{items:[{id, groups, routes:[...]}], count:1}` (measured live 2026-11-10,
 * 37 routes), so `body.routes` was undefined, read as an EMPTY table, and the
 * PUT would have carried only the app's routes: every other admin's route
 * deleted, and `groups` dropped. Hence the rule this module enforces: a body
 * that is not a recognised table is `unexpected-shape`, NEVER an empty table.
 *
 * SHAPES ACCEPTED by parseRoutesListing:
 *   - `{items:[table]}` (the measured listing). Exactly one table: zero is
 *     no table, and more than one is refused because which one the app should
 *     write is not decided (the spec documents `default` as the only id).
 *   - a bare `{id, routes}` table object.
 * Either way the table needs a non-empty string `id` and a `routes` array.
 * A bare table WITHOUT an id is refused rather than guessed as `default`: the
 * id is the write path (`PATCH /routes/{id}`), and a guess that happened to be
 * wrong would write a different table than the one read.
 *
 * INSERT POSITIONS: `top` (index 0), `before` an existing route id, or `end`
 * (after every existing route; an earlier `final` route matching the same
 * events - typically a catch-all - may shadow it, which `shadowedBy` reports).
 *
 * CONFLICTS refuse the insert. A new route whose id is already taken, and an
 * existing route whose filter selects the same input as the new routes
 * (input-id.ts matchInputIdFilter: a `match` AND a `legacy` bare-id match both
 * count). A catch-all filter (`true`, empty) is NOT a conflict - every table
 * ends in one, so counting it would refuse every insert - but a final one
 * above the insertion point is reported in `shadowedBy`. A filter this module
 * cannot read is NOT a conflict; it is reported in `uncheckable` so the
 * confirm can say "could not check", never "no conflict".
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { readProp } from "../cribl-api/envelope";
import { matchInputIdFilter, type InputIdMatch, type InputIdRef } from "../capture-filter/input-id";
import { parseRouteFilterInputs } from "../live-architecture/live-architecture";

/** One existing route as the confirm, a refusal and a position picker name it. */
export interface RouteRowSnapshot {
  readonly id: string;
  /** The route's name, or its id when it has none. */
  readonly name: string;
  /** The filter expression as stored ("" when absent). */
  readonly filter: string;
  readonly output?: string;
  readonly pipeline?: string;
  /** Cribl's default for `final` is true; only an explicit false is non-final. */
  readonly final: boolean;
  readonly disabled: boolean;
}

/** A recognised routing table, as read. `table` is the whole object, round-tripped untouched. */
export interface RoutesTableRead {
  readonly kind: "table";
  readonly tableId: string;
  readonly table: Readonly<Record<string, unknown>>;
  /** The `routes` array exactly as read (elements this module cannot name included). */
  readonly routes: readonly unknown[];
  /** The routes this module can name (an element with a non-empty string id), in table order. */
  readonly rows: readonly RouteRowSnapshot[];
}

export type RoutesTableParse =
  | RoutesTableRead
  | { readonly kind: "unexpected-shape"; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One route element as a snapshot row, or null when it carries no usable id. */
export function routeRow(item: unknown): RouteRowSnapshot | null {
  const id = readProp(item, "id");
  if (typeof id !== "string" || id === "") return null;
  const name = readProp(item, "name");
  const filter = readProp(item, "filter");
  const output = readProp(item, "output");
  const pipeline = readProp(item, "pipeline");
  return {
    id,
    name: typeof name === "string" && name !== "" ? name : id,
    filter: typeof filter === "string" ? filter : "",
    ...(typeof output === "string" && output !== "" ? { output } : {}),
    ...(typeof pipeline === "string" && pipeline !== "" ? { pipeline } : {}),
    final: readProp(item, "final") !== false,
    disabled: readProp(item, "disabled") === true,
  };
}

/** A table OBJECT (`{id, routes, ...}`) as a read, or why it is not one. */
export function parseRoutesTable(table: unknown): RoutesTableParse {
  if (!isRecord(table)) return { kind: "unexpected-shape", detail: "the routing table is not an object" };
  const routes = table["routes"];
  if (!Array.isArray(routes)) {
    return { kind: "unexpected-shape", detail: "the routing table carries no routes array" };
  }
  const id = table["id"];
  if (typeof id !== "string" || id === "") {
    return {
      kind: "unexpected-shape",
      detail: "the routing table carries no id, so which table to write is unknown (the app does not guess one)",
    };
  }
  const rows: RouteRowSnapshot[] = [];
  for (const item of routes) {
    const row = routeRow(item);
    if (row !== null) rows.push(row);
  }
  return { kind: "table", tableId: id, table, routes, rows };
}

/**
 * The GET /routes listing as ONE table. `{items:[table]}` or a bare table;
 * anything else - including `{items:[]}`, more than one table, or a table
 * without a routes array - is `unexpected-shape`, never an empty table.
 */
export function parseRoutesListing(body: unknown): RoutesTableParse {
  const items = readProp(body, "items");
  if (Array.isArray(items)) {
    if (items.length === 0) return { kind: "unexpected-shape", detail: "the routes listing holds no routing table" };
    if (items.length > 1) {
      return {
        kind: "unexpected-shape",
        detail: `the routes listing holds ${items.length} routing tables, and which one to write is not decided`,
      };
    }
    return parseRoutesTable(items[0]);
  }
  if (isRecord(body) && Array.isArray(body["routes"])) return parseRoutesTable(body);
  return { kind: "unexpected-shape", detail: "the routes response is not a routing table" };
}

/** Where the new routes go. */
export type RoutePosition =
  | { readonly kind: "top" }
  | { readonly kind: "before"; readonly routeId: string }
  /** After every existing route: an earlier final route may shadow it. */
  | { readonly kind: "end" };

/**
 * A route to add. The fields Cribl's RouteConf names; any other key a caller
 * sets travels as given. `filter` must select `input` (checked).
 */
export interface NewRoute {
  readonly id: string;
  readonly name: string;
  readonly filter: string;
  readonly pipeline: string;
  readonly output?: string;
  readonly final: boolean;
  readonly disabled?: boolean;
  readonly description?: string;
}

/** What an insert adds: routes, in evaluation order, all selecting ONE input. */
export interface RouteInsertRequest {
  readonly input: InputIdRef;
  readonly routes: readonly NewRoute[];
  readonly position: RoutePosition;
}

export type RouteConflict =
  /** A new route's id is already in the table. */
  | { readonly kind: "id-taken"; readonly routeId: string; readonly existing: RouteRowSnapshot }
  /** An existing route's filter selects the same input (`legacy`: only by the bare id). */
  | { readonly kind: "same-input"; readonly how: Exclude<InputIdMatch, "none">; readonly existing: RouteRowSnapshot };

export type RouteInsertRefusal =
  | { readonly kind: "no-routes"; readonly detail: string }
  | { readonly kind: "duplicate-new-id"; readonly routeId: string; readonly detail: string }
  | { readonly kind: "filter-not-for-input"; readonly routeId: string; readonly detail: string }
  | { readonly kind: "before-missing"; readonly routeId: string; readonly detail: string }
  | {
      readonly kind: "conflicts";
      readonly conflicts: readonly RouteConflict[];
      readonly uncheckable: readonly RouteRowSnapshot[];
      readonly detail: string;
    };

export type RouteInsertResult =
  | {
      readonly kind: "ok";
      /** The whole new routes array: the existing elements untouched, the new ones spliced in. */
      readonly routes: readonly unknown[];
      /** Where the first new route sits in `routes`. */
      readonly index: number;
      /** Existing routes whose filter could not be read: not checked, not conflicts. */
      readonly uncheckable: readonly RouteRowSnapshot[];
      /** Enabled, final, catch-all routes ABOVE the insertion point: they may consume the events first. */
      readonly shadowedBy: readonly RouteRowSnapshot[];
    }
  | { readonly kind: "refused"; readonly refusal: RouteInsertRefusal };

/** A route as one line, for a refusal: id, filter, output, pipeline. */
export function describeRoute(row: RouteRowSnapshot): string {
  const parts = [
    `filter ${row.filter === "" ? "(none)" : row.filter}`,
    `output ${row.output ?? "(none)"}`,
    `pipeline ${row.pipeline ?? "(none)"}`,
  ];
  if (row.disabled) parts.push("disabled");
  return `route ${row.id} (${parts.join(", ")})`;
}

/** One conflict as a sentence. */
export function describeConflict(c: RouteConflict): string {
  if (c.kind === "id-taken") {
    return `A route with id ${c.routeId} already exists: ${describeRoute(c.existing)}.`;
  }
  return c.how === "legacy"
    ? `Existing ${describeRoute(c.existing)} already names this source by its bare id.`
    : `Existing ${describeRoute(c.existing)} already selects this source.`;
}

/**
 * The conflicts of `request` against `rows`, plus the rows whose filter could
 * not be read. Disabled routes are checked too: a disabled route on the same
 * source is someone's routing for it, and the operator decides what to do with
 * it, not this app.
 */
export function routeConflicts(
  rows: readonly RouteRowSnapshot[],
  request: Pick<RouteInsertRequest, "input" | "routes">,
): { conflicts: RouteConflict[]; uncheckable: RouteRowSnapshot[] } {
  const conflicts: RouteConflict[] = [];
  const uncheckable: RouteRowSnapshot[] = [];
  const newIds = new Set(request.routes.map((r) => r.id));
  for (const row of rows) {
    if (newIds.has(row.id)) conflicts.push({ kind: "id-taken", routeId: row.id, existing: row });
    const parsed = parseRouteFilterInputs(row.filter);
    if (parsed.kind === "unparsed") {
      uncheckable.push(row);
      continue;
    }
    // A catch-all selects every input; it is not a claim on THIS one.
    if (parsed.kind === "all") continue;
    const how = matchInputIdFilter(parsed, request.input);
    if (how !== "none") conflicts.push({ kind: "same-input", how, existing: row });
  }
  return { conflicts, uncheckable };
}

function refused(refusal: RouteInsertRefusal): RouteInsertResult {
  return { kind: "refused", refusal };
}

/** Check the new routes themselves: some, unique ids, each filter selects the input. */
function newRoutesProblem(request: RouteInsertRequest): RouteInsertRefusal | null {
  if (request.routes.length === 0) return { kind: "no-routes", detail: "There are no routes to add." };
  const seen = new Set<string>();
  for (const route of request.routes) {
    if (seen.has(route.id)) {
      return { kind: "duplicate-new-id", routeId: route.id, detail: `Two of the new routes share the id ${route.id}.` };
    }
    seen.add(route.id);
    const parsed = parseRouteFilterInputs(route.filter);
    // `all` is excluded on purpose: a catch-all would claim every input, and
    // the conflict check above could not protect anything with it.
    if (parsed.kind === "unparsed" || parsed.kind === "all" || matchInputIdFilter(parsed, request.input) !== "match") {
      return {
        kind: "filter-not-for-input",
        routeId: route.id,
        detail: `New route ${route.id}'s filter (${route.filter}) does not select ${request.input.type}:${request.input.id}.`,
      };
    }
  }
  return null;
}

/**
 * Insert `request.routes` into `table` at `request.position`, or refuse.
 * The existing elements are carried exactly as read - by reference, in order -
 * so nothing another admin configured is restated or dropped.
 */
export function insertRoutes(table: RoutesTableRead, request: RouteInsertRequest): RouteInsertResult {
  const own = newRoutesProblem(request);
  if (own !== null) return refused(own);

  const { conflicts, uncheckable } = routeConflicts(table.rows, request);
  if (conflicts.length > 0) {
    return refused({
      kind: "conflicts",
      conflicts,
      uncheckable,
      detail: conflicts.map(describeConflict).join(" "),
    });
  }

  let index: number;
  switch (request.position.kind) {
    case "top":
      index = 0;
      break;
    case "end":
      index = table.routes.length;
      break;
    case "before": {
      const target = request.position.routeId;
      index = table.routes.findIndex((item) => readProp(item, "id") === target);
      if (index < 0) {
        return refused({
          kind: "before-missing",
          routeId: target,
          detail: `There is no route ${target} in routing table ${table.tableId} to insert before.`,
        });
      }
      break;
    }
  }

  const above = table.routes.slice(0, index);
  const shadowedBy: RouteRowSnapshot[] = [];
  for (const item of above) {
    const row = routeRow(item);
    if (row === null || row.disabled || !row.final) continue;
    if (parseRouteFilterInputs(row.filter).kind === "all") shadowedBy.push(row);
  }
  const added: unknown[] = request.routes.map((r) => ({ ...r }));
  return {
    kind: "ok",
    routes: [...above, ...added, ...table.routes.slice(index)],
    index,
    uncheckable,
    shadowedBy,
  };
}

/**
 * The synchronous re-check run on the post-answer re-read (the kit's
 * FreshCheck): the conflicts of the same request against the FRESH table.
 * Returns a refusal reason, or null. It makes no request.
 */
export function routeInsertFreshCheck(
  request: Pick<RouteInsertRequest, "input" | "routes">,
): (fresh: Record<string, unknown>) => string | null {
  return (fresh) => {
    const parsed = parseRoutesTable(fresh);
    if (parsed.kind !== "table") return `The routing table could not be re-read as a table (${parsed.detail}).`;
    const { conflicts } = routeConflicts(parsed.rows, request);
    return conflicts.length === 0 ? null : conflicts.map(describeConflict).join(" ");
  };
}
