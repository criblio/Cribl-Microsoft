import { describe, expect, it } from "vitest";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import type { CriblClient } from "../../ports/cribl-client";
import { flowQueryBody } from "../../domain/onboarding-flow/flow-query";
import { NO_GROUP_DETAIL, readSourceFlow } from "./read-source-flow";
import {
  readOnboardingCriblSide,
  routeConsumption,
  type RouteRow,
  type RoutesTable,
} from "./read-onboarding-cribl-side";
import * as barrel from "./index";

describe("readSourceFlow", () => {
  it("sends exactly one POST to the group's metrics query with splitBys ['input']", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { results: [{ input: "eventhub:a", in_events: 3 }] } });
    const answer = await readSourceFlow(cribl, "g", "window");
    expect(cribl.calls).toHaveLength(1);
    const call = cribl.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.groupId).toBe("g");
    expect(call.path).toBe("/system/metrics/query");
    expect(call.body).toEqual(flowQueryBody("window"));
    expect((call.body as { aggs: { splitBys: string[] } }).aggs.splitBys).toEqual(["input"]);
    expect(answer).toEqual({ kind: "rows", rows: [{ input: "eventhub:a", in_events: 3 }] });
  });

  it("sends the lookback body for the lookback kind", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { results: [] } });
    const answer = await readSourceFlow(cribl, "g", "lookback");
    expect(cribl.calls[0]!.body).toEqual(flowQueryBody("lookback"));
    expect((cribl.calls[0]!.body as { earliest: string }).earliest).toBe("-24h");
    expect(answer).toEqual({ kind: "empty" });
  });

  it("a 403 is refused, never empty", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 403, body: { message: "forbidden" } });
    const answer = await readSourceFlow(cribl, "g", "window");
    expect(answer.kind).toBe("refused");
    expect(answer).toMatchObject({ kind: "refused", status: 403 });
  });

  it("a 401 is refused too", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 401, body: "no" });
    expect(await readSourceFlow(cribl, "g", "window")).toMatchObject({ kind: "refused", status: 401 });
  });

  it("a 500 stays an http error, not refused", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 500, body: "boom" });
    expect(await readSourceFlow(cribl, "g", "window")).toMatchObject({ kind: "error", status: 500, reason: "http" });
  });

  it("an {items: []} body is unexpected-shape, never empty", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { items: [] } });
    expect(await readSourceFlow(cribl, "g", "window")).toMatchObject({ kind: "error", reason: "unexpected-shape" });
  });

  it("a transport rejection is failed, and does not throw", async () => {
    const rejecting: CriblClient = {
      request: async () => {
        throw new Error("bridge detached");
      },
      listGroups: async () => {
        throw new Error("unused");
      },
    } as unknown as CriblClient;
    await expect(readSourceFlow(rejecting, "g", "window")).resolves.toEqual({ kind: "failed", detail: "bridge detached" });
  });

  it("an aborted signal is failed 'cancelled' and sends nothing", async () => {
    const cribl = new FakeCriblClient();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await readSourceFlow(cribl, "g", "window", ctrl.signal)).toEqual({ kind: "failed", detail: "cancelled" });
    expect(cribl.calls).toHaveLength(0);
  });

  it("no worker group sends nothing and is failed", async () => {
    const cribl = new FakeCriblClient();
    expect(await readSourceFlow(cribl, "", "window")).toEqual({ kind: "failed", detail: NO_GROUP_DETAIL });
    expect(cribl.calls).toHaveLength(0);
  });
});

const INPUT = { type: "eventhub", id: "azure_onb_eh_ns_hub" };
const OTHER = { type: "azure_blob", id: "azure_onb_blob_acct_q" };

function inputsBody(...items: Array<Record<string, unknown>>) {
  return { status: 200, body: { count: items.length, items } };
}
function routesBody(routes: Array<Record<string, unknown>>) {
  return { status: 200, body: { count: 1, items: [{ id: "default", routes }] } };
}

describe("readOnboardingCriblSide", () => {
  it("makes exactly two GETs against the group: inputs and routes", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(inputsBody(), routesBody([]));
    await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(cribl.calls.map((c) => [c.method, c.groupId, c.path])).toEqual([
      ["GET", "g", "/system/inputs"],
      ["GET", "g", "/routes"],
    ]);
  });

  it("a 403 on the inputs read gives unknown for EVERY id, never absent", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 403, body: "denied" }, routesBody([]));
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT, OTHER]);
    expect(side.inputs.map((i) => i.input.kind)).toEqual(["unknown", "unknown"]);
    expect(side.inputs.every((i) => i.input.kind === "unknown" && i.input.reason === "denied")).toBe(true);
  });

  it("an unrecognized inputs body is unknown unexpected-shape, not absent", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { results: [] } }, routesBody([]));
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.input).toMatchObject({ kind: "unknown", reason: "unexpected-shape" });
  });

  it("a complete list without the id is absent; with it, present", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(inputsBody({ id: INPUT.id, type: "eventhub" }), routesBody([]));
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT, OTHER]);
    expect(side.inputs[0]!.input).toEqual({ kind: "present", type: "eventhub", disabled: false, sendToRoutes: true, connections: [] });
    expect(side.inputs[1]!.input).toEqual({ kind: "absent" });
  });

  it("the route filter __inputId=='eventhub:azure_onb_eh_ns_hub' consumes the input", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      inputsBody({ id: INPUT.id, type: "eventhub" }),
      routesBody([
        { id: "r1", name: "onb", filter: "__inputId=='eventhub:azure_onb_eh_ns_hub'", pipeline: "p1", output: "sentinel_out", final: true },
        { id: "r2", filter: "true", output: "devnull" },
      ]),
    );
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT, OTHER]);
    expect(side.inputs[0]!.route).toEqual({
      kind: "consumes",
      routes: [{ id: "r1", name: "onb", filter: "__inputId=='eventhub:azure_onb_eh_ns_hub'", pipeline: "p1", output: "sentinel_out", final: true }],
    });
    // The other input falls through to the catch-all route.
    expect(side.inputs[1]!.route).toMatchObject({ kind: "consumes", routes: [{ id: "r2" }] });
  });

  it("an unparseable filter before any final match gives cannot-evaluate", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      inputsBody(),
      routesBody([
        { id: "rx", filter: "__inputId=='eventhub:azure_onb_eh_ns_hub' && sourcetype=='x'" },
        { id: "r2", filter: "true" },
      ]),
    );
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.route).toMatchObject({ kind: "cannot-evaluate", routeId: "rx" });
  });

  it("a 403 on routes gives unknown, never not-routed", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(inputsBody(), { status: 403, body: "no" });
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.route).toMatchObject({ kind: "unknown", reason: "denied" });
  });

  it("a rejected read is unknown failed and does not throw", async () => {
    const rejecting = {
      request: async () => {
        throw new Error("down");
      },
    } as unknown as CriblClient;
    const side = await readOnboardingCriblSide(rejecting, "g", [INPUT]);
    expect(side.inputs[0]!.input).toEqual({ kind: "unknown", reason: "failed", detail: "down" });
    expect(side.inputs[0]!.route).toEqual({ kind: "unknown", reason: "failed", detail: "down" });
  });

  it("a QuickConnect input (sendToRoutes false) reads quickconnect, never a route walk", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      inputsBody({ id: INPUT.id, type: "eventhub", sendToRoutes: false, connections: [{ output: "sentinel_out", pipeline: "p1" }, { pipeline: "bad" }] }),
      routesBody([{ id: "r", filter: "true", final: true }]),
    );
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.input).toMatchObject({ kind: "present", sendToRoutes: false });
    expect(side.inputs[0]!.route).toEqual({ kind: "quickconnect", connections: [{ output: "sentinel_out", pipeline: "p1" }] });
  });

  it("sendToRoutes defaults to true: only an explicit false is QuickConnect", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      inputsBody({ id: INPUT.id, type: "eventhub", connections: [{ output: "x" }] }),
      routesBody([{ id: "r", filter: "true", final: true }]),
    );
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.route).toEqual({ kind: "consumes", routes: [{ id: "r", name: "r", filter: "true", final: true }] });
  });

  it("a route walk with the inputs read unknown, or the input absent, says it assumed sendToRoutes", async () => {
    const denied = new FakeCriblClient();
    denied.respondWith({ status: 403, body: "denied" }, routesBody([{ id: "r", filter: "true", final: true }]));
    const a = await readOnboardingCriblSide(denied, "g", [INPUT]);
    expect(a.inputs[0]!.route).toMatchObject({ kind: "consumes", assumesSendToRoutes: true });
    const absent = new FakeCriblClient();
    absent.respondWith(inputsBody(), routesBody([{ id: "r", filter: "true", final: true }]));
    const b = await readOnboardingCriblSide(absent, "g", [INPUT]);
    expect(b.inputs[0]!.route).toMatchObject({ kind: "consumes", assumesSendToRoutes: true });
    const present = new FakeCriblClient();
    present.respondWith(inputsBody({ id: INPUT.id, type: "eventhub" }), routesBody([{ id: "r", filter: "true", final: true }]));
    const c = await readOnboardingCriblSide(present, "g", [INPUT]);
    expect(c.inputs[0]!.route).not.toHaveProperty("assumesSendToRoutes");
  });

  it("an {items: []} routes body is unknown unexpected-shape, not an empty table (not-routed)", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(inputsBody({ id: INPUT.id, type: "eventhub" }), { status: 200, body: { count: 0, items: [] } });
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.route).toMatchObject({ kind: "unknown", reason: "unexpected-shape" });
  });

  it("a table object with no routes array is unknown, never a phantom route that consumes", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(inputsBody({ id: INPUT.id, type: "eventhub" }), { status: 200, body: { count: 1, items: [{ id: "default", groups: {} }] } });
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.route).toMatchObject({ kind: "unknown", reason: "unexpected-shape" });
  });

  it("a top-level {routes: [...]} body is still a routing table", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(inputsBody({ id: INPUT.id, type: "eventhub" }), { status: 200, body: { routes: [{ id: "r", filter: "true" }] } });
    const side = await readOnboardingCriblSide(cribl, "g", [INPUT]);
    expect(side.inputs[0]!.route).toMatchObject({ kind: "consumes", routes: [{ id: "r" }] });
  });

  it("no worker group reads nothing and every id is unknown", async () => {
    const cribl = new FakeCriblClient();
    const side = await readOnboardingCriblSide(cribl, "", [INPUT]);
    expect(cribl.calls).toHaveLength(0);
    expect(side.inputs[0]!.input.kind).toBe("unknown");
  });
});

describe("routeConsumption", () => {
  const table = (routes: RouteRow[]): RoutesTable => ({ kind: "table", routes });
  const row = (id: string, filter: string, extra: Partial<{ final: boolean; disabled: boolean }> = {}) => ({
    id,
    name: id,
    filter,
    final: extra.final ?? true,
    disabled: extra.disabled ?? false,
  });
  const EH_X = { type: "eventhub", id: "x" };

  it("skips disabled routes", () => {
    const r = routeConsumption(table([row("d", "true", { disabled: true }), row("p", "__inputId.startsWith('eventhub:')")]), EH_X);
    expect(r).toMatchObject({ kind: "consumes", routes: [{ id: "p" }] });
  });

  it("collects non-final copies before the final match", () => {
    const r = routeConsumption(table([row("c", "['eventhub:x'].includes(__inputId)", { final: false }), row("f", "true")]), EH_X);
    expect(r).toMatchObject({ kind: "consumes", routes: [{ id: "c" }, { id: "f" }] });
  });

  it("no final match over a complete table is not-routed", () => {
    expect(routeConsumption(table([row("o", "__inputId=='syslog:a'")]), EH_X)).toEqual({ kind: "not-routed", copies: [] });
  });

  it("matches type and id, not id alone", () => {
    expect(routeConsumption(table([row("o", "__inputId=='azure_blob:x'")]), EH_X).kind).toBe("not-routed");
  });

  // DBT-162: the bare-id filter this app's wiring writes is still a match, so
  // the app's own route shows - but flagged, because the events carry
  // `eventhub:x` and a capture found the bare form matching nothing.
  it("a bare-id filter consumes as a FLAGGED legacy match", () => {
    expect(routeConsumption(table([row("w", "__inputId=='x'")]), EH_X)).toEqual({
      kind: "consumes",
      routes: [{ id: "w", name: "w", filter: "__inputId=='x'", final: true, legacyBareMatch: true }],
    });
  });

  it("a typed filter is a plain match, and a list naming both forms is typed", () => {
    const typed = routeConsumption(table([row("t", "__inputId=='eventhub:x'")]), EH_X);
    expect(typed).toEqual({ kind: "consumes", routes: [{ id: "t", name: "t", filter: "__inputId=='eventhub:x'", final: true }] });
    const both = routeConsumption(table([row("b", "['x','eventhub:x'].includes(__inputId)")]), EH_X);
    expect(both).toMatchObject({ kind: "consumes", routes: [{ id: "b" }] });
    expect((both as { routes: object[] }).routes[0]).not.toHaveProperty("legacyBareMatch");
  });

  it("reads the same inputs Live Architecture does: a missing type is 'unknown', not ''", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 200, body: { items: [{ id: "x" }] } }, { status: 200, body: { routes: [] } });
    const side = await readOnboardingCriblSide(cribl, "g", [EH_X]);
    expect(side.inputs[0]!.input).toMatchObject({ kind: "present", type: "unknown" });
  });
});

describe("read-source-flow barrel", () => {
  it("exports the usecases", () => {
    expect(typeof barrel.readSourceFlow).toBe("function");
    expect(typeof barrel.readOnboardingCriblSide).toBe("function");
    expect(typeof barrel.routeConsumption).toBe("function");
  });
});
