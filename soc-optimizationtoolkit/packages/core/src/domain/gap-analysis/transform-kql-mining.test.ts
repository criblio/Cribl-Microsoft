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

describe("runtime boundary: parseTransformKql does NOT mine project maps", () => {
  it("ignores CCP projection maps (live regression 2026-07-13: they are the solution's ingest path, not our deployed DCR)", () => {
    const flow = parseTransformKql(
      "source | project TimeGenerated, DeviceAction=tostring(act), IncidentId=incident_id",
    );
    expect(flow.renames).toEqual([]);
  });

  it("keeps the legacy project-rename extraction (the deployable DCR shape)", () => {
    const flow = parseTransformKql(
      "source | project-rename DeviceAction = act | project Ignored=tostring(x)",
    );
    expect(flow.renames).toEqual([{ dest: "DeviceAction", source: "act" }]);
  });
});

describe("our OWN emitted transform (ADR 0004) reads back cleanly", () => {
  // schema-mapping became an EMITTER of transformKql when guid columns stopped
  // being dropped. Both miners in this domain therefore now parse a string we
  // wrote, and a self-referential cast is the one shape neither had seen.
  const EMITTED =
    "source | extend AwsEventId = toguid(AwsEventId), " +
    "SharedEventId = toguid(SharedEventId)";

  it("mines NO field pairs from a self-referential cast", () => {
    // Load-bearing and easy to break: `to\w+(...)` already matches toguid, so
    // the ONLY thing stopping `AwsEventId <- AwsEventId` becoming a rename is
    // the source-equals-dest guard. A cast is not a rename - the DCR consumes
    // and emits the same field - and mining one would tell the mapping review
    // the DCR already handles a rename that does not exist.
    expect(mineTransformFieldPairs(EMITTED)).toEqual([]);
  });

  it("reads the cast as a type coercion, not a phantom source field", () => {
    const flow = parseTransformKql(EMITTED);

    expect(flow.typeConversions).toEqual([
      { field: "AwsEventId", toType: "guid" },
      { field: "SharedEventId", toType: "guid" },
    ]);
    // The failure this guards: without toguid in the parser's skip list and
    // regex, this produced a rename FROM a field literally named "toguid" and
    // gap analysis reported a source field no sample could ever contain.
    expect(flow.renames).toEqual([]);
    expect(flow.columns.map((c) => c.name)).not.toContain("toguid");
  });
});
