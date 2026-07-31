/**
 * fetch-edge-fleets pins: only Edge FLEETS get their configuration
 * snapshotted (Stream groups skipped), the leader worker inventory is one
 * leader-level GET, the fetch cap surfaces skipped fleet ids, and a failed
 * worker read degrades to undefined instead of failing the load.
 */

import { describe, expect, it } from "vitest";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import {
  fetchEdgeFleetData,
  MAX_FLEET_FETCHES,
} from "./fetch-edge-fleets";

/** Script the seven per-fleet section GETs (packs empty = no detail reads). */
function scriptFleetSections(cribl: FakeCriblClient): void {
  cribl.respondWith(
    { status: 200, body: { items: [] } },
    { status: 200, body: { items: [] } },
    { status: 200, body: { routes: [] } },
    { status: 200, body: { items: [] } },
    { status: 200, body: { items: [] } },
    { status: 200, body: { items: [] } },
    { status: 200, body: { items: [] } },
  );
}

describe("fetchEdgeFleetData", () => {
  it("snapshots only Edge fleets and reads the worker inventory once", async () => {
    const cribl = new FakeCriblClient();
    cribl.groups = [
      { id: "prod-stream", product: "stream" },
      { id: "edge-a", product: "edge" },
      { id: "edge-b", product: "edge" },
    ];
    scriptFleetSections(cribl);
    scriptFleetSections(cribl);
    cribl.respondWith({
      status: 200,
      body: { items: [{ group: "prod-stream", info: { hostname: "w1" } }] },
    });
    const data = await fetchEdgeFleetData(cribl);
    expect(data.fleets.map((f) => f.id)).toEqual(["edge-a", "edge-b"]);
    expect(data.skippedFleets).toEqual([]);
    // No section read ever targets the Stream group.
    expect(cribl.calls.some((c) => c.groupId === "prod-stream")).toBe(false);
    expect(cribl.calls.filter((c) => c.groupId === "edge-a")).toHaveLength(7);
    expect(cribl.calls.filter((c) => c.groupId === "edge-b")).toHaveLength(7);
    // The worker inventory is ONE leader-level GET (no group context).
    const workerCalls = cribl.calls.filter((c) => c.path === "/master/workers");
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].method).toBe("GET");
    expect(workerCalls[0].groupId).toBeUndefined();
    expect(data.workers).toEqual({
      status: 200,
      body: { items: [{ group: "prod-stream", info: { hostname: "w1" } }] },
    });
  });

  it("caps fleet fetches and surfaces the skipped fleet ids", async () => {
    const cribl = new FakeCriblClient();
    const fleetIds = Array.from({ length: MAX_FLEET_FETCHES + 2 }, (_, i) => `fleet-${i}`);
    cribl.groups = fleetIds.map((id) => ({ id, product: "edge" }));
    for (let i = 0; i < MAX_FLEET_FETCHES; i++) {
      scriptFleetSections(cribl);
    }
    cribl.respondWith({ status: 200, body: { items: [] } });
    const data = await fetchEdgeFleetData(cribl);
    expect(data.fleets).toHaveLength(MAX_FLEET_FETCHES);
    expect(data.skippedFleets).toEqual([
      `fleet-${MAX_FLEET_FETCHES}`,
      `fleet-${MAX_FLEET_FETCHES + 1}`,
    ]);
  });

  it("degrades a failed worker read to undefined, keeping the fleets", async () => {
    const cribl = new FakeCriblClient();
    cribl.groups = [{ id: "edge-a", product: "edge" }];
    scriptFleetSections(cribl);
    // Nothing scripted for /master/workers: the fake throws, the usecase
    // catches, and offload hosts stay honestly unresolved downstream.
    const data = await fetchEdgeFleetData(cribl);
    expect(data.fleets.map((f) => f.id)).toEqual(["edge-a"]);
    expect(data.workers).toBeUndefined();
  });
});
