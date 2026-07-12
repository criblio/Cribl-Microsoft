// Ported VERBATIM from legacy IS-R/hooks/analyze-workflow.test.ts (porting-plan
// Unit 18 fixtures: "analyze-workflow.test.ts verbatim"). Only the import path
// changed (the helpers now live in the gap-analysis domain module). The
// connector-table hint helpers (2026-07-09) are a deliberate extension,
// pinned at the bottom.
import { describe, it, expect, vi } from "vitest";
import {
  hintsFromConnectorTables,
  matchSampleToTable,
  normalizeConnectorTableName,
  resolveDestinationTables,
  matchLogTypeToDcrFlow,
} from "./analyze-workflow";

describe("resolveDestinationTables", () => {
  it("uses vendor-research dest tables (stripping Microsoft-) and never loads connectors", async () => {
    const loadConnectors = vi.fn(async () => []);
    const r = await resolveDestinationTables(
      [
        { destTable: "Microsoft-CommonSecurityLog" },
        { destTable: "SecurityEvent" },
        { destTable: "Microsoft-CommonSecurityLog" }, // duplicate collapses
      ],
      loadConnectors,
    );
    expect(r).toEqual({
      tables: ["CommonSecurityLog", "SecurityEvent"],
      source: "Vendor research (Sentinel Content Hub)",
    });
    expect(loadConnectors).not.toHaveBeenCalled();
  });

  it("falls back to _CL custom-table connectors when research has none", async () => {
    const r = await resolveDestinationTables([], async () => [
      { name: "MyApp_CL.json", path: "Solutions/X/CustomTables/MyApp_CL.json" },
      { name: "readme.json", path: "Solutions/X/readme.json" },
    ]);
    expect(r.tables).toEqual(["MyApp_CL"]);
    expect(r.source).toBe("Sentinel repo (CustomTables definition)");
  });

  it("defaults to CommonSecurityLog when nothing resolves", async () => {
    const r = await resolveDestinationTables([], async () => []);
    expect(r).toEqual({
      tables: ["CommonSecurityLog"],
      source: "Default (no DCR definition found in Sentinel solution)",
    });
  });
});

describe("matchSampleToTable", () => {
  it("returns the default table when there are 0 or 1 destination tables", () => {
    expect(matchSampleToTable("anything", [], 1, "CommonSecurityLog")).toBe(
      "CommonSecurityLog",
    );
    expect(
      matchSampleToTable("anything", [{ id: "x", destTable: "T" }], 0, "Def"),
    ).toBe("Def");
  });

  it("matches a sample log type to a vendor log type via normalized id/name", () => {
    const lts = [
      { id: "fdr-events", name: "FDR Events", destTable: "ASimNetworkSessionLogs" },
      { id: "audit", name: "Audit", destTable: "AuditLogs" },
    ];
    expect(matchSampleToTable("FDR_Events", lts, 2, "Def")).toBe(
      "ASimNetworkSessionLogs",
    );
  });

  it("falls back to the default when no vendor log type matches", () => {
    const lts = [{ id: "audit", name: "Audit", destTable: "AuditLogs" }];
    expect(matchSampleToTable("totally-different", lts, 2, "Def")).toBe("Def");
  });
});

describe("connector-table hints (2026-07-09 extension)", () => {
  it("normalizes dataTypes display labels to bare table names", () => {
    expect(normalizeConnectorTableName("CommonSecurityLog (Zscaler)")).toBe(
      "CommonSecurityLog",
    );
    expect(normalizeConnectorTableName("Syslog (PaloAlto)")).toBe("Syslog");
    expect(normalizeConnectorTableName("MyApp_CL")).toBe("MyApp_CL");
    expect(normalizeConnectorTableName("not a table name!")).toBeNull();
    expect(normalizeConnectorTableName("")).toBeNull();
  });

  it("builds deduplicated hints from decoded connector table names", () => {
    expect(
      hintsFromConnectorTables([
        "CommonSecurityLog (Zscaler)",
        "CommonSecurityLog (Zscaler Private Access)",
        "garbage!!",
      ]),
    ).toEqual([
      {
        id: "CommonSecurityLog",
        name: "CommonSecurityLog (Zscaler)",
        destTable: "CommonSecurityLog",
      },
    ]);
  });

  it("resolves the Zscaler-shaped solution FROM its connectors, not the default", async () => {
    // Live report 2026-07-09: Zscaler Internet Access showed "Default (no
    // DCR definition found in Sentinel solution)" - its connector declares
    // the table only via a dataTypes label, which the hints tier now reads.
    const loadConnectors = vi.fn(async () => []);
    const r = await resolveDestinationTables(
      hintsFromConnectorTables(["CommonSecurityLog (Zscaler)"]),
      loadConnectors,
      "Sentinel solution connectors",
    );
    expect(r).toEqual({
      tables: ["CommonSecurityLog"],
      source: "Sentinel solution connectors",
    });
    expect(loadConnectors).not.toHaveBeenCalled();
  });

  it("keeps the verbatim legacy hint-source wording by default", async () => {
    const r = await resolveDestinationTables(
      [{ destTable: "SecurityEvent" }],
      async () => [],
    );
    expect(r.source).toBe("Vendor research (Sentinel Content Hub)");
  });
});

describe("matchLogTypeToDcrFlow (DCR-declared table routing, 2026-07-12)", () => {
  const FLOWS = [
    {
      tableName: "CrowdStrike_Process_Events_CL",
      eventSimpleNames: ["ProcessRollup2", "SyntheticProcessRollup2"],
    },
    {
      tableName: "CrowdStrike_Network_Events_CL",
      eventSimpleNames: ["NetworkConnectIP4", "NetworkConnectIP6"],
    },
    { tableName: "CommonSecurityLog", eventSimpleNames: [] },
  ];

  it("routes an event name to its DCR-declared table, case-insensitively", () => {
    expect(matchLogTypeToDcrFlow("PROCESSROLLUP2", FLOWS)).toBe(
      "CrowdStrike_Process_Events_CL",
    );
    expect(matchLogTypeToDcrFlow("NetworkConnectIP6", FLOWS)).toBe(
      "CrowdStrike_Network_Events_CL",
    );
  });

  it("routes stream-scoped split names by suffix", () => {
    expect(matchLogTypeToDcrFlow("fdr-PROCESSROLLUP2", FLOWS)).toBe(
      "CrowdStrike_Process_Events_CL",
    );
  });

  it("returns null when no DCR claims the log type (caller falls to name match)", () => {
    expect(matchLogTypeToDcrFlow("BLOCKED", FLOWS)).toBeNull();
    expect(matchLogTypeToDcrFlow("", FLOWS)).toBeNull();
    expect(matchLogTypeToDcrFlow("PROCESSROLLUP2", [])).toBeNull();
  });

  it("an exact match on a later flow beats a suffix on an earlier one", () => {
    // SYNTHETICPROCESSROLLUP2 ends with the PROCESSROLLUP2 event name too -
    // the exact event name must win regardless of declaration order.
    expect(matchLogTypeToDcrFlow("SYNTHETICPROCESSROLLUP2", FLOWS)).toBe(
      "CrowdStrike_Process_Events_CL",
    );
    const SPLIT = [
      { tableName: "T_Suffix_CL", eventSimpleNames: ["Rollup2"] },
      { tableName: "T_Exact_CL", eventSimpleNames: ["ProcessRollup2"] },
    ];
    expect(matchLogTypeToDcrFlow("ProcessRollup2", SPLIT)).toBe("T_Exact_CL");
  });
});
