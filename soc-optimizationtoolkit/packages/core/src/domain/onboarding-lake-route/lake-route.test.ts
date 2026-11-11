/**
 * onboarding-lake-route (AZR-35): ids, bodies built from the bundled spec, the
 * route, and the ownership refusals for the shared unroll pipeline.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchInputIdFilter } from "../capture-filter/input-id";
import { parseRouteFilterInputs } from "../live-architecture";
import { stampFor } from "../../kit/config-writes/ownership";
import { APP_ID } from "../cribl-secrets/secret-body";
import {
  LAKE_DATASET_ID_PATTERN,
  LAKE_ROUTE_SOURCES,
  UNROLL_PIPELINE_ID,
  buildLakeDatasetBody,
  buildLakeRoute,
  buildUnrollPipelineBody,
  classifyUnrollPipeline,
  datasetPresence,
  findPipeline,
  isLakeRouteSource,
  lakeOutputFor,
  pipelineCommitMarker,
  subsetDifferences,
} from "./index";

type Schema = { properties?: Record<string, Schema>; required?: string[]; enum?: string[] };
const spec: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../../../assets/cribl-openapi.json", import.meta.url)), "utf8"));
const schemas = (spec as { components: { schemas: Record<string, Schema> } }).components.schemas;

describe("the fixed ids", () => {
  it("scopes exactly the two sources the operator decided", () => {
    expect(Object.keys(LAKE_ROUTE_SOURCES).sort()).toEqual(["activityLog", "defenderExport"]);
    expect(isLakeRouteSource("defenderExport")).toBe(true);
    expect(isLakeRouteSource("activityLog")).toBe(true);
    for (const other of ["entraId", "diagnosticSettingsInitiative", "vnetFlowLogs", "xdrStreaming"]) {
      expect(isLakeRouteSource(other)).toBe(false);
    }
  });

  it("gives each source its own dataset, in the narrowest id form", () => {
    expect(LAKE_ROUTE_SOURCES.defenderExport.datasetId).toBe("azure_defender_alerts");
    expect(LAKE_ROUTE_SOURCES.activityLog.datasetId).toBe("azure_activity_log");
    for (const s of Object.values(LAKE_ROUTE_SOURCES)) expect(s.datasetId).toMatch(LAKE_DATASET_ID_PATTERN);
    expect(LAKE_DATASET_ID_PATTERN.test("Azure-Logs")).toBe(false);
  });

  it("says, for each, that Sentinel gets it through Microsoft's native connector", () => {
    expect(LAKE_ROUTE_SOURCES.defenderExport.nativeConnectorCopy).toContain("Defender for Cloud data connector");
    expect(LAKE_ROUTE_SOURCES.activityLog.nativeConnectorCopy).toContain("Azure Activity data connector");
    expect(LAKE_ROUTE_SOURCES.activityLog.nativeConnectorCopy).toContain("free");
    for (const s of Object.values(LAKE_ROUTE_SOURCES)) {
      expect(s.nativeConnectorCopy).toContain("Cribl Lake");
      expect(s.nativeConnectorCopy).not.toMatch(/_CL\b/);
    }
  });
});

describe("buildUnrollPipelineBody - from the bundled spec", () => {
  const body = buildUnrollPipelineBody();

  it("is a Pipeline: the required keys, and only conf keys the schema allows", () => {
    const pipeline = schemas["Pipeline"]!;
    for (const k of pipeline.required ?? []) expect(body).toHaveProperty(k);
    const confProps = Object.keys(pipeline.properties!["conf"]!.properties!);
    for (const k of Object.keys(body.conf)) expect(confProps).toContain(k);
  });

  it("holds ONE JsonUnroll function on `records`, every key one the schema names", () => {
    const fn = schemas["PipelineFunctionJsonUnroll"]!;
    expect(body.conf.functions).toHaveLength(1);
    const f = body.conf.functions[0]!;
    expect(fn.properties!["id"]!.enum).toContain(f["id"]);
    for (const k of Object.keys(f)) expect(Object.keys(fn.properties!)).toContain(k);
    expect(f["conf"]).toEqual({ path: "records" });
    const confSchema = schemas["FunctionConfSchemaJsonUnroll"]!;
    for (const k of Object.keys(f["conf"] as object)) expect(Object.keys(confSchema.properties!)).toContain(k);
  });

  it("carries the ownership stamp in conf.description", () => {
    expect(body.id).toBe(UNROLL_PIPELINE_ID);
    expect(body.conf.description).toContain(stampFor(APP_ID));
  });
});

describe("buildLakeDatasetBody", () => {
  it("names the source's dataset with a stamped description; only keys the spec's CriblLakeDataset has", () => {
    const body = buildLakeDatasetBody("activityLog");
    expect(body.id).toBe("azure_activity_log");
    expect(body.description).toContain(stampFor(APP_ID));
    const props = Object.keys(schemas["CriblLakeDataset"]!.properties!);
    for (const k of Object.keys(body)) expect(props).toContain(k);
  });
});

describe("buildLakeRoute", () => {
  it("filters exactly the created eventhub input, through the unroll pipeline, final, to the source's dataset", () => {
    const r = buildLakeRoute("defenderExport", "in_azure_defender_t1");
    expect(r).toMatchObject({
      id: "azure_onb_defender_alerts_lake",
      filter: "__inputId=='eventhub:in_azure_defender_t1'",
      pipeline: "azure_onb_unroll_records",
      output: "cribl_lake:azure_defender_alerts",
      final: true,
    });
    expect(r.name).toContain("Defender for Cloud alerts");
    expect(r.description).toContain(stampFor(APP_ID));
    // The filter is one the onboarding Cribl-side read recognises as THIS input.
    const parsed = parseRouteFilterInputs(r.filter);
    if (parsed.kind === "unparsed") throw new Error("the route filter must be readable");
    expect(matchInputIdFilter(parsed, { type: "eventhub", id: "in_azure_defender_t1" })).toBe("match");
  });

  it("gives the Activity Log its own route and dataset", () => {
    const r = buildLakeRoute("activityLog", "in_act");
    expect(r.id).toBe("azure_onb_activity_log_lake");
    expect(r.output).toBe(lakeOutputFor("azure_activity_log"));
  });

  it("names the pipeline's commit marker in the kit's directory form", () => {
    expect(pipelineCommitMarker(UNROLL_PIPELINE_ID)).toBe("local/cribl/pipelines/azure_onb_unroll_records/");
  });
});

describe("datasetPresence - inventory honesty", () => {
  it("present, absent, and unknown for a body that is not a listing", () => {
    expect(datasetPresence({ items: [{ id: "azure_activity_log" }], count: 1 }, "azure_activity_log")).toEqual({ kind: "present" });
    expect(datasetPresence({ items: [{ id: "other" }], count: 1 }, "azure_activity_log")).toEqual({ kind: "absent" });
    expect(datasetPresence({ count: 0 }, "azure_activity_log").kind).toBe("unknown");
    expect(datasetPresence(null, "azure_activity_log").kind).toBe("unknown");
  });
});

describe("subsetDifferences", () => {
  it("ignores keys the server adds and names each differing path", () => {
    expect(subsetDifferences({ a: 1, b: { c: "x" } }, { a: 1, b: { c: "x", d: 2 }, e: 3 })).toEqual([]);
    expect(subsetDifferences({ a: 1, b: { c: "x" } }, { a: 2, b: { c: "y" } }).map((d) => d.path)).toEqual(["a", "b.c"]);
    expect(subsetDifferences({ f: [1, 2] }, { f: [1] }).map((d) => d.path)).toEqual(["f"]);
    expect(subsetDifferences({ f: [{ p: "r" }] }, { f: [{ p: "s" }] }).map((d) => d.path)).toEqual(["f[0].p"]);
  });
});

describe("classifyUnrollPipeline - create-only, never rewrite, never take over", () => {
  const ours = () => structuredClone(buildUnrollPipelineBody()) as unknown as Record<string, unknown>;
  const listing = (...items: unknown[]) => ({ items, count: items.length });

  it("absent -> create", () => {
    expect(classifyUnrollPipeline(findPipeline(listing({ id: "main" }), UNROLL_PIPELINE_ID), false)).toEqual({ kind: "create" });
  });

  it("an unreadable listing is unknown, never absent", () => {
    expect(classifyUnrollPipeline(findPipeline({ nope: 1 }, UNROLL_PIPELINE_ID), true).kind).toBe("unknown");
  });

  it("ours (id, stamp, KV record) and unchanged -> reuse, even with server-added defaults", () => {
    const p = ours();
    (p["conf"] as Record<string, unknown>)["asyncFuncTimeout"] = 1000;
    ((p["conf"] as { functions: Record<string, unknown>[] }).functions[0]!)["disabled"] = false;
    expect(classifyUnrollPipeline(findPipeline(listing(p), UNROLL_PIPELINE_ID), true)).toEqual({ kind: "reuse" });
  });

  it("no KV record of the write -> foreign, naming the missing signal", () => {
    const v = classifyUnrollPipeline(findPipeline(listing(ours()), UNROLL_PIPELINE_ID), false);
    expect(v.kind).toBe("foreign");
    if (v.kind === "foreign") expect(v.missing).toEqual(["this app has no record of writing it"]);
  });

  it("no stamp (someone else's pipeline with the same id) -> foreign even with a KV record", () => {
    const p = ours();
    (p["conf"] as Record<string, unknown>)["description"] = "hand made";
    const v = classifyUnrollPipeline(findPipeline(listing(p), UNROLL_PIPELINE_ID), true);
    expect(v.kind).toBe("foreign");
    if (v.kind === "foreign") expect(v.missing).toEqual(["description carries no stamp from this app"]);
  });

  it("ours but edited -> differs, with the differing fields", () => {
    const p = ours();
    ((p["conf"] as { functions: { conf: Record<string, unknown> }[] }).functions[0]!).conf["path"] = "data";
    const v = classifyUnrollPipeline(findPipeline(listing(p), UNROLL_PIPELINE_ID), true);
    expect(v.kind).toBe("differs");
    if (v.kind === "differs") {
      expect(v.differences.map((d) => d.path)).toEqual(["conf.functions[0].conf.path"]);
      expect(v.differences[0]).toMatchObject({ expected: "records", actual: "data" });
    }
  });

  it("ours with a function added -> differs on the functions array", () => {
    const p = ours();
    (p["conf"] as { functions: unknown[] }).functions.push({ id: "eval", conf: {} });
    const v = classifyUnrollPipeline(findPipeline(listing(p), UNROLL_PIPELINE_ID), true);
    expect(v).toMatchObject({ kind: "differs", differences: [{ path: "conf.functions" }] });
  });
});
