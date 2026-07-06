/**
 * The ONE connector decoder + THREE projections - porting-plan Unit 14
 * (ENG-23 full / ENG-24 VendorLogType seam / ENG-26 fingerprint seam).
 *
 * Exercises all four connector formats over the vendored fixtures
 * (assets/sentinel-connectors) and asserts the three projections are views over
 * the SAME single decode.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalFieldString,
  decodeConnector,
  sanitizeLogTypeId,
  toFingerprints,
  toFullSchemas,
  toVendorLogTypes,
} from "./connector-decoder";
import {
  AISHIELD_CONNECTOR,
  CONNECTOR_FORMAT1_TABLES,
  CROWDSTRIKE_CUSTOM_DCR,
  ONEPASSWORD_CONNECTOR_DEFINITION,
} from "../../assets/sentinel-connectors";

describe("decodeConnector - Format 1: tables[] with columns (SYNTHESIZED)", () => {
  const decoded = decodeConnector(CONNECTOR_FORMAT1_TABLES, "connector-format1-tables.json");

  it("uses title as connectorName and decodes both tables", () => {
    expect(decoded.connectorName).toBe("Example Vendor Connector");
    expect(decoded.tables.map((t) => t.tableName)).toEqual([
      "ExampleVendor_Auth_CL",
      "ExampleVendor_Network_CL",
    ]);
  });

  it("accepts the name/type column variant and normalizes types at decode time", () => {
    const auth = decoded.tables[0];
    expect(auth.columns).toEqual([
      { name: "TimeGenerated", type: "datetime", description: "" },
      { name: "UserName", type: "string", description: "" },
      { name: "SessionId", type: "string", description: "" }, // guid -> string
      { name: "AttemptCount", type: "int", description: "" }, // Integer -> int
      { name: "Payload", type: "dynamic", description: "" }, // array -> dynamic
    ]);
  });

  it("accepts the columnName/columnType variant (same output shape)", () => {
    const net = decoded.tables[1];
    expect(net.columns).toEqual([
      { name: "SrcIp", type: "string", description: "" }, // str -> string
      { name: "DstPort", type: "real", description: "" }, // number -> real
      { name: "BytesSent", type: "long", description: "" }, // int64 -> long
      { name: "EventTime", type: "datetime", description: "" }, // DateTime -> datetime
    ]);
  });
});

describe("decodeConnector - Format 2: streamDeclarations, Custom- streams (REAL CrowdStrike DCR)", () => {
  const decoded = decodeConnector(CROWDSTRIKE_CUSTOM_DCR, "CrowdStrikeCustomDCR.json");

  it("has no top-level title/name, so connectorName is 'Unknown'", () => {
    expect(decoded.connectorName).toBe("Unknown");
  });

  it("strips the Custom- prefix from every stream name", () => {
    const names = decoded.tables.map((t) => t.tableName);
    expect(names).toContain("CrowdstrikeProcess");
    expect(names).toContain("CrowdstrikeDns");
    expect(names.every((n) => !n.startsWith("Custom-"))).toBe(true);
    expect(decoded.tables).toHaveLength(8);
  });

  it("extracts the Process stream's 144 columns", () => {
    const proc = decoded.tables.find((t) => t.tableName === "CrowdstrikeProcess");
    expect(proc?.columns).toHaveLength(144);
    expect(proc?.columns[0]).toEqual({
      name: "event_simpleName",
      type: "string",
      description: "",
    });
  });
});

describe("decodeConnector - Format 3: top-level dataTypes[] (REAL AIShield)", () => {
  const decoded = decodeConnector(AISHIELD_CONNECTOR, "AIShieldConnector.json");

  it("uses title as connectorName and emits a name-only, columnless table", () => {
    expect(decoded.connectorName).toBe("AIShield");
    expect(decoded.tables).toEqual([{ tableName: "AIShield_CL", columns: [] }]);
  });
});

describe("decodeConnector - Format 4: connectorUiConfig.dataTypes[] (REAL 1Password)", () => {
  const decoded = decodeConnector(
    ONEPASSWORD_CONNECTOR_DEFINITION,
    "OnePassword_DataConnectorDefinition.json",
  );

  it("falls back to name as connectorName and emits the ui-config dataType", () => {
    expect(decoded.connectorName).toBe("1PasswordCCPDefinition");
    expect(decoded.tables).toEqual([
      { tableName: "OnePasswordEventLogs_CL", columns: [] },
    ]);
  });
});

describe("decodeConnector - cascade + robustness", () => {
  it("Formats 3/4 fire ONLY when 1+2 produced nothing", () => {
    // A connector that has BOTH tables[] (Format 1) and dataTypes[] (Format 3):
    // Format 1 wins and Format 3 is suppressed.
    const both = {
      title: "Both",
      tables: [{ name: "T_CL", columns: [{ name: "a", type: "string" }] }],
      dataTypes: [{ name: "ShouldBeIgnored_CL" }],
    };
    const decoded = decodeConnector(both, "both.json");
    expect(decoded.tables.map((t) => t.tableName)).toEqual(["T_CL"]);
  });

  it("returns an empty table list for unrecognized / junk input without throwing", () => {
    expect(decodeConnector({}, "empty.json").tables).toEqual([]);
    expect(decodeConnector(null, "null.json").tables).toEqual([]);
    expect(decodeConnector("not an object", "str.json").tables).toEqual([]);
    expect(decodeConnector(42, "num.json").tables).toEqual([]);
  });

  it("drops nameless columns", () => {
    const c = {
      name: "C",
      tables: [{ name: "T", columns: [{ name: "", type: "string" }, { type: "int" }, { name: "keep", type: "int" }] }],
    };
    const decoded = decodeConnector(c, "c.json");
    expect(decoded.tables[0].columns).toEqual([{ name: "keep", type: "int", description: "" }]);
  });
});

describe("three projections over the SAME decode", () => {
  const decoded = decodeConnector(CONNECTOR_FORMAT1_TABLES, "connector-format1-tables.json");

  it("full projection (ENG-23): one DataConnectorSchema per table", () => {
    const full = toFullSchemas(decoded);
    expect(full).toHaveLength(2);
    expect(full[0]).toMatchObject({
      connectorName: "Example Vendor Connector",
      tableName: "ExampleVendor_Auth_CL",
      sourceFile: "connector-format1-tables.json",
    });
    expect(full[0].columns[2]).toEqual({
      name: "SessionId",
      type: "string",
      description: "",
    });
  });

  it("VendorLogType projection (ENG-24 seam): id sanitized, required:false", () => {
    const vlts = toVendorLogTypes(decoded);
    expect(vlts).toHaveLength(2);
    expect(vlts[0].id).toBe("ExampleVendor_Auth_CL");
    expect(vlts[0].name).toBe("ExampleVendor_Auth_CL");
    expect(vlts[0].fields.every((f) => f.required === false)).toBe(true);
    expect(vlts[0].fields[0]).toEqual({
      name: "TimeGenerated",
      type: "datetime",
      description: "",
      required: false,
    });
  });

  it("fingerprint projection (ENG-26 seam): fieldCount + sorted canonical string", () => {
    const fps = toFingerprints(decoded);
    expect(fps[0].logTypeName).toBe("ExampleVendor_Auth_CL");
    expect(fps[0].fieldCount).toBe(5);
    // sorted by name (localeCompare), name:type joined by "|"
    expect(fps[0].canonical).toBe(
      "AttemptCount:int|Payload:dynamic|SessionId:string|TimeGenerated:datetime|UserName:string",
    );
  });

  it("all three projections have the SAME per-table counts and names", () => {
    const full = toFullSchemas(decoded);
    const vlts = toVendorLogTypes(decoded);
    const fps = toFingerprints(decoded);
    expect(full.map((f) => f.tableName)).toEqual(decoded.tables.map((t) => t.tableName));
    expect(vlts.map((v) => v.name)).toEqual(decoded.tables.map((t) => t.tableName));
    expect(fps.map((f) => f.logTypeName)).toEqual(decoded.tables.map((t) => t.tableName));
    for (let i = 0; i < decoded.tables.length; i++) {
      expect(full[i].columns.length).toBe(decoded.tables[i].columns.length);
      expect(vlts[i].fields.length).toBe(decoded.tables[i].columns.length);
      expect(fps[i].fieldCount).toBe(decoded.tables[i].columns.length);
    }
  });

  it("name-only Format 3/4 tables project to empty columns / fieldCount 0 / '' canonical", () => {
    const d3 = decodeConnector(AISHIELD_CONNECTOR, "AIShieldConnector.json");
    expect(toFullSchemas(d3)[0].columns).toEqual([]);
    expect(toVendorLogTypes(d3)[0].fields).toEqual([]);
    expect(toFingerprints(d3)[0]).toMatchObject({ fieldCount: 0, canonical: "" });
  });
});

describe("helpers", () => {
  it("sanitizeLogTypeId replaces every non [A-Za-z0-9_] run with _", () => {
    expect(sanitizeLogTypeId("CrowdStrike_Process_Events_CL")).toBe(
      "CrowdStrike_Process_Events_CL",
    );
    expect(sanitizeLogTypeId("Vendor Table-Name.CL")).toBe("Vendor_Table_Name_CL");
  });

  it("canonicalFieldString is stable regardless of input order", () => {
    const a = canonicalFieldString([{ name: "b", type: "int" }, { name: "a", type: "string" }]);
    const b = canonicalFieldString([{ name: "a", type: "string" }, { name: "b", type: "int" }]);
    expect(a).toBe("a:string|b:int");
    expect(a).toBe(b);
    expect(canonicalFieldString([])).toBe("");
  });
});
