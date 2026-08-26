import { describe, expect, it } from "vitest";

import { isHeaderlessCsv } from "./log-type";
import { positionalFieldName } from "./models";
import {
  PANOS_CANONICAL_INDEX20,
  PANOS_CSV_HEADERS,
  PANOS_LEGACY_PARSER_INDEX20,
  PANOS_LOG_TYPES,
  PANOS_TRAFFIC_LOGSET_INDEX,
  convertPanosToJson,
  isPanosFormat,
  panosHeadersFor,
  panosLogTypeFrom,
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
  it("covers the legacy 8 log types plus the 4 cited on 2026-08-25", () => {
    // The legacy eight, plus AUDIT/CORRELATION/IPTAG/USERID transcribed from
    // Palo Alto's published Format lines. AUTH is NOT here and that is a
    // decision - see "declines AUTH" below.
    expect(Object.keys(PANOS_CSV_HEADERS).sort()).toEqual([
      "AUDIT",
      "AUTHENTICATION",
      "CONFIG",
      "CORRELATION",
      "DECRYPTION",
      "GLOBALPROTECT",
      "HIP-MATCH",
      "IPTAG",
      "SYSTEM",
      "THREAT",
      "TRAFFIC",
      "USERID",
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

  it("falls back to THE SHARED positional names for an unknown log type", () => {
    // CHANGED 2026-08-25, deliberately: this used to assert `field_0`/`field_3`.
    // Two modules were independently naming an unnamed column - parseCsv and
    // the PAN-OS branch of parsers.ts said `_0`, parsePanosLine said `field_0` -
    // and `isHeaderlessCsv`, the predicate that decides whether to OFFER the
    // operator the column-naming dialog, only recognised `_N`. So a PAN-OS log
    // type with no recorded column order was positional, needed names, and was
    // invisible to the app's own namer. Six of the thirteen types on the live
    // lab dataset were in that state.
    const parsed = parsePanosLine("1,2024/01/01,001,MYSTERY,a,b,c,d");
    expect(parsed?.logType).toBe("MYSTERY");
    expect(parsed?.fields.type).toBe("MYSTERY");
    expect(parsed?.fields[positionalFieldName(0)]).toBe("1");
    expect(parsed?.fields[positionalFieldName(3)]).toBe("MYSTERY");
    // The old names are GONE, not merely joined by new ones - two conventions
    // is the defect, so recognising both would preserve it.
    expect(parsed?.fields.field_0).toBeUndefined();
  });

  it("is now OFFERED the naming dialog, which is the point of the change", () => {
    // The behaviour the rename exists for. An unknown-type PAN-OS line parses
    // to mostly positional names, and isHeaderlessCsv is what routes a sample
    // to CsvHeaderDialog - so this is the difference between an operator who
    // can name AUDIT/USERID/IPTAG columns and one who cannot.
    const parsed = parsePanosLine("1,2024/01/01,001,MYSTERY,a,b,c,d");
    const fields = Object.keys(parsed?.fields ?? {}).map((name) => ({ name }));
    expect(isHeaderlessCsv(fields)).toBe(true);

    // And a type WITH a recorded column order is not - it already has names,
    // so asking the operator for them would be noise.
    const named = parsePanosLine(
      "1,2024/01/01 00:00:00,001,TRAFFIC,end,1,2024/01/01 00:00:00,10.0.0.1,10.0.0.2",
    );
    const namedFields = Object.keys(named?.fields ?? {}).map((name) => ({ name }));
    expect(isHeaderlessCsv(namedFields)).toBe(false);
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

describe("panosHeadersFor - the vendor's own hyphenation", () => {
  it("resolves HIPMATCH, which is what PAN-OS actually sends", () => {
    // Verified 2026-08-21 against Palo Alto's own fixtures in
    // elastic/integrations: every HIP-Match sample line reads
    // `...,12345678999,HIPMATCH,0,2305,...` and the spelling "HIP-MATCH"
    // appears NOWHERE in the vendor corpus. A plain index therefore missed the
    // one HIP-Match column list this dictionary carries, and every real
    // HIP-Match event parsed to positional field_N names instead.
    expect(panosHeadersFor("HIPMATCH")).toBe(PANOS_CSV_HEADERS["HIP-MATCH"]);
    expect(panosHeadersFor("HIP-MATCH")).toBe(PANOS_CSV_HEADERS["HIP-MATCH"]);
  });

  it("still resolves the plain keys unchanged", () => {
    expect(panosHeadersFor("TRAFFIC")).toBe(PANOS_CSV_HEADERS.TRAFFIC);
    expect(panosHeadersFor("THREAT")).toBe(PANOS_CSV_HEADERS.THREAT);
  });

  it("serves BOTH vendor spellings of the 2026-08-25 additions from one key", () => {
    // The fold is what lets USERID carry one key and answer to both spellings
    // PANOS_LOG_TYPES records (subtype 17 "USER-ID", subtype 4096 "USERID"),
    // and likewise IPTAG for 16 "IP-TAG" and 2048 "IPTAG".
    expect(panosHeadersFor("USER-ID")).toBe(PANOS_CSV_HEADERS.USERID);
    expect(panosHeadersFor("IP-TAG")).toBe(PANOS_CSV_HEADERS.IPTAG);
    // Lower case too - the vendor emits `audit`, not `AUDIT`, in real lines.
    expect(panosHeadersFor("audit")).toBe(PANOS_CSV_HEADERS.AUDIT);
  });

  it("does NOT invent a dictionary the toolkit does not have", () => {
    // The separator fold rescues a SPELLING; it must not manufacture a column
    // list. These types are recognised by isPanosFormat and have no recorded
    // order, so they must still answer undefined rather than reach for a
    // plausible neighbour's.
    expect(panosHeadersFor("WILDFIRE")).toBeUndefined();
    expect(panosHeadersFor("GTP")).toBeUndefined();
    expect(panosHeadersFor("TUNNEL-INSPECTION")).toBeUndefined();
    expect(panosHeadersFor("")).toBeUndefined();
  });

  it("declines AUTH rather than lending it AUTHENTICATION's order", () => {
    // THE DECLINE, PINNED. AUTH is live on the lab dataset and is in the
    // isPanosFormat allow-list, but Palo Alto publishes no AUTH log type and no
    // vendor fixture emits one. Handing it AUTHENTICATION's 46 columns because
    // the name starts the same way is precisely the invention this dictionary
    // refuses: it would silently rename every AUTH column with no evidence
    // that they line up. Undefined is the honest answer, and it is a decision
    // rather than an oversight - which is why it is asserted, not assumed.
    expect(panosHeadersFor("AUTH")).toBeUndefined();
    expect(panosHeadersFor("AUTH")).not.toBe(PANOS_CSV_HEADERS.AUTHENTICATION);
    // AUTHENTICATION itself is unaffected - the decline is about AUTH only.
    expect(panosHeadersFor("AUTHENTICATION")).toBe(
      PANOS_CSV_HEADERS.AUTHENTICATION,
    );
  });
});

describe("parsePanosLine - the AUDIT sub-format", () => {
  // Both lines are verbatim from Palo Alto's own fixtures (via
  // elastic/integrations), not hand-written: audit logs omit the leading
  // FUTURE_USE field, so every column shifts left by one.
  const AUDIT =
    "Apr 11 20:06:15 192.168.0.1 01111111111,2024/04/11 20:06:15,audit,2561,gui-op,suser,\"<show><config-locks/></show>\",success";
  const TRAFFIC =
    "<14>Aug 13 10:49:03 fw01 1,2026/08/13 10:49:02,013201031064,TRAFFIC,end,2817,2026/08/13 10:48:54,10.0.0.5,8.8.8.8";

  it("reads AUDIT, not the content-version number beside it", () => {
    // Read blindly at index 3 this reports "2561", which is not a parse
    // failure anyone notices - it flows on as a plausible discriminator and
    // the operator is invited to name a sample after it.
    expect(parsePanosLine(AUDIT)?.logType).toBe("AUDIT");
    expect(parsePanosLine(AUDIT)?.logType).not.toBe("2561");
  });

  it("still reads an ordinary line from index 3", () => {
    expect(parsePanosLine(TRAFFIC)?.logType).toBe("TRAFFIC");
  });

  it("does not mistake an ordinary line for the shifted shape", () => {
    // The detection is a numeric where a type name belongs. TRAFFIC and THREAT
    // are not numeric, so no normal line can trip it.
    const threat =
      "<14>Aug 13 10:49:04 fw01 1,2026/08/13 10:49:03,013201031064,THREAT,vuln,2818,2026/08/13 10:48:55";
    expect(parsePanosLine(threat)?.logType).toBe("THREAT");
  });
});

// ---------------------------------------------------------------------------
// The four orders added 2026-08-25 (AUDIT, CORRELATION, IPTAG, USERID)
// ---------------------------------------------------------------------------

/**
 * Every line below is Palo Alto's OWN fixture data, from
 * elastic/integrations `packages/panw/data_stream/panos/_dev/test/pipeline/
 * test-panw-panos-{userid,ip-tag,correlated-events,audit}-sample.log` - the same
 * corpus the AUDIT sub-format pins above already cite. The RFC3164 transport
 * prefix each fixture ships behind (`Nov 30 16:09:08 `) is removed, because that
 * is transport rather than vendor data and `stripSyslogPrefix` mis-handles the
 * hostname-less variant these fixtures use; the CSV body is untouched.
 *
 * These lines are a CHECK on the transcription, never its source - the orders
 * come from the vendor's published Format lines (cited per entry in
 * panos-dictionary.ts). What makes them a good check is that Palo Alto's
 * placeholder values spell the field names out at the indices the doc predicts.
 */
const FIXTURE = {
  // 32 fields: the PAN-OS 9.1 width, i.e. the documented 37-column order
  // truncated at `userbysource`. Note `domain\name` is escaped for TS.
  USERID:
    "1,2021/03/24 11:00:49,013101001305,USERID,login,2305,2021/03/24 11:00:49,vsys1,81.2.69.193,domain\\name,,0,1,10800,0,0,<data-source-collected>,<data-source-type>,1252774,0x0,0,0,0,0,,FW01,1,,2021/03/24 11:00:49,1,0x80000000,name",
  // 26 fields; the vendor filled most slots with their own field NAMES.
  IPTAG:
    "1,2019/11/23 00:44:44,01234567890,IPTAG,login,2561,2019/11/23 00:44:44,vsys,81.2.69.142,tag-name,1000,1000,100,Data Source Name, Data Source Type,Data Source Subtype,1000,0x0,0,0,0,0,vsys-name,d-name,vsys-id,1970-01-01T01:00:00.000+01:00",
  // 22 fields - exactly the documented width.
  CORRELATION:
    "1,2019/10/09 10:20:15,001234567890002,CORRELATION,0,2304,2019/10/09 10:20:15,81.2.69.142,src-user,vsys,cat,4,0,0,0,0,vsys-name,d-name,vsys-id,o-name,o-id,evidence",
  // 8 fields, and NO leading FUTURE_USE - the left-shifted sub-format.
  AUDIT:
    '003001000000,2024/04/18 18:35:20,audit,2561,gui-op,Mustang,"<show><config-locks><vsys>all</vsys></config-locks></show>",success',
} as const;

/** Field-shaped view of a parsed record, for {@link isHeaderlessCsv}. */
function fieldsOf(record: Record<string, unknown>): Array<{ name: string }> {
  return Object.keys(record).map((name) => ({ name }));
}

describe("USERID - Palo Alto 'User-ID Log Fields', 37-column Format line", () => {
  it("records the documented width and the load-bearing positions", () => {
    expect(PANOS_CSV_HEADERS.USERID).toHaveLength(37);
    expect(PANOS_CSV_HEADERS.USERID[0]).toBe("future_use1");
    expect(PANOS_CSV_HEADERS.USERID[3]).toBe("type");
    expect(PANOS_CSV_HEADERS.USERID[8]).toBe("ip");
    expect(PANOS_CSV_HEADERS.USERID[9]).toBe("user");
    expect(PANOS_CSV_HEADERS.USERID[16]).toBe("datasource");
    expect(PANOS_CSV_HEADERS.USERID[29]).toBe("factorno");
    expect(PANOS_CSV_HEADERS.USERID[36]).toBe("cluster_name");
  });

  it("THE ADJUDICATED CELL: index 30 is ugflags, not a placeholder", () => {
    // syslog-ng's scl/paloalto/panos.conf inserts two extra future_use columns
    // between factorno and ugflags, which would shift every column from here
    // on. Palo Alto's 9.1, 11.0 and 11.1 pages all disagree with it, and the
    // vendor's own fixture settles it: index 30 carries `0x80000000`, a FLAGS
    // value, exactly where the doc puts User Group Flags. If someone ever
    // "corrects" this against a third-party parser, this is the pin that fires.
    expect(PANOS_CSV_HEADERS.USERID[30]).toBe("ugflags");
    expect(PANOS_CSV_HEADERS.USERID[31]).toBe("userbysource");
    expect(parseCsv(FIXTURE.USERID)[0].ugflags).toBe("0x80000000");
    expect(parseCsv(FIXTURE.USERID)[0].userbysource).toBe("name");
  });

  it("names the vendor's own USERID line instead of numbering it", () => {
    const rec = parseCsv(FIXTURE.USERID)[0];
    expect(rec.type).toBe("USERID");
    expect(rec.subtype).toBe("login");
    expect(rec.ip).toBe("81.2.69.193");
    expect(rec.user).toBe("domain\\name");
    expect(rec.timeout).toBe("10800");
    // The vendor labelled these two slots with their own field names.
    expect(rec.datasource).toBe("<data-source-collected>");
    expect(rec.datasourcetype).toBe("<data-source-type>");
    expect(rec.seqno).toBe("1252774");
    expect(rec.device_name).toBe("FW01");
    expect(rec.factorcompletiontime).toBe("2021/03/24 11:00:49");
    // The line is 32 wide, so the 11.0-only tail is absent rather than guessed.
    expect(rec.cluster_name).toBeUndefined();
    // The positional names are GONE - that is the whole point.
    expect(rec._3).toBeUndefined();
    expect(rec._8).toBeUndefined();
  });

  it("is no longer offered the naming dialog", () => {
    expect(isHeaderlessCsv(fieldsOf(parseCsv(FIXTURE.USERID)[0]))).toBe(false);
  });
});

describe("IPTAG - Palo Alto 'IP-Tag Log Fields', 27-column Format line", () => {
  it("records the documented width and the load-bearing positions", () => {
    expect(PANOS_CSV_HEADERS.IPTAG).toHaveLength(27);
    expect(PANOS_CSV_HEADERS.IPTAG[3]).toBe("type");
    expect(PANOS_CSV_HEADERS.IPTAG[8]).toBe("ip");
    expect(PANOS_CSV_HEADERS.IPTAG[9]).toBe("tag_name");
    expect(PANOS_CSV_HEADERS.IPTAG[15]).toBe("datasourcesubtype");
    expect(PANOS_CSV_HEADERS.IPTAG[26]).toBe("cluster_name");
  });

  it("names the vendor's own IPTAG line, which labels its own columns", () => {
    // The clearest confirmation in the file: Palo Alto's fixture uses the field
    // NAMES as the values, so a correct order reads them back verbatim. A
    // one-position slip here would put "Data Source Type" in datasourcename.
    const rec = parseCsv(FIXTURE.IPTAG)[0];
    expect(rec.type).toBe("IPTAG");
    expect(rec.tag_name).toBe("tag-name");
    expect(rec.datasourcename).toBe("Data Source Name");
    expect(rec.datasourcetype).toBe("Data Source Type");
    expect(rec.datasourcesubtype).toBe("Data Source Subtype");
    expect(rec.vsys_name).toBe("vsys-name");
    expect(rec.device_name).toBe("d-name");
    expect(rec.vsys_id).toBe("vsys-id");
    expect(rec.high_res_timestamp).toBe("1970-01-01T01:00:00.000+01:00");
    expect(rec.actionflags).toBe("0x0");
    expect(rec._3).toBeUndefined();
  });

  it("is no longer offered the naming dialog", () => {
    expect(isHeaderlessCsv(fieldsOf(parseCsv(FIXTURE.IPTAG)[0]))).toBe(false);
  });
});

describe("CORRELATION - Palo Alto 'Correlated Events Log Fields', 22 columns", () => {
  it("records the documented width and the load-bearing positions", () => {
    expect(PANOS_CSV_HEADERS.CORRELATION).toHaveLength(22);
    expect(PANOS_CSV_HEADERS.CORRELATION[3]).toBe("type");
    expect(PANOS_CSV_HEADERS.CORRELATION[19]).toBe("objectname");
    expect(PANOS_CSV_HEADERS.CORRELATION[21]).toBe("evidence");
  });

  it("SPLITS the vendor's 'Source Address. Source User' typo into two columns", () => {
    // Every version of the page prints a PERIOD there where all the other
    // separators are commas. Read as one merged column, everything downstream
    // of index 7 shifts by one. The fixture carries `81.2.69.142,src-user` in
    // those two slots, so they are two fields and the period is a typo.
    expect(PANOS_CSV_HEADERS.CORRELATION[7]).toBe("src");
    expect(PANOS_CSV_HEADERS.CORRELATION[8]).toBe("srcuser");
    const rec = parseCsv(FIXTURE.CORRELATION)[0];
    expect(rec.src).toBe("81.2.69.142");
    expect(rec.srcuser).toBe("src-user");
  });

  it("names the vendor's own CORRELATION line instead of numbering it", () => {
    const rec = parseCsv(FIXTURE.CORRELATION)[0];
    expect(rec.type).toBe("CORRELATION");
    expect(rec.category).toBe("cat");
    expect(rec.severity).toBe("4");
    expect(rec.objectname).toBe("o-name");
    expect(rec.object_id).toBe("o-id");
    expect(rec.evidence).toBe("evidence");
    expect(rec._3).toBeUndefined();
  });

  it("is no longer offered the naming dialog", () => {
    expect(isHeaderlessCsv(fieldsOf(parseCsv(FIXTURE.CORRELATION)[0]))).toBe(
      false,
    );
  });
});

describe("AUDIT - Palo Alto 'Audit Log Fields', 8 columns, no leading FUTURE_USE", () => {
  it("starts at serial, because AUDIT omits the leading placeholder", () => {
    expect(PANOS_CSV_HEADERS.AUDIT).toHaveLength(8);
    expect(PANOS_CSV_HEADERS.AUDIT[0]).toBe("serial");
    expect(PANOS_CSV_HEADERS.AUDIT[0]).not.toBe("future_use1");
    expect(PANOS_CSV_HEADERS.AUDIT[2]).toBe("subtype");
    // The placeholder is at 3 here, not 0 - the whole left-shift in one cell.
    expect(PANOS_CSV_HEADERS.AUDIT[3]).toBe("future_use1");
    expect(PANOS_CSV_HEADERS.AUDIT[6]).toBe("cmd");
    expect(PANOS_CSV_HEADERS.AUDIT[7]).toBe("severity");
  });

  it("names the vendor's own AUDIT line instead of numbering it", () => {
    const rec = parseCsv(FIXTURE.AUDIT)[0];
    expect(rec.serial).toBe("003001000000");
    expect(rec.generated_time).toBe("2024/04/18 18:35:20");
    expect(rec.subtype).toBe("audit");
    // Both tail slots match the vendor's documented enumerations: Event ID is
    // the command's SOURCE (cli/gui/gui-op/gnmi/rest), Severity its OUTCOME
    // (none/success/failure). That is what makes this 8-wide order credible.
    expect(rec.eventid).toBe("gui-op");
    expect(rec.object).toBe("Mustang");
    expect(rec.cmd).toBe(
      "<show><config-locks><vsys>all</vsys></config-locks></show>",
    );
    expect(rec.severity).toBe("success");
    // The placeholder is dropped, and no positional names survive.
    expect(rec).not.toHaveProperty("future_use1");
    expect(rec._2).toBeUndefined();
  });

  it("reaches its order only because parseCsv reads the type by SHAPE", () => {
    // parseCsv read `values[3]` until 2026-08-25, which on an audit line is the
    // content-version number 2561. The order below would have been dead code on
    // the live path without that change, so this pins the joint rather than
    // trusting it.
    expect(panosLogTypeFrom(FIXTURE.AUDIT.split(","))).toBe("AUDIT");
    expect(panosLogTypeFrom(FIXTURE.AUDIT.split(","))).not.toBe("2561");
  });

  it("is no longer offered the naming dialog", () => {
    expect(isHeaderlessCsv(fieldsOf(parseCsv(FIXTURE.AUDIT)[0]))).toBe(false);
  });

  it("KNOWN LIMITATION: parsePanosLine's '1,' slice still mangles AUDIT", () => {
    // Naming AUDIT's columns makes a PRE-EXISTING parser fragility visible, so
    // it is pinned rather than left to surprise someone. `parsePanosLine` finds
    // the CSV body with indexOf('1,'), which for every other log type lands on
    // future_use1 - a column the dictionary discards anyway. AUDIT has no
    // leading placeholder, so index 0 is the SERIAL and the slice eats it:
    //   serial 01111111111 -> the slice lands on its last '1', serial reads "1"
    //   serial 003001000000 -> no '1,' until "2561,", so too few fields survive
    // parseCsv is the live path (it uses stripSyslogPrefix and is correct on
    // both), which is why this is recorded, not repaired, here.
    const luckySerial =
      'Apr 11 20:06:15 192.168.0.1 01111111111,2024/04/11 20:06:15,audit,2561,gui-op,suser,"<show><config-locks/></show>",success';
    const parsed = parsePanosLine(luckySerial);
    expect(parsed?.logType).toBe("AUDIT");
    expect(parsed?.fields.serial).toBe("1");
    expect(parsed?.fields.serial).not.toBe("01111111111");
    // The unlucky serial does not parse at all through this entry point.
    expect(parsePanosLine(`Apr 18 18:35:20 10.1.1.1 ${FIXTURE.AUDIT}`)).toBeNull();
    // ...while parseCsv keeps the serial whole.
    expect(parseCsv(FIXTURE.AUDIT)[0].serial).toBe("003001000000");
  });
});

describe("AUTH - DECLINED, and pinned so the decision stays visible", () => {
  // No order was added for AUTH. Palo Alto publishes 17 syslog log-type pages
  // and none is AUTH, no vendor fixture emits one, and the repo holds nothing.
  // The only ways to produce an order would be to infer one from live sample
  // values or to borrow AUTHENTICATION's - both are inventions, and a wrong
  // order mislabels every column after the first mistake. So AUTH still parses
  // POSITIONALLY, which is honest, and the dialog can still offer an operator
  // the chance to supply the real thing.
  //
  // This line is deliberately synthetic: the absence of any real AUTH artifact
  // is the reason for the decline, so there is none to quote.
  const AUTH =
    "1,2026/08/13 10:49:02,013201031064,AUTH,0,2817,2026/08/13 10:48:54,vsys1,authuser";

  it("still parses positionally rather than borrowing a plausible order", () => {
    const rec = parseCsv(AUTH)[0];
    expect(rec._3).toBe("AUTH");
    expect(rec.type).toBeUndefined();
    expect(PANOS_CSV_HEADERS.AUTH).toBeUndefined();
  });

  it("is still OFFERED the naming dialog, which is the fallback that matters", () => {
    // The decline costs the operator nothing they cannot fix: an undictionaried
    // type is exactly the case isHeaderlessCsv routes to the naming dialog, and
    // an operator-supplied order is new knowledge rather than an override.
    expect(isHeaderlessCsv(fieldsOf(parseCsv(AUTH)[0]))).toBe(true);
  });
});
