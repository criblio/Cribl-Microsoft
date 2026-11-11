/**
 * route-insert (DBT-301): the shared routing-table writer, against a stateful
 * leader holding the MEASURED listing shape `{items:[{id, groups, routes}],
 * count:1}` (fake-routes-leader.test-util.ts).
 *
 * The pins that carry the bug: other routes and `groups` survive the write;
 * the write is PATCH /m/<g>/routes/<tableId>; an unknown shape is refused with
 * no write; a table that moved voids; a conflict refuses (at plan, and on the
 * fresh read via the FreshCheck); a missing `before` refuses; an unplaced
 * commit scope refuses; written-not-verified never commits.
 */

import { describe, expect, it } from "vitest";
import { diffRows } from "../../kit/config-writes/readModifyWrite";
import type { NewRoute, RoutePosition } from "../../domain/routes-table";
import { FakeRoutesLeader, G, HASH, ROUTE_FILE, measuredTable } from "./fake-routes-leader.test-util";
import {
  applyRouteInsert,
  planRouteInsert,
  routesWriteTarget,
  type PlanRouteInsertInput,
  type PlanRouteInsertResult,
  type ReadyRouteInsert,
} from "./index";

const INPUT = { type: "syslog", id: "in_pan" };
const FILTER = "__inputId.startsWith('syslog:in_pan:')";
const NEW: NewRoute[] = [
  { id: "pan-lake", name: "pan to Lake", filter: FILTER, pipeline: "passthru", output: "cribl_lake:pan", final: false },
  { id: "pan-sentinel", name: "pan to Sentinel", filter: FILTER, pipeline: "pack:pan", output: "default", final: true },
];
const EXISTING_IDS = ["r_fw", "r_okta", "r_complex", "default"];

function planInput(over: Partial<PlanRouteInsertInput> = {}): PlanRouteInsertInput {
  return { groupId: G, input: INPUT, routes: NEW, position: { kind: "top" }, commitMessage: "wire pan", ...over };
}

function ready(result: PlanRouteInsertResult): ReadyRouteInsert {
  if (result.kind !== "ready") throw new Error(`expected ready, got ${result.kind}: ${result.detail}`);
  return result.ready;
}

const PLAN_CALLS = [`GET /m/${G}/routes`, `GET /m/${G}/routes/default`, `GET /m/${G}/version/status`];

describe("planRouteInsert - read-only, on the measured listing shape", () => {
  it("reads the table id from the listing and plans a top insert; only GETs", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    expect(leader.log).toEqual(PLAN_CALLS);
    expect(r.tableId).toBe("default");
    expect(r.index).toBe(0);
    expect(r.table.routeCount).toBe(4);
    expect(r.table.rows.map((x) => x.id)).toEqual(EXISTING_IDS);
    expect((r.routes as Array<{ id: string }>).map((x) => x.id)).toEqual(["pan-lake", "pan-sentinel", ...EXISTING_IDS]);
    // The unreadable filter is "could not check", never "no conflict".
    expect(r.uncheckable.map((x) => x.id)).toEqual(["r_complex"]);
    expect(r.commitFiles).toEqual([ROUTE_FILE]);
    expect(r.scope).toEqual({ alreadyDirty: [], elsewhere: [], unplaced: [], unknown: false });
    // The diff is the routes array only: groups and comments are not in it.
    expect(r.diff.map((d) => d.path)).toEqual(["routes"]);
  });

  it.each([
    ["an empty items list", { items: [], count: 0 }],
    ["a listing with no items or routes", { count: 1 }],
    ["a table without a routes array", { items: [{ id: "default", groups: {} }], count: 1 }],
    ["two tables", { items: [measuredTable(), { ...measuredTable(), id: "other" }], count: 2 }],
    ["a bare table without an id", { routes: [] }],
    ["the old reader's assumption, a bare routes array", [{ id: "x" }]],
    ["a string", "routes"],
    ["null", null],
  ])("%s is unexpected-shape and nothing is written or read further", async (_label, body) => {
    const leader = new FakeRoutesLeader();
    leader.listingBody = body;
    const result = await planRouteInsert({ cribl: leader }, planInput());
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("unexpected-shape");
    expect(leader.log).toEqual([`GET /m/${G}/routes`]);
  });

  it("a bare {id, routes} table is accepted with its own id", async () => {
    const leader = new FakeRoutesLeader();
    leader.listingBody = measuredTable();
    expect(ready(await planRouteInsert({ cribl: leader }, planInput())).tableId).toBe("default");
  });

  it("a refused listing read is routes-unreadable, not an empty table", async () => {
    const leader = new FakeRoutesLeader();
    leader.hooks.push((req) => (req.path === "/routes" ? { status: 403, body: {} } : undefined));
    const result = await planRouteInsert({ cribl: leader }, planInput());
    expect(result).toMatchObject({ kind: "refused", reason: "routes-unreadable" });
  });

  it("refuses an existing route on the same input, naming its id, filter, output and pipeline", async () => {
    const leader = new FakeRoutesLeader();
    const result = await planRouteInsert({ cribl: leader }, planInput({ input: { type: "syslog", id: "in_fw" }, routes: [
      { id: "fw-sentinel", name: "fw", filter: "__inputId.startsWith('syslog:in_fw:')", pipeline: "p", output: "o", final: true },
    ] }));
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("conflicts");
    expect(result.conflicts?.map((c) => [c.kind, c.existing.id])).toEqual([["same-input", "r_fw"]]);
    expect(result.detail).toContain("r_fw");
    expect(result.detail).toContain("__inputId.startsWith('syslog:in_fw:')");
    expect(result.detail).toContain("splunk_out");
    expect(result.detail).toContain("fw_pipeline");
    expect(result.table?.rows).toHaveLength(4);
    expect(leader.log).toEqual([`GET /m/${G}/routes`]);
  });

  it("refuses an existing bare-id (legacy) route on the same input", async () => {
    const leader = new FakeRoutesLeader();
    (leader.table["routes"] as unknown[]).unshift({ id: "old", filter: "__inputId=='in_pan'", pipeline: "x", output: "y" });
    const result = await planRouteInsert({ cribl: leader }, planInput());
    expect(result).toMatchObject({ kind: "refused", reason: "conflicts" });
    if (result.kind === "refused") expect(result.conflicts).toMatchObject([{ kind: "same-input", how: "legacy", existing: { id: "old" } }]);
  });

  it("refuses a new route id already in the table", async () => {
    const leader = new FakeRoutesLeader();
    (leader.table["routes"] as unknown[]).push({ id: "pan-sentinel", filter: "__inputId=='http:other'", output: "x" });
    const result = await planRouteInsert({ cribl: leader }, planInput());
    expect(result).toMatchObject({ kind: "refused", reason: "conflicts" });
    if (result.kind === "refused") expect(result.conflicts?.map((c) => c.kind)).toEqual(["id-taken"]);
  });

  it("refuses a `before` that names a route the table does not hold; no write", async () => {
    const leader = new FakeRoutesLeader();
    const result = await planRouteInsert({ cribl: leader }, planInput({ position: { kind: "before", routeId: "nope" } }));
    expect(result).toMatchObject({ kind: "refused", reason: "before-missing" });
    expect(leader.writes()).toEqual([]);
  });

  it.each<[RoutePosition, number, string[]]>([
    [{ kind: "before", routeId: "r_complex" }, 2, []],
    [{ kind: "end" }, 4, ["default"]],
  ])("position %j lands at %i; shadowedBy names the final catch-alls above it", async (position, index, shadow) => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput({ position })));
    expect(r.index).toBe(index);
    expect(r.shadowedBy.map((x) => x.id)).toEqual(shadow);
    expect((r.routes as Array<{ id: string }>).slice(index, index + 2).map((x) => x.id)).toEqual(["pan-lake", "pan-sentinel"]);
  });

  it("refuses when the table read differs from the listing (it moved while planning)", async () => {
    const leader = new FakeRoutesLeader();
    leader.hooks.push((req, l) => {
      if (req.method === "GET" && req.path === "/routes/default") (l.table["routes"] as unknown[]).push({ id: "late", filter: "true" });
      return undefined;
    });
    const result = await planRouteInsert({ cribl: leader }, planInput());
    expect(result).toMatchObject({ kind: "refused", reason: "table-moved" });
  });

  it("refuses an unplaced commit scope before any confirm", async () => {
    const leader = new FakeRoutesLeader();
    leader.pending = ["local/cribl/pipelines/route.yml"];
    const result = await planRouteInsert({ cribl: leader }, planInput());
    expect(result).toMatchObject({ kind: "refused", reason: "scope-unplaced" });
    expect(leader.writes()).toEqual([]);
  });

  it("refuses when the status read fails (status-unknown), never 'nothing pending'", async () => {
    const leader = new FakeRoutesLeader();
    leader.hooks.push((req) => (req.path === "/version/status" ? { status: 500, body: {} } : undefined));
    expect(await planRouteInsert({ cribl: leader }, planInput())).toMatchObject({ kind: "refused", reason: "status-unknown" });
  });

  it("names another admin's pending work in the routes file as alreadyDirty", async () => {
    const leader = new FakeRoutesLeader();
    leader.pending = [ROUTE_FILE, `groups/${G}/local/cribl/outputs.yml`];
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    expect(r.scope.alreadyDirty).toEqual([ROUTE_FILE]);
    expect(r.scope.elsewhere).toEqual([`groups/${G}/local/cribl/outputs.yml`]);
  });
});

describe("applyRouteInsert - the write keeps everything it did not add", () => {
  it("PATCHes /m/<g>/routes/<tableId> with every other route and `groups` intact, then commits and deploys", async () => {
    const leader = new FakeRoutesLeader();
    const before = measuredTable();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.log.length = 0;
    const outcome = await applyRouteInsert({ cribl: leader }, r);

    expect(outcome.kind).toBe("deployed");
    expect(leader.log).toEqual([
      `GET /m/${G}/version/status`,
      `GET /m/${G}/routes/default`,
      `PATCH /m/${G}/routes/default`,
      `GET /m/${G}/routes/default`,
      `GET /m/${G}/version/status`,
      `POST /m/${G}/version/commit`,
      `GET /m/${G}/version/status`,
      `GET /m/${G}/version?offset=0&limit=1`,
      `PATCH /products/stream/groups/${G}/deploy`,
    ]);
    const sent = leader.lastPatch()!;
    // Every key of the table object round-trips: id, groups, comments.
    expect(sent["id"]).toBe("default");
    expect(sent["groups"]).toEqual(before["groups"]);
    expect(sent["comments"]).toEqual(before["comments"]);
    // Every existing route, whole and in order, below the two new ones.
    const routes = sent["routes"] as unknown[];
    expect(routes).toHaveLength(6);
    expect(routes.slice(2)).toEqual(before["routes"]);
    expect(routes.slice(0, 2)).toEqual(NEW);
    // The commit carries the routes file only, and the deploy names that commit.
    const commit = leader.requests.find((q) => q.method === "POST")!;
    expect(commit.body).toEqual({ message: "wire pan", files: [ROUTE_FILE] });
    const deploy = leader.requests.at(-1)!;
    expect(deploy.body).toEqual({ version: HASH });
  });

  it("a route another admin added after the confirm VOIDS the approval: nothing written", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    (leader.table["routes"] as unknown[]).splice(1, 0, { id: "theirs", filter: "__inputId=='http:x'", output: "o" });
    const outcome = await applyRouteInsert({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "void", cause: "table-moved" });
    expect(leader.writes()).toEqual([]);
    expect((leader.table["routes"] as Array<{ id: string }>).map((x) => x.id)).toContain("theirs");
  });

  it("a change to `groups` alone does not void, and the fresh `groups` is what is sent", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.table["groups"] = { Gx1aB2: { name: "renamed", index: 1 }, new: { name: "added", index: 2 } };
    const outcome = await applyRouteInsert({ cribl: leader }, r);
    expect(outcome.kind).toBe("deployed");
    expect(leader.lastPatch()!["groups"]).toEqual({ Gx1aB2: { name: "renamed", index: 1 }, new: { name: "added", index: 2 } });
  });

  it("the FreshCheck refuses a conflict on the re-read, before any write", async () => {
    // A hand-built approval whose diff matches the fresh read exactly, so the
    // kit's drift check passes and only the synchronous FreshCheck can refuse.
    // (Through planRouteInsert the plan refuses first, and a route added later
    // voids by diff; this proves the re-check is wired into the write.)
    const leader = new FakeRoutesLeader();
    (leader.table["routes"] as unknown[]).unshift({ id: "dup", filter: "__inputId.startsWith('syslog:in_pan:')", output: "o", pipeline: "p" });
    const fresh = structuredClone(leader.table);
    const routes = [...NEW, ...(fresh["routes"] as unknown[])];
    const target = routesWriteTarget(G, "default");
    const diff = diffRows(fresh, { ...fresh, routes }, target.arrays);
    const handBuilt: ReadyRouteInsert = {
      groupId: G,
      tableId: "default",
      input: INPUT,
      position: { kind: "top" },
      index: 0,
      newRoutes: NEW,
      routes,
      diff,
      table: { tableId: "default", routeCount: 5, rows: [] },
      uncheckable: [],
      shadowedBy: [],
      scope: { alreadyDirty: [], elsewhere: [], unplaced: [], unknown: false },
      commitFiles: [ROUTE_FILE],
      commitMessage: "m",
    };
    const outcome = await applyRouteInsert({ cribl: leader }, handBuilt);
    expect(outcome.kind).toBe("refused-before-write");
    if (outcome.kind === "refused-before-write") expect(outcome.detail).toContain("dup");
    expect(leader.writes()).toEqual([]);
  });

  it("an unplaced pending path at apply refuses before the re-read", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.pending = ["local/cribl/pipelines/route.yml"];
    leader.log.length = 0;
    const outcome = await applyRouteInsert({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "scope-refused", reason: "scope-unplaced" });
    expect(leader.log).toEqual([`GET /m/${G}/version/status`]);
  });

  it("new pending work in the routes file since the confirm voids (scope-grew)", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.pending = [ROUTE_FILE];
    const outcome = await applyRouteInsert({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "void", cause: "scope-grew" });
    expect(leader.writes()).toEqual([]);
  });

  it("written-not-verified (the read-back differs) is never committed or deployed", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.dropWrites = true;
    const outcome = await applyRouteInsert({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "written-not-verified", check: "mismatch" });
    expect(leader.writes()).toEqual([`PATCH /m/${G}/routes/default`]);
  });

  it("a refused PATCH is `refused` with its status, and nothing is committed", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.hooks.push((req) => (req.method === "PATCH" && req.path === "/routes/default" ? { status: 400, body: {} } : undefined));
    const outcome = await applyRouteInsert({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "refused", status: 400 });
    expect(leader.writes()).toEqual([`PATCH /m/${G}/routes/default`]);
  });

  it("a PATCH with no answer says the write's effect is unknown", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.hooks.push((req) => {
      if (req.method === "PATCH" && req.path === "/routes/default") throw new Error("socket hang up");
      return undefined;
    });
    expect(await applyRouteInsert({ cribl: leader }, r)).toMatchObject({ kind: "transport-failed", writeSent: true });
  });

  it("a newer commit at HEAD is its own outcome: committed, not deployed", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    leader.hooks.push((req) => (req.method === "GET" && req.path === "/version" ? { status: 200, body: { items: [{ hash: "ffffffffffffffff" }] } } : undefined));
    const outcome = await applyRouteInsert({ cribl: leader }, r);
    expect(outcome).toMatchObject({ kind: "newer-commit", hash: HASH });
    expect(outcome.detail).toContain("nothing was deployed");
    expect(leader.writes().some((w) => w.includes("/deploy"))).toBe(false);
  });

  it("feeds every commit-path status to onCommitStep", async () => {
    const leader = new FakeRoutesLeader();
    const r = ready(await planRouteInsert({ cribl: leader }, planInput()));
    const steps: string[] = [];
    await applyRouteInsert({ cribl: leader, onCommitStep: (step, _m, _p, status) => steps.push(`${step}:${status}`) }, r);
    expect(steps).toEqual(["status:200", "status:200", "commit:200", "status:200", "head:200", "deploy:200"]);
  });
});
