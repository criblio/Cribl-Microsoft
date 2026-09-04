/**
 * DBT-80 - a CEF extension pair must not lose its key, and must not eat the
 * pairs that follow it.
 *
 * THE MEASURED DEFECT, taken against this directory exported from HEAD before
 * anything was changed, because the card recorded a CAUSE and the card was
 * wrong about it. The old pattern `/(\w+)=(.*?)(?=\s\w+=|$)/g` carries TWO
 * `\w+`s and they fail differently:
 *
 *   the CAPTURE `\w+` truncates the name (`src-ip` -> `ip`), as in DBT-79;
 *   the LOOKAHEAD `\w+` decides where a value ENDS, and a next key that is not
 *     all word characters is not a visible boundary - so the value expands
 *     straight THROUGH it:
 *
 *       first=1 a-b=2 tail=3   ->  { first: "1 a-b=2", tail: "3" }
 *
 * Three pairs in, TWO out, and `first` now holds another field's text as if it
 * were data. That second half is what makes this worse than DBT-79: KV lost the
 * pair, CEF loses the pair AND corrupts the surviving neighbour's value. On the
 * reported line both halves show at once:
 *
 *   src-ip=1.1.1.1 dst-ip=2.2.2.2 action=ACCEPT bytes=10
 *     -> { ip: "1.1.1.1 dst-ip=2.2.2.2", action: "ACCEPT", bytes: "10" }
 *
 * THE CARD'S HYPOTHESIS - an escaped `\=` inside a value - IS NOT THE CAUSE, and
 * the case is pinned below as a control rather than as a fix. Measured on HEAD,
 * `msg=x y\=z dst=2.2.2.2` pairs correctly, because the `\` before the `=` is not
 * a `\w` and the old lookahead therefore never mistook the escape for a boundary.
 * What the escape DOES do is constrain the fix: widening the key class far enough
 * to include `\` manufactures a field `y\` out of the escape, which is why the
 * shipped class excludes it. See the CEF_EXT_PAIR note in parsers.ts for the full
 * survey and the corpus calibration.
 *
 * WHY THE COUNTS ARE ASSERTED EXACTLY AND VALUES ARE ASSERTED TOO: the defect was
 * silent end to end. Measured through parseSampleContent, HEAD reported 10 clean
 * fields and ZERO parse notes for the reported line while the event had lost a
 * value and gained a corrupted one. A pin reading `expect(rec.action).toBeDefined()`
 * passes throughout. A pin asserting only KEY lists passes on the swallow too,
 * because the swallow damages the neighbouring VALUE, not the key list - so every
 * swallow case below asserts the neighbour's value as well.
 *
 * DBT-80 ROUND 2 - THE FIX'S OWN THREE DEFECTS, all silent, all found by measuring rather
 * than by a failing pin. The first draft of DBT-80 shipped a leading-grouping trim
 * shared with parseKv, and:
 *
 *   IT OVERWROTE A REAL FIELD WITH PROSE. `act=deny msg=blocked (act=drop)` trims
 *     `(act` to `act`, and the record assignment is last-write-wins, so the
 *     operator was shown act="drop)" where the device said deny. Not a loss - a
 *     WRONG VALUE reported as clean.
 *   IT DISCARDED MESSAGE TEXT. `<=` `(=` `[=` `{=` trim to an EMPTY key, the empty
 *     guard dropped the pair, and because a CEF value spans to the next key the
 *     drop took the rest of the message with it: `msg=Disk usage <= 90 percent on
 *     /var` became msg="Disk usage" with the remainder in no field at all.
 *   CRLF LOST THE LAST PAIR OF EVERY LINE, which HEAD did too and nobody had
 *     written down, and which the unioned field list hides end to end.
 *
 * WHAT THAT COSTS A TEST FILE, and it is the reason several pins below assert
 * things that look redundant: a corpus that cannot express a failure cannot clear
 * it. DBT-79 was cleared twice that way, and DBT-80's own 200000-line corpus
 * reported 0/0 while all three defects above were live in the code it measured,
 * because its generator never emitted a bare grouping token before an equals and
 * never emitted a CRLF.
 */

import { describe, expect, it } from "vitest";
import { parseCef, parseCsv, parseKv, parseLeef, parseSyslog } from "./parsers";
import { parseSampleContent } from "./parse-sample";

/** The seven fields parseCef lifts out of the pipe-delimited header. */
const HEADER_FIELDS = [
  "CEFVersion",
  "DeviceVendor",
  "DeviceProduct",
  "DeviceVersion",
  "DeviceEventClassID",
  "Name",
  "Severity",
];

const HDR = "CEF:0|V|P|1|100|n|5|";

/** The extension half of the single record parsed from `HDR + extension`. */
function ext(extension: string): Record<string, unknown> {
  const records = parseCef(HDR + extension);
  expect(records).toHaveLength(1);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(records[0])) {
    if (!HEADER_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

describe("parseCef extension keys (DBT-80)", () => {
  it("keeps both hyphenated keys distinct - the reported line, exactly", () => {
    const record = ext("src-ip=1.1.1.1 dst-ip=2.2.2.2 action=ACCEPT bytes=10");

    // FOUR extension keys, spelled as the vendor spelled them. HEAD produced
    // three, so the length catches it; the list is here because "three of the
    // right names" and "three because one ate the next" are different failures.
    expect(Object.keys(record)).toEqual([
      "src-ip",
      "dst-ip",
      "action",
      "bytes",
    ]);
    // THE VALUES ARE THE OTHER HALF OF THE DEFECT. Under HEAD the single
    // surviving `ip` read "1.1.1.1 dst-ip=2.2.2.2" - the source address welded
    // to the whole next pair. A key-list-only assertion would not see that.
    expect(record["src-ip"]).toBe("1.1.1.1");
    expect(record["dst-ip"]).toBe("2.2.2.2");
    expect(record["action"]).toBe("ACCEPT");
    expect(record["bytes"]).toBe("10");
  });

  it("does not swallow the pair after a key it cannot spell", () => {
    // The minimal shape, and the one that separates the two `\w+`s: `first` and
    // `tail` are both perfectly ordinary keys, so nothing about THEM is at fault.
    // HEAD returned { first: "1 a-b=2", tail: "3" } - two keys, one poisoned.
    const record = ext("first=1 a-b=2 tail=3");
    expect(Object.keys(record)).toEqual(["first", "a-b", "tail"]);
    expect(record["first"]).toBe("1");
    expect(record["a-b"]).toBe("2");
    expect(record["tail"]).toBe("3");
  });

  it("truncates in first position but swallows from second - both, one line", () => {
    // POSITION DECIDES WHICH HALF FIRES, which is why a survey that only ever
    // put the odd key FIRST would have reported "truncation, count preserved"
    // and missed the field loss entirely. Measured on HEAD:
    //   "a-b=1 next=2 tail=3"   -> { b: "1", next: "2", tail: "3" }      3 keys
    //   "first=1 a-b=2 tail=3"  -> { first: "1 a-b=2", tail: "3" }       2 keys
    // First position has no preceding value to be swallowed into, so `exec`
    // merely skips the prefix. From second position on, the previous value is
    // still open and takes the whole pair with it.
    const first = ext("a-b=1 next=2 tail=3");
    expect(Object.keys(first)).toEqual(["a-b", "next", "tail"]);
    expect(first["a-b"]).toBe("1");

    const second = ext("first=1 a-b=2 tail=3");
    expect(Object.keys(second)).toEqual(["first", "a-b", "tail"]);
    expect(second["first"]).toBe("1");
  });

  it("keeps every key character the survey found breaking", () => {
    // One row per character so a regression names the character that broke it.
    // Each is placed in SECOND position, where HEAD loses the pair rather than
    // merely renaming it - measured, HEAD returns two keys for every row here,
    // with `first` carrying the swallowed text.
    const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ["hyphen", "first=1 a-b=2 tail=3", ["first", "a-b", "tail"]],
      ["dot", "first=1 a.b=2 tail=3", ["first", "a.b", "tail"]],
      ["colon", "first=1 a:b=2 tail=3", ["first", "a:b", "tail"]],
      ["slash", "first=1 a/b=2 tail=3", ["first", "a/b", "tail"]],
      ["at", "first=1 @ts=2 tail=3", ["first", "@ts", "tail"]],
      ["dollar", "first=1 $id=2 tail=3", ["first", "$id", "tail"]],
      ["bracket", "first=1 a[0]=2 tail=3", ["first", "a[0]", "tail"]],
      ["hash", "first=1 k#1=2 tail=3", ["first", "k#1", "tail"]],
      ["percent", "first=1 k%2=2 tail=3", ["first", "k%2", "tail"]],
      ["plus", "first=1 a+b=2 tail=3", ["first", "a+b", "tail"]],
    ];

    for (const [label, line, expected] of cases) {
      const record = ext(line);
      expect(Object.keys(record), label).toEqual([...expected]);
      // The neighbour is clean. This is the assertion the key list cannot make:
      // under HEAD `first` read "1 <the whole swallowed pair>".
      expect(record["first"], label).toBe("1");
      expect(record["tail"], label).toBe("3");
    }
  });

  it("leaves an escaped equals alone - the control, not the fix", () => {
    // THE CARD NAMED THIS AS THE LIKELY CAUSE AND IT IS NOT ONE. Measured on
    // HEAD, both of these already paired correctly, because `\` is not `\w` so
    // the old lookahead could not read `\=` as a boundary. They are pinned
    // because the FIX could have broken them: a key class wide enough to hold
    // `\` splits here and invents a field named `y\`, measured on 153 lines of
    // the 200000-line corpus. The shipped class excludes `\` for exactly this.
    const spaced = ext("msg=x y\\=z dst=2.2.2.2");
    expect(Object.keys(spaced)).toEqual(["msg", "dst"]);
    expect(spaced["msg"]).toBe("x y\\=z");

    const adjacent = ext("msg=a\\=b dst=2.2.2.2");
    expect(Object.keys(adjacent)).toEqual(["msg", "dst"]);
    expect(adjacent["msg"]).toBe("a\\=b");

    // AND THE ESCAPE STILL SURVIVES UNEXPANDED - `\=` is not turned back into
    // `=`. That is a real gap, it is a VALUE question rather than a key one, and
    // it is filed rather than fixed here. Pinned as-is so the wart is on record
    // instead of being rediscovered as a regression.
    expect(spaced["msg"]).toContain("\\=");

    // The escape must not cost the pair AFTER it either. HEAD returned ONE key
    // for this line - the escaped value swallowed `a-b=2` on the way past.
    const thenHyphen = ext("msg=x y\\=z a-b=2");
    expect(Object.keys(thenHyphen)).toEqual(["msg", "a-b"]);
    expect(thenHyphen["msg"]).toBe("x y\\=z");
    expect(thenHyphen["a-b"]).toBe("2");
  });

  it("does not read an interior pipe as part of a key", () => {
    // A `|` inside the extension text is never part of a key NAME - it belongs to
    // a value the vendor wrote, or it is stray text. So a key must never absorb
    // one, and the widened class would have, which is the CEF form of DBT-79's
    // "widened class ate the syslog PRI".
    //
    // THIS COMMENT USED TO ARGUE FROM THE HEADER SPLIT - "always the residue of
    // the naive header split (parseCef splits on `|` and re-joins slice(7), and
    // the pack builds `__cefExtension` with the same two expressions)". DBT-98
    // made that premise false on both sides: the split is escape-aware now and
    // the extension is the verbatim remainder after the seventh unescaped pipe,
    // so an escaped `\|` in the header no longer leaks a `5|` into the extension.
    // The pins are unchanged - they feed these strings to the extension directly.
    //
    // Measured: with `|` in the key class these two name fields `a|b` and
    // `5|src`; HEAD names them `b` and `src`, and so does this parser. The whole
    // corpus difference between the two choices is 18907 lines.
    const artifact = ext("a|b=2 dst=3");
    expect(Object.keys(artifact)).toEqual(["b", "dst"]);

    const shifted = ext("5|src=1.1.1.1 dst=2.2.2.2");
    expect(Object.keys(shifted)).toEqual(["src", "dst"]);
    expect(shifted["src"]).toBe("1.1.1.1");

    // ...while a pipe inside a VALUE stays in the value, unchanged from HEAD.
    const inValue = ext("msg=a|b dst=2.2.2.2");
    expect(Object.keys(inValue)).toEqual(["msg", "dst"]);
    expect(inValue["msg"]).toBe("a|b");
  });

  it("starts a key after a non-space, not only after whitespace", () => {
    // THE ANCHOR'S OWN FAILURE MODE, which in DBT-79 shipped as a silent field
    // loss and was caught only by measurement. A whitespace-only anchor cannot
    // begin a key that is reached through an interior `|`, because there is no
    // space in front of it. Measured over the same 200000 lines, with everything
    // else identical to what ships: `(?:^|\s)` returns FEWER keys than HEAD on
    // 18828 of them; this anchor, on 0.
    //
    // CEF SEPARATES A LESSON KV COULD NOT. DBT-79's note reads as "the anchor
    // must be zero-width"; measured here, the zero-width but whitespace-only
    // `(?<!\S)` loses the SAME 18828 lines. Zero-width was never the property
    // that mattered - forbidding exactly the key class is.
    expect(Object.keys(ext("a|b=2 dst=3"))).toEqual(["b", "dst"]);
    expect(Object.keys(ext("=b=1 c=2"))).toEqual(["b", "c"]);
    expect(Object.keys(ext("a\\b=1 c=2"))).toEqual(["b", "c"]);
  });

  it("keeps an empty value as a pair", () => {
    // HEAD already did this and the widening had to not take it away - DBT-79
    // shipped a `+` on the value branch and lost `a[1]=`, and the lookahead
    // change here is exactly the kind of edit that could have repeated it.
    // Values are asserted, not just keys, so a future change cannot satisfy this
    // by inventing a placeholder for an empty field.
    const mid = ext("a=1 note= b=2");
    expect(Object.keys(mid)).toEqual(["a", "note", "b"]);
    expect(mid["note"]).toBe("");

    const trailing = ext("a=1 note=");
    expect(Object.keys(trailing)).toEqual(["a", "note"]);
    expect(trailing["note"]).toBe("");

    const several = ext("a= b= c=1");
    expect(Object.keys(several)).toEqual(["a", "b", "c"]);
    expect(several["a"]).toBe("");
    expect(several["b"]).toBe("");
  });

  it("keeps a value that contains spaces whole", () => {
    // THE REASON parseCef CANNOT SIMPLY REUSE parseKv's KV_PAIR, which is the
    // first thing this fix reached for. CEF values may contain spaces; KV's
    // bare-value class stops at one. Measured by driving KV_PAIR over this exact
    // extension: it returns cn1Label "Host" and msg "Blocked", dropping
    // "Severity" and "by rule 5" on the floor. The two parsers are the same idea
    // over different grammars and the patterns have to stay separate.
    const record = ext(
      "act=Block cn1Label=Host Severity cn1=3 msg=Blocked by rule 5",
    );
    expect(Object.keys(record)).toEqual(["act", "cn1Label", "cn1", "msg"]);
    expect(record["cn1Label"]).toBe("Host Severity");
    expect(record["msg"]).toBe("Blocked by rule 5");

    // A timestamp value with spaces, and a user agent with brackets and a
    // semicolon - both unchanged from HEAD, both plausible ways to break a
    // value-boundary change.
    const f5 = ext("dvchost=bigip x-forwarded-for=1.2.3.4 rt=Jan 01 2024 00:00:00");
    expect(Object.keys(f5)).toEqual(["dvchost", "x-forwarded-for", "rt"]);
    expect(f5["dvchost"]).toBe("bigip");
    expect(f5["rt"]).toBe("Jan 01 2024 00:00:00");

    const ua = ext(
      "src=10.0.0.1 requestClientApplication=Mozilla/5.0 (X11; Linux) dst=1.1.1.1",
    );
    expect(Object.keys(ua)).toEqual([
      "src",
      "requestClientApplication",
      "dst",
    ]);
    expect(ua["requestClientApplication"]).toBe("Mozilla/5.0 (X11; Linux)");
  });

  it("splits an unescaped equals inside a value, as it already did for words", () => {
    // A CHARACTERIZATION PIN ON THE PRICE OF THE FIX, not on a behaviour anyone
    // asked for. A value carrying an unescaped `=` after a space now splits
    // where HEAD left it alone:
    //   msg=see http://h/p?a=b more dst=1
    //     HEAD { msg: "see http://h/p?a=b more", dst: "1" }
    //     now  { msg: "see", "http://h/p?a": "b more", dst: "1" }
    //
    // IT IS NOT A NEW CLASS OF ERROR, and the control below is the proof: HEAD
    // splits the identical shape the moment the token is word-shaped. CEF
    // requires that `=` to be written `\=`, and when it is, the escape control
    // above shows the value stays whole.
    //
    // THE OTHER TWO REASONS THIS COMMENT USED TO GIVE WERE WRONG, and round 2
    // corrected them rather than reworded them. "The result gains a field rather
    // than losing one" was false for the `<=` family, which lost the rest of the
    // message - see the grouping-punctuation pins above. And "the invented name
    // is not a Cribl accessor, so the parse note names it" is true HERE only
    // because this particular name carries a `/` and a `.`; the note is asserted
    // below rather than assumed, and `retries`, `action`, `reason`, `ref` and
    // `src` are all invented names that ARE valid accessors and fire nothing.
    const control = ext("msg=see foo=bar more dst=1");
    expect(Object.keys(control)).toEqual(["msg", "foo", "dst"]);
    expect(control["msg"]).toBe("see");

    const now = ext("msg=see http://h/p?a=b more dst=1");
    expect(Object.keys(now)).toEqual(["msg", "http://h/p?a", "dst"]);
    const noted = parseSampleContent(`${HDR}msg=see http://h/p?a=b more dst=1`, {
      sourceName: "fw.log",
    });
    expect(noted.errors).toHaveLength(1);
    expect(noted.errors[0]).toContain("http://h/p?a");

    // A URL that is the WHOLE value has no interior space, so no boundary can
    // form inside it and nothing changed. This is the common shape by far.
    const whole = ext("request=http://h/p?a=b act=block");
    expect(Object.keys(whole)).toEqual(["request", "act"]);
    expect(whole["request"]).toBe("http://h/p?a=b");
  });

  it("does NOT trim prose grouping punctuation, so it cannot overwrite a field", () => {
    // DBT-80 ROUND 2, AND THE WORST THING IN THE WAVE. A CEF `msg` carries prose,
    // so the wider key class reaches `(retries` in "start (retries=3) end". The
    // first fix trimmed the opener to agree with parseKv on the spelling. That
    // put a PROSE token under a REAL FIELD'S NAME, and the assignment is
    // last-write-wins:
    //
    //   act=deny msg=blocked (act=drop) src=1.1.1.1
    //     HEAD    act="deny",  msg="blocked (act=drop)"
    //     trimmed act="drop)", msg="blocked"            <- the device said deny
    //     now     act="deny",  msg="blocked", "(act"="drop)"
    //
    // The trimmed row is a WRONG VALUE, not a missing one, and end to end all
    // three report the same three extension field names with `errors` empty.
    const overwrite = ext("act=deny msg=blocked (act=drop) src=1.1.1.1");
    expect(overwrite["act"]).toBe("deny");
    expect(Object.keys(overwrite)).toEqual(["act", "msg", "(act", "src"]);
    expect(overwrite["msg"]).toBe("blocked");
    expect(overwrite["(act"]).toBe("drop)");

    // The same shape with a different field, because "act" being special would
    // be a fine way to pass this by accident.
    const second = ext("suser=root msg=escalated (suser=admin) dst=8.8.8.8");
    expect(second["suser"]).toBe("root");
    expect(second["(suser"]).toBe("admin)");

    // KEEPING THE BRACKET IS WHAT MAKES IT LOUD, and this is the assertion the
    // key list cannot make. `retries` is a perfectly valid Cribl accessor, so the
    // trimmed spelling produced a clean-looking invented field and NO note;
    // `(retries` is not, so DBT-78's note names it.
    const record = ext("msg=start (retries=3) end=1");
    expect(Object.keys(record)).toEqual(["msg", "(retries", "end"]);
    expect(record["(retries"]).toBe("3)");
    const noted = parseSampleContent(`${HDR}msg=start (retries=3) end=1`, {
      sourceName: "fw.log",
    });
    expect(noted.errors).toHaveLength(1);
    expect(noted.errors[0]).toContain("(retries");

    // parseKv STILL TRIMS and therefore still disagrees, deliberately: its trim
    // is committed pinned behaviour with a blast radius of its own. Pinned so the
    // divergence is a recorded decision rather than a surprise - and note it has
    // the SAME overwrite, which is filed, not fixed.
    expect(Object.keys(parseKv("msg=start (retries=3) end=1")[0])).toEqual([
      "msg",
      "retries",
      "end",
    ]);
    expect(parseKv("act=deny msg=blocked (act=drop) src=1.1.1.1")[0]["act"]).toBe(
      "drop)",
    );

    // Pure punctuation before the `=` leaves nothing to name, and the pattern -
    // not a guard - is what refuses it: the key must hold a word character, so
    // `(=1` never forms a pair. Without the capture-side requirement this names
    // a field `(`; measured, `{"(": "1", "a": "2"}`.
    const punct = ext("(=1 a=2");
    expect(Object.keys(punct)).toEqual(["a"]);
  });

  it("keeps a message whole when it contains `<=`, `(=`, `[=` or `{=`", () => {
    // DBT-80 ROUND 2, AND THE ONE THAT DISCARDED TEXT OUTRIGHT. Those four two-character
    // sequences are exactly the grouping openers the trim removed, so the key
    // trimmed to EMPTY, the empty-key guard dropped the pair - and because a CEF
    // value spans to the NEXT key, the value capture took the whole rest of the
    // message with it. Measured through parseSampleContent:
    //
    //   msg=Disk usage <= 90 percent on /var suser=root
    //     HEAD     msg = "Disk usage <= 90 percent on /var"   errors []
    //     trimmed  msg = "Disk usage"                         errors []
    //
    // and "<= 90 percent on /var" appeared in NO field of the trimmed record.
    // VALUES ARE ASSERTED, not key lists: both records carry the same two keys.
    const shrunk = ext("msg=Disk usage <= 90 percent on /var suser=root");
    expect(Object.keys(shrunk)).toEqual(["msg", "suser"]);
    expect(shrunk["msg"]).toBe("Disk usage <= 90 percent on /var");
    expect(shrunk["suser"]).toBe("root");

    // The whole family, in one table, and THE TWO ASSERTIONS CATCH DIFFERENT
    // HALVES OF IT - measured row by row against the pattern this replaced:
    //
    //   <= (= [= {=   { msg: "a", dst: "1" }              same key list, text GONE
    //   >= != ~= := /= { msg: "a", ">": "b now", dst: "1" } extra garbage key
    //
    // So for the four openers the key list is IDENTICAL to a correct parse and
    // only the value assertion fires; for the other five only the key list does.
    // A table asserting one of the two would half-pass on the defect.
    const operators = ["<=", "(=", "[=", "{=", ">=", "!=", "~=", ":=", "/="];
    for (const op of operators) {
      const record = ext(`msg=a ${op} b now dst=1`);
      expect(Object.keys(record), op).toEqual(["msg", "dst"]);
      expect(record["msg"], op).toBe(`a ${op} b now`);
      expect(record["dst"], op).toBe("1");
    }
  });

  it("does not lose the last pair of a CRLF line", () => {
    // DBT-80 ROUND 2. NOT A REGRESSION - HEAD is byte-identical here - but it is the
    // card's own symptom and it was silent. parseCef split on "\n" alone, so
    // every line but the last kept its carriage return; `.` does not match `\r`
    // and `$` without the `m` flag does not match before it, so the final value
    // could never satisfy the lookahead. Measured, before the split changed:
    //
    //   ...|a=1 b=2 CRLF ...|a=3 b=4  ->  [{a:"1"}, {a:"3", b:"4"}]   b LOST
    //   ...|a=1     CRLF ...|a=3      ->  [{},      {a:"3"}]     whole ext LOST
    //
    // RECORD 0'S OWN KEYS AND VALUES, not the field list, because the field list
    // is what hides this: parseSampleContent UNIONS names across records, so the
    // last record - the one with no `\r` - contributes `b` and the operator sees
    // a complete schema over a record that lacks the field.
    const crlf = "CEF:0|V|P|1|100|n|5|a=1 b=2\r\nCEF:0|V|P|1|100|n|5|a=3 b=4";
    const records = parseCef(crlf);
    expect(records).toHaveLength(2);
    const first: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(records[0])) {
      if (!HEADER_FIELDS.includes(k)) first[k] = v;
    }
    expect(Object.keys(first)).toEqual(["a", "b"]);
    expect(first["a"]).toBe("1");
    expect(first["b"]).toBe("2");

    // The single-pair case, where the whole extension disappeared rather than
    // one field of it.
    const lone = parseCef("CEF:0|V|P|1|100|n|5|a=1\r\nCEF:0|V|P|1|100|n|5|a=3");
    expect(lone[0]["a"]).toBe("1");

    // ...and the raw event does not keep the carriage return either, since that
    // is what the generated pack is previewed against.
    const sourceLines: string[] = [];
    parseCef(crlf, sourceLines);
    expect(sourceLines).toEqual([
      "CEF:0|V|P|1|100|n|5|a=1 b=2",
      "CEF:0|V|P|1|100|n|5|a=3 b=4",
    ]);

    // THE UNIONED FIELD LIST IS THE MASK, pinned so the next reader can see why
    // the assertions above are on record 0 rather than on `parsed.fields`.
    const parsed = parseSampleContent(crlf, { sourceName: "fw.log" });
    expect(parsed.fields.map((f) => f.name)).toEqual([...HEADER_FIELDS, "a", "b"]);
    expect(parsed.errors).toEqual([]);
  });

  it("does not weld a carriage return into any sibling parser's value or raw event", () => {
    // THE SIBLINGS, pinned here because the CRLF sweep found them and this is the
    // file that records that sweep. They fail DIFFERENTLY from parseCef, which is
    // why one pin cannot stand for all of them:
    //
    //   parseLeef  splits pairs with indexOf("=")/slice, which neither knows nor
    //     cares what ends the line - so the LAST value kept the `\r`: b = "2\r".
    //     A corrupted value, not a missing pair.
    //   parseSyslog was already safe in its parsed FIELDS (`.` cannot match `\r`,
    //     so Message stopped short of it) and unsafe in `_raw` and in
    //     `sourceLines` - which becomes rawEvents, i.e. what the generated pack is
    //     previewed against.
    //   parseKv and parseCsv parse their FIELDS correctly through a CRLF file -
    //     KV's value class excludes whitespace, CSV trims every cell - and BOTH
    //     still pushed the carriage return into `sourceLines`. Calling them clean
    //     was this test's own first answer and it was wrong: the field assertion
    //     and the raw-event assertion are different questions, and only the second
    //     one reaches the pack.
    const leef = parseLeef(
      "LEEF:1.0|V|P|1|100|a=1\tb=2\r\nLEEF:1.0|V|P|1|100|a=3\tb=4",
    );
    expect(leef).toHaveLength(2);
    expect(leef[0]["b"]).toBe("2");

    const syslogLines: string[] = [];
    const syslog = parseSyslog(
      "Jan  1 12:00:00 host app[1]: hello\r\nJan  1 12:00:01 host app[2]: world",
      syslogLines,
    );
    expect(syslog).toHaveLength(2);
    expect(syslog[0]["_raw"]).toBe("Jan  1 12:00:00 host app[1]: hello");
    expect(syslogLines[0]).toBe("Jan  1 12:00:00 host app[1]: hello");

    // parseKv and parseCsv: the FIELDS were already right, and the RAW EVENT was
    // not. Both halves are asserted, in that order, because asserting only the
    // first is exactly the mistake that left these two out of the sweep.
    const kvLines: string[] = [];
    expect(parseKv("a=1 b=2\r\na=3 b=4", kvLines)[0]["b"]).toBe("2");
    expect(kvLines).toEqual(["a=1 b=2", "a=3 b=4"]);

    const csvLines: string[] = [];
    expect(parseCsv("a,b,c\r\n1,2,3\r\n4,5,6", csvLines)[0]["c"]).toBe("3");
    expect(csvLines).toEqual(["1,2,3", "4,5,6"]);

    // ...and through the public entry, where the raw event becomes what the pack
    // is built against.
    const parsed = parseSampleContent(
      "CEF:0|V|P|1|100|n|5|a=1 b=2\r\nCEF:0|V|P|1|100|n|5|a=3 b=4",
      { sourceName: "fw.log" },
    );
    expect(parsed.rawEvents).toEqual([
      "CEF:0|V|P|1|100|n|5|a=1 b=2",
      "CEF:0|V|P|1|100|n|5|a=3 b=4",
    ]);
  });

  it("gives a positional sample the same raw events a CEF sample gets", () => {
    // GEN-6, pinned HERE as an ASYMMETRY because that is how it was found:
    // parseByFormat threaded `sourceLines` into five parsers and not into the
    // positional case, so `rawEventsFor`'s all-or-nothing length check failed and
    // every positional sample fell back to JSON.stringify.
    //
    // The consequence is not cosmetic. pack-assembly writes these strings as the
    // pack's raw events, so the pack's own pipeline was previewed against a JSON
    // object where the source sends a whitespace-separated line - and running the
    // generated positional extract over that string recovers ONE field of
    // fourteen, because JSON.stringify emits no spaces for the split to find.
    const vpcLines = [
      "2 123456789010 eni-abc 10.0.0.1 10.0.0.2 20641 22 6 20 4249 1418530010 1418530070 ACCEPT OK",
      "2 123456789010 eni-abc 10.0.0.3 10.0.0.4 20641 22 6 20 4249 1418530010 1418530070 REJECT OK",
    ];
    const positional = parseSampleContent(vpcLines.join("\n"), {
      sourceName: "vpc.log",
    });
    expect(positional.format).toBe("positional");
    expect(positional.eventCount).toBe(2);
    // THE ORIGINAL LINE, not a re-serialization. Asserted by equality with the
    // input rather than by `not.toContain("{")` - the JSON form also contains
    // every one of these values, so a weaker assertion passes on the defect.
    expect(positional.rawEvents).toEqual(vpcLines);
    // The count the defect actually costs: 14 whitespace columns from the shipped
    // raw event, and 1 from the JSON string it used to ship.
    expect(positional.rawEvents[0].split(/\s+/)).toHaveLength(14);
    expect(JSON.stringify(positional.records[0]).split(/\s+/)).toHaveLength(1);

    // The CEF control, on the same assertion, so a future change that breaks the
    // pairing for BOTH cannot pass by symmetry.
    const cefLines = [
      "CEF:0|V|P|1|100|n|5|a=1 b=2",
      "CEF:0|V|P|1|100|n|5|a=3 b=4",
    ];
    const cef = parseSampleContent(cefLines.join("\n"), { sourceName: "fw.log" });
    expect(cef.rawEvents).toEqual(cefLines);

    // An UNRECOGNISED positional file pairs too - the accumulator is pushed where
    // the record is emitted, not where the columns happen to be nameable.
    const unnamed = ["alpha beta gamma delta", "epsilon zeta eta theta"];
    const unnamedParsed = parseSampleContent(unnamed.join("\n"), {
      sourceName: "p.log",
    });
    expect(unnamedParsed.format).toBe("positional");
    expect(unnamedParsed.rawEvents).toEqual(unnamed);
  });

  it("scans a bare token once, not once per character", () => {
    // A TIMING PIN, and unlike DBT-79's it guards a defect HEAD ALREADY HAS
    // rather than one the fix could introduce. The shape is a token with no `=`
    // sitting BEFORE the first pair, which is the only place the key class has
    // to scan text that no value has claimed.
    //
    // Measured on this machine, through this function, at 64000B:
    //   word-only token   HEAD 5413ms   unanchored 6475ms   this 0.9ms
    // and the growth is the real evidence - 16000B/32000B/64000B/128000B cost
    // HEAD 336/1296/5413/20068ms (quadratic, as 4x per doubling predicts) and
    // this pattern 0.2/0.4/0.9/1.4ms. parseSampleContent runs SYNCHRONOUSLY on
    // the samples screen, so HEAD's are seconds of frozen UI.
    //
    // The budget sits far nearer the fix than the defect: a machine would have
    // to be ~1000x slower than this one to fail spuriously, or ~5x faster than
    // it to let HEAD's behaviour through.
    const WORD =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
    let token = "";
    for (let i = 0; i < 64000; i++) token += WORD[(i * 7) % WORD.length];
    const line = `${HDR}${token} act=deny srcip=10.0.0.1`;

    const started = performance.now();
    const records = parseCef(line);
    const elapsed = performance.now() - started;

    // CORRECTNESS FIRST, so a pin that "passes" by parsing nothing is not a
    // pass: the bare token contributes no pair and the two real ones survive.
    expect(records).toHaveLength(1);
    const keys = Object.keys(records[0]).filter(
      (k) => !HEADER_FIELDS.includes(k),
    );
    expect(keys).toEqual(["act", "srcip"]);
    expect(elapsed).toBeLessThan(1000);
  }, 30_000);

  it("reports the fields end to end, and says the names are unaddressable", () => {
    // The whole point, through the public entry the app actually calls. Measured
    // on HEAD this produced TEN fields ending [..., "ip", "action", "bytes"] and
    // ZERO parse notes: the operator saw a clean parse of an event that had lost
    // a field and had another field's text pasted into a value.
    const line =
      "CEF:0|Palo Alto Networks|PAN-OS|10.2|end|TRAFFIC|3|src-ip=10.0.0.1 dst-ip=8.8.8.8 action=ACCEPT bytes=10";
    const parsed = parseSampleContent(line, { sourceName: "fw.log" });

    expect(parsed.format).toBe("cef");
    expect(parsed.fields.map((f) => f.name)).toEqual([
      ...HEADER_FIELDS,
      "src-ip",
      "dst-ip",
      "action",
      "bytes",
    ]);
    // Recovering the fields is only half the answer - these names are still not
    // Cribl accessors, and the parse says so rather than leaving it to a build
    // failure several screens later (DBT-78).
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("src-ip");
    expect(parsed.errors[0]).toContain("dst-ip");

    // AND THE NOTE MUST NOT FIRE ON CLEAN NAMES. DBT-79's widened key class
    // welded a syslog prefix into a name and then accused the vendor of it; the
    // control is cheap and that false positive was not.
    const clean = parseSampleContent(`${HDR}first=1 second=2 tail=3`, {
      sourceName: "fw.log",
    });
    expect(clean.fields.map((f) => f.name)).toEqual([
      ...HEADER_FIELDS,
      "first",
      "second",
      "tail",
    ]);
    expect(clean.errors).toEqual([]);
  });

  it("keeps the raw event as it arrived, syslog header included", () => {
    // `sourceLines` becomes `rawEvents`, which is what the generated pipeline is
    // built against and what the operator is shown as the vendor's bytes. The
    // extension change must not touch it, and the syslog-wrapped form is the one
    // where a parser is tempted to hand back its own reconstruction.
    const line =
      "<134>host1 CEF:0|V|P|1|100|n|5|src-ip=10.0.0.1 dst=8.8.8.8 act=allow";
    const sourceLines: string[] = [];
    const records = parseCef(line, sourceLines);

    expect(sourceLines).toEqual([line]);
    expect(records[0]["_syslogHeader"]).toBe("<134>host1");
    expect(
      Object.keys(records[0]).filter(
        (k) => !HEADER_FIELDS.includes(k) && k !== "_syslogHeader",
      ),
    ).toEqual(["src-ip", "dst", "act"]);

    const parsed = parseSampleContent(line, { sourceName: "fw.log" });
    expect(parsed.format).toBe("cef");
    expect(parsed.rawEvents).toEqual([line]);
  });
});
