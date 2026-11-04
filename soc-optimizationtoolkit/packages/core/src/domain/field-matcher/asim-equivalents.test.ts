/**
 * Pins for DBT-252: a log type re-pointed at an ASim table is re-matched
 * against ASim columns, not left in the CEF catch-all.
 *
 * Reported live 2026-11-04: the PaloAlto TRAFFIC sample moved from
 * CommonSecurityLog to ASimNetworkSessionLogs kept src/dst/ports/bytes in
 * AdditionalExtensions - a column the ASim table does not have - and matched
 * srcuser to DstUserId. Three defects: the CEF catch-all fallback, a CEF-only
 * alias vocabulary, and a fuzzy tier blind to source/destination polarity.
 *
 * Every pin runs against the BUNDLED ASimNetworkSessionLogs and
 * CommonSecurityLog schemas, so a column name that drifts out of the real
 * tables fails here rather than silently never matching.
 */

import { describe, expect, it } from "vitest";
import { FakeSentinelContent } from "../../testing/fake-sentinel-content";
import { collectGapReports } from "../../usecases/analyze-samples/analyze-samples";
import { createBundledSchemaCatalog, resolveSchemaFromCatalog } from "./bundled-schema-catalog";
import {
  ASIM_COLUMN_EQUIVALENTS,
  asimEquivalentOf,
  cefEquivalentOf,
} from "./knowledge-bases";
import { matchSampleToSchema } from "./match-fields";
import { getOverflowConfig } from "./overflow";
import { oppositeDirections } from "./scoring";

const ASIM = "ASimNetworkSessionLogs";
const CSL = "CommonSecurityLog";

const PAN_TRAFFIC_FIELDS = [
  "src",
  "dst",
  "sport",
  "dport",
  "proto",
  "action",
  "srcuser",
  "dstuser",
  "natsrc",
  "natsport",
  "bytes_sent",
  "bytes_received",
];

function match(table: string, names: readonly string[]) {
  const columns = resolveSchemaFromCatalog(table);
  if (columns === null) throw new Error(`${table} is not in the bundled catalog`);
  const result = matchSampleToSchema(
    names.map((name) => ({ name, type: "string", sampleValues: ["x"] })),
    columns,
    undefined,
    table,
  );
  const dest = new Map(result.matched.map((m) => [m.sourceName, m.destName]));
  return { result, dest };
}

describe("getOverflowConfig - ASim tables (DBT-252)", () => {
  it("uses the dynamic AdditionalFields column for every ASim table", () => {
    for (const table of [
      "ASimNetworkSessionLogs",
      "ASimDnsActivityLogs",
      "ASimWebSessionLogs",
      "ASimAuthenticationEventLogs",
    ]) {
      expect(getOverflowConfig(table)).toEqual({
        fieldName: "AdditionalFields",
        fieldType: "dynamic",
      });
      // ...and that column really exists, as dynamic, in the bundled schema.
      const column = resolveSchemaFromCatalog(table)?.find(
        (c) => c.name === "AdditionalFields",
      );
      expect(column?.type).toBe("dynamic");
    }
  });

  it("leaves CommonSecurityLog and custom tables as they were", () => {
    expect(getOverflowConfig(CSL).fieldName).toBe("AdditionalExtensions");
    expect(getOverflowConfig("Contoso_CL").fieldName).toBe("AdditionalData_d");
  });
});

describe("ASim column equivalents (DBT-252)", () => {
  it("names only columns some bundled ASim table really has", () => {
    const asimColumns = new Set<string>();
    for (const table of [
      "ASimNetworkSessionLogs",
      "ASimDnsActivityLogs",
      "ASimWebSessionLogs",
      "ASimFileEventLogs",
    ]) {
      for (const c of resolveSchemaFromCatalog(table) ?? []) asimColumns.add(c.name);
    }
    const missing = Object.values(ASIM_COLUMN_EQUIVALENTS).filter(
      (c) => !asimColumns.has(c),
    );
    expect(missing).toEqual([]);
  });

  it("round-trips case-insensitively", () => {
    expect(asimEquivalentOf("destinationip")).toBe("DstIpAddr");
    expect(cefEquivalentOf("DSTIPADDR")).toBe("DestinationIP");
    expect(asimEquivalentOf("NotAColumn")).toBeUndefined();
  });
});

describe("matching a PAN-OS TRAFFIC sample against ASimNetworkSessionLogs (DBT-252)", () => {
  it("maps addresses, ports, NAT, users and bytes to their ASim columns", () => {
    const { dest } = match(ASIM, PAN_TRAFFIC_FIELDS);
    expect(Object.fromEntries(dest)).toMatchObject({
      src: "SrcIpAddr",
      dst: "DstIpAddr",
      sport: "SrcPortNumber",
      dport: "DstPortNumber",
      proto: "NetworkProtocol",
      action: "DvcAction",
      srcuser: "SrcUsername",
      dstuser: "DstUsername",
      natsrc: "SrcNatIpAddr",
      natsport: "SrcNatPortNumber",
      bytes_sent: "SrcBytes",
      bytes_received: "DstBytes",
    });
  });

  it("overflows the rest into AdditionalFields, never AdditionalExtensions", () => {
    const { result } = match(ASIM, [...PAN_TRAFFIC_FIELDS, "qqvendoronly"]);
    expect(result.overflow.map((o) => o.sourceName)).toEqual(["qqvendoronly"]);
    expect(result.overflow.every((o) => o.destName === "AdditionalFields")).toBe(true);
  });

  it("does not change what CommonSecurityLog matches", () => {
    const { dest } = match(CSL, PAN_TRAFFIC_FIELDS);
    expect(Object.fromEntries(dest)).toMatchObject({
      src: "SourceIP",
      dst: "DestinationIP",
      sport: "SourcePort",
      dport: "DestinationPort",
      srcuser: "SourceUserName",
      bytes_sent: "SentBytes",
      bytes_received: "ReceivedBytes",
    });
  });
});

describe("polarity guard (DBT-252)", () => {
  it("never fuzzy-matches a source-side name to a destination-side column", () => {
    // srcuser reduced to "user" like DstUserId and matched it before the guard.
    // Offered ONLY the wrong-direction column, it must stay unmatched.
    const result = matchSampleToSchema(
      [{ name: "srcuser", type: "string", sampleValues: ["abby"] }],
      [{ name: "DstUserId", type: "string" }],
      undefined,
      "Contoso_CL",
    );
    expect(result.matched).toHaveLength(0);
  });

  it("recognises the direction prefixes both ways and ignores neutral names", () => {
    expect(oppositeDirections("srcuser", "DstUserId")).toBe(true);
    expect(oppositeDirections("destination_host", "SourceHostName")).toBe(true);
    expect(oppositeDirections("srcuser", "SrcUsername")).toBe(false);
    expect(oppositeDirections("user", "DstUserId")).toBe(false);
  });
});

describe("vendor/learned mappings follow a log type onto an ASim table (DBT-252)", () => {
  it("re-aims a CEF-column mapping at the ASim equivalent instead of dropping it", async () => {
    const content = JSON.stringify({ qqpanaddr: "10.1.2.3", qqother: "x" });
    const [report] = await collectGapReports(
      {
        content: new FakeSentinelContent({ files: {} }),
        catalog: createBundledSchemaCatalog(),
      },
      {
        solutionName: "",
        samples: [{ logType: "TRAFFIC", tableName: ASIM, content }],
        // A field no alias knows, mapped by a pack to the CEF column.
        vendorMappings: [
          {
            sourceName: "qqpanaddr",
            sourceType: "string",
            destName: "DestinationIP",
            destType: "string",
          },
        ],
      },
    );
    expect(report).toBeDefined();
    const row = report!.fieldMappings.find((m) => m.source === "qqpanaddr");
    expect(row?.dest).toBe("DstIpAddr");
  });
});
