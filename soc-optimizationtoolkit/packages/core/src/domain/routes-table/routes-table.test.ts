import { describe, expect, it } from "vitest";
import {
  insertRoutes,
  parseRoutesListing,
  parseRoutesTable,
  routeConflicts,
  routeInsertFreshCheck,
  type NewRoute,
  type RouteInsertRequest,
  type RoutesTableRead,
} from "./routes-table";

const THEIRS = [
  { id: "a", filter: "__inputId=='http:in_a'", output: "o_a", pipeline: "p_a", final: true, extra: { keep: [1, 2] } },
  { id: "b", filter: "sourcetype=='x' && foo", output: "o_b" },
  { notAnId: true },
  { id: "catch", filter: "true", output: "default", final: true },
];

function table(routes: unknown[] = THEIRS): RoutesTableRead {
  const parsed = parseRoutesTable({ id: "default", groups: { g: { name: "n" } }, routes });
  if (parsed.kind !== "table") throw new Error(parsed.detail);
  return parsed;
}

const SENTINEL: NewRoute = {
  id: "new",
  name: "new",
  filter: "__inputId=='tcpjson:in_t'",
  pipeline: "pack:x",
  output: "default",
  final: true,
};

function req(over: Partial<RouteInsertRequest> = {}): RouteInsertRequest {
  return { input: { type: "tcpjson", id: "in_t" }, routes: [SENTINEL], position: { kind: "top" }, ...over };
}

describe("parseRoutesListing - an unknown shape is never an empty table", () => {
  it("reads the measured {items:[table], count:1} with its id and every element", () => {
    const parsed = parseRoutesListing({ items: [{ id: "default", groups: { g: {} }, routes: THEIRS }], count: 1 });
    expect(parsed.kind).toBe("table");
    if (parsed.kind !== "table") return;
    expect(parsed.tableId).toBe("default");
    expect(parsed.routes).toBe(THEIRS);
    // The element without an id is kept in `routes`, just not named in `rows`.
    expect(parsed.rows.map((r) => r.id)).toEqual(["a", "b", "catch"]);
  });

  it("accepts an empty routes array as a real, empty table (it was read, not assumed)", () => {
    const parsed = parseRoutesListing({ items: [{ id: "default", routes: [] }] });
    expect(parsed).toMatchObject({ kind: "table", tableId: "default", rows: [] });
  });

  it.each([
    [{ items: [] }],
    [{ items: [{ id: "default" }] }],
    [{ items: [{ routes: [] }] }],
    [{ items: [{ id: "", routes: [] }] }],
    [{ items: [{ id: "a", routes: [] }, { id: "b", routes: [] }] }],
    [{ routes: [] }],
    [{ id: "default" }],
    [{ routes: "x", id: "default" }],
    [[]],
    [null],
    [undefined],
    ["text"],
  ])("%j is unexpected-shape", (body) => {
    expect(parseRoutesListing(body).kind).toBe("unexpected-shape");
  });
});

describe("insertRoutes - positions", () => {
  it("top: new routes first, every existing element after them by reference, in order", () => {
    const t = table();
    const r = insertRoutes(t, req());
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.index).toBe(0);
    expect(r.routes.slice(1)).toHaveLength(THEIRS.length);
    THEIRS.forEach((el, i) => expect(r.routes[i + 1]).toBe(el));
    expect(r.shadowedBy).toEqual([]);
  });

  it("before: lands directly above the named route", () => {
    const r = insertRoutes(table(), req({ position: { kind: "before", routeId: "catch" } }));
    if (r.kind !== "ok") throw new Error("refused");
    expect(r.index).toBe(3);
    expect(r.routes[3]).toMatchObject({ id: "new" });
    expect(r.routes[4]).toBe(THEIRS[3]);
  });

  it("before a route that is not there refuses", () => {
    const r = insertRoutes(table(), req({ position: { kind: "before", routeId: "gone" } }));
    expect(r).toMatchObject({ kind: "refused", refusal: { kind: "before-missing", routeId: "gone" } });
  });

  it("end: after everything, and names the final catch-all that may shadow it", () => {
    const r = insertRoutes(table(), req({ position: { kind: "end" } }));
    if (r.kind !== "ok") throw new Error("refused");
    expect(r.index).toBe(THEIRS.length);
    expect(r.shadowedBy.map((x) => x.id)).toEqual(["catch"]);
  });

  it("a disabled or non-final catch-all above does not shadow", () => {
    const routes = [
      { id: "c1", filter: "true", final: false },
      { id: "c2", filter: "", final: true, disabled: true },
    ];
    const r = insertRoutes(table(routes), req({ position: { kind: "end" } }));
    if (r.kind !== "ok") throw new Error("refused");
    expect(r.shadowedBy).toEqual([]);
  });
});

describe("insertRoutes - conflicts and checks refuse", () => {
  it("an existing route on the same input refuses, naming id, filter, output and pipeline", () => {
    const r = insertRoutes(table(), req({ input: { type: "http", id: "in_a" }, routes: [{ ...SENTINEL, filter: "__inputId=='http:in_a'" }] }));
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused" || r.refusal.kind !== "conflicts") throw new Error("expected conflicts");
    expect(r.refusal.conflicts).toMatchObject([{ kind: "same-input", how: "match", existing: { id: "a" } }]);
    expect(r.refusal.detail).toBe("Existing route a (filter __inputId=='http:in_a', output o_a, pipeline p_a) already selects this source.");
    expect(r.refusal.uncheckable.map((x) => x.id)).toEqual(["b"]);
  });

  it("a bare-id (legacy) match is a conflict, and so is a prefix covering the input", () => {
    const routes = [
      { id: "bare", filter: "__inputId=='in_t'" },
      { id: "pref", filter: "__inputId.startsWith('tcpjson:')" },
      { id: "other", filter: "__inputId=='tcpjson:in_u'" },
    ];
    const { conflicts } = routeConflicts(table(routes).rows, req());
    expect(conflicts.map((c) => (c.kind === "same-input" ? `${c.existing.id}:${c.how}` : c.kind))).toEqual(["bare:legacy", "pref:match"]);
  });

  it("a disabled route on the same input still conflicts", () => {
    const { conflicts } = routeConflicts(table([{ id: "d", filter: "__inputId=='tcpjson:in_t'", disabled: true }]).rows, req());
    expect(conflicts).toHaveLength(1);
  });

  it("a catch-all is not a conflict; an unreadable filter is uncheckable, not a conflict", () => {
    const { conflicts, uncheckable } = routeConflicts(table().rows, req());
    expect(conflicts).toEqual([]);
    expect(uncheckable.map((x) => x.id)).toEqual(["b"]);
  });

  it("a taken id refuses", () => {
    const r = insertRoutes(table(), req({ routes: [{ ...SENTINEL, id: "catch" }] }));
    expect(r).toMatchObject({ kind: "refused", refusal: { kind: "conflicts", conflicts: [{ kind: "id-taken", routeId: "catch" }] } });
  });

  it("refuses no routes, a duplicate new id, and a new filter that does not select the input", () => {
    expect(insertRoutes(table(), req({ routes: [] }))).toMatchObject({ refusal: { kind: "no-routes" } });
    expect(insertRoutes(table(), req({ routes: [SENTINEL, SENTINEL] }))).toMatchObject({ refusal: { kind: "duplicate-new-id" } });
    for (const filter of ["__inputId=='in_t'", "true", "foo && bar", "__inputId=='tcpjson:other'"]) {
      expect(insertRoutes(table(), req({ routes: [{ ...SENTINEL, filter }] }))).toMatchObject({ refusal: { kind: "filter-not-for-input" } });
    }
  });
});

describe("routeInsertFreshCheck - the synchronous re-check on the re-read", () => {
  it("null on a clean fresh table, a reason naming the route when a conflict appeared", () => {
    const check = routeInsertFreshCheck(req());
    expect(check({ id: "default", routes: THEIRS })).toBeNull();
    const why = check({ id: "default", routes: [...THEIRS, { id: "late", filter: "__inputId=='tcpjson:in_t'", output: "x" }] });
    expect(why).toContain("route late");
  });

  it("refuses a fresh read that is not a table", () => {
    expect(routeInsertFreshCheck(req())({ id: "default" })).toMatch(/could not be re-read as a table/);
  });
});
