import { describe, expect, it } from "vitest";

import {
  splitSamplesByLogType,
  splitFoundNoDiscriminator,
  hasNamedFields,
  splitSampleId,
  convertPanosSplitAtLoad,
  parseKvLine,
} from "./splitting";
import { parsePositional } from "./positional";

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

  // DBT-117: `positional` had no branch, so a capture isVpcFlowV2 recognises -
  // and parsePositional names srcaddr/dstaddr/account_id - fell off the end to
  // `false`. The rule checks EVERY line, unlike the first-line branches above,
  // because parsePositional's naming decision is per capture and the two must
  // agree on it.
  const VPC_V2 = [
    "2 123456789012 eni-0a1b2c3d 10.0.0.5 10.0.1.9 443 49152 6 10 840 1700000000 1700000060 ACCEPT OK",
    "2 123456789012 eni-0a1b2c3d 10.0.0.7 10.0.1.2 22 51000 6 3 180 1700000000 1700000060 REJECT OK",
    "2 123456789012 eni-0a1b2c3d - - - - - - - 1700000000 1700000060 - NODATA",
  ];

  it("positional qualifies for a recognised VPC Flow v2 capture, agreeing with parsePositional", () => {
    expect(hasNamedFields(VPC_V2, "positional")).toBe(true);
    const records = parsePositional(VPC_V2.join("\n"));
    expect(records).toHaveLength(3);
    expect(Object.keys(records[0])).toEqual([
      "version",
      "account_id",
      "interface_id",
      "srcaddr",
      "dstaddr",
      "srcport",
      "dstport",
      "protocol",
      "packets",
      "bytes",
      "start",
      "end",
      "action",
      "log_status",
    ]);
  });

  it("positional skips blank lines the way parsePositional does", () => {
    const withBlank = [VPC_V2[0], "", "   ", VPC_V2[1]];
    expect(hasNamedFields(withBlank, "positional")).toBe(true);
    expect(Object.keys(parsePositional(withBlank.join("\n"))[0])[3]).toBe(
      "srcaddr",
    );
  });

  it("positional does NOT qualify unless every line is VPC v2", () => {
    // 13 fields: one short of v2, so the columns stay field1..field13.
    const thirteen = [
      "2 123456789012 eni-0a1b2c3d 10.0.0.5 10.0.1.9 443 49152 6 10 840 1700000000 1700000060 ACCEPT",
    ];
    expect(hasNamedFields(thirteen, "positional")).toBe(false);
    // A v2 line FIRST plus one that is not: pins the all-lines rule, which is
    // what parsePositional applies (its keys here are field1..).
    const mixed = [VPC_V2[0], "3 a b c d e f g h i j k l m"];
    expect(hasNamedFields(mixed, "positional")).toBe(false);
    expect(Object.keys(parsePositional(mixed.join("\n"))[0])[0]).toBe("field1");
    expect(hasNamedFields([], "positional")).toBe(false);
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
