import { describe, expect, it } from "vitest";

import {
  autoDetectLogTypes,
  DISCRIMINATOR_FIELDS,
  HIGH_CONFIDENCE_DISCRIMINATOR_COUNT,
  parseSampleContent,
  selectDiscriminatorField,
} from "./index";

// The legacy codebase had THREE drifted discriminator lists (sample-parser
// auto-detect, sample-resolver DISCRIMINATOR_FIELDS, renderer deploy
// discriminatorFields). These tests pin the reconciled UNION and the single
// high-confidence selection rule.

describe("DISCRIMINATOR_FIELDS reconciliation", () => {
  it("is the union of all three legacy copies (no member dropped)", () => {
    // Members unique to each source must all survive the union.
    expect(DISCRIMINATOR_FIELDS).toContain("event_simpleName"); // A + B
    expect(DISCRIMINATOR_FIELDS).toContain("Type"); // A only
    expect(DISCRIMINATOR_FIELDS).toContain("event_type"); // C only
    expect(DISCRIMINATOR_FIELDS).toContain("module"); // C only
    // Common members present too.
    for (const shared of ["type", "subtype", "DeviceEventClassID", "action"]) {
      expect(DISCRIMINATOR_FIELDS).toContain(shared);
    }
    // No duplicates.
    expect(new Set(DISCRIMINATOR_FIELDS).size).toBe(DISCRIMINATOR_FIELDS.length);
  });

  it("carries RFC 5424's msgid, LAST so the payload still wins", () => {
    // Added 2026-08-21. RFC 5424 defines MSGID to "identify the type of
    // message", so a compliant syslog sender has already answered what this
    // list asks, and Cribl surfaces it without anyone parsing a payload.
    // Without it an RFC 5424 feed reads as undiscriminated while the log type
    // sits in a named field.
    expect(DISCRIMINATOR_FIELDS).toContain("msgid");
    // The ordering is the contract, and it is about ENVELOPE vs PAYLOAD rather
    // than about msgid specifically: selection takes the first qualifying
    // field, so anything the device wrote beats anything a sender or collector
    // wrapped around it. The envelope is what the sender CLAIMS; the payload is
    // what the device wrote.
    //
    // This used to assert msgid was literally last. It is not any more -
    // `data_source` joined the envelope tail on 2026-08-25 - and pinning the
    // last INDEX pinned the wrong thing: it would have failed on any new
    // envelope field while permitting msgid to drift above `type`, which is the
    // move that would actually break behaviour.
    const envelopeFields = ["msgid", "data_source"];
    const payloadFields = ["type", "subtype", "event_simpleName", "category"];
    for (const envelope of envelopeFields) {
      for (const payload of payloadFields) {
        expect(
          DISCRIMINATOR_FIELDS.indexOf(envelope),
          `${envelope} must rank below the payload field ${payload}`,
        ).toBeGreaterThan(DISCRIMINATOR_FIELDS.indexOf(payload));
      }
    }
    // And every envelope field sits in the tail, so none can self-select on a
    // single distinct value.
    for (const envelope of envelopeFields) {
      expect(DISCRIMINATOR_FIELDS.indexOf(envelope)).toBeGreaterThanOrEqual(
        HIGH_CONFIDENCE_DISCRIMINATOR_COUNT,
      );
    }
  });

  it("carries data_source, the Windows channel Cribl's own source emits", () => {
    // Added 2026-08-25 from LIVE Cribl Lake data. Cribl's Windows Event source
    // puts the Windows channel in `data_source`, and for Windows events the
    // channel IS the log type. Measured at dataset scale:
    //   dataset="winevt_plwindows" | summarize count() by data_source
    //     Microsoft-Windows-DNS-Client/Operational   766,570
    //     Security                                    22,792
    // Without it that dataset reported NO log types and the operator was told
    // to capture from a live source instead - for data already in their lake.
    expect(DISCRIMINATOR_FIELDS).toContain("data_source");

    // It SPLITS a two-channel Windows sample, which is the whole point.
    const winEvents = [
      { data_source: "Security", _raw: "<Event ...>" },
      { data_source: "Security", _raw: "<Event ...>" },
      { data_source: "Microsoft-Windows-DNS-Client/Operational", _raw: "{...}" },
    ];
    expect(selectDiscriminatorField(winEvents)).toBe("data_source");

    // But a SINGLE-channel dataset still reports no discriminator rather than
    // claiming the whole dataset is one named type - it is in the low-
    // confidence tail precisely so it needs two distinct values to speak.
    const oneChannel = [
      { data_source: "Security", _raw: "<Event ...>" },
      { data_source: "Security", _raw: "<Event ...>" },
    ];
    expect(selectDiscriminatorField(oneChannel)).toBeUndefined();
  });

  it("does NOT carry the Lake fields that describe the dataset, not the event", () => {
    // `datatype`, `schemaId` and `source` are on every Cribl Lake row and look
    // like obvious discriminators. They are not: each carried exactly ONE
    // distinct value in every dataset sampled live on 2026-08-25, because they
    // describe the DATASET. Adding them to the tail would do nothing (they can
    // never reach two values); adding them to the high-confidence prefix would
    // make every dataset self-report as a single named log type, which is a
    // claim about the data rather than a reading of it.
    for (const datasetLevel of ["datatype", "schemaId", "source"]) {
      expect(DISCRIMINATOR_FIELDS).not.toContain(datasetLevel);
    }
    // A single-valued dataset-level field must not select even when it is the
    // only thing on the record.
    expect(
      selectDiscriminatorField([
        { datatype: "logs", schemaId: "s1" },
        { datatype: "logs", schemaId: "s1" },
      ]),
    ).toBeUndefined();
  });

  it("prefers a payload `type` over the syslog envelope's msgid", () => {
    // Both present and both usable: the one the device wrote wins.
    const records = [
      { msgid: "TRAFFIC", type: "TRAFFIC" },
      { msgid: "THREAT", type: "THREAT" },
    ];
    expect(selectDiscriminatorField(records)).toBe("type");
  });

  it("falls back to msgid when nothing parsed the payload", () => {
    // The RFC 5424 case this entry exists for: the envelope is all there is.
    const records = [
      { msgid: "TRAFFIC", _raw: "<134>1 ... 1,2026/08/13,serial,TRAFFIC,end" },
      { msgid: "AUDIT", _raw: "<134>1 ... 011,2024/04/11,audit,2561,gui-op" },
    ];
    expect(selectDiscriminatorField(records)).toBe("msgid");
  });

  it("keeps the resolver's high-confidence six at the front", () => {
    expect(HIGH_CONFIDENCE_DISCRIMINATOR_COUNT).toBe(6);
    expect(DISCRIMINATOR_FIELDS.slice(0, 6)).toEqual([
      "event_simpleName",
      "type",
      "subtype",
      "DeviceEventClassID",
      "Activity",
      "eventType",
    ]);
  });
});

describe("selectDiscriminatorField", () => {
  it("selects a high-confidence field on a SINGLE distinct value", () => {
    const records = [
      { event_simpleName: "DnsRequest", x: 1 },
      { event_simpleName: "DnsRequest", x: 2 },
    ];
    expect(selectDiscriminatorField(records)).toBe("event_simpleName");
  });

  it("does NOT select a low-confidence field on a single value", () => {
    // 'category' is index >= 6, so one distinct value is not enough.
    const records = [{ category: "web" }, { category: "web" }];
    expect(selectDiscriminatorField(records)).toBeUndefined();
  });

  it("selects a low-confidence field once it has >=2 distinct values", () => {
    const records = [{ logType: "auth" }, { logType: "traffic" }];
    expect(selectDiscriminatorField(records)).toBe("logType");
  });

  it("prefers the earlier field when several qualify", () => {
    const records = [
      { type: "A", action: "allow" },
      { type: "B", action: "deny" },
    ];
    expect(selectDiscriminatorField(records)).toBe("type");
  });
});

describe("autoDetectLogTypes", () => {
  it("splits records by the chosen discriminator", () => {
    const sample = parseSampleContent(
      '{"event_simpleName":"DnsRequest","x":1}\n' +
        '{"event_simpleName":"ProcessRollup2","x":2}\n' +
        '{"event_simpleName":"DnsRequest","x":3}',
    );
    const result = autoDetectLogTypes(sample);
    expect(result.discriminatorField).toBe("event_simpleName");
    const byName = new Map(result.logTypes.map((lt) => [lt.name, lt.eventCount]));
    expect(byName.get("DnsRequest")).toBe(2);
    expect(byName.get("ProcessRollup2")).toBe(1);
  });

  it("sanitizes non-alphanumeric characters in the group name", () => {
    const sample = parseSampleContent(
      '{"event_simpleName":"Some Value!","x":1}\n' +
        '{"event_simpleName":"Other/Type","x":2}',
    );
    const names = autoDetectLogTypes(sample).logTypes.map((lt) => lt.name);
    expect(names).toContain("Some_Value_");
    expect(names).toContain("Other_Type");
  });

  it("returns a single default group when no discriminator qualifies", () => {
    const sample = parseSampleContent('{"foo":"a"}\n{"bar":"b"}');
    const result = autoDetectLogTypes(sample);
    expect(result.discriminatorField).toBeUndefined();
    expect(result.logTypes).toEqual([
      { name: "default", eventCount: 2, discriminator: "", value: "" },
    ]);
  });
});
