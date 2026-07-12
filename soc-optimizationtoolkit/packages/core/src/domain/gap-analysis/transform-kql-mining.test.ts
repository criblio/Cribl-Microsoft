/**
 * Pins for THE shared transformKql miner - used by the Sentinel-DCR pack
 * generator (via native TS import) AND the runtime kql-parser, so these pins
 * hold both sides of the former duplication in lockstep.
 */

import { describe, expect, it } from "vitest";
import { parseTransformKql } from "./kql-parser";
import { mineTransformFieldPairs } from "./transform-kql-mining";

describe("mineTransformFieldPairs", () => {
  it("accepts the four documented RHS shapes", () => {
    const kql =
      "source | project TimeGenerated, DeviceAction=tostring(act), " +
      "IncidentId=incident_id, Reason=column_ifexists('why', ''), " +
      "CreationTime=datetime(1970-01-01) + (creation_time * 1ms)";
    expect(mineTransformFieldPairs(kql)).toEqual([
      { sourceName: "act", destName: "DeviceAction" },
      { sourceName: "incident_id", destName: "IncidentId" },
      { sourceName: "why", destName: "Reason" },
      { sourceName: "creation_time", destName: "CreationTime" },
    ]);
  });

  it("skips constants, now(), lookup dicts, and case-only renames", () => {
    const kql =
      "source | where event_simpleName in ('A','B') " +
      "| project TimeGenerated = now(), Vendor='Zscaler', " +
      "Severity=parse_json('{\"DEBUG\":\"Informational\"}')[level], " +
      "Status=status, act=act";
    expect(mineTransformFieldPairs(kql)).toEqual([]);
  });

  it("reads project-rename and extend stages by default", () => {
    const kql = "source | extend Dest=todynamic(src) | project-rename B = a";
    expect(mineTransformFieldPairs(kql)).toEqual([
      { sourceName: "src", destName: "Dest" },
      { sourceName: "a", destName: "B" },
    ]);
  });

  it("honors the stage filter (the runtime parser reads project only)", () => {
    const kql =
      "source | extend Dest=todynamic(src) | project A=b | project-rename C = d";
    expect(mineTransformFieldPairs(kql, ["project"])).toEqual([
      { sourceName: "b", destName: "A" },
    ]);
  });
});

describe("runtime lockstep: parseTransformKql sees project-map renames", () => {
  it("counts a CCP projection map as DCR-side renames", () => {
    // The audit's exact drift case: a DCR that projects Dest = tostring(src)
    // previously yielded ZERO renames at runtime while the generator mined it.
    const flow = parseTransformKql(
      "source | project TimeGenerated, DeviceAction=tostring(act), IncidentId=incident_id",
    );
    expect(flow.renames).toEqual([
      { dest: "DeviceAction", source: "act" },
      { dest: "IncidentId", source: "incident_id" },
    ]);
    // The derived column set includes the projected destinations.
    expect(flow.columns.map((c) => c.name)).toContain("DeviceAction");
  });

  it("keeps project-rename extraction authoritative (no duplicates)", () => {
    const flow = parseTransformKql(
      "source | project-rename DeviceAction = act | project DeviceAction=tostring(act)",
    );
    expect(flow.renames).toEqual([{ dest: "DeviceAction", source: "act" }]);
  });
});
