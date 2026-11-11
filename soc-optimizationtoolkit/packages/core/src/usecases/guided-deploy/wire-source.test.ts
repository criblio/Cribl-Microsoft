/**
 * wireSource plan/apply (DBT-301) over the shared route-insert writer, against
 * the MEASURED routes listing shape.
 *
 * Replaced pins: the old "GET -> prepend -> PUT -> commit -> deploy per group"
 * test fed a bare `{id, routes}` body, the shape the leader does NOT answer, and
 * asserted the PUT carried the prepended routes; it is replaced by the
 * route-survival pin below (measured `{items:[...]}` shape, PATCH to the one
 * table, every other route and `groups` intact). The "commit/deploy failures
 * are warnings" pin is replaced by the named commit outcomes (route-insert
 * tests and the commit-failed pin here). The "throws when the routes GET
 * fails" pin is replaced by a refusal with no write.
 */

import { describe, expect, it } from "vitest";
import type { CriblRequest } from "../../ports/cribl-client";
import { FakeRoutesLeader, G, measuredTable } from "../route-insert/fake-routes-leader.test-util";
import { applyWireSource, parseSourceEntry, planWireSource, type PlanWireSourceResult, type ReadyWireSource } from "./wire-source";

const INPUTS = {
  items: [
    { id: "in_syslog_paloalto", type: "syslog", disabled: false },
    { id: "in_json", type: "tcpjson" },
  ],
  count: 2,
};

/** The routes leader, plus the group's inputs list and the leader Lake create. */
function leader(opts: { inputs?: unknown; inputsStatus?: number; lakeStatus?: number } = {}): FakeRoutesLeader {
  const l = new FakeRoutesLeader();
  l.hooks.push((req: CriblRequest) => {
    if (req.groupId === G && req.method === "GET" && req.path === "/system/inputs") {
      return { status: opts.inputsStatus ?? 200, body: opts.inputs ?? INPUTS };
    }
    if (req.groupId === undefined && req.method === "POST" && req.path === "/system/lake/datasets") {
      return { status: opts.lakeStatus ?? 200, body: {} };
    }
    return undefined;
  });
  return l;
}

const BASE = { groupId: G, source: "in_syslog_paloalto", packName: "paloalto-sentinel" };
const LAKE = { enabled: true, dataset: "paloalto-raw", deploymentType: "cloud" as const };

function ready(r: PlanWireSourceResult): ReadyWireSource {
  if (r.kind !== "ready") throw new Error(`expected ready, got ${JSON.stringify(r)}`);
  return r.ready;
}

describe("planWireSource - resolves the input type from Cribl, read-only", () => {
  it("takes the type from the group's inputs list and writes the typed filter", async () => {
    const l = leader();
    const r = ready(await planWireSource({ cribl: l }, BASE));
    expect(r.input).toEqual({ type: "syslog", id: "in_syslog_paloalto" });
    expect(r.filter).toBe("__inputId.startsWith('syslog:in_syslog_paloalto:')");
    expect(r.routes.every((route) => route.filter === r.filter)).toBe(true);
    expect(l.writes()).toEqual([]);
    expect(l.log[0]).toBe(`GET /m/${G}/system/inputs`);
  });

  it("accepts <type>:<id> when the type agrees, and refuses when it does not", async () => {
    expect(ready(await planWireSource({ cribl: leader() }, { ...BASE, source: "syslog:in_syslog_paloalto" })).input.type).toBe("syslog");
    const wrong = await planWireSource({ cribl: leader() }, { ...BASE, source: "http:in_syslog_paloalto" });
    expect(wrong).toMatchObject({ kind: "refused", reason: "input-type-mismatch" });
  });

  it("an id the list does not show refuses, worded as not visible (never 'does not exist')", async () => {
    const r = await planWireSource({ cribl: leader() }, { ...BASE, source: "in_missing" });
    expect(r).toMatchObject({ kind: "refused", reason: "input-not-visible" });
    if (r.kind === "refused") expect(r.detail).toContain("may not be allowed to see it");
  });

  it("an unreadable inputs list refuses before the routes are read", async () => {
    const l = leader({ inputsStatus: 403 });
    expect(await planWireSource({ cribl: l }, BASE)).toMatchObject({ kind: "refused", reason: "inputs-unreadable" });
    expect(l.log).toEqual([`GET /m/${G}/system/inputs`]);
    const shapeless = leader({ inputs: { nope: 1 } });
    expect(await planWireSource({ cribl: shapeless }, BASE)).toMatchObject({ kind: "refused", reason: "inputs-unreadable" });
  });

  it("an unexpected routes shape refuses with no write (the measured bug's guard)", async () => {
    const l = leader();
    l.listingBody = { count: 1 };
    const r = await planWireSource({ cribl: l }, BASE);
    expect(r).toMatchObject({ kind: "insert-refused", result: { reason: "unexpected-shape" } });
    expect(l.writes()).toEqual([]);
  });

  it("an existing route on the same input refuses (no silent skip of an existing id)", async () => {
    const l = leader();
    (l.table["routes"] as unknown[]).unshift({ id: "paloalto-sentinel-sentinel", filter: "__inputId=='in_syslog_paloalto'", output: "x" });
    const r = await planWireSource({ cribl: l }, BASE);
    expect(r).toMatchObject({ kind: "insert-refused", result: { reason: "conflicts" } });
  });
});

describe("applyWireSource - routes at the top, nothing else touched", () => {
  it("no Lake: one final Sentinel route at index 0, every other route and `groups` intact, PATCH to the table", async () => {
    const l = leader();
    const r = ready(await planWireSource({ cribl: l }, BASE));
    const result = await applyWireSource({ cribl: l }, r);
    expect(result.dataset).toEqual({ kind: "not-needed" });
    expect(result.insert.kind).toBe("deployed");
    expect(l.writes()).toEqual([
      `PATCH /m/${G}/routes/default`,
      `POST /m/${G}/version/commit`,
      `PATCH /products/stream/groups/${G}/deploy`,
    ]);
    const sent = l.lastPatch()!;
    const before = measuredTable();
    expect(sent["groups"]).toEqual(before["groups"]);
    const routes = sent["routes"] as Array<Record<string, unknown>>;
    expect(routes.slice(1)).toEqual(before["routes"]);
    expect(routes[0]).toMatchObject({ id: "paloalto-sentinel-sentinel", final: true, pipeline: "pack:paloalto-sentinel" });
  });

  it("Lake (cloud): dataset first, then Lake (non-final) directly above Sentinel (final), both above the rest", async () => {
    const l = leader();
    const r = ready(await planWireSource({ cribl: l }, { ...BASE, lake: LAKE }));
    expect(r.createDataset).toBe("paloalto-raw");
    const result = await applyWireSource({ cribl: l }, r);
    expect(result.dataset).toEqual({ kind: "created-or-exists", dataset: "paloalto-raw", status: 200 });
    expect(l.writes()[0]).toBe("POST /system/lake/datasets");
    const routes = l.lastPatch()!["routes"] as Array<Record<string, unknown>>;
    expect(routes.slice(0, 2).map((x) => [x["id"], x["final"]])).toEqual([
      ["paloalto-sentinel-lake", false],
      ["paloalto-sentinel-sentinel", true],
    ]);
    expect(routes.slice(2).map((x) => x["id"])).toEqual(["r_fw", "r_okta", "r_complex", "default"]);
  });

  it("a 409 on the dataset is success", async () => {
    const l = leader({ lakeStatus: 409 });
    const result = await applyWireSource({ cribl: l }, ready(await planWireSource({ cribl: l }, { ...BASE, lake: LAKE })));
    expect(result.dataset.kind).toBe("created-or-exists");
  });

  it("a refused commit is named, never a 'committed' literal and never a deploy", async () => {
    const l = leader();
    const r = ready(await planWireSource({ cribl: l }, BASE));
    l.hooks.push((req) => (req.method === "POST" && req.path === "/version/commit" ? { status: 500, body: {} } : undefined));
    const result = await applyWireSource({ cribl: l }, r);
    expect(result.insert.kind).toBe("commit-failed");
    expect(l.writes().some((w) => w.includes("/deploy"))).toBe(false);
  });

  it("a table that moved after the confirm voids: no route write", async () => {
    const l = leader();
    const r = ready(await planWireSource({ cribl: l }, BASE));
    (l.table["routes"] as unknown[]).pop();
    const result = await applyWireSource({ cribl: l }, r);
    expect(result.insert).toMatchObject({ kind: "void", cause: "table-moved" });
    expect(l.writes()).toEqual([]);
  });
});

describe("parseSourceEntry", () => {
  it("reads <id> and <type>:<id>, and rejects the rest", () => {
    expect(parseSourceEntry(" in_a ")).toEqual({ id: "in_a", type: null });
    expect(parseSourceEntry("syslog:in_a")).toEqual({ id: "in_a", type: "syslog" });
    for (const bad of ["", "  ", ":in_a", "syslog:", "syslog:in_a:1.2.3.4"]) expect(parseSourceEntry(bad)).toBeNull();
  });
});
