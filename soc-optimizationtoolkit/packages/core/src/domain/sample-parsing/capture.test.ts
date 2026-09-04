import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { SampleFormat } from "./index";
import {
  detectCaptureInnerFormat,
  looksPositional,
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

describe("positional is the LAST branch before unknown (DBT-108)", () => {
  // A Cribl capture of a positional log unwrapped to the ENVELOPE, not the
  // events: this detector had no positional branch, returned "unknown", and
  // unwrapCapture declined. See format-detection.ts for the full note.
  //
  // THE ORDERING IS THE WHOLE RISK. Positional has no fingerprint, only a
  // consistent column count, and syslog / CEF / LEEF / kv lines are all
  // whitespace-separated too. So the ladder below pins each of them against an
  // inner line that IS consistently whitespace-columned - deliberately the
  // hardest case - and asserts BOTH that the format is unchanged AND that
  // looksPositional would have claimed it. The second assertion is what stops
  // this suite passing vacuously: without it, a later edit shortening a fixture
  // to two tokens would defang the guard silently, because a two-token line
  // cannot reach the positional branch either way.

  const TEMPTING: ReadonlyArray<
    readonly [string, SampleFormat, readonly string[]]
  > = [
    [
      "kv",
      "kv",
      [
        "src=10.0.0.1 dst=10.0.0.2 act=allow proto=tcp",
        "src=10.0.0.3 dst=10.0.0.4 act=deny proto=udp",
      ],
    ],
    [
      "syslog with a priority",
      "syslog",
      [
        "<34>Oct 11 22:14:15 mymachine su: failed for lonvick",
        "<34>Oct 11 22:14:16 mymachine su: failed for jsmith",
      ],
    ],
    [
      "RFC 3164 syslog with no priority",
      "syslog",
      [
        "Oct 11 22:14:15 mymachine su: failed for lonvick",
        "Oct 11 22:14:16 mymachine su: failed for jsmith",
      ],
    ],
    [
      "JSON pretty enough to have spaces in it",
      "ndjson",
      [
        '{"src": "10.0.0.1", "dst": "10.0.0.2", "act": "allow", "n": 1}',
        '{"src": "10.0.0.3", "dst": "10.0.0.4", "act": "deny", "n": 2}',
      ],
    ],
    [
      "syslog-wrapped PAN-OS CSV",
      "csv",
      [
        "<14>May  7 10:00:00 host-fw 1,2020/05/07 10:00:00,001,TRAFFIC,end,a,b",
        "<14>May  7 10:00:01 host-fw 1,2020/05/07 10:00:01,001,TRAFFIC,end,c,d",
      ],
    ],
  ];

  it.each(TEMPTING)(
    "does NOT steal %s, even though it looks positional",
    (_label, expected, lines) => {
      // Reachability first: if this ever goes false the case below is vacuous.
      expect(looksPositional(lines)).toBe(true);
      expect(detectCaptureInnerFormat([...lines])).toBe(expected);
    },
  );

  it("still claims CEF, LEEF and plain CSV, which never reach the branch", () => {
    // These three are NOT whitespace-columned, so they are the control group:
    // they prove the ladder above the branch is untouched, not that the branch
    // loses a race. Asserted separately from TEMPTING for exactly that reason.
    const cef = [
      "CEF:0|Sec|tm|1.0|100|worm stopped|10|src=10.0.0.1 dst=2.1.2.2",
      "CEF:0|Sec|tm|1.0|101|worm stopped|10|src=1.1.1.1 dst=2.2.2.2",
    ];
    const leef = [
      "LEEF:1.0|Vendor|Product|1.0|EventID|src=10.0.0.1 dst=2.1.2.2",
      "LEEF:1.0|Vendor|Product|1.0|EventID|src=1.1.1.1 dst=2.2.2.2",
    ];
    const csv = ["1,2,3,4,5,6", "7,8,9,10,11,12"];
    for (const lines of [cef, leef, csv]) {
      expect(looksPositional(lines)).toBe(false);
    }
    expect(detectCaptureInnerFormat(cef)).toBe("cef");
    expect(detectCaptureInnerFormat(leef)).toBe("leef");
    expect(detectCaptureInnerFormat(csv)).toBe("csv");
  });

  it("claims a positional log once nothing more specific matches", () => {
    expect(
      detectCaptureInnerFormat([
        "2 123456789012 eni-abc123 10.0.1.4 10.0.2.7 443 51234 6 12 3400 1600000000 1600000060 ACCEPT OK",
        "2 123456789012 eni-abc123 10.0.1.9 10.0.2.9 22 51235 6 4 800 1600000000 1600000060 REJECT OK",
      ]),
    ).toBe("positional");
  });

  it("keeps looksPositional's two floors: one row, and fewer than four columns", () => {
    // Both floors live in positional.ts and are imported, not re-expressed, so
    // "is this positional" has ONE definition. These pin that this detector
    // inherits them rather than having relaxed them on the way in.
    const oneRow = [
      "2 123456789012 eni-abc123 10.0.1.4 10.0.2.7 443 51234 6 12 3400 1600000000 1600000060 ACCEPT OK",
    ];
    expect(looksPositional(oneRow)).toBe(false);
    expect(detectCaptureInnerFormat(oneRow)).toBe("unknown");

    const threeColumns = ["just some words", "more opaque text"];
    expect(detectCaptureInnerFormat(threeColumns)).toBe("unknown");
  });
});

describe("the reported capture: AWS VPC Flow Logs over S3 (DBT-108 regression)", () => {
  // THE OPERATOR'S OWN FILE, vendored, and the regression pin for this card.
  // 100 events from a live Cribl capture of an S3 VPC Flow Logs feed.
  //
  // REDACTED IN TWO PLACES AND NOWHERE ELSE: the S3 bucket name and the AWS
  // account id (which appears both in the object path and as positional column
  // 1) were replaced with `example-flowlogs-bucket` and `123456789012`, because
  // this repository is public and those two identify a customer. Everything
  // else is the operator's bytes - the envelope field set and its order, the
  // `__isBroken` flag, the ENI ids, the addresses, the ports, the epochs, and
  // the all-dash NODATA rows that taught isVpcFlowV2 to accept `-`.
  //
  // The redaction is measurement-neutral and that was checked rather than
  // assumed: format, event count, field names, errors, raw-event count, inner
  // format, isVpcFlowV2 and the single distinct column width of 14 are
  // identical on the original and on this copy.

  const CAPTURE = readFileSync(
    new URL("./__fixtures__/vpc-flow-capture.json", import.meta.url),
    "utf8",
  );

  const ENVELOPE_FIELDS = [
    "__criblEventType",
    "__ctrlFields",
    "__final",
    "__cloneCount",
    "_raw",
    "__channel",
    "source",
    "__source",
    "__isBroken",
    "__raw",
    "_time",
    "cribl_breaker",
    "__inputId",
  ];

  it("unwraps to the VPC columns, not the Cribl envelope", () => {
    const parsed = parseSampleContent(CAPTURE, {
      sourceName: "vpc_flows.json",
    });

    expect(parsed.format).toBe("positional");
    expect(parsed.eventCount).toBe(100);

    // THE DISCRIMINATING ASSERTION, and it has to be the NAMES. A count alone
    // passes with the envelope: the broken parse also yielded 100 events, and
    // 13 fields is not obviously wrong next to 14.
    const names = parsed.fields.map((f) => f.name);
    expect(names).toEqual([
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

    // The three an operator actually maps to a DCR column, named individually
    // so a failure says which one went missing.
    expect(names).toContain("srcaddr");
    expect(names).toContain("dstaddr");
    expect(names).toContain("account_id");

    // And the envelope must be GONE - every one of the 13 names the defect
    // showed instead. This is the half that fails if the unwrap stops running.
    for (const envelope of ENVELOPE_FIELDS) {
      expect(names).not.toContain(envelope);
    }
  });

  it("stores the vendor's own line as the raw event, not the wrapper JSON", () => {
    const parsed = parseSampleContent(CAPTURE, {
      sourceName: "vpc_flows.json",
    });
    expect(parsed.rawEvents).toHaveLength(100);
    // Before the fix this was the whole envelope object re-serialized, which is
    // what a generated pack would have been previewed against.
    expect(parsed.rawEvents[0]).not.toContain("__criblEventType");
    expect(parsed.rawEvents[0]?.split(/\s+/)).toHaveLength(14);
    expect(parsed.errors).toEqual([]);
  });

  it("reaches the app's OWN capture path too (capture-samples.ts)", () => {
    // capture-samples.ts calls detectCaptureInnerFormat on the ALREADY-EXTRACTED
    // `_raw` values - a different shape from the wrapped upload above, and the
    // route the product steers operators to, so the larger blast radius. This
    // pins that one fix serves both call sites.
    const rawEvents = CAPTURE.split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => String((JSON.parse(l) as { _raw?: unknown })._raw ?? ""));
    expect(rawEvents).toHaveLength(100);
    expect(detectCaptureInnerFormat(rawEvents)).toBe("positional");
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
