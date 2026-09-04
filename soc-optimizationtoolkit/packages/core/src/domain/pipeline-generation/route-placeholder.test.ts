// Pins for HON-5: a COLUMN-ORDER vendor is told BEFORE the preview that their
// pack can never route automatically.
//
// The distinction these protect is the whole point. A placeholder filter has
// two very different causes, and the generic message is right for one of them
// and actively misleading for the other: told "no discriminator found", such an
// operator goes and collects more samples, which cannot possibly help, because
// both discriminators return null for these formats by construction.
//
// "CSV" WAS ONLY HALF THE SET UNTIL 2026-09-03. `formatCanDiscriminate` tested
// `format !== "csv"`, so `positional` - whitespace columns, AWS VPC Flow and
// friends, taught to the parser and the pipeline by GEN-6 - answered TRUE and
// got a filter over names that exist only after the pipeline extracts. The
// route ran first, so every disjunct was false; and because a filter had been
// produced the log type was neither a placeholder nor "unreachable", so the
// pack previewed clean and HON-5's own warning stayed silent, telling nobody.
//
// AND STILL ONLY HALF OF IT UNTIL GEN-8 (2026-09-04). Three more formats mint
// the names their filters were being built from, and each needed a different
// answer, which is why widening the one set would have been wrong:
//   syslog     WHOLE format, regex captures. Measured through the real chain,
//              a two-log-type plan (sshd vs CRON) got `Program === 'sshd' ||
//              _raw.indexOf('Program=sshd')`, matching 0 of its 2 own events at
//              route time. Its cause is not a column, so it gets its own words.
//   cef, leef  PER FIELD. The pipe-delimited HEADER names are minted; the
//              extension pairs are genuinely in the text, so these formats stay
//              routable. Measured: AUTH vs TRAFFIC on one extension schema got
//              `DeviceEventClassID === 'AUTH'` (0 of 2), while the same corpus
//              differing on `act` got `act === 'Allowed'` (2 of 2).
//   json       the string an UNDETECTED sample actually becomes, and the gap
//              GEN-8 leaves open. This line said "unknown" until 2026-09-04,
//              which is a name the product never delivers here:
//              normalizeSourceFormat erases "unknown" to "json" before the plan
//              input is built, so the planner and both discriminators only ever
//              see "json". Measured with planFormat "json" - CEF content got
//              `DeviceEventClassID === 'AUTH'` (0 of 2 own events), RFC 3164
//              syslog got `Program === 'sshd'` (0 of 2), headerless PAN-OS CSV
//              got `_2 === 'TRAFFIC'` (0 of 2), each a FILTER, so each pack
//              previewed clean. Calibrated on the same harness: JSON content
//              whose names really are in the text matched 2 of 2.

import { describe, expect, it } from "vitest";
import {
  csvRoutingWarning,
  formatCanDiscriminate,
  isMintedHeaderField,
  isPlaceholderFilter,
  placeholderRouteFilter,
} from "./route-placeholder";
import { deriveRouteDiscriminator } from "./route-discriminator";
import {
  deriveValueDiscriminator,
  fieldValuesFromRecords,
} from "./route-value-discriminator";
// Reached across domains ON PURPOSE - see the parser-agreement pins below.
import { parseByFormat } from "../sample-parsing/parsers";

describe("formatCanDiscriminate", () => {
  it("says the formats with NO usable names cannot, and the rest can", () => {
    expect(formatCanDiscriminate("csv")).toBe(false);
    expect(formatCanDiscriminate("CSV")).toBe(false);
    // The half that was missing. A positional event carries values in column
    // order exactly as a CSV row does; only the separator differs.
    expect(formatCanDiscriminate("positional")).toBe(false);
    expect(formatCanDiscriminate("POSITIONAL")).toBe(false);
    // cef and leef stay TRUE and that is the whole point of GEN-8's shape:
    // their extension pairs are in the raw text, so those packs route. Only
    // their header NAMES are unusable, which isMintedHeaderField answers.
    for (const f of ["cef", "json", "ndjson", "leef", "kv"]) {
      expect(formatCanDiscriminate(f), f).toBe(true);
    }
  });

  /**
   * `syslog` IS FALSE AS OF GEN-8, and the reason is its own, not CSV's.
   *
   * Every name parseSyslog produces is minted by a REGEX CAPTURE and is absent
   * from the line (Timestamp, Hostname, Program, PID, Message; RFC 5424 adds
   * Priority, Version, AppName, ProcID, MsgID). Measured through the real chain
   * on 2026-09-04: a two-log-type syslog plan (sshd vs CRON) had the value path
   * choose `Program === 'sshd' || _raw.indexOf('Program=sshd') !== -1`, which
   * matched 0 of that log type's 2 OWN events when evaluated against an
   * unparsed route-time event. The one key parseSyslog copies verbatim, `_raw`,
   * separates nothing either: every syslog log type in the pack carries it.
   *
   * A SECOND SHAPE, also measured: with one event per log type and the log type
   * tagged from the text of the message, the value path chose
   * `Message === 'Failed password for root'` - a whole message string, so
   * over-fitted to one event as well as untestable at route time. `_raw` was
   * not what it picked; `Message` outranks it on the field-name tiebreak.
   */
  it("covers syslog, whose names are minted by a regex capture", () => {
    expect(formatCanDiscriminate("syslog")).toBe(false);
    expect(formatCanDiscriminate("SYSLOG")).toBe(false);
  });

  it("AGREES with the two discriminators it is describing", () => {
    // This predicate is a claim ABOUT other code. If either discriminator ever
    // learns to handle a column-order format, or another format starts
    // returning null, the warning becomes a lie - and nothing else would notice.
    //
    // THE VALUE FIXTURE HAS TO QUALIFY ON EVERY OTHER GUARD or this assertion
    // is theatre, and the one that stood here until 2026-09-03 did not.
    // It was `{ a: ["1"] }` for log type TRAFFIC against a sibling carrying
    // only `b`, and "1" does not NAME TRAFFIC - so it dies on guard 0, before
    // the format ever matters. Measured: that fixture returns null on "cef"
    // too, so the format gate cannot have been what produced its null and the
    // assertion would have survived deleting the gate outright.
    // `a: ["TRAFFIC"]` against a sibling `a: ["THREAT"]` names its log type, is
    // constant, and is column-shaped, so it yields a filter on "cef" (asserted
    // below) and the format gate is the only thing left that can null it.
    const own = { logType: "TRAFFIC", eventCount: 1, values: { a: ["TRAFFIC"] } };
    const sibs = [
      { logType: "THREAT", eventCount: 1, values: { a: ["THREAT"] } },
    ];
    for (const format of ["csv", "positional", "syslog"]) {
      expect(
        deriveRouteDiscriminator(["a"], [new Set(["b"])], format),
        format,
      ).toBeNull();
      expect(deriveValueDiscriminator(own, sibs, format), format).toBeNull();
    }
    // And the controls, which are what make the assertions above mean
    // something: the SAME inputs on a routable format really do produce a
    // filter, so the nulls are about the format and not about the fixtures.
    expect(
      deriveRouteDiscriminator(["unique_field"], [new Set(["other"])], "cef"),
    ).not.toBeNull();
    expect(deriveValueDiscriminator(own, sibs, "cef")).toContain(
      "a === 'TRAFFIC'",
    );
  });
});

/**
 * GEN-8's PER-FIELD half. cef and leef are routable formats that carry a
 * handful of unroutable NAMES, so the answer had to be per field rather than a
 * third entry in the format set - excluding the formats outright would delete
 * routing that demonstrably works (`act=Allowed` is in the raw text).
 *
 * The lists are exactly what parseCef and parseLeef assign before their
 * extension loops, read out of sample-parsing/parsers.ts and confirmed by
 * parsing real lines on 2026-09-04:
 *   CEF   CEFVersion, DeviceVendor, DeviceProduct, DeviceVersion,
 *         DeviceEventClassID, Name, Severity (+ _syslogHeader when the line has
 *         a syslog prefix)
 *   LEEF  LEEFVersion, DeviceVendor, DeviceProduct, DeviceVersion, EventID
 */
describe("isMintedHeaderField", () => {
  const CEF_HEADERS = [
    "CEFVersion",
    "DeviceVendor",
    "DeviceProduct",
    "DeviceVersion",
    "DeviceEventClassID",
    "Name",
    "Severity",
    "_syslogHeader",
  ];
  const LEEF_HEADERS = [
    "LEEFVersion",
    "DeviceVendor",
    "DeviceProduct",
    "DeviceVersion",
    "EventID",
  ];

  it("names all EIGHT CEF header fields and no extension field", () => {
    for (const f of CEF_HEADERS) {
      expect(isMintedHeaderField(f, "cef"), f).toBe(true);
    }
    // Real CEF extension keys, which ARE in the raw text as `name=value`.
    for (const f of ["act", "src", "dst", "suser", "requestClientApplication"]) {
      expect(isMintedHeaderField(f, "cef"), f).toBe(false);
    }
  });

  it("names all FIVE LEEF header fields, and _syslogHeader is NOT one", () => {
    for (const f of LEEF_HEADERS) {
      expect(isMintedHeaderField(f, "leef"), f).toBe(true);
    }
    // parseLeef assigns no syslog prefix key, so listing one here would be an
    // exclusion for a field LEEF never produces - and would silently cost a
    // vendor who really does send `_syslogHeader=` as a tab-delimited pair.
    expect(isMintedHeaderField("_syslogHeader", "leef")).toBe(false);
    // CEF-only headers are not LEEF headers.
    expect(isMintedHeaderField("CEFVersion", "leef")).toBe(false);
    expect(isMintedHeaderField("DeviceEventClassID", "leef")).toBe(false);
    // ...and LEEF-only ones are not CEF headers.
    expect(isMintedHeaderField("LEEFVersion", "cef")).toBe(false);
    expect(isMintedHeaderField("EventID", "cef")).toBe(false);
  });

  it("matches case-insensitively, because mappings need not keep the parser's", () => {
    expect(isMintedHeaderField("deviceeventclassid", "cef")).toBe(true);
    expect(isMintedHeaderField("DEVICEEVENTCLASSID", "CEF")).toBe(true);
    expect(isMintedHeaderField("eventid", "LEEF")).toBe(true);
  });

  it("says nothing about a format that has no header, whole or routable", () => {
    // It answers ONE question - "did this format's header mint this name" - and
    // the whole-format formats are answered by formatCanDiscriminate instead.
    // A predicate that returned true for `Timestamp` on syslog would be making
    // a claim about a header syslog does not have.
    for (const format of ["json", "ndjson", "kv", "csv", "positional", "syslog", "unknown"]) {
      for (const field of ["Name", "Severity", "Timestamp", "EventID", "act"]) {
        expect(isMintedHeaderField(field, format), `${format}/${field}`).toBe(
          false,
        );
      }
    }
  });

  /**
   * THE LIST IS A COPY OF A DECISION MADE IN ANOTHER MODULE, so it is pinned
   * against that module rather than against itself.
   *
   * `MINTED_HEADER_FIELDS` was read out of parseCef and parseLeef. Nothing else
   * would notice if those parsers grew an eighth CEF header or renamed one: the
   * new name would sail through the exclusion, win the length-first sort, and
   * produce a route filter that is false for every event - which is GEN-8
   * exactly, re-entering by the door it came out of. These two ask the parser.
   */
  it("stays in step with parseCef, which is where the CEF list came from", () => {
    // A CEF line with a syslog prefix and an EMPTY extension: every key the
    // parser produces here is a header, so every one must be excluded.
    const headerOnly = parseByFormat(
      "Oct 11 22:14:15 relay1 CEF:0|V|P|1.0|100|Name|3|",
      "cef",
    );
    expect(headerOnly).toHaveLength(1);
    const keys = Object.keys(headerOnly[0]);
    expect(keys).toHaveLength(8);
    for (const k of keys) {
      expect(isMintedHeaderField(k, "cef"), k).toBe(true);
    }

    // ...and with extension pairs, the ONLY names that survive the exclusion
    // are those pairs - the half that really is in the raw text.
    const withExt = parseByFormat(
      "CEF:0|V|P|1.0|100|Name|3|act=Allowed src=1.1.1.1",
      "cef",
    );
    expect(
      Object.keys(withExt[0]).filter((k) => !isMintedHeaderField(k, "cef")),
    ).toEqual(["act", "src"]);
  });

  it("stays in step with parseLeef, whose header list is a different one", () => {
    const headerOnly = parseByFormat("LEEF:1.0|V|P|1.0|100|", "leef");
    expect(headerOnly).toHaveLength(1);
    const keys = Object.keys(headerOnly[0]);
    expect(keys).toHaveLength(5);
    for (const k of keys) {
      expect(isMintedHeaderField(k, "leef"), k).toBe(true);
    }

    const withExt = parseByFormat(
      "LEEF:1.0|V|P|1.0|100|evtType=AUTH\tsrc=1.1.1.1",
      "leef",
    );
    expect(
      Object.keys(withExt[0]).filter((k) => !isMintedHeaderField(k, "leef")),
    ).toEqual(["evtType", "src"]);
  });

  /**
   * THE GAP IS KEYED ON "json", and this test was titled "unknown" until
   * 2026-09-04 - a string that never reaches this function.
   * `normalizeSourceFormat` (pipeline-preview-state.ts) erases "unknown", "" and
   * undefined to "json" before `reportToPlanInput` builds the plan, so the
   * planner and both discriminators only ever see "json". "unknown" reaches
   * exactly one caller on this surface: csvRoutingWarning, called from the
   * samples screen with the DETECTED format.
   *
   * So the pin, the module doc and GEN-8's card all named a string the product
   * does not deliver here, and a fix aimed at "unknown" would have changed
   * nothing an operator could see.
   *
   * Keying the exclusion on "json" instead was rejected and stays rejected: a
   * JSON document carrying `Name`, `Severity` or `Timestamp` in its text is
   * ordinary, and excluding those names would delete real routing from every
   * genuine JSON pack in order to rescue the undetected ones. The fix is to key
   * on the parser that actually RAN.
   */
  it("does not fire on 'json', which is what an undetected sample becomes", () => {
    expect(isMintedHeaderField("DeviceEventClassID", "json")).toBe(false);
    expect(isMintedHeaderField("Name", "json")).toBe(false);
    expect(isMintedHeaderField("Timestamp", "json")).toBe(false);
    // "unknown" is answered the same way and for the same reason. It is kept
    // because csvRoutingWarning really is handed it - but it is NOT the string
    // that carries the gap, because it never gets as far as this predicate.
    expect(isMintedHeaderField("DeviceEventClassID", "unknown")).toBe(false);
    expect(isMintedHeaderField("Name", "unknown")).toBe(false);
  });

  /**
   * ...AND THE GAP ITSELF, MEASURED rather than described.
   *
   * The prose above and in route-placeholder.ts quotes three filters and three
   * zeros. Prose rots; this runs the chain an undetected sample really takes -
   * parseByFormat's try-each fallback over the CONTENT, fieldValuesFromRecords,
   * the value path at planFormat "json" - and evaluates the emitted filter
   * against an unparsed route-time event carrying only `_raw`.
   *
   * THIS PINS A DEFECT, deliberately and loudly. Every case below produces a
   * FILTER, so the log type counts as neither a placeholder nor unreachable and
   * the pack previews CLEAN while matching none of its own events. When GEN-8's
   * remaining half lands, these expectations SHOULD fail - that is the point:
   * whoever fixes it has to come here and correct the numbers the docs quote,
   * rather than leaving three stale measurements behind.
   *
   * THE CALIBRATION CASE IS NOT OPTIONAL. A zero from a harness that cannot
   * return true is indistinguishable from a zero from a blind one, so the last
   * case feeds content whose names really ARE in the text and requires 2 of 2.
   */
  it("MEASURES the json gap, and calibrates the harness that measures it", () => {
    // A route-time event: `_raw` is the whole line and EVERY other name is
    // undefined, which is the fact the whole module turns on. The proxy is what
    // makes an unmentioned name resolve to undefined instead of throwing, so a
    // filter naming a minted field evaluates to false rather than blowing up -
    // the same thing Cribl does with an absent field.
    const routeTime = (filter: string, raw: string): boolean =>
      Boolean(
        new Function(
          "_raw",
          `with (new Proxy({ _raw }, { has: () => true, get: (t, k) => (k === "_raw" ? t._raw : undefined) })) { return (${filter}); }`,
        )(raw),
      );

    const run = (
      lines: Readonly<Record<string, string[]>>,
    ): Record<string, { filter: string | null; own: number }> => {
      const evidence = Object.entries(lines).map(([name, ls]) => ({
        name,
        ls,
        // "unknown" is the DETECTED format - the try-each fallback picks the
        // parser from the content, exactly as the samples screen does.
        ev: fieldValuesFromRecords(name, parseByFormat(ls.join("\n"), "unknown")),
      }));
      const out: Record<string, { filter: string | null; own: number }> = {};
      for (const { name, ls, ev } of evidence) {
        const sibs = evidence.filter((e) => e.name !== name).map((e) => e.ev);
        // planFormat "json", because that is what normalizeSourceFormat hands
        // the planner for a sample whose format was never detected.
        const filter = deriveValueDiscriminator(ev, sibs, "json");
        out[name] = {
          filter,
          own:
            filter === null
              ? 0
              : ls.filter((l) => routeTime(filter, l)).length,
        };
      }
      return out;
    };

    const cef = run({
      AUTH: [
        "CEF:0|Vend|Prod|1.0|AUTH|Auth event|3|act=Allowed src=1.1.1.1",
        "CEF:0|Vend|Prod|1.0|AUTH|Auth event|3|act=Allowed src=1.1.1.5",
      ],
      TRAFFIC: [
        "CEF:0|Vend|Prod|1.0|TRAFFIC|Traffic event|3|act=Blocked src=1.1.1.3",
        "CEF:0|Vend|Prod|1.0|TRAFFIC|Traffic event|3|act=Blocked src=1.1.1.7",
      ],
    });
    expect(cef["AUTH"].filter).toBe("DeviceEventClassID === 'AUTH'");
    expect(cef["AUTH"].own).toBe(0);

    const syslog = run({
      sshd: [
        "Oct 11 22:14:15 host1 sshd[1234]: Failed password for root",
        "Oct 11 22:14:20 host1 sshd[1235]: Failed password for admin",
      ],
      CRON: [
        "Oct 11 22:15:01 host1 CRON[2001]: (root) CMD (run-parts)",
        "Oct 11 22:16:01 host1 CRON[2002]: (root) CMD (run-parts)",
      ],
    });
    expect(syslog["sshd"].filter).toBe("Program === 'sshd'");
    expect(syslog["sshd"].own).toBe(0);

    const csv = run({
      TRAFFIC: [
        "2026/09/04 10:00:00,001801000000,TRAFFIC,start,2026/09/04 10:00:01,10.0.0.1",
        "2026/09/04 10:00:02,001801000000,TRAFFIC,start,2026/09/04 10:00:03,10.0.0.2",
      ],
      THREAT: [
        "2026/09/04 11:00:00,001801000000,THREAT,vulnerability,2026/09/04 11:00:01,10.0.0.9",
        "2026/09/04 11:00:02,001801000000,THREAT,vulnerability,2026/09/04 11:00:03,10.0.0.8",
      ],
    });
    expect(csv["TRAFFIC"].filter).toBe("_2 === 'TRAFFIC'");
    expect(csv["TRAFFIC"].own).toBe(0);

    // A BARE FIELD TEST, with no `_raw` disjunct at all - worse than the dead
    // second term the other formats at least emit. deriveValueDiscriminator
    // suppresses the raw fallback for json and ndjson, because a bare value
    // token would match anywhere in a JSON document.
    for (const c of [cef["AUTH"], syslog["sshd"], csv["TRAFFIC"]]) {
      expect(c.filter).not.toContain("_raw");
    }

    // CALIBRATION. The same harness, on content whose names really are in the
    // text, must return TRUE - otherwise the three zeros above prove nothing.
    const calibration = run({
      AUTH: ['{"authField":"a","common":"1"}', '{"authField":"b","common":"2"}'],
      TRAFFIC: [
        '{"trafficField":"c","common":"3"}',
        '{"trafficField":"d","common":"4"}',
      ],
    });
    // The value path declines (no value NAMES the log type), so the presence
    // path is what a real JSON pack routes on - and it puts the quoted key in
    // the raw term, which IS in the text.
    expect(calibration["AUTH"].filter).toBeNull();
    const presence = deriveRouteDiscriminator(
      ["authField", "common"],
      [new Set(["trafficfield", "common"])],
      "json",
    );
    expect(presence).toContain(`_raw.indexOf('"authField"')`);
    const lines = [
      '{"authField":"a","common":"1"}',
      '{"authField":"b","common":"2"}',
    ];
    expect(lines.filter((l) => routeTime(presence ?? "", l)).length).toBe(2);
  });
});

describe("csvRoutingWarning", () => {
  it("warns a CSV log type that has siblings", () => {
    const text = csvRoutingWarning("csv", 3);

    expect(text).toContain("cannot be routed automatically");
    // The actionable half: stop collecting samples, write the filter.
    expect(text).toContain("more samples will not change that");
    expect(text).toContain("placeholder filter");
  });

  it("warns a POSITIONAL log type too, and says so in words", () => {
    const text = csvRoutingWarning("positional", 3) ?? "";

    expect(text).toContain("cannot be routed automatically");
    expect(text).toContain("more samples will not change that");
    expect(text).toContain("placeholder filter");
    // HON-5's cause has to stay TRUE of the operator reading it. A VPC Flow
    // operator handed a warning that names CSV alone goes looking for a CSV
    // bug they do not have, which is the same wrong-cause failure HON-5 was
    // written to prevent - one step further down.
    expect(text).toContain("whitespace-positional");
  });

  it("gives both COLUMN-ORDER formats the SAME text, because it is one cause", () => {
    // A CSV row and a whitespace-positional line differ only in separator, so
    // two messages here would be two chances to get the reason wrong.
    expect(csvRoutingWarning("positional", 2)).toBe(csvRoutingWarning("csv", 2));
  });

  it("warns a SYSLOG log type, in its own words and not CSV's", () => {
    const text = csvRoutingWarning("syslog", 3) ?? "";

    // The three clauses every format-cause warning owes the operator.
    expect(text).toContain("cannot be routed automatically");
    expect(text).toContain("more samples will not change that");
    expect(text).toContain("placeholder filter");

    // And the half that has to be TRUE OF SYSLOG. A syslog line has no columns
    // to look at, so reusing the column-order text would send this operator
    // hunting for a column layout their events do not have - the same
    // wrong-cause failure HON-5 exists to prevent, one format further along.
    expect(text).not.toContain("Column-order");
    expect(text).not.toContain("column order");
    expect(text).toContain("regex");
    expect(text).toContain("_raw");
    expect(text).not.toBe(csvRoutingWarning("csv", 3));
  });

  /**
   * THE CLAUSE THAT WAS FALSE, and the pin that stops it coming back.
   *
   * Until 2026-09-04 this text ran "...the only field that survives to route
   * time is _raw, and every syslog log type in the pack carries it. So no filter
   * can tell this log type from the others in the pack - more samples will not
   * change that. Its route ships with a placeholder filter for you to complete."
   * The middle clause is FALSE, and it contradicts the sentence after it: if NO
   * filter can separate them, the placeholder the operator is asked to complete
   * is impossible work.
   *
   * MEASURED on the exact two-event fixture route-value-discriminator.test.ts
   * pins for this format (2026-09-04): `typeof _raw === 'string' &&
   * _raw.indexOf('sshd[') !== -1` is TRUE on
   * "Oct 11 22:14:15 host1 sshd[1234]: Failed password for root" and FALSE on
   * "Oct 11 22:15:01 host1 CRON[2001]: (root) CMD (run-parts)"; the mirror on
   * 'CRON[' is the reverse. A route filter separates them cleanly.
   *
   * What is true is narrower: no filter built from the FIELD NAMES can, because
   * the names are minted by the regex however many events arrive. So the text
   * owes the operator both halves - the impossibility scoped to the names, and
   * the form that works.
   */
  it("scopes the impossibility to the NAMES and hands over the working form", () => {
    const text = csvRoutingWarning("syslog", 3) ?? "";

    // It must not claim the separation itself is impossible.
    expect(text).not.toContain("no filter can tell this log type");
    // It must scope the claim to what was actually measured.
    expect(text).toContain("no filter built from them can match");
    // And it must SHOW the filter that works. An operator told only "write a
    // filter over _raw" still has to guess the shape the route evaluates, and
    // guessing is what produced the dead routes this module exists for.
    expect(text).toContain("typeof _raw === 'string'");
    expect(text).toContain("_raw.indexOf(");
  });

  it("scopes it for COLUMN ORDER too, which shipped the false clause a wave longer", () => {
    // THE PIN THIS BRANCH EARNED. The syslog branch above was corrected on
    // 2026-09-04 and the column-order branch was not, on the argument that its
    // string was HON-5's live-verified copy and rewriting verified wording as a
    // drive-by makes it worse. That caution was nearly right and missed two
    // things: HON-5 verified that the copy RENDERS, not that it is TRUE, and
    // the deferral said the change was "filed instead" when no card existed -
    // the third time a comment in route-placeholder.ts claimed a filing that
    // had not happened.
    //
    // So one function told one operator the truth and another the false
    // version, from the same warning. Both branches are pinned now, together,
    // because a single-branch pin is what let them diverge.
    //
    // MEASURED for the example the text hands over: on a headerless PAN-OS CSV,
    // _raw.indexOf(',TRAFFIC,') is TRUE on the TRAFFIC row and FALSE on the
    // THREAT row - so the separation the old clause called impossible is one
    // string search away.
    for (const format of ["csv", "positional"]) {
      const text = csvRoutingWarning(format, 3) ?? "";
      expect(text, format).not.toContain("no filter can tell this log type");
      expect(text, format).toContain("nothing built from those field");
      expect(text, format).toContain("_raw.indexOf(");
    }
  });

  it("...and the example it gives really does separate the sampled lines", () => {
    // The pin above only reads the text. This one RUNS the expression out of it,
    // so the example cannot rot into something plausible that matches nothing -
    // which is precisely the defect class this module exists to prevent, and it
    // would be that much worse arriving as advice.
    const text = csvRoutingWarning("syslog", 3) ?? "";
    const example = /typeof _raw === '[^']*' && _raw\.indexOf\('[^']*'\) !== -1/.exec(
      text,
    )?.[0];
    expect(example, "the warning must carry a runnable example").toBeDefined();

    const run = (raw: string): boolean =>
      Boolean(new Function("_raw", `return (${example ?? "false"});`)(raw));

    // The same two events the syslog value-discriminator pins are built on.
    expect(run("Oct 11 22:14:15 host1 sshd[1234]: Failed password for root")).toBe(
      true,
    );
    expect(run("Oct 11 22:15:01 host1 CRON[2001]: (root) CMD (run-parts)")).toBe(
      false,
    );
  });

  it("tells a syslog operator which names it means", () => {
    // Naming them is what makes "more samples will not change that" checkable
    // rather than something the operator has to take on trust: they can look at
    // their own line and see that none of these words is in it.
    const text = csvRoutingWarning("syslog", 1) ?? "";
    for (const name of ["Timestamp", "Hostname", "Program", "PID", "Message"]) {
      expect(text, name).toContain(name);
    }
  });

  it("stays SILENT for a single-log-type syslog pack, as for the others", () => {
    expect(csvRoutingWarning("syslog", 0)).toBeNull();
  });

  it("stays SILENT for a single-log-type positional pack, as for CSV", () => {
    // Same argument, same threshold: plan.ts runs the ladder only when
    // `tables.length > 1`, so a lone positional log type keeps a working
    // match-all and warning about it would be crying wolf.
    expect(csvRoutingWarning("positional", 0)).toBeNull();
  });

  it("stays SILENT for a single-log-type CSV pack", () => {
    // plan.ts only runs the discriminator ladder `if (tables.length > 1)`, so a
    // lone CSV log type keeps a working match-all. Warning there would be
    // crying wolf about a pack that routes correctly - the DBT-19 failure this
    // repo has already had twice.
    expect(csvRoutingWarning("csv", 0)).toBeNull();
  });

  it("stays silent for every format that CAN discriminate", () => {
    for (const f of ["cef", "json", "ndjson", "leef", "kv"]) {
      expect(csvRoutingWarning(f, 5), f).toBeNull();
    }
  });

  it("stays silent for CEF and LEEF even though their HEADERS are unusable", () => {
    // Deliberate, and the reason GEN-8 is not one format set. Most CEF packs
    // route perfectly well on extension fields, so a format-level warning would
    // fire on all of them - crying wolf about packs that work, which is the
    // DBT-19 failure this repo has already had twice. The header exclusion is
    // per FIELD and shows up only if it actually costs the log type its filter.
    expect(csvRoutingWarning("cef", 5)).toBeNull();
    expect(csvRoutingWarning("leef", 5)).toBeNull();
  });

  it("does not promise the route is missing - the pack still ships it", () => {
    // The placeholder keeps the route AND the pipeline; only the filter is
    // unfinished. An operator who reads this as "no route was generated" would
    // go looking for a bug that is not there.
    const text = csvRoutingWarning("csv", 2) ?? "";

    expect(text).toContain("Its route ships with");
    expect(text).not.toContain("dropped");
  });
});

describe("placeholderRouteFilter - unchanged by HON-5", () => {
  it("still never matches and still names its log type", () => {
    const filter = placeholderRouteFilter("TRAFFIC");

    expect(isPlaceholderFilter(filter)).toBe(true);
    expect(filter).toContain("TRAFFIC");
  });
});
