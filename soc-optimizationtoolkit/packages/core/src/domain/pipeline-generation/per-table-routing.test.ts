/**
 * Per-log-type destinations (user requirement, 2026-08-18).
 *
 * "Each unique DCR/Table also gets its own Sentinel Destination in the Cribl
 * Pack, so the route needs to send the log for that table to its specific
 * pipeline and destination."
 *
 * The plan model already resolves this - each TablePlan is a per-logType entry
 * carrying its own pipeline, and its destination is derived from its TABLE - so
 * these pins exist to keep it that way. The failure they guard is a regression
 * toward one destination per pack, or per log type: the first silently merges
 * feeds that belong in different tables, the second creates duplicate outputs
 * for one table and splits its ingestion.
 *
 * CrowdStrike is the worked example because it is the shape that motivates it:
 * one solution whose log types land in more than one table.
 */

import { describe, expect, it } from "vitest";
import { buildPipelinePlan } from "./plan";
import { generateRouteYml } from "./route-yml";

/** Three log types, two tables - the CrowdStrike shape. */
function crowdstrikePlan() {
  const table = (logType: string, sentinelTable: string) => ({
    sentinelTable,
    logType,
    presetFields: [],
    sourceFormat: "json" as const,
    sampleFieldValues: {
      logType,
      eventCount: 4,
      values: { event_simpleName: Array.from({ length: 4 }, () => logType) },
    },
  });
  return buildPipelinePlan({
    solutionName: "CrowdStrike Falcon Endpoint Protection",
    packName: "ms-sentinel-crowdstrike",
    tables: [
      table("DetectionSummaryEvent", "CrowdStrikeAlerts_CL"),
      table("ProcessRollup2", "CrowdStrikeFalconEventStream_CL"),
      table("NetworkConnectIP4", "CrowdStrikeFalconEventStream_CL"),
    ],
  });
}

describe("per-table destinations, per-log-type pipelines", () => {
  it("gives each TABLE its own destination", () => {
    const plan = crowdstrikePlan();
    const byTable = new Map(plan.tables.map((t) => [t.sentinelTable, t.destinationId]));
    expect(byTable.size).toBe(2);
    expect(new Set(byTable.values()).size).toBe(2);
  });

  it("gives log types sharing a table the SAME destination", () => {
    // Two feeds into one table must not create two outputs for it - that
    // would split one table's ingestion across duplicate destinations.
    const plan = crowdstrikePlan();
    const sharing = plan.tables.filter(
      (t) => t.sentinelTable === "CrowdStrikeFalconEventStream_CL",
    );
    expect(sharing).toHaveLength(2);
    expect(sharing[0]!.destinationId).toBe(sharing[1]!.destinationId);
  });

  it("still gives each log type its OWN pipeline", () => {
    // Sharing a destination must NOT mean sharing a pipeline: the renames,
    // reduction rules and overflow config are per log type.
    const plan = crowdstrikePlan();
    const pipelines = plan.tables.map((t) => t.pipelineName);
    expect(new Set(pipelines).size).toBe(3);
  });

  it("routes each log type to the destination for ITS table", () => {
    // The end-to-end claim, read off the emitted route.yml rather than the
    // plan: a route pair per log type, each naming its table's output.
    const yml = generateRouteYml(crowdstrikePlan());
    const outputs = [...yml.matchAll(/output: (\S+)/g)].map((m) => m[1]);
    expect(new Set(outputs).size).toBe(2);
    // 3 log types x (reduction + passthrough)
    expect(outputs).toHaveLength(6);
    expect(outputs.filter((o) => o === "MS-Sentinel-CrowdStrikeAlerts-dest")).toHaveLength(2);
    expect(
      outputs.filter((o) => o === "MS-Sentinel-CrowdStrikeFalconEventStream-dest"),
    ).toHaveLength(4);
  });
});
