import { describe, expect, it } from "vitest";

import {
  splitSamplesByLogType,
  splitFoundNoDiscriminator,
  hasNamedFields,
  splitSampleId,
  convertPanosSplitAtLoad,
  parseKvLine,
  SPLITTER_DISCRIMINATOR_ALIASES,
} from "./splitting";
import { DISCRIMINATOR_FIELDS } from "./discriminators";

describe("splitSamplesByLogType", () => {
  it("splits JSON events by a discriminator, uppercasing the log type", () => {
    const raw = ['{"type":"traffic","x":1}', '{"type":"threat","y":2}'];
    const splits = splitSamplesByLogType(raw, "fallback", "json");
    expect(splits.map((s) => s.logType)).toEqual(["TRAFFIC", "THREAT"]);
    expect(splits[0].rawEvents).toEqual(['{"type":"traffic","x":1}']);
  });

  it("is DETERMINISTIC - the same input yields byte-identical splits", () => {
    const raw = [
      '{"event_simpleName":"ProcessRollup2","a":1}',
      '{"event_simpleName":"DnsRequest","b":2}',
      '{"event_simpleName":"ProcessRollup2","c":3}',
    ];
    const first = splitSamplesByLogType(raw, "fallback", "ndjson");
    const second = splitSamplesByLogType(raw, "fallback", "ndjson");
    expect(first).toEqual(second);
    expect(first.map((s) => s.logType)).toEqual(["PROCESSROLLUP2", "DNSREQUEST"]);
  });

  it("falls back to PAN-OS CSV grouping by the position-3 type field", () => {
    const raw = [
      "1,2024/01/15 10:30:00,001901001,TRAFFIC,end,2561,2024/01/15 10:29:55,10.0.0.5,8.8.8.8",
      "1,2024/01/15 10:31:00,001901001,THREAT,vuln,2562,2024/01/15 10:30:55,10.0.0.6,9.9.9.9",
    ];
    const splits = splitSamplesByLogType(raw, "panos", "unknown");
    expect(splits.map((s) => s.logType).sort()).toEqual(["THREAT", "TRAFFIC"]);
  });

  it("uses the fallback log type when no discriminator qualifies", () => {
    const raw = ['{"a":1}', '{"b":2}'];
    const splits = splitSamplesByLogType(raw, "myfallback", "json");
    expect(splits).toHaveLength(1);
    expect(splits[0].logType).toBe("myfallback");
  });
});

describe("splitFoundNoDiscriminator", () => {
  it("is TRUE for the single fallback group (nothing discriminated)", () => {
    const splits = splitSamplesByLogType(['{"a":1}', '{"b":2}'], "myfallback", "json");
    expect(splitFoundNoDiscriminator(splits, "myfallback")).toBe(true);
  });

  it("is FALSE when a real discriminator produced the groups", () => {
    const splits = splitSamplesByLogType(
      ['{"type":"traffic"}', '{"type":"threat"}'],
      "myfallback",
      "json",
    );
    expect(splits).toHaveLength(2);
    expect(splitFoundNoDiscriminator(splits, "myfallback")).toBe(false);
  });

  it("is FALSE for a genuine SINGLE log type - one group, but not the fallback", () => {
    // The distinction that matters: one group is not by itself a failure. Only
    // a group still wearing the fallback name means nothing discriminated.
    const splits = splitSamplesByLogType(
      ['{"type":"traffic","a":1}', '{"type":"traffic","b":2}'],
      "myfallback",
      "json",
    );
    expect(splits).toHaveLength(1);
    expect(splits[0].logType).toBe("TRAFFIC");
    expect(splitFoundNoDiscriminator(splits, "myfallback")).toBe(false);
  });
});

describe("hasNamedFields", () => {
  it("CEF/LEEF/KV always qualify", () => {
    expect(hasNamedFields(["CEF:0|v|p|1|1|e|5|src=1"], "cef")).toBe(true);
    expect(hasNamedFields(["LEEF:1.0|v|p|1|e|src=1"], "leef")).toBe(true);
    expect(hasNamedFields(["a=1 b=2"], "kv")).toBe(true);
  });

  it("JSON with numeric keys does NOT qualify (headerless CSV parse)", () => {
    expect(hasNamedFields(['{"_0":"a","_1":"b"}'], "json")).toBe(false);
    expect(hasNamedFields(['{"src":"a","dst":"b"}'], "json")).toBe(true);
  });

  it("CSV qualifies only with an identifier header row", () => {
    expect(hasNamedFields(["src,dst,action,proto"], "csv")).toBe(true);
    // an all-numeric data row: fewer than half look like identifiers
    expect(hasNamedFields(["1.2.3.4,5.6.7.8,443,80"], "csv")).toBe(false);
  });

  it("syslog qualifies for PAN-OS CSV, embedded kv, or embedded CEF", () => {
    expect(
      hasNamedFields(
        ["1,2024/01/15 10:30:00,001901001,TRAFFIC,end,2561"],
        "syslog",
      ),
    ).toBe(true);
    expect(hasNamedFields(["<134>Jan 1 host app: raw text only"], "syslog")).toBe(
      false,
    );
  });
});

describe("PAN-OS load-time conversion", () => {
  it("converts PAN-OS syslog+CSV to named-field JSON at load, flipping format", () => {
    const line =
      "1,2024/01/15 10:30:00,001901001,TRAFFIC,end,2561,2024/01/15 10:29:55,10.0.0.5,8.8.8.8";
    const converted = convertPanosSplitAtLoad([line], "unknown");
    expect(converted.format).toBe("json");
    const obj = JSON.parse(converted.rawEvents[0]);
    expect(obj.type).toBe("TRAFFIC");
    expect(obj.src).toBe("10.0.0.5");
  });

  it("passes non-PAN-OS events through unchanged", () => {
    const converted = convertPanosSplitAtLoad(['{"a":1}'], "json");
    expect(converted).toEqual({ rawEvents: ['{"a":1}'], format: "json" });
  });
});

describe("splitSampleId + parseKvLine", () => {
  it("builds the stable `${source}:${logType}` id", () => {
    expect(splitSampleId("capture:in_syslog", "TRAFFIC")).toBe(
      "capture:in_syslog:TRAFFIC",
    );
  });

  it("parses quoted and bare key=value pairs, stripping a syslog prefix", () => {
    expect(parseKvLine('<190>date=2019-05-10 type="traffic" srcip=10.0.0.1')).toEqual(
      { date: "2019-05-10", type: "traffic", srcip: "10.0.0.1" },
    );
  });
});

describe("KV splitting on full keys (DBT-84)", () => {
  // Under the `\w+` key class, hyphenated keys TRUNCATED and then COLLIDED:
  // `log-type` and `sub-type` both became `type`, last one winning, and
  // `src-ip`/`dst-ip` both became `ip`. So the subtype silently overwrote the
  // log type, the result depended on pair order, and a line with three real
  // pairs could count as two and fail the >= 3 gate - dropping the whole
  // sample into the fallback group.
  const panos = (logType: string, subType: string, order: "log-first" | "sub-first") =>
    order === "log-first"
      ? `log-type=${logType} sub-type=${subType} src-ip=1 dst-ip=2`
      : `sub-type=${subType} log-type=${logType} src-ip=1 dst-ip=2`;

  it("keeps the whole key, so hyphenated keys no longer collide", () => {
    expect(parseKvLine("log-type=TRAFFIC sub-type=end src-ip=1 dst-ip=2")).toEqual({
      "log-type": "TRAFFIC",
      "sub-type": "end",
      "src-ip": "1",
      "dst-ip": "2",
    });
  });

  it("groups by the LOG TYPE, not by the subtype that used to overwrite it", () => {
    const raw = [
      panos("TRAFFIC", "end", "log-first"),
      panos("THREAT", "url", "log-first"),
      panos("TRAFFIC", "start", "log-first"),
    ];
    const splits = splitSamplesByLogType(raw, "fb", "kv");
    expect(splits.map((s) => [s.logType, s.eventCount])).toEqual([
      ["TRAFFIC", 2],
      ["THREAT", 1],
    ]);
    expect(splits[0].rawEvents).toEqual([raw[0], raw[2]]);
  });

  it("does not depend on the order the pairs are written in", () => {
    const raw = [
      panos("TRAFFIC", "end", "sub-first"),
      panos("THREAT", "url", "sub-first"),
      panos("TRAFFIC", "start", "sub-first"),
    ];
    expect(
      splitSamplesByLogType(raw, "fb", "kv").map((s) => [s.logType, s.eventCount]),
    ).toEqual([
      ["TRAFFIC", 2],
      ["THREAT", 1],
    ]);
  });

  it("counts real pairs at the >= 3 gate, not collapsed keys", () => {
    const splits = splitSamplesByLogType(
      ["src-ip=1 dst-ip=2 action=A", "src-ip=1 dst-ip=2 action=B"],
      "fb",
      "kv",
    );
    expect(splits.map((s) => [s.logType, s.eventCount])).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
  });

  it("does not re-key the samples the truncation used to name correctly", () => {
    // The case that worked BY ACCIDENT before: `log-type` truncated to `type`.
    // The splitter-local alias keeps it selecting through `type`.
    expect(
      splitSamplesByLogType(
        ["log-type=TRAFFIC srcip=1 action=A", "log-type=THREAT srcip=2 action=B"],
        "fb",
        "kv",
      ).map((s) => s.logType),
    ).toEqual(["TRAFFIC", "THREAT"]);
    // ONE distinct value still selects, because the alias target `type` sits in
    // the high-confidence prefix. Without the alias this falls back to "fb".
    expect(
      splitSamplesByLogType(["log-type=TRAFFIC a=1 b=2"], "fb", "kv").map(
        (s) => s.logType,
      ),
    ).toEqual(["TRAFFIC"]);
  });

  it("lets an exact `type=` beat an aliased `log-type=`, in either order", () => {
    // Operator decision 2026-10-02 (DBT-84): the exact key wins.
    for (const line of ["type=x log-type=TRAFFIC a=1", "log-type=TRAFFIC type=x a=1"]) {
      expect(splitSamplesByLogType([line], "fb", "kv").map((s) => s.logType)).toEqual([
        "X",
      ]);
    }
  });

  it("aliases only INTO the shared list, whose entries stay plain identifiers", () => {
    // The alias table lives in the splitter, NOT in DISCRIMINATOR_FIELDS:
    // query-lake-samples interpolates those names unquoted into KQL, so a
    // hyphenated entry there would parse `isnotempty(log-type)` as subtraction.
    expect(SPLITTER_DISCRIMINATOR_ALIASES).toEqual({
      "log-type": "type",
      "sub-type": "subtype",
      "event-type": "eventType",
    });
    for (const target of Object.values(SPLITTER_DISCRIMINATOR_ALIASES)) {
      expect(DISCRIMINATOR_FIELDS).toContain(target);
    }
    expect(DISCRIMINATOR_FIELDS.filter((f) => /[^A-Za-z0-9_]/.test(f))).toEqual([]);
  });
});
