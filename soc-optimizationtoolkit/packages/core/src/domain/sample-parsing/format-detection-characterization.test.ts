/**
 * CHARACTERIZATION of detectSampleFormat, across every format and both modes.
 *
 * Written 2026-08-19 BEFORE changing the detector, for one reason: it decides
 * CEF vs CSV vs syslog vs kv for EVERY vendor this toolkit touches, and a
 * regression in it does not throw - it silently reroutes a sample to the wrong
 * parser, which surfaces much later as an empty field list or a broken pack.
 * The narrow fix being made (PAN-OS positional CSV) must be provably narrow, so
 * everything else is pinned first.
 *
 * These pins describe BEHAVIOUR, not intent. Where the current behaviour is
 * arguably wrong it is pinned as-is and labelled, so a future deliberate change
 * has to edit a test that says what it is doing.
 */

import { describe, expect, it } from "vitest";

import { detectSampleFormat } from "./format-detection";

const lenient = (s: string) => detectSampleFormat(s);
const strict = (s: string) => detectSampleFormat(s, { mode: "strict" });

// --- Real-shaped fixtures, one per vendor family ---------------------------

const CEF =
  "CEF:0|Palo Alto Networks|PAN-OS|10.2|end|TRAFFIC|3|src=10.0.0.1 dst=8.8.8.8";
const CEF_SYSLOG_WRAPPED = `<134>Aug 13 10:49:03 fw01 ${CEF}`;
const LEEF = "LEEF:1.0|Lancope|StealthWatch|1.0|41|src=10.0.0.1\tdst=10.0.0.2";
const NDJSON = '{"a":1,"b":"x"}\n{"a":2,"b":"y"}';
const JSON_ARRAY = '[{"a":1},{"a":2}]';
const CSV_HEADER = "src,dst,action,proto\n1.2.3.4,5.6.7.8,allow,tcp";
const KV = 'date=2019-05-10 type="traffic" srcip=10.0.0.1 action=accept';
const SYSLOG_3164 = "<34>Oct 11 22:14:15 mymachine su: authentication failure";
const SYSLOG_NO_PRI = "Oct 11 22:14:15 mymachine su: authentication failure";

const PANOS_CSV =
  "1,2026/08/13 10:49:02,013201031064,GLOBALPROTECT,0,2817,2026/08/13 10:48:54,vsys1,gateway-hip-check,host-info,,,user,US,AU131080,203.0.113.136";
const PANOS_SYSLOG_WRAPPED = `<14>Aug 13 10:49:03 PALC-M700-MD-2.example.org ${PANOS_CSV}`;
const PANOS_TRAFFIC_WRAPPED =
  "<14>Aug 13 10:49:03 fw01 1,2026/08/13 10:49:02,013201031064,TRAFFIC,end,2817,2026/08/13 10:48:54,10.0.0.5,8.8.8.8";

describe("lenient mode (what parseSampleContent uses)", () => {
  it("CEF wins over everything, wrapped or not", () => {
    expect(lenient(CEF)).toBe("cef");
    // The load-bearing lenient/strict divergence: a syslog header does not
    // hide CEF here.
    expect(lenient(CEF_SYSLOG_WRAPPED)).toBe("cef");
  });

  it("LEEF is detected the same way", () => {
    expect(lenient(LEEF)).toBe("leef");
    expect(lenient(`<134>Aug 13 10:49:03 host ${LEEF}`)).toBe("leef");
  });

  it("a JSON array is json; a JSON object stream is ndjson", () => {
    expect(lenient(JSON_ARRAY)).toBe("json");
    expect(lenient(NDJSON)).toBe("ndjson");
    expect(lenient('{"only":"one"}')).toBe("ndjson");
  });

  it("an unparseable brace is NOT json", () => {
    expect(lenient("{not json at all")).toBe("unknown");
  });

  it("CSV needs an identifier HEADER row, not just commas", () => {
    expect(lenient(CSV_HEADER)).toBe("csv");
    // A data row of values is not a header, so it is not csv by this rule.
    expect(lenient("1.2.3.4,5.6.7.8,443,80,tcp")).toBe("unknown");
  });

  it("kv needs more than two pairs on the first line", () => {
    expect(lenient(KV)).toBe("kv");
    expect(lenient("a=1 b=2")).toBe("unknown");
  });

  it("syslog is a priority prefix or an RFC 3164 date", () => {
    expect(lenient(SYSLOG_3164)).toBe("syslog");
    expect(lenient(SYSLOG_NO_PRI)).toBe("syslog");
  });

  it("classifies plain prose as unknown", () => {
    expect(lenient("this is just some text")).toBe("unknown");
    expect(lenient("")).toBe("unknown");
  });
});

describe("strict mode (a single already-split event)", () => {
  it("is PREFIX-only, so a syslog header hides CEF", () => {
    // The deliberate divergence from lenient. Pinned because it looks like a
    // bug and is not - strict classifies one already-split event.
    expect(strict(CEF)).toBe("cef");
    expect(strict(CEF_SYSLOG_WRAPPED)).toBe("syslog");
  });

  it("calls any brace or bracket json, without validating", () => {
    expect(strict(JSON_ARRAY)).toBe("json");
    expect(strict(NDJSON)).toBe("json");
    expect(strict("{not json at all")).toBe("json");
  });

  it("accepts a SINGLE leading pair as kv", () => {
    expect(strict("a=1")).toBe("kv");
  });

  it("has no CSV heuristic at all", () => {
    expect(strict(CSV_HEADER)).toBe("unknown");
  });

  it("reads a bare RFC 3164 date as syslog", () => {
    expect(strict(SYSLOG_NO_PRI)).toBe("syslog");
    expect(strict(SYSLOG_3164)).toBe("syslog");
  });
});

describe("PAN-OS positional CSV", () => {
  it("is CSV with or without the syslog header the source adds", () => {
    // THE FIX (2026-08-19). Before it, the wrapped form was classified
    // "syslog", parseSyslog could not match a PAN-OS body, and the whole file
    // parsed to ZERO events - the operator got "could not parse any events"
    // for a perfectly good PAN-OS export. The bare form fell through to
    // "unknown" and only worked via the parser fallback.
    expect(lenient(PANOS_CSV)).toBe("csv");
    expect(lenient(PANOS_SYSLOG_WRAPPED)).toBe("csv");
    expect(lenient(PANOS_TRAFFIC_WRAPPED)).toBe("csv");
  });

  it("does NOT hijack ordinary syslog that happens to contain commas", () => {
    // The regression this fix could plausibly cause. The rescue keys on the
    // PAN-OS positional fingerprint (`1,<date> <time>,<serial>,<TYPE>`), not on
    // a comma count, so a chatty syslog line stays syslog.
    expect(
      lenient("<134>Jan  1 12:00:00 host app: a, b, c, d, e, f, g"),
    ).toBe("syslog");
    expect(
      lenient("Jan  1 12:00:00 host app: one, two, three, four, five, six"),
    ).toBe("syslog");
  });

  it("does not hijack a CEF or kv line carrying commas", () => {
    expect(lenient(`${CEF} extra=a,b,c,d,e,f`)).toBe("cef");
    expect(lenient("date=2019-05-10 msg=a,b,c,d,e,f action=accept")).toBe("kv");
  });

  it("leaves STRICT mode alone - it classifies one split event", () => {
    // strict is used where the content is already known to be one record; the
    // fix is about whole-file upload detection and must not reach it.
    expect(strict(PANOS_SYSLOG_WRAPPED)).toBe("syslog");
  });
});
