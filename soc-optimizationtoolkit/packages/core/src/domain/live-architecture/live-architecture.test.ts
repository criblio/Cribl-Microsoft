/**
 * live-architecture pins: filter-form parsing, Azure keep rules, flow
 * assembly (breakers, pre/post pipelines, packs, default resolution,
 * non-final copies), tolerant section degradation, cost tiers, node
 * identity, and info completeness.
 */

import { describe, expect, it } from "vitest";
import {
  buildLiveDiagram,
  criblUiBaseFromLeaderUrl,
  installedPackIds,
  isAzureCriblType,
  isAzureInput,
  outputCostTier,
  parseRouteFilterInputs,
  type LiveArchitectureSnapshot,
  type LiveSnapshotSection,
} from "./live-architecture";

const ok = (body: unknown): LiveSnapshotSection => ({ status: 200, body });

/** A realistic snapshot: the FlowLogLab-style wiring plus a non-Azure flow. */
function labSnapshot(): LiveArchitectureSnapshot {
  return {
    groupId: "default",
    inputs: ok({
      items: [
        {
          id: "flowlog_collector",
          type: "collection",
          collector: { type: "azure_blob" },
          breakerRulesets: ["Azure_vNet_FlowLogs"],
          pipeline: "Azure_vNet_FlowLogs_PreProcessing",
        },
        { id: "syslog_pan", type: "syslog" },
        { id: "old_input", type: "tcp", disabled: true },
      ],
    }),
    outputs: ok({
      items: [
        { id: "sentinel_dest", type: "sentinel" },
        { id: "splunk_dest", type: "splunk" },
        { id: "default", type: "default", defaultId: "sentinel_dest" },
      ],
    }),
    routes: ok({
      id: "default",
      routes: [
        {
          id: "r1",
          name: "flowlogs",
          filter: "__inputId=='flowlog_collector'",
          pipeline: "pack:AzureFlowLogs",
          output: "sentinel_dest",
          final: true,
        },
        {
          id: "r2",
          name: "pan-to-splunk",
          filter: "__inputId=='syslog_pan'",
          pipeline: "passthru",
          output: "splunk_dest",
          final: true,
        },
      ],
    }),
    pipelines: ok({
      items: [
        {
          id: "Azure_vNet_FlowLogs_PreProcessing",
          conf: { functions: [{ id: "eval" }, { id: "unroll" }, { id: "serialize" }] },
        },
      ],
    }),
    breakers: ok({
      items: [{ id: "Azure_vNet_FlowLogs", rules: [{ name: "r" }] }],
    }),
    packs: ok({ items: [{ id: "AzureFlowLogs", version: "0.0.3" }] }),
  };
}

describe("parseRouteFilterInputs", () => {
  it("parses the single-input forms this app writes", () => {
    expect(parseRouteFilterInputs("__inputId=='a'")).toEqual({
      kind: "inputs",
      ids: ["a"],
    });
    expect(parseRouteFilterInputs('__inputId==="a-b"')).toEqual({
      kind: "inputs",
      ids: ["a-b"],
    });
    expect(parseRouteFilterInputs("  __inputId == 'x'  ")).toEqual({
      kind: "inputs",
      ids: ["x"],
    });
  });

  it("parses the includes() list form", () => {
    expect(parseRouteFilterInputs("['a','b'].includes(__inputId)")).toEqual({
      kind: "inputs",
      ids: ["a", "b"],
    });
  });

  it("parses the startsWith prefix form collector routes use", () => {
    expect(parseRouteFilterInputs("__inputId.startsWith('collection:')")).toEqual({
      kind: "prefix",
      value: "collection:",
    });
    expect(parseRouteFilterInputs('__inputId.startsWith( "in_" )')).toEqual({
      kind: "prefix",
      value: "in_",
    });
  });

  it("missing or true means all inputs; anything else is unparsed", () => {
    expect(parseRouteFilterInputs(undefined)).toEqual({ kind: "all" });
    expect(parseRouteFilterInputs("true")).toEqual({ kind: "all" });
    expect(parseRouteFilterInputs("source=='x'")).toEqual({ kind: "unparsed" });
  });
});

describe("isAzureCriblType / isAzureInput / outputCostTier", () => {
  it("classifies types by prefix plus the known unprefixed names", () => {
    expect(isAzureCriblType("input", "azure_blob")).toBe(true);
    expect(isAzureCriblType("input", "eventhub")).toBe(true);
    expect(isAzureCriblType("input", "office365_mgmt")).toBe(true);
    expect(isAzureCriblType("input", "syslog")).toBe(false);
    expect(isAzureCriblType("output", "sentinel")).toBe(true);
    expect(isAzureCriblType("output", "azure_data_explorer")).toBe(true);
    expect(isAzureCriblType("output", "splunk")).toBe(false);
  });

  it("sniffs collection inputs through their inner collector type", () => {
    expect(
      isAzureInput({ type: "collection", conf: { collector: { type: "azure_blob" } } }),
    ).toBe(true);
    expect(
      isAzureInput({ type: "collection", conf: { collector: { type: "s3" } } }),
    ).toBe(false);
  });

  it("maps output types onto the pinned cost tiers", () => {
    expect(outputCostTier("sentinel")).toBe("premium");
    expect(outputCostTier("azure_logs")).toBe("premium");
    expect(outputCostTier("azure_blob")).toBe("economical");
    expect(outputCostTier("azure_data_explorer")).toBe("economical");
    expect(outputCostTier("cribl_lake")).toBe("economical");
    expect(outputCostTier("splunk")).toBeUndefined();
  });
});

describe("buildLiveDiagram - full chain", () => {
  it("draws the collector chain through the pack into Sentinel", () => {
    const { diagram, notes } = buildLiveDiagram(labSnapshot(), { azureOnly: true });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "in:flowlog_collector",
        "brk:Azure_vNet_FlowLogs",
        "pre:Azure_vNet_FlowLogs_PreProcessing",
        "routes",
        "pack:AzureFlowLogs",
        "out:sentinel_dest",
      ]),
    );
    const edgePairs = diagram.edges.map((e) => `${e.from}>${e.to}`);
    expect(edgePairs).toEqual(
      expect.arrayContaining([
        "in:flowlog_collector>brk:Azure_vNet_FlowLogs",
        "brk:Azure_vNet_FlowLogs>pre:Azure_vNet_FlowLogs_PreProcessing",
        "pre:Azure_vNet_FlowLogs_PreProcessing>routes",
        "routes>pack:AzureFlowLogs",
        "pack:AzureFlowLogs>out:sentinel_dest",
      ]),
    );
    expect(
      diagram.edges.find((e) => e.to === "out:sentinel_dest")?.cost,
    ).toBe("premium");
    // The syslog->splunk flow is filtered by azureOnly; the note says so.
    expect(ids).not.toContain("in:syslog_pan");
    expect(notes.some((n) => n.startsWith("Azure filter:"))).toBe(true);
    // Disabled input skipped with a note.
    expect(ids).not.toContain("in:old_input");
    expect(notes.some((n) => n.includes("disabled input"))).toBe(true);
  });

  it("azureOnly false keeps everything, flows stay whole", () => {
    const { diagram } = buildLiveDiagram(labSnapshot(), { azureOnly: false });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("in:syslog_pan");
    expect(ids).toContain("out:splunk_dest");
    // Passthru route: no pipeline node between hub and splunk.
    expect(
      diagram.edges.some((e) => e.from === "routes" && e.to === "out:splunk_dest"),
    ).toBe(true);
  });

  it("keeps a non-Azure input WHOLE when its output is Azure", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        {
          id: "r1",
          name: "pan-to-sentinel",
          filter: "__inputId=='syslog_pan'",
          output: "sentinel_dest",
          final: true,
        },
      ],
    });
    const { diagram } = buildLiveDiagram(snapshot, { azureOnly: true });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("in:syslog_pan");
    expect(ids).toContain("out:sentinel_dest");
  });
});

describe("buildLiveDiagram - routing semantics", () => {
  it("resolves the default output through defaultId", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        { id: "r1", name: "to-default", filter: "__inputId=='flowlog_collector'", final: true },
      ],
    });
    const { diagram } = buildLiveDiagram(snapshot, { azureOnly: true });
    expect(diagram.nodes.some((n) => n.id === "out:sentinel_dest")).toBe(true);
  });

  it("labels non-final routes as copies and notes them", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        {
          id: "r0",
          name: "lake-copy",
          filter: "__inputId=='flowlog_collector'",
          output: "cribl_lake:flows",
          final: false,
        },
        {
          id: "r1",
          name: "flowlogs",
          filter: "__inputId=='flowlog_collector'",
          pipeline: "pack:AzureFlowLogs",
          output: "sentinel_dest",
          final: true,
        },
      ],
    });
    const { diagram, notes } = buildLiveDiagram(snapshot, { azureOnly: true });
    const lakeEdge = diagram.edges.find((e) => e.to === "out:cribl_lake:flows");
    expect(lakeEdge?.label).toBe("lake-copy (copy)");
    expect(lakeEdge?.cost).toBe("economical");
    expect(notes.some((n) => n.includes("Non-final route(s)"))).toBe(true);
  });

  it("treats unparsed filters as any-input with a note", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        {
          id: "r1",
          name: "weird",
          filter: "source.startsWith('x')",
          output: "sentinel_dest",
          final: true,
        },
      ],
    });
    const { diagram, notes } = buildLiveDiagram(snapshot, { azureOnly: false });
    // Both enabled inputs chain into the hub (the route can match any).
    expect(diagram.nodes.some((n) => n.id === "in:flowlog_collector")).toBe(true);
    expect(diagram.nodes.some((n) => n.id === "in:syslog_pan")).toBe(true);
    expect(notes.some((n) => n.includes("filter not recognized"))).toBe(true);
  });

  it("notes enabled inputs no route matches (all filters specific)", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        {
          id: "r1",
          name: "flowlogs",
          filter: "__inputId=='flowlog_collector'",
          output: "sentinel_dest",
          final: true,
        },
      ],
    });
    const { notes } = buildLiveDiagram(snapshot, { azureOnly: false });
    expect(notes.some((n) => n.includes("matched by no route") && n.includes("syslog_pan"))).toBe(
      true,
    );
  });
});

describe("buildLiveDiagram - degradation", () => {
  it("survives a failed routes section (sources still chain into the hub - no, hub needs routes; empty diagram with notes)", () => {
    const snapshot = labSnapshot();
    snapshot.routes = { status: 500, body: { error: "boom" } };
    const result = buildLiveDiagram(snapshot, { azureOnly: true });
    expect(result.notes.some((n) => n.includes("Routes returned HTTP 500"))).toBe(true);
    // No routes -> no triples -> empty diagram, honest note.
    expect(result.diagram.nodes).toHaveLength(0);
    expect(result.notes.some((n) => n.startsWith("No Azure-related flows"))).toBe(true);
  });

  it("survives a missing inputs section with output-driven flows", () => {
    const snapshot = labSnapshot();
    snapshot.inputs = undefined;
    const { diagram, notes } = buildLiveDiagram(snapshot, { azureOnly: true });
    expect(notes.some((n) => n.includes("Sources could not be fetched"))).toBe(true);
    expect(diagram.nodes.some((n) => n.id === "out:sentinel_dest")).toBe(true);
    expect(diagram.nodes.some((n) => n.id.startsWith("in:"))).toBe(false);
  });

  it("never throws on garbage bodies", () => {
    const snapshot: LiveArchitectureSnapshot = {
      groupId: "g",
      inputs: ok("not an envelope"),
      outputs: ok(42),
      routes: ok({ nothing: true }),
      pipelines: undefined,
      breakers: { status: 403, body: {} },
      packs: ok(null),
    };
    const result = buildLiveDiagram(snapshot, { azureOnly: false });
    expect(result.diagram.nodes).toHaveLength(0);
    expect(result.notes.length).toBeGreaterThanOrEqual(6);
  });
});

describe("buildLiveDiagram - identity and info", () => {
  it("an input and a route pipeline sharing an id stay distinct nodes", () => {
    const snapshot: LiveArchitectureSnapshot = {
      groupId: "g",
      inputs: ok({ items: [{ id: "shared", type: "eventhub" }] }),
      outputs: ok({ items: [{ id: "dest", type: "sentinel" }] }),
      routes: ok({
        routes: [
          {
            id: "r1",
            name: "r1",
            filter: "__inputId=='shared'",
            pipeline: "shared",
            output: "dest",
            final: true,
          },
        ],
      }),
      pipelines: ok({ items: [] }),
      breakers: ok({ items: [] }),
      packs: ok({ items: [] }),
    };
    const { diagram } = buildLiveDiagram(snapshot, { azureOnly: true });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("in:shared");
    expect(ids).toContain("pipe:shared");
  });

  it("every emitted node carries info with purpose and at least one doc link", () => {
    const { diagram } = buildLiveDiagram(labSnapshot(), { azureOnly: false });
    expect(diagram.nodes.length).toBeGreaterThan(0);
    for (const node of diagram.nodes) {
      expect(node.info, node.id).toBeDefined();
      expect(node.info!.purpose.length).toBeGreaterThan(10);
      expect(node.info!.docs.length).toBeGreaterThanOrEqual(1);
      for (const doc of node.info!.docs) {
        expect(doc.url.startsWith("https://")).toBe(true);
      }
    }
  });

  it("is deterministic", () => {
    expect(buildLiveDiagram(labSnapshot(), { azureOnly: true })).toEqual(
      buildLiveDiagram(labSnapshot(), { azureOnly: true }),
    );
  });
});

/** A group whose only source is a scheduled collector JOB (/jobs section):
 * the breaker and pre-processing pipeline nest under the job's `input.`
 * sub-object, and route filters address it as `collection:{jobId}`. */
function jobsSnapshot(): LiveArchitectureSnapshot {
  return {
    groupId: "default",
    inputs: ok({ items: [{ id: "syslog_pan", type: "syslog" }] }),
    outputs: ok({
      items: [{ id: "adx_dest", type: "azure_data_explorer", pipeline: "adx_post" }],
    }),
    routes: ok({
      routes: [
        {
          id: "r1",
          name: "blob-flows",
          filter: "__inputId=='collection:blob_flowlogs'",
          pipeline: "shape_flows",
          output: "adx_dest",
          final: true,
        },
      ],
    }),
    pipelines: ok({
      items: [
        { id: "shape_flows", conf: { functions: [{ id: "eval" }] } },
        { id: "adx_post", conf: { functions: [{ id: "numerify" }] } },
        { id: "blob_pre", conf: { functions: [{ id: "drop" }] } },
      ],
    }),
    breakers: ok({ items: [{ id: "FlowBreaker", rules: [{ name: "r" }] }] }),
    packs: ok({ items: [] }),
    jobs: ok({
      items: [
        {
          id: "blob_flowlogs",
          type: "collection",
          collector: { type: "azure_blob" },
          input: {
            type: "collection",
            breakerRulesets: ["FlowBreaker"],
            pipeline: "blob_pre",
          },
        },
      ],
    }),
  };
}

describe("buildLiveDiagram - collector jobs and stage badges (2026-07-29)", () => {
  it("chains a job's nested breaker/pre-processing and matches its collection: alias", () => {
    const { diagram } = buildLiveDiagram(jobsSnapshot(), { azureOnly: true });
    const edgePairs = diagram.edges.map((e) => `${e.from}>${e.to}`);
    expect(edgePairs).toEqual(
      expect.arrayContaining([
        "in:blob_flowlogs>brk:FlowBreaker",
        "brk:FlowBreaker>pre:blob_pre",
        "pre:blob_pre>routes",
        "routes>pipe:shape_flows",
        "pipe:shape_flows>post:adx_post",
        "post:adx_post>out:adx_dest",
      ]),
    );
    expect(diagram.edges.find((e) => e.to === "out:adx_dest")?.cost).toBe("economical");
    expect(
      diagram.edges.find((e) => e.from === "routes" && e.to === "pipe:shape_flows")
        ?.label,
    ).toBe("blob-flows");
  });

  it("every stage carries its badge (the seven-stage captions)", () => {
    const { diagram } = buildLiveDiagram(jobsSnapshot(), { azureOnly: true });
    const badgeOf = new Map(diagram.nodes.map((n) => [n.id, n.badge]));
    expect(badgeOf.get("in:blob_flowlogs")).toBe("collection source");
    expect(badgeOf.get("brk:FlowBreaker")).toBe("Event breaker");
    expect(badgeOf.get("pre:blob_pre")).toBe("Pre-processing");
    expect(badgeOf.get("routes")).toBe("Routing table");
    expect(badgeOf.get("pipe:shape_flows")).toBe("Pipeline");
    expect(badgeOf.get("post:adx_post")).toBe("Post-processing");
    expect(badgeOf.get("out:adx_dest")).toBe("azure_data_explorer destination");
    // The pack stage badge, from the lab wiring.
    const lab = buildLiveDiagram(labSnapshot(), { azureOnly: true });
    expect(
      lab.diagram.nodes.find((n) => n.id === "pack:AzureFlowLogs")?.badge,
    ).toBe("Pack");
    expect(
      lab.diagram.nodes.find((n) => n.id === "out:sentinel_dest")?.badge,
    ).toBe("sentinel destination");
  });

  it("a startsWith('collection:') filter consumes only collector jobs", () => {
    const snapshot = jobsSnapshot();
    snapshot.routes = ok({
      routes: [
        {
          id: "r1",
          name: "all-collectors",
          filter: "__inputId.startsWith('collection:')",
          output: "adx_dest",
          final: true,
        },
      ],
    });
    const { diagram } = buildLiveDiagram(snapshot, { azureOnly: false });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("in:blob_flowlogs");
    expect(ids).not.toContain("in:syslog_pan");
  });

  it("the collector job's info names the collector type", () => {
    const { diagram } = buildLiveDiagram(jobsSnapshot(), { azureOnly: true });
    const job = diagram.nodes.find((n) => n.id === "in:blob_flowlogs")!;
    expect(job.info?.purpose).toContain("azure_blob");
  });
});

describe("buildLiveDiagram - source/destination focus (2026-07-29)", () => {
  it("focusSources keeps only that source's flows, with everything in-between", () => {
    const { diagram, notes } = buildLiveDiagram(labSnapshot(), {
      azureOnly: false,
      focusSources: ["flowlog_collector"],
    });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("in:flowlog_collector");
    expect(ids).toContain("brk:Azure_vNet_FlowLogs");
    expect(ids).toContain("pre:Azure_vNet_FlowLogs_PreProcessing");
    expect(ids).toContain("pack:AzureFlowLogs");
    expect(ids).toContain("out:sentinel_dest");
    expect(ids).not.toContain("in:syslog_pan");
    expect(ids).not.toContain("out:splunk_dest");
    expect(notes.some((n) => n.startsWith("Focus: showing 1 of 2"))).toBe(true);
  });

  it("focusOutputs keeps only flows into that destination", () => {
    const { diagram } = buildLiveDiagram(labSnapshot(), {
      azureOnly: false,
      focusOutputs: ["splunk_dest"],
    });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("in:syslog_pan");
    expect(ids).toContain("out:splunk_dest");
    expect(ids).not.toContain("in:flowlog_collector");
    expect(ids).not.toContain("out:sentinel_dest");
  });

  it("matches synthesized lake destinations by their raw route reference", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        {
          id: "r0",
          name: "lake-copy",
          filter: "__inputId=='flowlog_collector'",
          output: "cribl_lake:flows",
          final: false,
        },
        {
          id: "r1",
          name: "flowlogs",
          filter: "__inputId=='flowlog_collector'",
          pipeline: "pack:AzureFlowLogs",
          output: "sentinel_dest",
          final: true,
        },
      ],
    });
    const { diagram } = buildLiveDiagram(snapshot, {
      azureOnly: false,
      focusOutputs: ["cribl_lake:flows"],
    });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("out:cribl_lake:flows");
    expect(ids).not.toContain("out:sentinel_dest");
    expect(ids).not.toContain("pack:AzureFlowLogs");
  });

  it("both filters compose; an empty intersection is honest", () => {
    const { diagram, notes } = buildLiveDiagram(labSnapshot(), {
      azureOnly: false,
      focusSources: ["syslog_pan"],
      focusOutputs: ["sentinel_dest"],
    });
    // syslog_pan only routes to splunk - nothing between the two picks.
    expect(diagram.nodes).toHaveLength(0);
    expect(notes.some((n) => n.startsWith("Focus: showing 0 of 2"))).toBe(true);
  });
});

describe("routes popover detail and pack internals (2026-07-30)", () => {
  it("the Routes popover lists each route with filter, pack/pipeline, and destination", () => {
    const { diagram } = buildLiveDiagram(labSnapshot(), { azureOnly: false });
    const hub = diagram.nodes.find((n) => n.id === "routes")!;
    expect(hub.info?.purpose).toContain(
      "1. flowlogs - filter: __inputId=='flowlog_collector' - via pack AzureFlowLogs -> sentinel_dest",
    );
    expect(hub.info?.purpose).toContain(
      "2. pan-to-splunk - filter: __inputId=='syslog_pan' - via pipeline passthru -> splunk_dest",
    );
  });

  it("resolves the default indirection in the popover line", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        { id: "r1", name: "to-default", filter: "__inputId=='flowlog_collector'", final: true },
      ],
    });
    const { diagram } = buildLiveDiagram(snapshot, { azureOnly: true });
    const hub = diagram.nodes.find((n) => n.id === "routes")!;
    expect(hub.info?.purpose).toContain(
      "1. to-default - filter: __inputId=='flowlog_collector' - via pipeline passthru -> default (sentinel_dest)",
    );
  });

  it("installedPackIds parses tolerantly", () => {
    expect(
      installedPackIds(ok({ items: [{ id: "A" }, { name: "B" }, {}] })),
    ).toEqual(["A", "B"]);
    expect(installedPackIds(undefined)).toEqual([]);
    expect(installedPackIds({ status: 500, body: {} })).toEqual([]);
  });

  /** A group whose ONLY flow lives inside an all-inclusive pack. */
  function packSnapshot(): LiveArchitectureSnapshot {
    return {
      groupId: "default",
      inputs: ok({ items: [] }),
      outputs: ok({ items: [] }),
      routes: ok({ routes: [] }),
      pipelines: ok({ items: [] }),
      breakers: ok({ items: [] }),
      packs: ok({
        items: [
          { id: "AllInOne", displayName: "All In One", version: "1.0.0" },
          { id: "OtherPack" },
        ],
      }),
      jobs: ok({ items: [] }),
      packDetails: {
        AllInOne: {
          inputs: ok({ items: [{ id: "eh_in", type: "eventhub" }] }),
          outputs: ok({ items: [{ id: "sent_out", type: "sentinel" }] }),
          routes: ok({
            routes: [
              {
                id: "r1",
                name: "pack-route",
                filter: "true",
                pipeline: "shape",
                output: "sent_out",
                final: true,
              },
            ],
          }),
          pipelines: ok({ items: [{ id: "shape", conf: { functions: [{ id: "eval" }] } }] }),
        },
      },
    };
  }

  it("draws an all-inclusive pack's embedded endpoints through the pack card", () => {
    const { diagram, notes } = buildLiveDiagram(packSnapshot(), { azureOnly: true });
    const badgeOf = new Map(diagram.nodes.map((n) => [n.id, n.badge]));
    expect(badgeOf.get("in:AllInOne/eh_in")).toBe("eventhub source");
    expect(badgeOf.get("pack:AllInOne")).toBe("Pack");
    expect(badgeOf.get("out:AllInOne/sent_out")).toBe("sentinel destination");
    const edgePairs = diagram.edges.map((e) => `${e.from}>${e.to}`);
    expect(edgePairs).toEqual(
      expect.arrayContaining([
        "in:AllInOne/eh_in>pack:AllInOne",
        "pack:AllInOne>out:AllInOne/sent_out",
      ]),
    );
    expect(
      diagram.edges.find((e) => e.to === "out:AllInOne/sent_out")?.cost,
    ).toBe("premium");
    // The pack popover names the internals: endpoints, pipelines, routes.
    const pack = diagram.nodes.find((n) => n.id === "pack:AllInOne")!;
    expect(pack.info?.purpose).toContain("Embedded source(s): eh_in (eventhub).");
    expect(pack.info?.purpose).toContain("Embedded destination(s): sent_out (sentinel).");
    expect(pack.info?.purpose).toContain("1 pack pipeline(s).");
    expect(pack.info?.purpose).toContain(
      "1. pack-route - filter: true - via pipeline shape -> sent_out",
    );
    // The card is labeled by the pack's DISPLAY NAME and offers explode.
    const packNode = diagram.nodes.find((n) => n.id === "pack:AllInOne")!;
    expect(packNode.label).toBe("All In One");
    expect(packNode.expandable).toBe(true);
    expect(packNode.expanded).toBe(false);
    // Honest notes: what was drawn, and the inspection shortfall.
    expect(
      notes.some((n) => n.startsWith("Pack 'All In One': 1 embedded source(s)")),
    ).toBe(true);
    expect(
      notes.some((n) => n.includes("inspected for 1 of 2 installed pack(s)")),
    ).toBe(true);
    // Pack flows drawn -> no misleading "no flows" note.
    expect(notes.some((n) => n.startsWith("No Azure-related flows"))).toBe(false);
  });

  it("the Azure filter skips a non-Azure pack's internals with a note", () => {
    const snapshot = packSnapshot();
    snapshot.packDetails = {
      AllInOne: {
        inputs: ok({ items: [{ id: "syslog_in", type: "syslog" }] }),
        outputs: ok({ items: [{ id: "splunk_out", type: "splunk" }] }),
        routes: ok({ routes: [] }),
        pipelines: ok({ items: [] }),
      },
    };
    const { diagram, notes } = buildLiveDiagram(snapshot, { azureOnly: true });
    expect(diagram.nodes.some((n) => n.id.startsWith("in:AllInOne"))).toBe(false);
    expect(
      notes.some((n) => n.includes("non-Azure pack(s): AllInOne")),
    ).toBe(true);
    expect(notes.some((n) => n.startsWith("No Azure-related flows"))).toBe(true);
  });

  it("an exploded pack fans out into routes, pipelines, and destinations", () => {
    const { diagram } = buildLiveDiagram(packSnapshot(), {
      azureOnly: true,
      expandedPacks: ["AllInOne"],
    });
    const badgeOf = new Map(diagram.nodes.map((n) => [n.id, n.badge]));
    expect(badgeOf.get("routes:AllInOne")).toBe("Routing table");
    expect(badgeOf.get("pipe:AllInOne/shape")).toBe("Pack pipeline");
    const edgePairs = diagram.edges.map((e) => `${e.from}>${e.to}`);
    expect(edgePairs).toEqual(
      expect.arrayContaining([
        "in:AllInOne/eh_in>pack:AllInOne",
        "pack:AllInOne>routes:AllInOne",
        "routes:AllInOne>pipe:AllInOne/shape",
        "pipe:AllInOne/shape>out:AllInOne/sent_out",
      ]),
    );
    expect(
      diagram.edges.find(
        (e) => e.from === "routes:AllInOne" && e.to === "pipe:AllInOne/shape",
      )?.label,
    ).toBe("pack-route");
    expect(
      diagram.edges.find((e) => e.to === "out:AllInOne/sent_out")?.cost,
    ).toBe("premium");
    // Exploded: the generic pack -> destination shortcut is gone.
    expect(edgePairs).not.toContain("pack:AllInOne>out:AllInOne/sent_out");
    expect(diagram.nodes.find((n) => n.id === "pack:AllInOne")?.expanded).toBe(true);
    // The internal routing table popover carries the route detail.
    expect(
      diagram.nodes.find((n) => n.id === "routes:AllInOne")?.info?.purpose,
    ).toContain("1. pack-route - filter: true - via pipeline shape -> sent_out");
  });

  it("inventories every complete flow and honors selectedFlows", () => {
    // The inventory is filter-independent: azureOnly still lists both.
    const inventory = buildLiveDiagram(labSnapshot(), { azureOnly: true }).flows;
    expect(inventory).toEqual([
      {
        key: "g:flowlog_collector>r1>sentinel_dest",
        label:
          "flowlog_collector -> flowlogs (pack AzureFlowLogs) -> sentinel_dest",
        azure: true,
      },
      {
        key: "g:syslog_pan>r2>splunk_dest",
        label: "syslog_pan -> pan-to-splunk -> splunk_dest",
        azure: false,
      },
    ]);
    // Pack flows appear as one selectable unit, labeled by display name.
    expect(
      buildLiveDiagram(packSnapshot(), { azureOnly: true }).flows,
    ).toEqual([
      {
        key: "p:AllInOne",
        label: "Pack All In One: eh_in -> sent_out",
        azure: true,
      },
    ]);
    // Selecting one flow draws only that flow, with an honest note.
    const { diagram, notes } = buildLiveDiagram(labSnapshot(), {
      azureOnly: false,
      selectedFlows: ["g:syslog_pan>r2>splunk_dest"],
    });
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain("in:syslog_pan");
    expect(ids).toContain("out:splunk_dest");
    expect(ids).not.toContain("in:flowlog_collector");
    expect(notes.some((n) => n.startsWith("Flow selection: 1 of 2"))).toBe(true);
  });

  it("a flow selection without the pack key skips the pack internals", () => {
    const { diagram } = buildLiveDiagram(packSnapshot(), {
      azureOnly: true,
      selectedFlows: ["g:something>r9>elsewhere"],
    });
    expect(diagram.nodes.some((n) => n.id === "pack:AllInOne")).toBe(false);
  });

  it("pipeline popovers list the functions by type in evaluation order", () => {
    const { diagram } = buildLiveDiagram(labSnapshot(), { azureOnly: true });
    const pre = diagram.nodes.find(
      (n) => n.id === "pre:Azure_vNet_FlowLogs_PreProcessing",
    )!;
    expect(pre.info?.purpose).toBe(
      "Pre-processing pipeline 'Azure_vNet_FlowLogs_PreProcessing': 3 function(s).\n" +
        "1. eval\n2. unroll\n3. serialize",
    );
    // Disabled functions stay in order, marked.
    const snapshot = labSnapshot();
    snapshot.pipelines = ok({
      items: [
        {
          id: "Azure_vNet_FlowLogs_PreProcessing",
          conf: {
            functions: [
              { id: "eval" },
              { id: "drop", disabled: true },
              { id: "serialize" },
            ],
          },
        },
      ],
    });
    const withDisabled = buildLiveDiagram(snapshot, { azureOnly: true });
    expect(
      withDisabled.diagram.nodes.find(
        (n) => n.id === "pre:Azure_vNet_FlowLogs_PreProcessing",
      )?.info?.purpose,
    ).toBe(
      "Pre-processing pipeline 'Azure_vNet_FlowLogs_PreProcessing': " +
        "3 function(s) (1 disabled).\n1. eval\n2. drop (disabled)\n3. serialize",
    );
  });

  it("the pack's internal routing table explodes one level further", () => {
    const snapshot = packSnapshot();
    snapshot.packDetails = {
      AllInOne: {
        ...snapshot.packDetails!.AllInOne,
        routes: ok({
          routes: [
            {
              id: "r1",
              name: "pack-route",
              filter: "true",
              pipeline: "shape",
              output: "sent_out",
              final: true,
            },
            {
              id: "r2",
              name: "old-pack-route",
              filter: "false",
              output: "sent_out",
              final: true,
              disabled: true,
            },
          ],
        }),
      },
    };
    // Exploded pack, COLLAPSED internal table: hub is expandable, no route nodes.
    const collapsed = buildLiveDiagram(snapshot, {
      azureOnly: true,
      expandedPacks: ["AllInOne"],
    });
    const hub = collapsed.diagram.nodes.find((n) => n.id === "routes:AllInOne")!;
    expect(hub.expandable).toBe(true);
    expect(hub.expanded).toBe(false);
    expect(
      collapsed.diagram.nodes.some((n) => n.id.startsWith("route:AllInOne/")),
    ).toBe(false);

    // Exploded internal table: per-route nodes, disabled ones subdued.
    const { diagram } = buildLiveDiagram(snapshot, {
      azureOnly: true,
      expandedPacks: ["AllInOne"],
      expandedPackRoutes: ["AllInOne"],
    });
    expect(diagram.nodes.find((n) => n.id === "routes:AllInOne")?.expanded).toBe(true);
    const edgePairs = diagram.edges.map((e) => `${e.from}>${e.to}`);
    expect(edgePairs).toEqual(
      expect.arrayContaining([
        "routes:AllInOne>route:AllInOne/r1",
        "route:AllInOne/r1>pipe:AllInOne/shape",
        "pipe:AllInOne/shape>out:AllInOne/sent_out",
        "routes:AllInOne>route:AllInOne/r2",
      ]),
    );
    const r1 = diagram.nodes.find((n) => n.id === "route:AllInOne/r1")!;
    expect(r1.badge).toBe("Route");
    expect(r1.info?.purpose).toBe(
      "Route 'pack-route' - entry 1 of pack 'All In One' routes.\n" +
        "Pipeline: shape\n" +
        "Destination: sent_out",
    );
    const r2 = diagram.nodes.find((n) => n.id === "route:AllInOne/r2")!;
    expect(r2.muted).toBe(true);
    expect(r2.badge).toBe("Route (disabled)");
    expect(diagram.edges.find((e) => e.to === "route:AllInOne/r2")?.muted).toBe(true);
    expect(diagram.edges.some((e) => e.from === "route:AllInOne/r2")).toBe(false);
  });

  it("pack-internal nodes link to the pack's Cribl UI page", () => {
    const base = "http://leader.internal:9000";
    const { diagram } = buildLiveDiagram(packSnapshot(), {
      azureOnly: true,
      uiBase: base,
    });
    expect(
      diagram.nodes.find((n) => n.id === "in:AllInOne/eh_in")?.info?.docs[0]?.url,
    ).toBe(`${base}/m/default/p/AllInOne`);
  });
});

describe("routing-table explode (2026-07-30)", () => {
  it("the hub is expandable; exploded routes become their own nodes", () => {
    const collapsed = buildLiveDiagram(labSnapshot(), { azureOnly: false });
    const hub = collapsed.diagram.nodes.find((n) => n.id === "routes")!;
    expect(hub.expandable).toBe(true);
    expect(hub.expanded).toBe(false);
    expect(collapsed.diagram.nodes.some((n) => n.id.startsWith("route:"))).toBe(false);

    const { diagram } = buildLiveDiagram(labSnapshot(), {
      azureOnly: false,
      expandRoutes: true,
    });
    expect(diagram.nodes.find((n) => n.id === "routes")?.expanded).toBe(true);
    const r1 = diagram.nodes.find((n) => n.id === "route:r1")!;
    expect(r1.label).toBe("flowlogs");
    expect(r1.badge).toBe("Route");
    // CLEAN popover (user report 2026-07-30): pipeline + destination as
    // labeled lines, NO raw filter expression (that stays on the hub).
    expect(r1.info?.purpose).toBe(
      "Route 'flowlogs' - entry 1 of the routing table.\n" +
        "Pipeline: pack AzureFlowLogs\n" +
        "Destination: sentinel_dest",
    );
    const edgePairs = diagram.edges.map((e) => `${e.from}>${e.to}`);
    expect(edgePairs).toEqual(
      expect.arrayContaining([
        "routes>route:r1",
        "route:r1>pack:AzureFlowLogs",
        "routes>route:r2",
        "route:r2>out:splunk_dest",
      ]),
    );
    // The route node carries the name; downstream edges drop the label.
    expect(
      diagram.edges.find(
        (e) => e.from === "route:r1" && e.to === "pack:AzureFlowLogs",
      )?.label,
    ).toBeUndefined();
  });

  it("disabled routes draw subdued in the exploded table only", () => {
    const snapshot = labSnapshot();
    snapshot.routes = ok({
      routes: [
        {
          id: "r1",
          name: "flowlogs",
          filter: "__inputId=='flowlog_collector'",
          pipeline: "pack:AzureFlowLogs",
          output: "sentinel_dest",
          final: true,
        },
        {
          id: "r2",
          name: "pan-to-splunk",
          filter: "__inputId=='syslog_pan'",
          pipeline: "passthru",
          output: "splunk_dest",
          final: true,
        },
        {
          id: "r3",
          name: "old-route",
          filter: "__inputId=='syslog_pan'",
          output: "splunk_dest",
          final: true,
          disabled: true,
        },
      ],
    });
    const collapsed = buildLiveDiagram(snapshot, { azureOnly: false });
    expect(collapsed.diagram.nodes.some((n) => n.id === "route:r3")).toBe(false);

    const { diagram } = buildLiveDiagram(snapshot, {
      azureOnly: false,
      expandRoutes: true,
    });
    const r3 = diagram.nodes.find((n) => n.id === "route:r3")!;
    expect(r3.muted).toBe(true);
    expect(r3.label).toBe("old-route (disabled)");
    expect(r3.badge).toBe("Route (disabled)");
    expect(r3.info?.purpose).toContain("DISABLED");
    // Position numbering reflects the REAL table order.
    expect(r3.info?.purpose).toContain("entry 3 of the routing table");
    expect(diagram.edges.find((e) => e.to === "route:r3")?.muted).toBe(true);
    // The disabled route pulls no destination chain of its own.
    expect(
      diagram.edges.some((e) => e.from === "route:r3"),
    ).toBe(false);
  });
});

describe("Cribl UI resource links (2026-07-29)", () => {
  it("derives the UI base from a leader URL (cloud gets /stream)", () => {
    expect(criblUiBaseFromLeaderUrl("https://main-acme.cribl.cloud")).toBe(
      "https://main-acme.cribl.cloud/stream",
    );
    expect(criblUiBaseFromLeaderUrl("http://leader.internal:9000/")).toBe(
      "http://leader.internal:9000",
    );
    expect(criblUiBaseFromLeaderUrl("  ")).toBeUndefined();
    expect(criblUiBaseFromLeaderUrl("not a url")).toBeUndefined();
  });

  it("with uiBase, every live node links to ITS page in the Cribl UI", () => {
    const base = "http://leader.internal:9000";
    const { diagram } = buildLiveDiagram(jobsSnapshot(), {
      azureOnly: true,
      uiBase: base,
    });
    const linkOf = new Map(
      diagram.nodes.map((n) => [n.id, n.info?.docs[0]]),
    );
    expect(linkOf.get("routes")).toEqual({
      label: "Open Routes in Cribl (default)",
      url: `${base}/m/default/routes`,
    });
    expect(linkOf.get("in:blob_flowlogs")?.url).toBe(
      `${base}/m/default/inputs/collectors`,
    );
    expect(linkOf.get("brk:FlowBreaker")?.url).toBe(
      `${base}/m/default/knowledge/breakerrules`,
    );
    expect(linkOf.get("pre:blob_pre")?.url).toBe(
      `${base}/m/default/pipelines/blob_pre`,
    );
    expect(linkOf.get("pipe:shape_flows")?.url).toBe(
      `${base}/m/default/pipelines/shape_flows`,
    );
    expect(linkOf.get("post:adx_post")?.url).toBe(
      `${base}/m/default/pipelines/adx_post`,
    );
    expect(linkOf.get("out:adx_dest")?.url).toBe(
      `${base}/m/default/outputs`,
    );
    // Each resource link REPLACES the docs list (user: navigate to the
    // resource instead of the documentation reference).
    for (const node of diagram.nodes) {
      expect(node.info?.docs, node.id).toHaveLength(1);
    }
  });

  it("regular sources and packs link to their pages too", () => {
    const base = "https://main-acme.cribl.cloud/stream";
    const { diagram } = buildLiveDiagram(labSnapshot(), {
      azureOnly: false,
      uiBase: base,
    });
    expect(
      diagram.nodes.find((n) => n.id === "in:syslog_pan")?.info?.docs[0]?.url,
    ).toBe(`${base}/m/default/inputs`);
    expect(
      diagram.nodes.find((n) => n.id === "pack:AzureFlowLogs")?.info?.docs[0]?.url,
    ).toBe(`${base}/m/default/p/AzureFlowLogs`);
  });

  it("without uiBase, the documentation links stay", () => {
    const { diagram } = buildLiveDiagram(labSnapshot(), { azureOnly: true });
    const hub = diagram.nodes.find((n) => n.id === "routes")!;
    expect(hub.info?.docs[0]?.url).toContain("docs.cribl.io");
  });
});
