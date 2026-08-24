/**
 * Raw-line preservation pins (ADR 0003 salvage; docs/sample-acquisition-phase0.md
 * section 0.3).
 *
 * parseSampleContent used to build `rawEvents` as records.map(JSON.stringify)
 * unconditionally, so a LEEF / syslog / KV / headerless-CSV sample - and every
 * Cribl capture - reached pack generation as JSON and shipped a JSON object in
 * the pack's `_raw`. Nothing failed when that happened: the whole suite stayed
 * green through the change, which is exactly why these pins assert the BYTES
 * rather than that some string is present.
 */

import { describe, expect, it } from "vitest";

import { parseSampleContent } from "./parse-sample";
import { RAW_EVENTS_CAP } from "./models";
import { generateSampleFile } from "../pack-assembly/sample-file";

// Real-shaped PAN-OS GlobalProtect lines: the CSV body, and the same body with
// the syslog header a Cribl syslog source delivers in front of it.
const PANOS_SYSLOG_HEADER = "<14>Aug 13 10:49:03 PALC-M700-MD-2.example.org ";
const PANOS_CSV_1 =
  "1,2026/08/13 10:49:02,013201031064,GLOBALPROTECT,0,2817,2026/08/13 10:48:54,vsys1,gateway-hip-check,host-info,,,exampledom,US,AU131080,203.0.113.136,0.0.0.0,10.248.107.212,0.0.0.0,1ee9533f-aa5d-45b7-8444-f1155e174d24,MXL9511R59,6.2.8,any,,1,,,success,,0,,0,GP-GW,7608730157713666651";
const PANOS_CSV_2 =
  "1,2026/08/13 10:49:02,013201031064,GLOBALPROTECT,0,2817,2026/08/13 10:49:01,vsys1,portal-auth,login,Cookie,,pre-logon,US,AL114021,198.51.100.29,0.0.0.0,0.0.0.0,0.0.0.0,6fea3a15-d333-490b-97c3-5f1f483bb901,5CG140066W,6.2.8,Windows,,1,,,failure,,0,pre-logon,11,GP-PORTAL,7608730157713666671";
const PANOS_LINE_1 = PANOS_SYSLOG_HEADER + PANOS_CSV_1;
const PANOS_LINE_2 = PANOS_SYSLOG_HEADER + PANOS_CSV_2;

describe("line-oriented formats keep the ORIGINAL vendor bytes", () => {
  it("CEF: rawEvents are the input lines verbatim, syslog header included", () => {
    const lines = [
      "<134>host1 CEF:0|Palo Alto Networks|PAN-OS|10.2|end|TRAFFIC|3|src=10.0.0.1 dst=8.8.8.8 spt=443",
      "<134>host2 CEF:0|Palo Alto Networks|PAN-OS|10.2|vuln|THREAT|7|src=10.0.0.2 dst=9.9.9.9 spt=80",
    ];
    const parsed = parseSampleContent(lines.join("\n"));

    expect(parsed.format).toBe("cef");
    expect(parsed.rawEvents).toEqual(lines);
    // Not a re-serialization: a JSON record would start with "{".
    expect(parsed.rawEvents.every((e) => e.startsWith("<134>"))).toBe(true);
  });

  it("LEEF: rawEvents are the input lines verbatim (no reconstruction exists)", () => {
    const lines = [
      "LEEF:1.0|Lancope|StealthWatch|1.0|41|src=10.0.0.1\tdst=10.0.0.2\tspt=1234",
      "LEEF:1.0|Lancope|StealthWatch|1.0|42|src=10.0.0.3\tdst=10.0.0.4\tspt=5678",
    ];
    const parsed = parseSampleContent(lines.join("\n"));

    expect(parsed.format).toBe("leef");
    expect(parsed.rawEvents).toEqual(lines);
  });

  it("syslog: rawEvents are the input lines verbatim", () => {
    const lines = [
      "<34>Oct 11 22:14:15 mymachine su: authentication failure for user root",
      "<34>Oct 11 22:14:16 mymachine su: authentication failure for user admin",
    ];
    const parsed = parseSampleContent(lines.join("\n"));

    expect(parsed.format).toBe("syslog");
    expect(parsed.rawEvents).toEqual(lines);
  });

  it("KV: rawEvents are the input lines verbatim", () => {
    const lines = [
      'date=2019-05-10 type="traffic" srcip=10.0.0.1 dstip=8.8.8.8 action=accept',
      'date=2019-05-10 type="traffic" srcip=10.0.0.2 dstip=9.9.9.9 action=deny',
    ];
    const parsed = parseSampleContent(lines.join("\n"));

    expect(parsed.format).toBe("kv");
    expect(parsed.rawEvents).toEqual(lines);
  });

  it("headerless PAN-OS CSV: rawEvents are the CSV lines verbatim", () => {
    const parsed = parseSampleContent([PANOS_CSV_1, PANOS_CSV_2].join("\n"));

    expect(parsed.records).toHaveLength(2);
    expect(parsed.rawEvents).toEqual([PANOS_CSV_1, PANOS_CSV_2]);
    // NAMED, not positional. This asserted `_3` until the 2026-08-20 audit,
    // with a comment claiming GLOBALPROTECT had no column dictionary - it has
    // had one all along; parseCsv just wired two of the seven.
    expect(parsed.records[0].type).toBe("GLOBALPROTECT");
    expect(parsed.records[0].eventid).toBe("gateway-hip-check");
    expect(parsed.rawEvents[0].startsWith("{")).toBe(false);
  });
});

describe("FIXED - a syslog-prefixed PAN-OS file uploaded directly", () => {
  it("parses, instead of yielding zero events", () => {
    // Was a KNOWN GAP pinned here on 2026-08-19 and fixed the same day.
    // detectSampleFormat called this "syslog"; parseSyslog's RFC 3164/5424
    // regexes cannot match a PAN-OS body, so every record was dropped and a
    // good export reported "could not parse any events". Detection now
    // recognises the PAN-OS positional fingerprint ahead of the syslog check.
    const parsed = parseSampleContent([PANOS_LINE_1, PANOS_LINE_2].join("\n"));

    expect(parsed.format).toBe("csv");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.errors).toEqual([]);
    expect(parsed.records[0].type).toBe("GLOBALPROTECT");
    expect(parsed.records[0].eventid).toBe("gateway-hip-check");
    expect(parsed.rawEvents).toEqual([PANOS_LINE_1, PANOS_LINE_2]);
  });
});

describe("Cribl capture: the wrapper's _raw IS the vendor line", () => {
  it("unwrapping a capture keeps the inner _raw, not the exploded fields", () => {
    const capture = [
      JSON.stringify({ _raw: PANOS_LINE_1, _time: 1786632543, source: "pan_syslog" }),
      JSON.stringify({ _raw: PANOS_LINE_2, _time: 1786632543, source: "pan_syslog" }),
    ].join("\n");

    const parsed = parseSampleContent(capture, { sourceName: "capture.json" });

    // The unwrap still happens (fields come from the vendor line, not the
    // wrapper) - the wrapper's own keys must be gone.
    expect(parsed.format).toBe("csv");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]._time).toBeUndefined();
    expect(parsed.records[0].source).toBeUndefined();
    expect(parsed.records[0].type).toBe("GLOBALPROTECT");
    // ...and the raw events are the vendor bytes the capture carried, syslog
    // header and all - NOT the wrapper JSON and NOT the exploded columns.
    expect(parsed.rawEvents).toEqual([PANOS_LINE_1, PANOS_LINE_2]);
    expect(parsed.rawEvents[0]).toContain(PANOS_SYSLOG_HEADER.trim());
  });

  it("a capture wrapping PAN-OS TRAFFIC keeps the line AND names the columns", () => {
    const traffic =
      PANOS_SYSLOG_HEADER +
      "1,2026/08/13 10:49:02,013201031064,TRAFFIC,end,2817,2026/08/13 10:48:54,10.0.0.5,8.8.8.8,0.0.0.0,0.0.0.0,rule1,user1,,ssl,vsys1,trust,untrust,eth1,eth2,logprof,2026/08/13,1234,1,443,55000,0,0,0x0,tcp,allow";
    const parsed = parseSampleContent(JSON.stringify({ _raw: traffic, _time: 1 }));

    // TRAFFIC has a column dictionary, so the record IS named...
    expect(parsed.records[0].type).toBe("TRAFFIC");
    expect(parsed.records[0].src).toBe("10.0.0.5");
    // ...and the raw line survives alongside it.
    expect(parsed.rawEvents).toEqual([traffic]);
  });

  it("a capture wrapping CEF keeps the CEF line, not the wrapper JSON", () => {
    const cef = "CEF:0|Zscaler|NSSWeblog|1.0|allowed|Web Access|3|src=10.0.0.1 dst=1.1.1.1";
    const capture = JSON.stringify({ _raw: cef, _time: 1, host: "w1" });

    const parsed = parseSampleContent(capture);

    expect(parsed.rawEvents).toEqual([cef]);
    expect(parsed.rawEvents[0].startsWith("{")).toBe(false);
  });
});

describe("JSON and NDJSON keep the re-serialized form (deliberately unchanged)", () => {
  it("NDJSON without a _raw wrapper still stores serialized records", () => {
    const parsed = parseSampleContent(
      ['{"a":1,"b":"x"}', '{"a":2,"b":"y"}'].join("\n"),
    );

    expect(parsed.format).toBe("ndjson");
    expect(parsed.rawEvents).toEqual(['{"a":1,"b":"x"}', '{"a":2,"b":"y"}']);
    expect(parsed.rawEvents.every((e) => e.startsWith("{"))).toBe(true);
  });

  it("a JSON array stores one serialized record per element", () => {
    const parsed = parseSampleContent('[{"a":1},{"a":2}]');

    expect(parsed.rawEvents).toHaveLength(2);
    expect(JSON.parse(parsed.rawEvents[1]).a).toBe(2);
  });
});

describe("the line/record pairing cannot drift", () => {
  it("PAIRS each raw event with ITS OWN record when the parser filters lines", () => {
    // parseCef drops every line without "CEF:". If source lines were collected
    // before that filter, each rawEvent would be shifted onto the wrong record.
    const content = [
      "this line is not CEF at all",
      "<134>hostA CEF:0|V|P|1|100|first|3|src=10.0.0.1",
      "### another junk line ###",
      "<134>hostB CEF:0|V|P|1|200|second|3|src=10.0.0.2",
      "trailing junk",
    ].join("\n");

    const parsed = parseSampleContent(content);

    expect(parsed.records).toHaveLength(2);
    expect(parsed.rawEvents).toHaveLength(2);
    // The pairing itself, event by event: record[i]'s identity must appear in
    // rawEvents[i] and NOT in the other one.
    expect(parsed.records[0].DeviceEventClassID).toBe("100");
    expect(parsed.rawEvents[0]).toContain("|100|first|");
    expect(parsed.rawEvents[0]).not.toContain("second");
    expect(parsed.records[1].DeviceEventClassID).toBe("200");
    expect(parsed.rawEvents[1]).toContain("|200|second|");
    expect(parsed.rawEvents[1]).not.toContain("first");
    // No junk line leaked in as an event.
    expect(parsed.rawEvents.some((e) => e.includes("junk"))).toBe(false);
  });

  it("PAIRS correctly when the CSV parser DROPS a line for having one field", () => {
    // parseCsv keeps only records with more than one field, so a comma-less
    // junk line is parsed and then discarded. This is the drift case the CEF
    // one above cannot reach: there the skip happens before any work, here the
    // record is built and only then thrown away. Push the line at the wrong
    // moment and every later event carries its neighbour's bytes.
    const content = [PANOS_CSV_1, "GARBAGE-NO-COMMAS", PANOS_CSV_2].join("\n");

    const parsed = parseSampleContent(content);

    expect(parsed.records).toHaveLength(2);
    expect(parsed.rawEvents).toEqual([PANOS_CSV_1, PANOS_CSV_2]);
    // Pair each event to its own record by a field only that record carries.
    expect(parsed.records[0].eventid).toBe("gateway-hip-check");
    expect(parsed.rawEvents[0]).toContain("gateway-hip-check");
    expect(parsed.records[1].eventid).toBe("portal-auth");
    expect(parsed.rawEvents[1]).toContain("portal-auth");
    expect(parsed.rawEvents.some((e) => e.includes("GARBAGE"))).toBe(false);
  });

  it("caps at RAW_EVENTS_CAP while still storing original lines", () => {
    const total = RAW_EVENTS_CAP + 25;
    const lines = Array.from(
      { length: total },
      (_, i) => `<134>h CEF:0|V|P|1|${i}|evt|3|src=10.0.0.${i % 250}`,
    );
    const parsed = parseSampleContent(lines.join("\n"));

    expect(parsed.eventCount).toBe(total);
    expect(parsed.rawEvents).toHaveLength(RAW_EVENTS_CAP);
    expect(parsed.rawEvents[0]).toBe(lines[0]);
    expect(parsed.rawEvents[RAW_EVENTS_CAP - 1]).toBe(lines[RAW_EVENTS_CAP - 1]);
  });
});

describe("what this fixes downstream: the pack sample file", () => {
  it("a LEEF sample now reaches the pack as a LEEF line, not a JSON object", () => {
    const leef =
      "LEEF:1.0|Lancope|StealthWatch|1.0|41|src=10.0.0.1\tdst=10.0.0.2\tspt=1234";
    const parsed = parseSampleContent(leef);

    const { events } = generateSampleFile(
      "Lancope",
      "CommonSecurityLog",
      [],
      [
        {
          tableName: "CommonSecurityLog",
          rawEvents: parsed.rawEvents,
          source: "Lancope:flow",
          logType: "flow",
        },
      ],
      1,
      "flow",
    );

    expect(events).toHaveLength(1);
    expect(events[0]._raw).toBe(leef);
    // The old behavior: `_raw` was the JSON object, and reconstructCefLine
    // could not rescue LEEF (no CEFVersion), so it shipped as-is.
    expect(events[0]._raw.startsWith("{")).toBe(false);
  });

  it("a PAN-OS capture reaches the pack as the original syslog line", () => {
    const capture = JSON.stringify({ _raw: PANOS_LINE_1, _time: 1786632543 });
    const parsed = parseSampleContent(capture);

    const { events } = generateSampleFile(
      "PaloAlto",
      "CommonSecurityLog",
      [],
      [
        {
          tableName: "CommonSecurityLog",
          rawEvents: parsed.rawEvents,
          source: "PaloAlto:GLOBALPROTECT",
          logType: "GLOBALPROTECT",
        },
      ],
      1,
      "GLOBALPROTECT",
    );

    expect(events[0]._raw).toBe(PANOS_LINE_1);
  });
});
