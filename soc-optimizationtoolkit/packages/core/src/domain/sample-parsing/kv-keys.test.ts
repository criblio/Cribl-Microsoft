/**
 * DBT-79 - a key=value pair must not lose the part of its key before a hyphen.
 *
 * THE MEASURED DEFECT, verbatim from the card and reproduced against the shipped
 * parser before anything was changed:
 *
 *   src-ip=1.1.1.1 dst-ip=2.2.2.2 action=ACCEPT bytes=10
 *     -> { ip: "2.2.2.2", action: "ACCEPT", bytes: "10" }
 *
 * Four fields in, three out. `src-` and `dst-` discarded, the two distinct
 * fields COLLIDED onto `ip`, and the second silently overwrote the first. No
 * error, no note, and no test in the suite noticed - which is why the counts
 * below are asserted exactly rather than by presence. A pin reading
 * `expect(record.action).toBeDefined()` would have passed throughout the defect.
 *
 * The cause was recorded as UNKNOWN on the card, so the survey came first: see
 * the note on KV_PAIR in parsers.ts for the full character-by-character result
 * and which characters truncate versus drop the pair outright.
 *
 * THE FIX THEN BROKE TWO THINGS OF ITS OWN, and the last four cases in this file
 * are the pins for those rather than for the original defect. Both came from the
 * same cause: the widened key class could START MID-TOKEN, which `\w+` could not.
 *
 *   It ate a syslog PRI into the first key (`<189>date` -> `189>date`), which
 *     destroyed the field name, moved the timestamp election off `date`, and
 *     made DBT-78's note fire as a FALSE POSITIVE about a name this parser had
 *     invented. FortiGate's default wire format, so not a corner.
 *   It made the scan quadratic in the length of a token with no `=` in it -
 *     seconds of frozen UI on the samples screen, invisible to every correctness
 *     assertion because the ANSWER stayed right.
 *
 * AND THEN THE ANCHOR THAT FIXED THOSE TWO REINTRODUCED DBT-79 ITSELF. `(?:^|\s)`
 * let a key begin only after whitespace, so a pair following a QUOTED value -
 * `msg="login ok",id=7` - was skipped and the field was gone with `errors` still
 * empty. That is the third pin, and its lesson is why the others are worded the
 * way they are: the equivalence check that cleared the anchor compared it against
 * a lookbehind on all 16 lines in this file and found 0 disagreements, which was
 * true and useless, because not one of those 16 lines had a key adjacent to a
 * quoted value. A corpus that cannot express the defect cannot clear a fix.
 *
 * None of the three was caught by the green suite that shipped the widened class,
 * which is the argument for pinning the measured pair (name AND note count), for
 * the timing case being here at all, and for the quoted-value case carrying its
 * own controls.
 */

import { describe, expect, it } from "vitest";
import { parseKv } from "./parsers";
import { parseSampleContent } from "./parse-sample";
import { parseKvLine } from "./splitting";
import { DISCRIMINATOR_FIELDS } from "./discriminators";

describe("parseKv key capture (DBT-79)", () => {
  it("keeps both hyphenated keys distinct - the reported line, exactly", () => {
    const records = parseKv(
      "src-ip=1.1.1.1 dst-ip=2.2.2.2 action=ACCEPT bytes=10",
    );

    expect(records).toHaveLength(1);
    // FOUR keys, in order, spelled as the vendor spelled them. The defect
    // produced exactly three, so the length assertion alone catches it - the
    // key list is here because "three of the right names" and "three because
    // two collided" are different failures and should not read the same.
    expect(Object.keys(records[0])).toEqual([
      "src-ip",
      "dst-ip",
      "action",
      "bytes",
    ]);
    // The collision itself: under the defect BOTH of these read "2.2.2.2"
    // through the single surviving `ip` key, so the source address was gone.
    expect(records[0]["src-ip"]).toBe("1.1.1.1");
    expect(records[0]["dst-ip"]).toBe("2.2.2.2");
  });

  it("keeps every key character the survey found breaking", () => {
    // One line per character so a regression names the character that broke.
    // SIX of the seven share a trailing word run between their two keys, so the
    // pre-fix parser collapsed each pair onto ONE key - measured against this
    // directory exported from HEAD, `src-ip=... dst-ip=...` yielded [ip] and
    // `a.b=1 c.b=2` yielded [b]. That is what the count assertion is for.
    //
    // THE BRACKET ROW IS NOT ONE OF THE SIX, and saying otherwise is how a
    // characterization row gets mistaken for a regression pin. Measured on HEAD
    // it ALREADY yields [a[0], a[1]] - identical to now - because no `\w+` sits
    // before either `=`, so the old regex matched nothing on the line at all and
    // the whitespace fallback handed back both keys whole. The bracket defect is
    // pinned by the NEXT test, which puts a matching pair alongside so that
    // fallback cannot run; this row only records that the two agree.
    const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ["hyphen", "src-ip=1.1.1.1 dst-ip=2.2.2.2", ["src-ip", "dst-ip"]],
      ["dot", "a.b=1 c.b=2", ["a.b", "c.b"]],
      ["colon", "a:b=1 c:b=2", ["a:b", "c:b"]],
      ["slash", "a/b=1 c/b=2", ["a/b", "c/b"]],
      ["at", "@ts=1 a@ts=2", ["@ts", "a@ts"]],
      ["dollar", "$id=1 a$id=2", ["$id", "a$id"]],
      ["bracket", "a[0]=1 a[1]=2", ["a[0]", "a[1]"]],
    ];

    for (const [label, line, expected] of cases) {
      const records = parseKv(line);
      expect(records, label).toHaveLength(1);
      expect(Object.keys(records[0]), label).toEqual([...expected]);
    }
  });

  it("does not drop a bracketed pair when other pairs on the line match", () => {
    // The bracket case was a DIFFERENT failure from truncation and needs its own
    // pin: no `\w+` sits immediately before `a[0]=`, so the old regex matched
    // nothing there and the pair vanished ENTIRELY - but only when some other
    // pair on the line matched, because a line with no matches at all fell
    // through to the whitespace fallback, which kept the key intact. The two
    // paths inside one function disagreed about the same input.
    const withCompanion = parseKv("a[0]=1 a[1]=2 action=ACCEPT");
    expect(Object.keys(withCompanion[0])).toEqual(["a[0]", "a[1]", "action"]);

    const alone = parseKv("a[0]=1");
    expect(Object.keys(alone[0])).toEqual(["a[0]"]);
    // THE AGREEMENT is the assertion: the same key spelled the same way whether
    // or not a second pair shares the line.
    expect(Object.keys(alone[0])[0]).toBe(Object.keys(withCompanion[0])[0]);
  });

  it("trims grouping punctuation the sentence owns, not the field", () => {
    // A syslog message can wrap a pair in parentheses; the paren belongs to the
    // prose. Trimming LEADING openers only - a trailing subscript like a[0] is
    // part of the name and must survive, which the case above pins.
    const records = parseKv("msg=start (retries=3) end=1");
    expect(Object.keys(records[0])).toEqual(["msg", "retries", "end"]);
    // The CLOSING paren is still part of the value, unchanged from before this
    // fix and deliberately not touched by it: the value class is "run of
    // non-comma non-space", and narrowing it to balance brackets would change
    // how every ordinary value ends. Pinned as it is so the wart is on record
    // rather than discovered again.
    expect(records[0]["retries"]).toBe("3)");
  });

  it("still parses the ordinary shapes it always did", () => {
    // Non-regression, and deliberately the shapes the widened key class could
    // plausibly have broken: an unquoted value containing `=`, a quoted value
    // containing spaces, and the comma rule (a comma splits only when NOT
    // followed by whitespace).
    const records = parseKv(
      'user=admin url=http://h/p?a=b msg="login ok" list=a,b tail=x, y=2',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      user: "admin",
      url: "http://h/p?a=b",
      msg: "login ok",
      list: "a,b",
      tail: "x",
      y: "2",
    });
  });

  it("does not weld a syslog priority onto the first key", () => {
    // THE REGRESSION THE WIDENED KEY CLASS INTRODUCED, and the reason this pin
    // exists at all. `<189>date=...` is FortiGate's DEFAULT wire format: a bare
    // syslog PRI with the first pair welded straight on, no space. `\w+` could
    // not start there so it skipped to `date`; `[^\s=,"]+` swallowed the prefix
    // and the leading-grouping trim removed only the `<`, leaving `189>date`.
    //
    // Measured before the fix, on this exact line:
    //   fields ["189>date","eventtime","srcip"], timestampField "eventtime",
    //   1 parse note - versus the shipped ["date","eventtime","srcip"] / "date"
    //   / 0 notes.
    const line =
      "<189>date=2024-01-01T00:00:00Z eventtime=1557771816 srcip=10.0.0.1";

    expect(Object.keys(parseKv(line)[0])).toEqual([
      "date",
      "eventtime",
      "srcip",
    ]);

    const parsed = parseSampleContent(line, { sourceName: "fortigate.log" });
    expect(parsed.format).toBe("kv");
    expect(parsed.fields.map((f) => f.name)).toEqual([
      "date",
      "eventtime",
      "srcip",
    ]);
    // THE TIMESTAMP ELECTION IS PART OF THE DAMAGE, not a bonus assertion.
    // `guessTimestampField` scores a named-and-typed candidate first, and
    // `candidateKey("189>date")` is "189date", which is in no list - so the
    // corrupted name dropped `date` out of the top tier and the election moved
    // to `eventtime`. parse-sample.ts's own header names "date" as the
    // FortiGate case it is there to get right.
    expect(parsed.timestampField).toBe("date");
    // ZERO NOTES, and this half is not optional. With the prefix welded on, the
    // DBT-78 note fired as a FALSE POSITIVE accusing the vendor of a field name
    // this parser had manufactured. A pin asserting only the key list passes
    // while the operator is still being told their sample is broken.
    expect(parsed.errors).toEqual([]);
  });

  it("keeps the raw event as it arrived, prefix and all", () => {
    // The strip is for EXTRACTION only. `sourceLines` becomes `rawEvents`, which
    // is what the generated pipeline is built against and what the operator is
    // shown as "the vendor's bytes" - rewriting it would make the app claim it
    // received something it did not.
    // THREE pairs, not two, and the reason is worth writing down: with two,
    // `detectSampleFormat` returns "syslog" (its KV threshold is >= 3 pairs),
    // parseKv is never called, and this pin passes on an empty `rawEvents`
    // without ever reaching the code it claims to test. Measured while writing
    // it - the two-pair version asserted nothing.
    const line = "<189>date=2024-01-01 eventtime=1557771816 srcip=10.0.0.1";
    const sourceLines: string[] = [];
    parseKv(line, sourceLines);
    expect(sourceLines).toEqual([line]);

    const parsed = parseSampleContent(line, { sourceName: "fg.log" });
    expect(parsed.format).toBe("kv");
    expect(parsed.rawEvents).toEqual([line]);
  });

  it("starts a key after a quoted value, not only after whitespace", () => {
    // THE ANCHOR'S OWN SILENT FIELD LOSS - DBT-79's failure mode, reintroduced by
    // the fix for DBT-79 and caught only by measurement. The first anchor was
    // `(?:^|\s)`, so a key could begin only after WHITESPACE. A quoted value ends
    // ON its closing quote, so `lastIndex` lands on the `,` in `msg="ok",id=7` or
    // on the quote itself in `a="1"b="2"` - neither is a space, `exec` skipped
    // forward to the next one, and the pair in between vanished.
    //
    // Measured through parseSampleContent against this directory exported from
    // HEAD, before the anchor was replaced:
    //   user=root msg="login ok",id=7 act=deny
    //     HEAD   4 fields [user, msg, id, act]   0 notes
    //     broken 3 fields [user, msg, act]       0 notes
    //   a="1"b="2" c=3 d=4   HEAD [a,b,c,d] -> broken [a,c,d]
    //   msg="a b"key=1 z=2   HEAD [msg,key,z] -> broken [msg,z]
    //
    // Only a QUOTED value can strand a key: a bare value's `,(?=\S)` swallows
    // `,X`, so the comma never survives to be a predecessor. That is why the
    // existing non-regression case above - `msg="login ok" list=a,b` - misses
    // this by one space, and why these lines are asserted by exact key list and
    // VALUE rather than by presence.
    const afterComma = parseKv('user=root msg="login ok",id=7 act=deny');
    expect(Object.keys(afterComma[0])).toEqual(["user", "msg", "id", "act"]);
    expect(afterComma[0]["id"]).toBe("7");
    expect(afterComma[0]["msg"]).toBe("login ok");

    const afterQuote = parseKv('a="1"b="2" c=3 d=4');
    expect(Object.keys(afterQuote[0])).toEqual(["a", "b", "c", "d"]);
    expect(afterQuote[0]["b"]).toBe("2");

    expect(Object.keys(parseKv('msg="a b"key=1 z=2')[0])).toEqual([
      "msg",
      "key",
      "z",
    ]);

    // AN EMPTY VALUE IS A PAIR, and this case is the one the anchor work nearly
    // shipped. The value branch was `+`, so `a[1]=` matched nothing at all.
    //
    // Measured against this directory exported from HEAD, over 400,000 generated
    // lines: `a[0]=1 a[1]=` returned [a[0]] here and [a[0], a[1]] on HEAD - the
    // COMMITTED parser was better, by accident. Its `\w+` key class could not
    // match before the `]` in `a[0]=`, so it matched ZERO pairs on that line,
    // which is the only condition under which parseKv's whitespace fallback
    // runs, and the fallback returned both keys whole. Widening the key class
    // switched that fallback off and exposed the `+`.
    //
    // Both halves are asserted because they fail for different reasons: the
    // bracket line is the regression, and `user=root note=` is the PRE-EXISTING
    // drop that HEAD has too and that the same `*` closes. Values are asserted,
    // not just keys, so a future change cannot satisfy this by inventing a
    // placeholder value for an empty field.
    const emptyAfterBracket = parseKv("a[0]=1 a[1]=");
    expect(Object.keys(emptyAfterBracket[0])).toEqual(["a[0]", "a[1]"]);
    expect(emptyAfterBracket[0]["a[1]"]).toBe("");

    const emptyTrailing = parseKv("user=root note=");
    expect(Object.keys(emptyTrailing[0])).toEqual(["user", "note"]);
    expect(emptyTrailing[0]["note"]).toBe("");

    // The character before a key may also be `=`, which is how the class ended up
    // as "everything the key class excludes" rather than a hand-picked `[\s",]`.
    // Measured: HEAD yields b, c, d here; a `[\s",]` anchor yields only c and d.
    expect(Object.keys(parseKv("=b=1 c=2 d=3")[0])).toEqual(["b", "c", "d"]);

    // CONTROLS - shapes the wider anchor must NOT change, each measured identical
    // on HEAD, on the broken anchor and now. A key still cannot start mid-token,
    // and `;` and `|` still belong to the value.
    expect(Object.keys(parseKv('"a"=1 b=2')[0])).toEqual(["b"]);
    expect(Object.keys(parseKv("a=1;b=2")[0])).toEqual(["a"]);
    expect(Object.keys(parseKv("a=1|b=2")[0])).toEqual(["a"]);

    // AND THE SILENCE IS WHY THE KEY LISTS ABOVE ARE ASSERTED EXACTLY. The
    // whitespace fallback in parseKv runs only when the regex matched ZERO pairs,
    // so a PARTIAL loss produces no note at all - measured, `errors` was EMPTY
    // under the broken anchor too, while the operator's event was a field short.
    // This assertion therefore catches NOTHING by itself; it is here to record
    // that nothing was ever going to warn us, and to pin the other half - a
    // correct parse of accessor-safe names must not invent a note either.
    const parsed = parseSampleContent(
      'user=root msg="login ok",id=7 act=deny',
      { sourceName: "fw.log" },
    );
    expect(parsed.format).toBe("kv");
    expect(parsed.fields.map((f) => f.name)).toEqual([
      "user",
      "msg",
      "id",
      "act",
    ]);
    expect(parsed.errors).toEqual([]);
  });

  it("scans a long bare token once, not once per character", () => {
    // A TIMING PIN, which nothing else in this file is, because the defect it
    // guards is invisible to every correctness assertion - the parse was always
    // RIGHT, just quadratically slow, and parseSampleContent runs synchronously
    // on the samples screen.
    //
    // The shape: one token with no `=` in it, so it is not the value of any pair
    // and the key class has to scan it. Greedy `[^\s=,"]+` ran to the end of the
    // token from EVERY start offset, backtracked looking for `=`, failed, and
    // `exec` advanced one character and repeated. `\w+` never did this on this
    // input because `.` and `-` broke each scan short. Base64url with dotted
    // segments is what a JWT logged raw inside a KV line looks like.
    //
    // Re-measured 2026-09-03 on this machine, after the anchor was replaced with
    // the lookbehind that ships now, because a fix for either half of this pair
    // can restore the other:
    //   64000B  no anchor  6370ms   this anchor 1.1ms
    //   96000B  no anchor 14776ms   this anchor 1.3ms
    //  128000B  no anchor 24476ms   this anchor 1.6ms
    // The budget sits between those, far nearer the fix - a machine would have to
    // be ~900x slower than this one to fail spuriously, or ~6x faster than it to
    // let the defect through. The GROWTH is the real evidence: doubling the token
    // from 64KB to 128KB costs 3.8x the time with no anchor - quadratic, as 4x
    // predicts - and 1.5x with it.
    const B64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let token = "";
    for (let i = 0; i < 64000; i++) token += B64[(i * 7) % B64.length];
    const third = Math.floor(token.length / 3);
    const jwtish = `${token.slice(0, third)}.${token.slice(third, 2 * third)}.${token.slice(2 * third)}`;
    const line = `action=deny reason=bad-token ${jwtish} srcip=10.0.0.1`;

    const started = performance.now();
    const records = parseKv(line);
    const elapsed = performance.now() - started;

    // Correctness first, so a pin that "passes" by parsing nothing is not a
    // pass: the bare token contributes no pair, the three real ones survive.
    expect(Object.keys(records[0])).toEqual(["action", "reason", "srcip"]);
    expect(elapsed).toBeLessThan(1000);
  }, 30_000);

  it("leaves the splitter's probe truncating, on purpose and in this order", () => {
    // A CHARACTERIZATION PIN ON A DIVERGENCE, not on a behaviour anyone wants.
    // `parseKv` and `parseKvLine` used to agree; since DBT-79 they do not, and
    // the comment on each says so. This makes the claim checkable, because a
    // comment about two functions rots the moment someone edits one of them.
    expect(Object.keys(parseKv("src-ip=1.1.1.1 action=A")[0])).toEqual([
      "src-ip",
      "action",
    ]);
    expect(Object.keys(parseKvLine("src-ip=1.1.1.1 action=A"))).toEqual([
      "ip",
      "action",
    ]);

    // WHY THE TRUNCATION STAYS. The probe exists to pick a DISCRIMINATOR, and
    // the truncated spelling is the one on the list: `log-type` truncates to
    // `type`, which is in the high-confidence prefix, so a single distinct
    // value selects it. Today's split works BY ACCIDENT.
    expect(Object.keys(parseKvLine("log-type=TRAFFIC action=A"))).toContain(
      "type",
    );
    expect(DISCRIMINATOR_FIELDS).toContain("type");
    // The correct key is in NO list, which is the whole hazard: widen the probe
    // and this field stops selecting, the split falls back, and every stored
    // sample is re-keyed - a log type is the tagged-sample store's key.
    expect(DISCRIMINATOR_FIELDS).not.toContain("log-type");

    // SO WHEN THIS PIN FAILS, read the order before "fixing" it: hyphenated
    // aliases go into DISCRIMINATOR_FIELDS FIRST, the probe's key class second.
    // Reversing that silently re-keys an operator's samples.
  });

  it("reports four fields end to end, and says the names are unaddressable", () => {
    // The whole point, through the public entry the app actually calls. Under
    // the defect this produced THREE fields and no note at all: the operator saw
    // a clean parse of an event that had lost a value.
    const parsed = parseSampleContent(
      "src-ip=1.1.1.1 dst-ip=2.2.2.2 action=ACCEPT bytes=10",
      { sourceName: "vpc.log" },
    );

    expect(parsed.format).toBe("kv");
    expect(parsed.fields.map((f) => f.name)).toEqual([
      "src-ip",
      "dst-ip",
      "action",
      "bytes",
    ]);
    // Recovering the field is only half the answer - these names are still not
    // Cribl accessors, and the parse says so instead of leaving it to a build
    // failure several screens later (DBT-78).
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("src-ip");
    expect(parsed.errors[0]).toContain("dst-ip");
  });
});
