/**
 * edge-fleets pins: tolerant worker-inventory parsing, offload resolution
 * (cribl_* outputs only, exact and short-name/FQDN host matching, honest
 * unresolved), and the fleet inventory builder (worker-group nodes joined
 * to the diagram, offload facts and edges, flows preserved).
 */

import { describe, expect, it } from "vitest";
import type {
  LiveArchitectureSnapshot,
  LiveSnapshotSection,
} from "./live-architecture";
import {
  buildFleetInventory,
  parseWorkerInventory,
  resolveOffloads,
  type WorkerRecord,
} from "./edge-fleets";
import { listLiveOutputs } from "./live-architecture";

const ok = (body: unknown): LiveSnapshotSection => ({ status: 200, body });

/** A realistic Edge fleet: local collection routed to Stream receivers. */
function fleetSnapshot(): LiveArchitectureSnapshot {
  return {
    groupId: "edge-default",
    inputs: ok({
      items: [
        { id: "file_logs", type: "file" },
        { id: "win_events", type: "windows_events" },
      ],
    }),
    outputs: ok({
      items: [
        {
          id: "to_stream",
          type: "cribl_tcp",
          host: "worker-1.contoso.local",
          port: 10300,
        },
        {
          id: "lb_stream",
          type: "cribl_http",
          loadBalanced: true,
          hosts: [{ host: "worker-2" }, { host: "worker-9" }],
        },
        { id: "blob_out", type: "azure_blob" },
      ],
    }),
    routes: ok({
      id: "edge-default",
      routes: [
        {
          id: "r1",
          name: "files",
          filter: "__inputId=='file_logs'",
          pipeline: "passthru",
          output: "to_stream",
          final: true,
        },
        {
          id: "r2",
          name: "winlogs",
          filter: "__inputId=='win_events'",
          pipeline: "passthru",
          output: "lb_stream",
          final: true,
        },
      ],
    }),
    pipelines: ok({ items: [] }),
    breakers: ok({ items: [] }),
    packs: ok({ items: [] }),
  };
}

const WORKERS: WorkerRecord[] = [
  { hostname: "worker-1.contoso.local", group: "prod-stream" },
  { hostname: "worker-2.contoso.local", group: "prod-stream" },
];

describe("parseWorkerInventory", () => {
  it("accepts array, items, and data envelopes", () => {
    const row = { group: "g1", info: { hostname: "h1" } };
    for (const body of [[row], { items: [row] }, { data: [row] }]) {
      expect(parseWorkerInventory(ok(body))).toEqual([
        { hostname: "h1", group: "g1" },
      ]);
    }
  });

  it("prefers info.hostname, falls back to host, skips incomplete rows", () => {
    const records = parseWorkerInventory(
      ok({
        items: [
          { group: "g1", host: "top-host", info: { hostname: "real-host" } },
          { group: "g2", host: "host-only" },
          { group: "g3" },
          { info: { hostname: "no-group" } },
        ],
      }),
    );
    expect(records).toEqual([
      { hostname: "real-host", group: "g1" },
      { hostname: "host-only", group: "g2" },
    ]);
  });

  it("returns empty for a missing section, an HTTP error, or garbage", () => {
    expect(parseWorkerInventory(undefined)).toEqual([]);
    expect(parseWorkerInventory({ status: 403, body: { items: [] } })).toEqual([]);
    expect(parseWorkerInventory(ok("nonsense"))).toEqual([]);
  });
});

describe("resolveOffloads", () => {
  it("resolves cribl_* outputs to worker groups; other types are not offloads", () => {
    const offloads = resolveOffloads(
      listLiveOutputs(fleetSnapshot().outputs),
      WORKERS,
    );
    expect(offloads).toEqual([
      {
        outputId: "to_stream",
        outputType: "cribl_tcp",
        hosts: ["worker-1.contoso.local"],
        workerGroups: ["prod-stream"],
      },
      {
        outputId: "lb_stream",
        outputType: "cribl_http",
        hosts: ["worker-2", "worker-9"],
        workerGroups: ["prod-stream"],
      },
    ]);
  });

  it("matches short names against FQDNs in either direction", () => {
    const outputs = listLiveOutputs(
      ok({
        items: [
          { id: "a", type: "cribl_tcp", host: "worker-2" },
          { id: "b", type: "cribl_tcp", host: "worker-3.contoso.local" },
        ],
      }),
    );
    const offloads = resolveOffloads(outputs, [
      ...WORKERS,
      { hostname: "worker-3", group: "dmz-stream" },
    ]);
    expect(offloads[0].workerGroups).toEqual(["prod-stream"]);
    expect(offloads[1].workerGroups).toEqual(["dmz-stream"]);
  });

  it("leaves unmatched hosts visible with no invented group", () => {
    const outputs = listLiveOutputs(
      ok({ items: [{ id: "x", type: "cribl_tcp", host: "unknown-host" }] }),
    );
    expect(resolveOffloads(outputs, WORKERS)).toEqual([
      {
        outputId: "x",
        outputType: "cribl_tcp",
        hosts: ["unknown-host"],
        workerGroups: [],
      },
    ]);
  });
});

describe("buildFleetInventory", () => {
  it("joins each resolved worker group to the diagram behind its offload output", () => {
    const inventory = buildFleetInventory("edge-default", fleetSnapshot(), WORKERS);
    const wgNode = inventory.diagram.nodes.find((n) => n.id === "wg:prod-stream");
    expect(wgNode).toBeDefined();
    expect(wgNode?.label).toBe("Stream worker group 'prod-stream'");
    expect(wgNode?.badge).toBe("Stream worker group");
    // BOTH offload outputs point at the shared group node, labeled.
    const offloadEdges = inventory.diagram.edges.filter(
      (e) => e.to === "wg:prod-stream",
    );
    expect(offloadEdges.map((e) => `${e.from} ${e.label}`).sort()).toEqual([
      "out:lb_stream offload",
      "out:to_stream offload",
    ]);
  });

  it("appends an Offloads-to fact on the destination's info popover", () => {
    const inventory = buildFleetInventory("edge-default", fleetSnapshot(), WORKERS);
    const outNode = inventory.diagram.nodes.find((n) => n.id === "out:to_stream");
    expect(outNode?.info?.facts).toContainEqual({
      label: "Offloads to",
      value: "Stream worker group prod-stream",
    });
  });

  it("links the worker-group node to its routes page when a UI base is known", () => {
    const inventory = buildFleetInventory(
      "edge-default",
      fleetSnapshot(),
      WORKERS,
      { uiBase: "https://leader.example.com/stream" },
    );
    const wgNode = inventory.diagram.nodes.find((n) => n.id === "wg:prod-stream");
    expect(wgNode?.info?.docs?.[0]).toEqual({
      label: "Open Routes in Cribl (prod-stream)",
      url: "https://leader.example.com/stream/m/prod-stream/routes",
    });
  });

  it("notes unresolved receiver hosts and keeps the flows inventory", () => {
    const inventory = buildFleetInventory("edge-default", fleetSnapshot(), []);
    expect(
      inventory.notes.some(
        (n) => n.includes("to_stream") && n.includes("could not be resolved"),
      ),
    ).toBe(true);
    // No group nodes appear when nothing resolved; the raw hosts stay in facts.
    expect(inventory.diagram.nodes.some((n) => n.id.startsWith("wg:"))).toBe(false);
    const outNode = inventory.diagram.nodes.find((n) => n.id === "out:to_stream");
    expect(outNode?.info?.facts).toContainEqual({
      label: "Offloads to",
      value: "worker-1.contoso.local",
    });
    // One flow per source/destination pair, never Azure-filtered.
    expect(inventory.flows.map((f) => f.key).sort()).toEqual([
      "g:file_logs>r1>to_stream",
      "g:win_events>r2>lb_stream",
    ]);
  });
});
