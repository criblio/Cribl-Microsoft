/**
 * DBT-98 - parseCef must honour CEF's own pipe escape in the HEADER.
 *
 * THE MEASURED DEFECT, taken on this directory at HEAD before anything changed.
 * `CEF:0|V\|W|P|1.0|100|worm|5|src=...` escapes the pipe exactly as the CEF
 * specification requires; `split("|")` split on it anyway and every header field
 * from DeviceVendor down shifted one position:
 *
 *   DeviceVendor `V\`   DeviceProduct `W`     DeviceVersion `P`
 *   DeviceEventClassID `1.0`   Name `100`     Severity `worm`
 *
 * IT WAS SILENT, and that is why the pins below assert VALUES rather than names.
 * All seven header names are present and correct in both the broken and the fixed
 * parse - a field list, a key-count assertion and `toBeDefined()` all pass with
 * every value off by one. The first test in this file asserts the name lists are
 * IDENTICAL across the escaped and unescaped cases, so the next reader can see
 * that a name-only pin here would be worth nothing.
 *
 * THE THREE SHAPES, and the middle one is the trap. A literal pipe in a header
 * value is written `\|`; a literal backslash is written `\\`. So `\\` before a
 * pipe leaves that pipe a REAL separator - "split on a pipe with no backslash in
 * front of it" is wrong in the opposite direction from "split on every pipe", and
 * only consuming the escapes gets both. HEAD's answers, all three:
 *
 *   unescaped     `V|P`      separator right, value right
 *   escaped pipe  `V\|W|P`   separator WRONG - six fields shift
 *   escaped bslash `V\\|P`   separator right BY LUCK, value wrong (`V\\` kept)
 *
 * THE PACK WAS FIXED IN THE SAME CHANGE and is pinned in
 * pipeline-generation/pipeline-conf.test.ts, against these same bytes. Fixing this
 * side alone would have made the screen promise header values the installed
 * pipeline cannot produce.
 *
 * WHAT THE FIX COSTS IS PINNED HERE TOO, in three tests, because every one of
 * these is silent and two of them were written down wrongly first:
 *
 *   a DANGLING escape has TWO answers. Bare, the line vanishes and so does its
 *     raw event. SYSLOG-WRAPPED - the standard transport - the record SURVIVES
 *     carrying only `_syslogHeader` and not one of the seven fields, and it
 *     still counts as an event and still reaches the pack's sample file.
 *   an UNESCAPED literal backslash before a pipe SHIFTS every field after it and
 *     swallows the extension whole. That is the spec choice working as intended;
 *     it is pinned so it is a decision on the record, not a later discovery.
 *   a LONE backslash before an ordinary character is NOT a cost, and for one
 *     revision it was: the unescape consumed any escaped character, so
 *     `C:\Program Files\Acme` in a header value reached the operator as
 *     `C:Program FilesAcme` while the identical bytes in the EXTENSION survived.
 *
 * EVERY BACKSLASH IN THIS FILE COMES FROM `String.fromCharCode(92)`, not from a
 * source escape. A `\\` in a TypeScript literal is one character and a `\\\\` is
 * two, and a fixture that quietly loses one is indistinguishable from a passing
 * test - the first attempt at this measurement lost exactly one backslash to a
 * shell heredoc and reported the wrong shape. The first test asserts the fixture
 * bytes themselves so a mangled fixture fails instead of passing.
 */

import { describe, expect, it } from "vitest";
import { CEF_HEADER_PATTERN, parseCef } from "./parsers";
import { parseSampleContent } from "./parse-sample";

/** One backslash, built from its code point so no source escaping can lose it. */
const BS = String.fromCharCode(92);

/** The seven header fields parseCef lifts out, in header order. */
const HEADER_FIELDS = [
  "CEFVersion",
  "DeviceVendor",
  "DeviceProduct",
  "DeviceVersion",
  "DeviceEventClassID",
  "Name",
  "Severity",
];

/** The single record parsed from `line`, or undefined when the line produced none. */
function one(line: string): Record<string, unknown> | undefined {
  const records = parseCef(line);
  expect(records.length).toBeLessThanOrEqual(1);
  return records[0];
}

/** The seven header values of `line`, in header order. */
function header(line: string): unknown[] {
  const record = one(line);
  expect(record, `no record for ${line}`).toBeDefined();
  return HEADER_FIELDS.map((f) => record![f]);
}

/** The extension half of the record for `line`. */
function extension(line: string): Record<string, unknown> {
  const record = one(line);
  expect(record, `no record for ${line}`).toBeDefined();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record!)) {
    if (!HEADER_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

const PLAIN = "CEF:0|V|P|1.0|100|worm|5|src=1.1.1.1";
const ESCAPED_PIPE = `CEF:0|V${BS}|W|P|1.0|100|worm|5|src=1.1.1.1`;
const ESCAPED_BACKSLASH = `CEF:0|V${BS}${BS}|P|1.0|100|worm|5|src=1.1.1.1`;
const BOTH_ESCAPES = `CEF:0|V${BS}${BS}${BS}|W|P|1.0|100|worm|5|src=1.1.1.1`;

describe("parseCef header pipe escape (DBT-98)", () => {
  it("the fixtures carry the bytes they claim to, and the names hide the defect", () => {
    // THE FIXTURE CHECK. Everything below is a statement about where a backslash
    // sits, so a fixture that lost one would pass the wrong test quietly.
    expect(BS).toHaveLength(1);
    expect(BS.charCodeAt(0)).toBe(92);
    // Code points, not a re-spelling of the fixture: comparing the fixture to
    // another template built the same way would agree with itself while both
    // were wrong. `CEF:0|` is six characters, so the vendor starts at 6.
    expect(
      [6, 7, 8, 9].map((i) => ESCAPED_PIPE.charCodeAt(i)),
    ).toEqual([86, 92, 124, 87]); // V \ | W
    expect(ESCAPED_PIPE.split(BS)).toHaveLength(2); // exactly one backslash
    expect(ESCAPED_BACKSLASH.split(BS)).toHaveLength(3); // exactly two
    expect(BOTH_ESCAPES.split(BS)).toHaveLength(4); // exactly three

    // THE NAMES ARE IDENTICAL ON BOTH, which is the whole reason this defect
    // survived. Under HEAD these two lists were identical too, while six of the
    // seven values on the second line were another field's.
    expect(Object.keys(one(PLAIN)!)).toEqual([...HEADER_FIELDS, "src"]);
    expect(Object.keys(one(ESCAPED_PIPE)!)).toEqual([...HEADER_FIELDS, "src"]);
  });

  it("does not split on an ESCAPED pipe, and unescapes it in the value", () => {
    // HEAD: ["0", "V\", "W", "P", "1.0", "100", "worm"] - DeviceVendor read the
    // escaped fragment, DeviceProduct read what should have been the vendor, and
    // so on down the header. The extension was `5|src=1.1.1.1`.
    expect(header(ESCAPED_PIPE)).toEqual([
      "0",
      `V|W`,
      "P",
      "1.0",
      "100",
      "worm",
      "5",
    ]);
    expect(extension(ESCAPED_PIPE)).toEqual({ src: "1.1.1.1" });

    // The control, unchanged from HEAD, so the pin above cannot be passing
    // because the parser stopped parsing headers.
    expect(header(PLAIN)).toEqual(["0", "V", "P", "1.0", "100", "worm", "5"]);
    expect(extension(PLAIN)).toEqual({ src: "1.1.1.1" });
  });

  it("treats a pipe after an ESCAPED BACKSLASH as a real separator", () => {
    // THE CASE THAT BREAKS THE OBVIOUS FIX. `\\` is a literal backslash, so the
    // pipe after it separates. HEAD got the SEPARATOR right here by luck - it
    // split on every pipe - and got the VALUE wrong, keeping `V\\` unexpanded.
    // A "pipe not preceded by a backslash" rule would get the separator wrong
    // and shift the whole header, which is the defect wearing the fix's clothes.
    expect(header(ESCAPED_BACKSLASH)).toEqual([
      "0",
      `V${BS}`,
      "P",
      "1.0",
      "100",
      "worm",
      "5",
    ]);
    expect(extension(ESCAPED_BACKSLASH)).toEqual({ src: "1.1.1.1" });
  });

  it("resolves an escaped backslash and an escaped pipe in one field", () => {
    // `V\\\|W` is backslash-then-pipe: `\\` yields `\`, `\|` yields `|`. One
    // left-to-right pass gets both because the first escape consumes the
    // backslash the second would otherwise have re-used.
    expect(header(BOTH_ESCAPES)).toEqual([
      "0",
      `V${BS}|W`,
      "P",
      "1.0",
      "100",
      "worm",
      "5",
    ]);
    expect(extension(BOTH_ESCAPES)).toEqual({ src: "1.1.1.1" });
  });

  it("honours the escape in every header position, not only the vendor", () => {
    // Name and Severity are the two an operator maps most often and the two the
    // shift reached last, so they are pinned by position rather than assumed to
    // follow from the vendor case.
    expect(header(`CEF:0|V|P|1.0|100|worm${BS}|trojan|5|src=1.1.1.1`)).toEqual([
      "0",
      "V",
      "P",
      "1.0",
      "100",
      "worm|trojan",
      "5",
    ]);
    // HEAD read Severity `5\` and left `6|` at the head of the extension.
    const severity = `CEF:0|V|P|1.0|100|worm|5${BS}|6|src=1.1.1.1`;
    expect(header(severity)).toEqual([
      "0",
      "V",
      "P",
      "1.0",
      "100",
      "worm",
      "5|6",
    ]);
    expect(extension(severity)).toEqual({ src: "1.1.1.1" });
  });

  it("keeps the extension VERBATIM - it is a remainder, not a re-join", () => {
    // The old `slice(7).join("|")` reconstituted the extension only because the
    // split it undid had been naive. Group 8 is everything after the seventh
    // unescaped pipe, so both an escaped and an unescaped pipe inside the
    // extension survive exactly as the vendor wrote them. `\=` staying
    // unexpanded is CEF_EXT_PAIR's documented gap, unchanged here.
    expect(extension(`CEF:0|V|P|1.0|100|worm|5|msg=a${BS}|b src=1.1.1.1`)).toEqual({
      msg: `a${BS}|b`,
      src: "1.1.1.1",
    });
    expect(extension("CEF:0|V|P|1.0|100|worm|5|msg=a|b dst=2.2.2.2")).toEqual({
      msg: "a|b",
      dst: "2.2.2.2",
    });
    // An interior pipe that opens what looks like a key is still read the way
    // cef-keys.test.ts pins it - the extension pattern is untouched by DBT-98.
    expect(Object.keys(extension("CEF:0|V|P|1.0|100|worm|5|5|src=1.1.1.1 dst=2"))).toEqual([
      "src",
      "dst",
    ]);
  });

  it("tells a MISSING extension from an EMPTY one, and keeps both records", () => {
    const none = one("CEF:0|V|P|1.0|100|worm|5");
    expect(none).toBeDefined();
    expect(Object.keys(none!)).toEqual(HEADER_FIELDS);
    expect(none!["Severity"]).toBe("5");

    const empty = one("CEF:0|V|P|1.0|100|worm|5|");
    expect(empty).toBeDefined();
    expect(Object.keys(empty!)).toEqual(HEADER_FIELDS);
    expect(empty!["Severity"]).toBe("5");
  });

  it("keeps the syslog header, and the raw event, beside a corrected parse", () => {
    const line = `<134>host1 ${ESCAPED_PIPE}`;
    const record = one(line);
    expect(record).toBeDefined();
    expect(record!["_syslogHeader"]).toBe("<134>host1");
    expect(record!["DeviceVendor"]).toBe("V|W");
    expect(record!["DeviceProduct"]).toBe("P");

    // The raw event is the vendor's bytes, escape and syslog prefix included -
    // it is what the generated pack is previewed against.
    const sourceLines: string[] = [];
    parseCef(line, sourceLines);
    expect(sourceLines).toEqual([line]);
  });

  it("keeps a LONE backslash in a header value, and still resolves the two spec escapes", () => {
    // THE UNESCAPE IS THE TWO CHARACTERS CEF DEFINES, NOT ANY CHARACTER. While
    // it was `/\\([\s\S])/g` every lone backslash in a HEADER value was deleted,
    // and the identical bytes in the EXTENSION survived - one line, two answers,
    // no error anywhere. A Windows path is the shape that shows it, and it is
    // exactly the kind of value an operator maps to a destination column.
    const win =
      `CEF:0|Acme|C:${BS}Program Files${BS}Acme|1.0|100|worm|5` +
      `|path=C:${BS}Program Files${BS}Acme fname=a${BS}b`;
    const record = one(win);
    expect(record).toBeDefined();
    // The wide class gave "C:Program FilesAcme" - two characters gone, silently.
    expect(record!["DeviceProduct"]).toBe(`C:${BS}Program Files${BS}Acme`);
    // The extension is not unescaped at all, and never was. Asserted here rather
    // than taken on trust because it is the CONTRAST that made the header's
    // deletion a defect instead of a policy.
    expect(record!["path"]).toBe(`C:${BS}Program Files${BS}Acme`);
    expect(record!["fname"]).toBe(`a${BS}b`);

    // AND THE SPEC ESCAPES STILL RESOLVE, in the same test, because a pin that
    // only checked the path above would pass just as happily on no unescape at
    // all - which would put `V\\` and `V\|W` back in front of the operator.
    expect(header(ESCAPED_PIPE)[1]).toBe("V|W");
    expect(header(ESCAPED_BACKSLASH)[1]).toBe(`V${BS}`);
    expect(header(BOTH_ESCAPES)[1]).toBe(`V${BS}|W`);
    expect(header(PLAIN)[1]).toBe("V");
  });

  it("produces NO record for a header the pattern cannot read - the cost, pinned", () => {
    // WHAT THE FIX COSTS, on record rather than discovered later.
    //
    // A short header was already dropped at HEAD (it required 7 parts), so this
    // row is unchanged...
    expect(parseCef("CEF:0|V|P|1.0|100|worm")).toEqual([]);
    // ...and this row is NOT: a DANGLING backslash - an escape with nothing to
    // escape - used to yield a record with Severity `5\`. It is malformed CEF and
    // it now yields nothing. There is no error channel in this function to make
    // that loud, which is why it is written down here.
    expect(parseCef(`CEF:0|V|P|1.0|100|worm|5${BS}`)).toEqual([]);
    // ...and the raw event goes with it, so nothing downstream counts the line.
    const bareLines: string[] = [];
    parseCef(`CEF:0|V|P|1.0|100|worm|5${BS}`, bareLines);
    expect(bareLines).toEqual([]);
    // A line with no CEF: at all was, and stays, skipped entirely.
    expect(parseCef("just a syslog line")).toEqual([]);
  });

  it("keeps a PHANTOM record when the unreadable header arrives over syslog", () => {
    // THE SAME MALFORMED HEADER, THE OTHER SPELLING, AND THE WORSE ANSWER. The
    // row above is true only for a BARE line. `_syslogHeader` is assigned
    // whenever the line has a prefix - outside the `header !== null` branch - and
    // the push is guarded on the record having any key at all, so a header that
    // failed to match never reaches the emptiness guard. The record is KEPT and
    // carries NOT ONE of the seven header fields.
    const line = `<134>host1 CEF:0|V|P|1.0|100|worm|5${BS}`;
    const record = one(line);
    expect(record).toBeDefined();
    // ITS OWN KEYS, exhaustively. `toBeDefined()` or a header-name lookup would
    // pass on a full record too; the whole content of this pin is that the list
    // is this short.
    expect(Object.keys(record!)).toEqual(["_syslogHeader"]);
    expect(record!["_syslogHeader"]).toBe("<134>host1");
    for (const f of HEADER_FIELDS) expect(record![f]).toBeUndefined();
    // And it occupies a slot in the raw events - the bytes the generated pack is
    // previewed against and shipped with.
    const sourceLines: string[] = [];
    parseCef(line, sourceLines);
    expect(sourceLines).toEqual([line]);

    // THE MECHANISM PREDATES DBT-98 and this row proves it, so the card that
    // carries it is not filed against the pipe-escape fix. A SHORT header was
    // dropped at HEAD too (`parts.length >= 7`), and HEAD had this same pair of
    // answers for it - measured against HEAD's own code: bare gives `[]`,
    // syslog-wrapped gives `[{_syslogHeader}]`. The stricter pattern only
    // widened the set of lines that arrive here; it did not open the door.
    const short = "<134>host1 CEF:0|V|P|1.0|100|worm";
    expect(Object.keys(one(short)!)).toEqual(["_syslogHeader"]);
    expect(parseCef("CEF:0|V|P|1.0|100|worm")).toEqual([]);
  });

  it("MASKS the phantom record end to end - the count and the field list both lie", () => {
    // WHY THE PIN ABOVE ASSERTS ONE RECORD'S OWN KEYS. parseSampleContent UNIONS
    // field names across records, so three healthy lines supply every name the
    // fourth is missing. Nothing an operator is shown says a line was gutted.
    const sample = [
      "<134>host1 CEF:0|V|P|1.0|100|worm|5|src=1.1.1.1 dpt=80",
      "<134>host2 CEF:0|V|P|1.0|100|worm|5|src=2.2.2.2 dpt=81",
      `<134>host3 CEF:0|V|P|1.0|100|worm|5${BS}`,
      "<134>host4 CEF:0|V|P|1.0|100|worm|5|src=4.4.4.4 dpt=83",
    ].join("\n");
    const parsed = parseSampleContent(sample, { sourceName: "fw.log" });

    expect(parsed.format).toBe("cef");
    expect(parsed.eventCount).toBe(4); // four lines in, four events out
    expect(parsed.rawEvents).toHaveLength(4);
    expect(parsed.errors).toEqual([]); // and nothing is said
    expect(parsed.fields.map((f) => f.name)).toEqual([
      ...HEADER_FIELDS,
      "src",
      "dpt",
      "_syslogHeader",
    ]);
    // The record itself, which is the only place the loss is visible.
    expect(Object.keys(parseCef(sample)[2]!)).toEqual(["_syslogHeader"]);
  });

  it("SHIFTS a non-compliant producer's fields, and that is the recorded decision", () => {
    // A PRODUCER THAT WRITES AN UNESCAPED LITERAL BACKSLASH BEFORE A PIPE gets a
    // different answer than it got at HEAD. HEAD split on every pipe and so
    // agreed, by accident, with a reader who thinks the backslash is data; this
    // pattern consumes `\|` as the escape the specification says it is, and the
    // pipe stops separating.
    //
    // THE SPEC CHOICE IS NOT BEING RECONSIDERED HERE - a producer that means a
    // literal backslash must write `\\`, and guessing which one it meant is
    // exactly what breaks the ESCAPED_BACKSLASH row above. This pin exists so
    // the cost is a decision on the record rather than a discovery in a ticket.
    const shifted = `CEF:0|V|P|1.0${BS}|100|worm|5|src=1.1.1.1 dpt=80`;
    // HEAD: ["0","V","P","1.0\","100","worm","5"] with extension `src=1.1.1.1 dpt=80`.
    expect(header(shifted)).toEqual([
      "0",
      "V",
      "P",
      "1.0|100",
      "worm",
      "5",
      "src=1.1.1.1 dpt=80",
    ]);
    // The extension does not shift - it VANISHES. It was pulled into Severity,
    // so there is no eighth field left to pair, and `src`/`dpt` exist nowhere.
    expect(extension(shifted)).toEqual({});

    // AND IT IS SILENT. All seven names present, no error, the count right - the
    // same signature as the defect DBT-98 fixed, which is why it is written down
    // instead of trusted to be noticed.
    const parsed = parseSampleContent(
      ["CEF:0|V|P|1.0|100|worm|5|src=9.9.9.9 dpt=99", shifted].join("\n"),
      { sourceName: "fw.log" },
    );
    expect(parsed.eventCount).toBe(2);
    expect(parsed.errors).toEqual([]);
    expect(parsed.fields.map((f) => f.name)).toEqual([
      ...HEADER_FIELDS,
      "src",
      "dpt",
    ]);

    // A LONE BACKSLASH BEFORE AN ORDINARY CHARACTER IS NOT PART OF THIS COST and
    // was, for one revision, treated as if it were. `FireEye\NX` now reads the
    // way HEAD read it; only the backslash-before-a-pipe shape moves.
    expect(header(`CEF:0|FireEye${BS}NX|P|1.0|100|worm|5|src=1.1.1.1`)).toEqual([
      "0",
      `FireEye${BS}NX`,
      "P",
      "1.0",
      "100",
      "worm",
      "5",
    ]);
  });

  it("scans a long header linearly, so the fix cannot freeze the samples screen", () => {
    // The alternation's two branches are disjoint on their first character, so
    // every position has exactly one way to be consumed and there is nothing to
    // backtrack over. Measured through parseCef on this machine, including the
    // shape that would be pathological for a backtracking engine - a header
    // field made entirely of escaped pipes:
    //
    //   plain field       16000B 0.71ms  32000B 0.29ms  64000B 0.40ms  128000B 0.68ms
    //   all escaped pipes 16000B 0.36ms                 64000B 1.46ms
    //
    // 8x the bytes is inside the noise, which is the evidence; the absolute
    // numbers drift between runs, so the pin is a BUDGET. A pattern that
    // backtracked here would take seconds, not milliseconds, and
    // parseSampleContent runs SYNCHRONOUSLY on the samples screen (CEF_EXT_PAIR's
    // trap 2 is the same lesson, paid for on the extension).
    const long = `CEF:0|${"a".repeat(64000)}|P|1.0|100|worm|5|src=1.1.1.1`;
    const started = performance.now();
    const record = parseCef(long)[0];
    const elapsed = performance.now() - started;
    expect(record).toBeDefined();
    expect(record!["DeviceProduct"]).toBe("P");
    expect(elapsed).toBeLessThan(1000);
  });

  it("is the SAME pattern the generated pack emits", () => {
    // The anti-drift pin lives on the pack side (pipeline-conf.test.ts asserts
    // the emitted conf contains this exact source text). Here it is only checked
    // that the constant is what parseCef actually uses, so the pack cannot be
    // pinned against a constant this parser has quietly stopped reading.
    expect(CEF_HEADER_PATTERN.global).toBe(false);
    expect(CEF_HEADER_PATTERN.exec(PLAIN)).not.toBeNull();
    expect(CEF_HEADER_PATTERN.exec(ESCAPED_PIPE)![2]).toBe(`V${BS}|W`);
    expect(CEF_HEADER_PATTERN.exec(ESCAPED_PIPE)![8]).toBe("src=1.1.1.1");
  });
});
