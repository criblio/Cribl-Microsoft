// Pins for the Sentinel-DCR pack generator's transformKql miner (audit
// finding: the generator and the runtime kql-parser both read DCR
// transformKql and MUST stay in lockstep; this pin covers the generator's
// accepted RHS shapes so a drift is caught at test time).
import { describe, expect, it } from "vitest";
import { minePairsFromTransform } from "../../../scripts/generate-sentinel-dcr-packs.mjs";

describe("minePairsFromTransform", () => {
  it("accepts the four documented RHS shapes", () => {
    const kql =
      "source | project TimeGenerated, DeviceAction=tostring(act), " +
      "IncidentId=incident_id, Reason=column_ifexists('why', ''), " +
      "CreationTime=datetime(1970-01-01) + (creation_time * 1ms)";
    expect(minePairsFromTransform(kql)).toEqual([
      { sourceName: "act", destName: "DeviceAction" },
      { sourceName: "incident_id", destName: "IncidentId" },
      { sourceName: "why", destName: "Reason" },
      { sourceName: "creation_time", destName: "CreationTime" },
    ]);
  });

  it("skips case-only renames (the matcher's case-insensitive ladder already covers them)", () => {
    expect(minePairsFromTransform("source | project Status=status")).toEqual([]);
  });

  it("skips constants, now(), lookup dicts, and same-name passthrough", () => {
    const kql =
      "source | where event_simpleName in ('A','B') " +
      "| project TimeGenerated = now(), Vendor='Zscaler', " +
      "Severity=parse_json('{\"DEBUG\":\"Informational\"}')[level], act=act";
    expect(minePairsFromTransform(kql)).toEqual([]);
  });

  it("reads project-rename and extend stages too", () => {
    const kql = "source | extend Dest=todynamic(src) | project-rename B = a";
    expect(minePairsFromTransform(kql)).toEqual([
      { sourceName: "src", destName: "Dest" },
      { sourceName: "a", destName: "B" },
    ]);
  });
});
