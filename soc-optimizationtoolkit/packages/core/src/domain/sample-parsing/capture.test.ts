import { describe, expect, it } from "vitest";

import {
  detectCaptureInnerFormat,
  parseSampleContent,
  stripSyslogPrefix,
  unwrapCapture,
} from "./index";

// Cribl capture is the PRIMARY sample format (user memory). A capture wraps each
// event as NDJSON with the real vendor line in `_raw`, so the format is ALWAYS
// read from the INNER `_raw` content, never the JSON wrapper. These tests are
// NEW coverage for the ENG-15 gaps the catalog flags as edge-case archive
// material: silent wrapper fallback, format replacement, the >=5-comma CSV
// threshold, and PAN-OS prefix stripping.

describe("detectCaptureInnerFormat", () => {
  it("finds CEF/LEEF via includes, even behind a syslog header", () => {
    expect(detectCaptureInnerFormat(["CEF:0|V|P|1|1|n|5|a=b"])).toBe("cef");
    expect(detectCaptureInnerFormat(["<13>host CEF:0|V|P|1|1|n|5|a=b"])).toBe(
      "cef",
    );
    expect(detectCaptureInnerFormat(["LEEF:1.0|V|P|1|E"])).toBe("leef");
  });

  it("finds inner JSON, kv, and syslog", () => {
    expect(detectCaptureInnerFormat(['{"a":1}'])).toBe("ndjson");
    expect(detectCaptureInnerFormat(["a=1 b=2 c=3"])).toBe("kv");
    expect(detectCaptureInnerFormat(["<34>Oct 11 22:14:15 host su: m"])).toBe(
      "syslog",
    );
  });

  describe(">=5-comma CSV threshold (pinned)", () => {
    it("claims csv at exactly 5 commas", () => {
      expect(detectCaptureInnerFormat(["1,2,3,4,5,6"])).toBe("csv");
    });
    it("does NOT claim csv at 4 commas", () => {
      expect(detectCaptureInnerFormat(["1,2,3,4,5"])).toBe("unknown");
    });
  });

  it("kv needs >=3 pairs; two pairs is not enough", () => {
    expect(detectCaptureInnerFormat(["a=1 b=2"])).toBe("unknown");
  });

  it("returns unknown for opaque text", () => {
    expect(detectCaptureInnerFormat(["just some words"])).toBe("unknown");
  });
});

describe("stripSyslogPrefix (drives the PAN-OS CSV threshold)", () => {
  it("strips a non-standard prefix down to the PAN-OS positional start", () => {
    expect(
      stripSyslogPrefix("host-fw 1,2020/05/07 10:00:00,001,TRAFFIC,end,a,b"),
    ).toBe("1,2020/05/07 10:00:00,001,TRAFFIC,end,a,b");
  });

  it("strips the FULL RFC 5424 header, structured-data included", () => {
    // This branch had NO pin until 2026-08-25 and was one field short: RFC 5424
    // carries SIX fields after VERSION (TIMESTAMP, HOSTNAME, APP-NAME, PROCID,
    // MSGID, STRUCTURED-DATA) and only five were consumed, so the `-` marking an
    // absent structured-data element stayed glued to the message.
    //
    // It hid because the only caller that could see it was PAN-OS, where the
    // damage lands in positional field 0 - which every dictionary lists as
    // `future_use1` and skips. A JSON payload has no such luck.
    expect(
      stripSyslogPrefix(
        '<13>1 2026-08-25T16:35:36.206Z cribl-hw01 app - - - {"src":"1.2.3.4"}',
      ),
    ).toBe('{"src":"1.2.3.4"}');

    // A REAL structured-data element is not mistaken for the message.
    expect(
      stripSyslogPrefix(
        '<13>1 2026-08-25T16:35:36.206Z host app 123 ID47 [ex@1 a="b"] the message',
      ),
    ).toBe("the message");

    // And a sender that omits structured-data entirely still strips.
    expect(
      stripSyslogPrefix("<13>1 2026-08-25T16:35:36.206Z host app 123 ID47 the message"),
    ).toBe("the message");
  });

  it("lets a syslog-wrapped PAN-OS line reach the >=5-comma csv threshold", () => {
    // Without stripping, the leading words would still count, but the point is
    // the DATA portion (>=5 commas) is what gets classified.
    expect(
      detectCaptureInnerFormat([
        "host-fw 1,2020/05/07 10:00:00,001,TRAFFIC,end,a,b",
      ]),
    ).toBe("csv");
  });
});

describe("a vendor payload shipped over syslog", () => {
  // THE ASYMMETRY THIS CLOSED. parseCsv's headerless branch had always called
  // stripSyslogPrefix before splitting, so wrapped PAN-OS parsed into real
  // column names. parseNdjson had no equivalent - it tested
  // `line.startsWith("{")`, skipped anything wrapped, and a JSON payload over
  // syslog parsed to ZERO records while the same payload as CSV parsed fine.
  //
  // Detection and parsing now agree on which bytes they read: parseNdjson
  // strips for itself, and only then does the detector classify on the payload.

  it("parses wrapped JSON into ITS OWN fields, not the envelope's", () => {
    const parsed = parseSampleContent(
      '<13>1 2026-08-25T16:35:36.206Z cribl-hw01 app - - - {"src":"1.2.3.4","action":"allow"}',
    );
    expect(parsed.format).toBe("ndjson");
    expect(parsed.records).toHaveLength(1);
    // The discriminating assertion: the ENVELOPE fields (Priority, Version,
    // Hostname, MsgID...) must be absent. A record count alone cannot tell the
    // two apart - syslog parsing also yields exactly one record.
    expect(parsed.fields.map((f) => f.name).sort()).toEqual(["action", "src"]);
  });

  it("still parses wrapped PAN-OS into its dictionary names", () => {
    const parsed = parseSampleContent(
      "<13>1 2026-08-25T16:35:36.206Z cribl-hw01 app - - - " +
        "1,2012/10/30 09:46:12,01606001116,TRAFFIC,end,1,2012/04/10 04:39:58,192.168.0.2,175.16.199.1",
    );
    expect(parsed.format).toBe("csv");
    expect(parsed.fields.map((f) => f.name)).toContain("serial");
    expect(parsed.fields.map((f) => f.name)).toContain("type");
  });

  it("does NOT reinterpret syslog that merely carries commas or a brace", () => {
    // The refusals. Once a header is stripped, "a, b, c, d, e, f, g" IS a valid
    // identifier header row - which is why only SELF-EVIDENCING payloads (JSON,
    // which proves itself by parsing) are reclassified, and csv is not.
    expect(
      parseSampleContent("<134>Jan  1 12:00:00 host app: a, b, c, d, e, f, g").format,
    ).toBe("syslog");
    expect(
      parseSampleContent(
        "<13>1 2026-08-25T16:35:36.206Z cribl-hw01 app - - - just a human message",
      ).format,
    ).toBe("syslog");
  });
});

describe("unwrapCapture / parseSampleContent format replacement", () => {
  it("REPLACES the wrapper: CEF in _raw wins over the ndjson wrapper", () => {
    const capture =
      '{"_time":1,"_raw":"CEF:0|Sec|tm|1.0|100|worm|10|src=10.0.0.1 dst=2.1.2.2"}\n' +
      '{"_time":2,"_raw":"CEF:0|Sec|tm|1.0|101|worm|10|src=1.1.1.1 dst=2.2.2.2"}';
    const parsed = parseSampleContent(capture, { sourceName: "capture" });

    // Format detected from the INNER content, not the JSON wrapper.
    expect(parsed.format).toBe("cef");
    const fieldNames = parsed.fields.map((f) => f.name);
    expect(fieldNames).toContain("DeviceVendor");
    expect(fieldNames).toContain("src");
    // The wrapper-only field is gone after replacement.
    expect(fieldNames).not.toContain("_time");
  });

  it("SILENTLY falls back to the wrapper when the inner format is unknown", () => {
    const capture =
      '{"_time":1,"_raw":"just words"}\n{"_time":2,"_raw":"more words"}';
    const parsed = parseSampleContent(capture, { sourceName: "capture" });

    // Inner detect -> unknown, so the ndjson wrapper is kept unchanged.
    expect(parsed.format).toBe("ndjson");
    expect(parsed.fields.map((f) => f.name)).toContain("_raw");
  });

  it("leaves a non-capture (no _raw) sample untouched", () => {
    const records = [{ a: 1 }, { a: 2 }];
    expect(unwrapCapture(records, "ndjson")).toEqual({
      records,
      format: "ndjson",
    });
  });
});
