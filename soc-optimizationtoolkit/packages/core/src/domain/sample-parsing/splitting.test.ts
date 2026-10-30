import { describe, expect, it } from "vitest";

import {
  splitSamplesByLogType,
  splitSamplesWithLeftOut,
  splitFoundNoDiscriminator,
  hasNamedFields,
  splitSampleId,
  convertPanosSplitAtLoad,
  parseKvLine,
  SPLITTER_DISCRIMINATOR_ALIASES,
} from "./splitting";
import { parsePositional } from "./positional";
import { DISCRIMINATOR_FIELDS } from "./discriminators";
import type { SampleFormat } from "./models";
import {
  documentedLogTypesForSolution,
  mergeLogTypeSources,
} from "../log-type-catalog";
import { compareLogTypeCoverage } from "../coverage-analysis/expected-log-types";

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

  it("does not weld a CEF/LEEF or syslog header onto the first key", () => {
    // REVIEW FINDING on DBT-84's first cut, measured before this pin existed.
    // The first cut copied parseKv's key class `[^\s=,"]+` and its left
    // boundary, but this probe receives RAW lines that still carry a header -
    // CEF/LEEF `|` fields, a `prog:` syslog tag - and neither `|` nor `:` was a
    // boundary. So the header was glued onto the first key:
    //   "...|Blocked|5|cat=TRAFFIC ..." -> key "CEF:0|Acme|...|5|cat"
    // and when that first pair WAS the discriminator the capture fell back to
    // one group. Under `\w+` (before DBT-84) these lines split correctly, so the
    // widening regressed captures that never had a collision to fix.
    expect(
      Object.keys(
        parseKvLine(
          "<14>Oct 2 fw CEF:0|Acme|FW|1.0|100|Blocked|5|cat=TRAFFIC src=1 dst=2",
        ),
      ),
    ).toEqual(["cat", "src", "dst"]);
    expect(
      Object.keys(parseKvLine("LEEF:1.0|Acme|FW|1.0|100|devTime=1 src=1 dst=2")),
    ).toEqual(["devTime", "src", "dst"]);
    expect(Object.keys(parseKvLine("host app:type=A a=1 b=2"))).toEqual([
      "type",
      "a",
      "b",
    ]);
    // A bracketed timestamp welded to the first key is the same shape.
    expect(Object.keys(parseKvLine("[2024-01-01]type=A a=1 b=2"))).toEqual([
      "type",
      "a",
      "b",
    ]);

    // End to end: the discriminator is the FIRST extension key in each shape.
    const grouped = (raw: string[], format: SampleFormat) =>
      splitSamplesByLogType(raw, "fb", format).map((s) => [s.logType, s.eventCount]);
    expect(
      grouped(
        [
          "CEF:0|Acme|FW|1|1|n|5|category=A src=1 dst=2",
          "CEF:0|Acme|FW|1|1|n|5|category=B src=1 dst=2",
        ],
        "cef",
      ),
    ).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
    expect(
      grouped(["host app:type=A a=1 b=2", "host app:type=B a=1 b=2"], "kv"),
    ).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
    // Hyphenated keys after a header stay whole, so the DBT-84 fix still holds
    // there: the log type wins over the subtype.
    expect(
      grouped(
        [
          "CEF:0|V|P|1|1|n|5|log-type=TRAFFIC sub-type=end src-ip=1",
          "CEF:0|V|P|1|1|n|5|log-type=THREAT sub-type=url src-ip=1",
        ],
        "cef",
      ),
    ).toEqual([
      ["TRAFFIC", 1],
      ["THREAT", 1],
    ]);
  });

  it("reads a dotted key whole, so it no longer truncates into the list", () => {
    // DOCUMENTED REGROUP, not a defect: `\w+` cut `event.type` to `type`, which
    // selected by accident exactly as `log-type` did. The dotted key is read
    // whole - `src.ip`/`dst.ip` collided the same way hyphens did - and it is
    // NOT aliased, so such a capture regroups (release notes, DBT-84).
    expect(parseKvLine("event.type=A src.ip=1 dst.ip=2")).toEqual({
      "event.type": "A",
      "src.ip": "1",
      "dst.ip": "2",
    });
  });
});

// DBT-196 (UAT 2026-10-29, live capture on in_syslog): a PAN-OS CEF capture
// ticked for THREAT and TRAFFIC came back "Captured 100 events in 1 log type",
// because the type lives in the CEF HEADER and the splitter's probe reads only
// key=value pairs. Operator decision: split PAN-OS CEF by header field 6 (the
// TYPE), for PAN-OS CEF only; the subtype in field 5 is not the discriminator.
describe("splitSamplesByLogType - PAN-OS CEF header type (DBT-196)", () => {
  // Syslog-wrapped, the shape the capture delivered. Field 5 is the subtype
  // (`url`, `end`), field 6 the type. No extension key names either.
  const PAN_THREAT =
    "<14>Oct 29 10:00:00 fw01 CEF:0|Palo Alto Networks|PAN-OS|10.1.0|url|THREAT|1|rt=Oct 29 2026 10:00:00 GMT deviceExternalId=0123 src=10.0.0.1 dst=1.2.3.4 act=alert";
  const PAN_TRAFFIC =
    "<14>Oct 29 10:00:01 fw01 CEF:0|Palo Alto Networks|PAN-OS|10.1.0|end|TRAFFIC|1|rt=Oct 29 2026 10:00:01 GMT deviceExternalId=0123 src=10.0.0.2 dst=5.6.7.8 act=allow";

  const grouped = (raw: string[]) =>
    splitSamplesByLogType(raw, "captured", "cef").map((s) => [
      s.logType,
      s.eventCount,
      s.rawEvents,
    ]);

  it("splits syslog-wrapped |url|THREAT| and |end|TRAFFIC| lines by TYPE, not subtype", () => {
    expect(grouped([PAN_THREAT, PAN_TRAFFIC, PAN_THREAT])).toEqual([
      ["THREAT", 2, [PAN_THREAT, PAN_THREAT]],
      ["TRAFFIC", 1, [PAN_TRAFFIC]],
    ]);
  });

  it("names a single-type PAN-OS capture rather than falling back", () => {
    const splits = splitSamplesByLogType([PAN_TRAFFIC, PAN_TRAFFIC], "captured", "cef");
    expect(splits.map((s) => [s.logType, s.eventCount])).toEqual([["TRAFFIC", 2]]);
    expect(splitFoundNoDiscriminator(splits, "captured")).toBe(false);
  });

  it("files each raw line under its OWN log type when another line parses to nothing", () => {
    // A syslog line with no CEF header and no key=value pairs yields no parsed
    // object. The groups used to index the raw lines by the parsed object's
    // position, so every later line shifted by one: THREAT carried the sshd
    // line, TRAFFIC carried the THREAT line, and the TRAFFIC line was lost.
    // The unparsed line is still left out of every group (DBT-197 territory);
    // this pins only that no line lands under another line's log type.
    const noise = "<14>Oct 29 10:00:02 fw01 sshd: session opened for THREAT review";
    expect(grouped([noise, PAN_THREAT, PAN_TRAFFIC])).toEqual([
      ["THREAT", 1, [PAN_THREAT]],
      ["TRAFFIC", 1, [PAN_TRAFFIC]],
    ]);
    // Same shift from a PAN-OS line whose TYPE field is empty: it falls to the
    // KV path, fails the pair gate, and must not take the next line's slot.
    const emptyType = "CEF:0|Palo Alto Networks|PAN-OS|10.1.0|url||1|src=1";
    expect(grouped([emptyType, PAN_TRAFFIC])).toEqual([
      ["TRAFFIC", 1, [PAN_TRAFFIC]],
    ]);
  });

  it("reads a bare (unwrapped) PAN-OS CEF line the same way", () => {
    const bare = PAN_THREAT.slice(PAN_THREAT.indexOf("CEF:"));
    const bareTraffic = PAN_TRAFFIC.slice(PAN_TRAFFIC.indexOf("CEF:"));
    expect(grouped([bare, bareTraffic]).map((g) => g.slice(0, 2))).toEqual([
      ["THREAT", 1],
      ["TRAFFIC", 1],
    ]);
  });

  it("takes the header TYPE over an extension type, and needs no pair count", () => {
    // The header is the device's own statement of the type: an extension
    // `type=` / `log-type=` (a custom log format) does not override it, and a
    // line with fewer than the KV probe's three pairs still splits - the header
    // is the evidence, not the pairs.
    const withExtType = [
      "CEF:0|Palo Alto Networks|PAN-OS|10.1.0|url|THREAT|1|type=end src=1 dst=2",
      "CEF:0|Palo Alto Networks|PAN-OS|10.1.0|end|TRAFFIC|1|log-type=url src=1 dst=2",
    ];
    expect(grouped(withExtType).map((g) => g.slice(0, 2))).toEqual([
      ["THREAT", 1],
      ["TRAFFIC", 1],
    ]);
    const fewPairs = [
      "CEF:0|Palo Alto Networks|PAN-OS|10.1.0|start|TRAFFIC|1|src=1",
      "CEF:0|Palo Alto Networks|PAN-OS|10.1.0|general|SYSTEM|1|",
    ];
    expect(grouped(fewPairs).map((g) => g.slice(0, 2))).toEqual([
      ["TRAFFIC", 1],
      ["SYSTEM", 1],
    ]);
  });

  it("leaves every other CEF vendor and product unchanged", () => {
    // The same header shape from another vendor - and from another Palo Alto
    // product - is NOT split by its header: it falls back exactly as before.
    for (const [vendor, product] of [
      ["Acme", "FW"],
      ["Palo Alto Networks", "Traps"],
    ]) {
      const lines = [PAN_THREAT, PAN_TRAFFIC].map((l) =>
        l.replace("Palo Alto Networks|PAN-OS", `${vendor}|${product}`),
      );
      expect(grouped(lines)).toEqual([["captured", 2, lines]]);
    }
    // A non-PAN CEF line with a discriminator in its extension still splits on
    // that, not on its header.
    const acme = [
      "CEF:0|Acme|FW|1|url|THREAT|5|category=A src=1 dst=2",
      "CEF:0|Acme|FW|1|end|TRAFFIC|5|category=B src=1 dst=2",
    ];
    expect(grouped(acme).map((g) => g.slice(0, 2))).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
  });

  it("produces names the PAN-OS needs list counts as provided", () => {
    // "Log types this solution needs" reads mergeLogTypeSources (vendor tier)
    // and compareLogTypeCoverage (content tier), both through
    // logTypeNameMatches. Split names that miss those keys - a subtype such as
    // URL or END - leave it at "None provided yet" with the samples in hand.
    const provided = splitSamplesByLogType(
      [PAN_THREAT, PAN_TRAFFIC],
      "captured",
      "cef",
    ).map((s) => s.logType);
    const merged = mergeLogTypeSources({
      expected: [],
      vendorLogTypes: documentedLogTypesForSolution("PaloAlto-PAN-OS"),
      provided,
    });
    expect(merged.filter((m) => m.provided).map((m) => m.value)).toEqual([
      "THREAT",
      "TRAFFIC",
    ]);
    expect(merged.length).toBe(8);
    const coverage = compareLogTypeCoverage(
      [
        { value: "THREAT", field: "Activity", referencedBy: ["r1"], referencedTypes: ["alert-rule"] },
        { value: "TRAFFIC", field: "Activity", referencedBy: ["r2"], referencedTypes: ["alert-rule"] },
      ],
      provided,
    );
    expect(coverage.missing).toEqual([]);
    expect(coverage.matched).toEqual(["THREAT", "TRAFFIC"]);
  });
});

// DBT-205 (F1/F2 build review, 2026-10-29). A key=value line under the probe's
// three-pair gate, or a line that parses to nothing at all, adds no record to
// the discriminator's input. Two failures followed from that: raw lines filed
// by the RECORD's position shift by one after such a line (DBT-196 measured
// the shift on PAN-OS CEF), and the skipped line itself vanished from every
// group with no word, so the group counts summed below the captured count.
describe("splitSamplesWithLeftOut (DBT-205)", () => {
  const TRAFFIC_1 = "log-type=TRAFFIC src=10.0.0.1 dst=1.2.3.4 action=allow";
  const SHORT_KV = "a=1 b=2";
  const THREAT_1 = "log-type=THREAT src=10.0.0.2 dst=5.6.7.8 action=alert";
  const TRAFFIC_2 = "log-type=TRAFFIC src=10.0.0.3 dst=9.9.9.9 action=deny";
  const NOISE = "sshd: session opened for user root";
  const THREAT_2 = "log-type=THREAT src=10.0.0.4 dst=4.4.4.4 action=drop";
  const MIXED = [TRAFFIC_1, SHORT_KV, THREAT_1, TRAFFIC_2, NOISE, THREAT_2];

  it("files every raw line after a short kv line under its OWN log type", () => {
    const { splits } = splitSamplesWithLeftOut(MIXED, "fb", "kv");
    expect(splits.map((s) => [s.logType, s.rawEvents])).toEqual([
      ["TRAFFIC", [TRAFFIC_1, TRAFFIC_2]],
      ["THREAT", [THREAT_1, THREAT_2]],
    ]);
  });

  it("reports the lines it left out, so groups plus left-out equal the input", () => {
    const { splits, leftOut } = splitSamplesWithLeftOut(MIXED, "fb", "kv");
    expect(leftOut).toBe(2);
    const grouped = splits.reduce((n, s) => n + s.eventCount, 0);
    expect(grouped + leftOut).toBe(MIXED.length);
  });

  it("agrees with splitSamplesByLogType, which returns only the groups", () => {
    expect(splitSamplesByLogType(MIXED, "fb", "kv")).toEqual(
      splitSamplesWithLeftOut(MIXED, "fb", "kv").splits,
    );
  });

  it("leaves nothing out when every line falls into the fallback group", () => {
    // The fallback paths carry every input line, so there is no shortfall to
    // report - only the no-discriminator fact, which the caller already says.
    for (const raw of [[NOISE, NOISE], [SHORT_KV, NOISE], ['{"a":1}', '{"a":2}']]) {
      const { splits, leftOut } = splitSamplesWithLeftOut(raw, "fb", "unknown");
      expect(leftOut).toBe(0);
      expect(splits).toEqual([
        { logType: "fb", rawEvents: raw, format: "unknown", eventCount: raw.length },
      ]);
    }
  });

  it("leaves nothing out of the PAN-OS CSV grouping, which files every line", () => {
    // The headerless-CSV path names real log types from position 3, so it is
    // not the fallback group - but it groups EVERY input line, so its shortfall
    // is 0 too. Pinned separately because no other case here reaches it.
    const CSV_TRAFFIC = "1,2026/10/29 10:00:00,0123,TRAFFIC,end,2049,2026/10/29 10:00:00,10.0.0.1";
    const CSV_THREAT = "1,2026/10/29 10:00:01,0123,THREAT,url,2049,2026/10/29 10:00:01,10.0.0.2";
    const { splits, leftOut } = splitSamplesWithLeftOut(
      [CSV_TRAFFIC, CSV_THREAT, CSV_TRAFFIC],
      "fb",
      "csv",
    );
    expect(splits.map((s) => [s.logType, s.rawEvents])).toEqual([
      ["TRAFFIC", [CSV_TRAFFIC, CSV_TRAFFIC]],
      ["THREAT", [CSV_THREAT]],
    ]);
    expect(leftOut).toBe(0);
  });

  it("does not change the PAN-OS CEF split, and leaves none of it out", () => {
    const PAN_THREAT =
      "<14>Oct 29 10:00:00 fw01 CEF:0|Palo Alto Networks|PAN-OS|10.1.0|url|THREAT|1|rt=Oct 29 2026 10:00:00 GMT deviceExternalId=0123 src=10.0.0.1 dst=1.2.3.4 act=alert";
    const PAN_TRAFFIC =
      "<14>Oct 29 10:00:01 fw01 CEF:0|Palo Alto Networks|PAN-OS|10.1.0|end|TRAFFIC|1|rt=Oct 29 2026 10:00:01 GMT deviceExternalId=0123 src=10.0.0.2 dst=5.6.7.8 act=allow";
    const { splits, leftOut } = splitSamplesWithLeftOut(
      [PAN_THREAT, PAN_TRAFFIC, PAN_THREAT],
      "captured",
      "cef",
    );
    expect(leftOut).toBe(0);
    expect(splits.map((s) => [s.logType, s.rawEvents])).toEqual([
      ["THREAT", [PAN_THREAT, PAN_THREAT]],
      ["TRAFFIC", [PAN_TRAFFIC]],
    ]);
  });
});
