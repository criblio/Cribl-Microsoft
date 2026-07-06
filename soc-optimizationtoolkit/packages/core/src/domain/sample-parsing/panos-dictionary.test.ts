import { describe, expect, it } from "vitest";

import {
  PANOS_CANONICAL_INDEX20,
  PANOS_CSV_HEADERS,
  PANOS_LEGACY_PARSER_INDEX20,
  PANOS_LOG_TYPES,
  PANOS_TRAFFIC_LOGSET_INDEX,
  convertPanosToJson,
  isPanosFormat,
  parseCsv,
  parsePanosLine,
} from "./index";

// NEW coverage (Unit 12 named this a coverage gap). The headline test is the
// CONSCIOUS-CHOICE characterization of the three-way PAN-OS dictionary drift.

describe("PAN-OS dictionary drift reconciliation (conscious choice)", () => {
  it("records which value each legacy source held at the drifted index, and the choice", () => {
    // Drift at TRAFFIC/THREAT index 20:
    //   Source A - IS/sample-parser.ts PANOS_TRAFFIC_COLS[20] = 'log_action'
    //     (sample-parser.ts line ~221; ported verbatim into Unit 11 parsers.ts
    //     line 65 as a stopgap, now removed by this unit).
    //   Source B - IS/sample-resolver.ts PANOS_CSV_HEADERS.TRAFFIC[20] = 'logset'
    //     (sample-resolver.ts line 1038).
    // CHOICE: keep 'logset' (Source B). WHY: Source B is the documented PAN-OS
    // 11.0 field order (8 log types, ~130 cols, cites the official Palo Alto
    // syslog field-descriptions page); Source A was a truncated 2-type subset.
    // We adopt B's dictionary wholesale, so the drifted cell follows it.
    expect(PANOS_LEGACY_PARSER_INDEX20).toBe("log_action");
    expect(PANOS_CANONICAL_INDEX20).toBe("logset");

    expect(PANOS_CSV_HEADERS.TRAFFIC[PANOS_TRAFFIC_LOGSET_INDEX]).toBe("logset");
    expect(PANOS_CSV_HEADERS.TRAFFIC[PANOS_TRAFFIC_LOGSET_INDEX]).not.toBe(
      PANOS_LEGACY_PARSER_INDEX20,
    );
    // THREAT drifted at the same index and is reconciled identically.
    expect(PANOS_CSV_HEADERS.THREAT[PANOS_TRAFFIC_LOGSET_INDEX]).toBe("logset");
  });

  it("propagates the canonical 'logset' through the Unit 11 headerless parseCsv", () => {
    // Proves there is now ONE authoritative dictionary: the Unit 11 internal
    // parseCsv consumes the canonical set, so its output flipped from the old
    // 'log_action' to 'logset' at index 20.
    const line =
      "1,2020/05/07 10:00:00,001,TRAFFIC,end,0,2020/05/07,10.0.0.1,10.0.0.2,,,rule1,user1,user2,ssl,vsys1,trust,untrust,eth1,eth2,MyLogProfile";
    const rec = parseCsv(line)[0];
    expect(rec.logset).toBe("MyLogProfile");
    expect(rec).not.toHaveProperty("log_action");
  });
});

describe("canonical PAN-OS dictionaries", () => {
  it("covers exactly the legacy 8 log types", () => {
    expect(Object.keys(PANOS_CSV_HEADERS).sort()).toEqual([
      "AUTHENTICATION",
      "CONFIG",
      "DECRYPTION",
      "GLOBALPROTECT",
      "HIP-MATCH",
      "SYSTEM",
      "THREAT",
      "TRAFFIC",
    ]);
  });

  it("shares the documented first-20 column prefix across TRAFFIC and THREAT", () => {
    expect(PANOS_CSV_HEADERS.TRAFFIC.slice(0, 20)).toEqual(
      PANOS_CSV_HEADERS.THREAT.slice(0, 20),
    );
  });
});

describe("PANOS_LOG_TYPES (deduplicated from two identical legacy copies)", () => {
  it("maps the numeric DeviceEventClassID ids to names", () => {
    // Legacy defined this map twice (sample-resolver.ts:863 and
    // default-samples.ts:724), byte-for-byte identical; there is now ONE.
    expect(PANOS_LOG_TYPES["1"]).toBe("TRAFFIC");
    expect(PANOS_LOG_TYPES["2"]).toBe("THREAT");
    expect(PANOS_LOG_TYPES["256"]).toBe("CORRELATION");
    expect(PANOS_LOG_TYPES["8192"]).toBe("GTP");
    expect(Object.keys(PANOS_LOG_TYPES)).toHaveLength(20);
  });
});

describe("parsePanosLine ('1,' slice fingerprint)", () => {
  it("locates the CSV body via indexOf('1,') and skips future_use positions", () => {
    const line =
      "<14>Nov 30 16:09:08 PA-220 1,2024/01/01 00:00:00,001122,TRAFFIC,end,0,2024/01/01,10.0.0.1";
    const parsed = parsePanosLine(line);
    expect(parsed?.logType).toBe("TRAFFIC");
    expect(parsed?.fields.type).toBe("TRAFFIC");
    expect(parsed?.fields.receive_time).toBe("2024/01/01 00:00:00");
    expect(parsed?.fields.src).toBe("10.0.0.1");
    // future_use1 (value "1") and future_use2 (value "0") are dropped.
    expect(parsed?.fields).not.toHaveProperty("future_use1");
    expect(parsed?.fields).not.toHaveProperty("future_use2");
  });

  it("returns null with no '1,' fingerprint or fewer than 7 fields", () => {
    expect(parsePanosLine("no fingerprint at all")).toBeNull();
    expect(parsePanosLine("1,too,few")).toBeNull();
  });

  it("falls back to generic field_N names for an unknown log type", () => {
    const parsed = parsePanosLine("1,2024/01/01,001,MYSTERY,a,b,c,d");
    expect(parsed?.logType).toBe("MYSTERY");
    expect(parsed?.fields.type).toBe("MYSTERY");
    expect(parsed?.fields.field_0).toBe("1");
    expect(parsed?.fields.field_3).toBe("MYSTERY");
  });
});

describe("isPanosFormat / convertPanosToJson", () => {
  it("recognizes the PAN-OS syslog+CSV positional fingerprint", () => {
    expect(
      isPanosFormat(["1,2024/01/01 00:00:00,001,TRAFFIC,end"]),
    ).toBe(true);
    expect(isPanosFormat(["not a panos line"])).toBe(false);
    expect(isPanosFormat([])).toBe(false);
  });

  it("converts recognized lines and passes unrecognized input through unchanged", () => {
    const converted = convertPanosToJson([
      "1,2024/01/01 00:00:00,001,TRAFFIC,end,0,2024/01/01,10.0.0.1",
    ]);
    expect(converted.logType).toBe("TRAFFIC");
    expect(JSON.parse(converted.events[0]).type).toBe("TRAFFIC");

    const passthrough = convertPanosToJson(["not a panos line"]);
    expect(passthrough.events).toEqual(["not a panos line"]);
    expect(passthrough.logType).toBe("");
  });
});
