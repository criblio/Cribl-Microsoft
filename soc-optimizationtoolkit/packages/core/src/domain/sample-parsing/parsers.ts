/**
 * Format-specific parsers - ported near-verbatim from the legacy
 * sample-parser.ts (IS/sample-parser.ts). Each turns raw text into an array of
 * record objects; field discovery and type inference happen in parse-sample.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 *
 * ORIGINAL-LINE CAPTURE (2026-08-18): every LINE-ORIENTED parser takes an
 * optional `sourceLines` accumulator and pushes the input line that produced
 * each record, AT THE POINT the record is produced - so a parser that FILTERS a
 * line (parseCef skips lines without "CEF:", parseCsv drops single-field rows)
 * cannot drift the pairing. That is what lets parseSampleContent keep the raw
 * vendor bytes instead of a re-serialization; see its `rawEvents` note. JSON and
 * NDJSON deliberately do not participate: re-serializing a parsed JSON record
 * loses nothing a downstream pipeline can observe.
 *
 * `parseCsvWithHeaders` (external header resolution) is deliberately NOT here -
 * that is Unit 12 (headerless CSV + vendor feed-config resolution). This module
 * ports only the INTERNAL headerless parseCsv used by parseSampleContent's
 * dispatch (PAN-OS positional column naming).
 */

import { positionalFieldName } from "./models";
import { parsePositional } from "./positional";
import type { SampleFormat } from "./models";
import { panosHeadersFor, panosLogTypeFrom } from "./panos-dictionary";

// ---------------------------------------------------------------------------
// Syslog prefix stripping (shared by parseCsv and capture inner detection)
// ---------------------------------------------------------------------------

/**
 * Strip a syslog prefix from a line to reach the data content. Handles:
 * - RFC 5424: "<14>1 2024-01-01T12:00:00Z host app - - <data>"
 * - RFC 3164: "Jan  1 12:00:00 host <data>"
 * - PAN-OS simple: "Apr 08 12:45:16 PA-VM 1,2020/05/07,..." -> "1,2020/05/07,..."
 *
 * Ported verbatim from legacy stripSyslogPrefix. The PAN-OS branch is the
 * load-bearing one for the capture >=5-comma CSV threshold (a syslog-wrapped
 * PAN-OS CSV line must have its prefix removed before commas are counted).
 */
export function stripSyslogPrefix(line: string): string {
  // RFC 5424 has SIX fields after VERSION: TIMESTAMP, HOSTNAME, APP-NAME,
  // PROCID, MSGID, STRUCTURED-DATA. This consumed only five until 2026-08-25,
  // so the structured-data element was left glued to the message and
  // `<13>1 <ts> host app - - - {"src":"1.2.3.4"}` stripped to `- {"src":...}`.
  //
  // It went unnoticed because the only caller that could see it was PAN-OS, and
  // there the damage lands in positional field 0 - which every dictionary lists
  // as `future_use1` and skips. A JSON payload has no such luck: the leftover
  // `- ` means the line no longer starts with `{`, so it parsed to nothing.
  // The existing pins covered only the non-standard PAN-OS fallback branch
  // below, never this one.
  //
  // STRUCTURED-DATA is OPTIONAL here because senders that omit it exist, and
  // matching either `-` or a `[...]` element keeps a real SD block from being
  // mistaken for the message.
  const rfc5424 = line.match(
    /^<\d+>\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+(?:\s+(?:-|\[[^\]]*\]))?\s+(.*)/,
  );
  if (rfc5424) {
    return rfc5424[1];
  }

  const rfc3164 = line.match(/^\w{3}\s+\d+\s+\d+:\d+:\d+\s+\S+\s+(.*)/);
  if (rfc3164) {
    return rfc3164[1];
  }

  // PAN-OS: strip everything before the "1,YYYY/MM/DD..." positional start.
  const panOs = line.match(/(\d+,\d{4}\/\d{2}\/\d{2}.*)/);
  if (panOs) {
    return panOs[1];
  }

  return line;
}

// ---------------------------------------------------------------------------
// PAN-OS positional column names (headerless CSV)
// ---------------------------------------------------------------------------
//
// Unit 11 kept a local TRAFFIC/THREAT column copy here as a stopgap; Unit 12
// deleted it and this headerless path now consumes the ONE canonical dictionary
// (see panos-dictionary.ts). The drifted index 20 therefore resolves to the
// canonical 'logset' (not the old 'log_action') - the conscious reconciliation
// is pinned by panos-dictionary.test.ts.

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse a JSON array or a single JSON object into record(s). */
export function parseJson(content: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(content.trim());
  if (Array.isArray(parsed)) {
    return parsed as Array<Record<string, unknown>>;
  }
  return [parsed as Record<string, unknown>];
}

/** Parse newline-delimited JSON (one object per line; bad lines skipped). */
export function parseNdjson(content: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n")) {
    // A PARSER STRIPS THE TRANSPORT PREFIX IT MIGHT ARRIVE BEHIND, and until
    // 2026-08-25 this one did not while parseCsv did. The asymmetry was the
    // whole defect: a JSON payload shipped over syslog
    // (`<13>1 ... cribl-hw01 app - - - {"src":"1.2.3.4"}`) failed the
    // startsWith("{") test, `continue` skipped it, and the sample parsed to
    // ZERO records - while the same payload as CSV parsed fine, because
    // parseCsv's headerless branch calls stripSyslogPrefix before splitting.
    //
    // ONLY WHEN IT PROVES ITSELF. The stripped form is used only if it actually
    // JSON.parses, so this cannot reinterpret an ordinary syslog line that
    // happens to contain a brace - which is the same self-evidencing rule the
    // detector applies, and the reason both can now agree on these bytes.
    const trimmed = line.trim();
    const candidate = trimmed.startsWith("{")
      ? trimmed
      : stripSyslogPrefix(trimmed).trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      records.push(JSON.parse(candidate) as Record<string, unknown>);
    } catch {
      // Skip malformed lines (legacy filtered them out silently).
    }
  }
  return records;
}

/**
 * Parse CSV. Detects whether the first line is a header (all identifier-like
 * fields) or headerless positional data (PAN-OS syslog). Ported verbatim from
 * legacy parseCsv.
 */
export function parseCsv(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  // `\r?\n`, not `\n` - see the CRLF note on {@link parseCef}. The CELLS were
  // always safe here (every one is trimmed), but the line pushed into
  // `sourceLines` is the sample's raw event and it carried the carriage return
  // on every line but the last.
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const firstFields = lines[0]
    .split(",")
    .map((header) => header.trim().replace(/^"|"$/g, ""));
  const isHeader =
    firstFields.length > 2 &&
    firstFields.every((field) => /^[a-zA-Z_][a-zA-Z0-9_ ]*$/.test(field));

  if (isHeader && lines.length >= 2) {
    return lines.slice(1).map((line) => {
      const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      const record: Record<string, unknown> = {};
      firstFields.forEach((header, i) => {
        record[header] = values[i] ?? "";
      });
      sourceLines?.push(line);
      return record;
    });
  }

  // Headerless: strip syslog prefix, detect PAN-OS TRAFFIC/THREAT by position 3.
  // A for-loop rather than map+filter so the source line is pushed only for
  // records that SURVIVE the >1-field filter - map+filter would push for the
  // dropped ones too and shift every later pairing by one.
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const stripped = stripSyslogPrefix(line);
    const values = stripped
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""));
    const record: Record<string, unknown> = {};

    // EVERY dictionary, not the two that were hardcoded (2026-08-20 audit).
    // PANOS_CSV_HEADERS carries eight - TRAFFIC, THREAT, SYSTEM, CONFIG,
    // GLOBALPROTECT, AUTHENTICATION, DECRYPTION, HIP-MATCH - and six of them
    // sat unused behind an if/else that named only the first two.
    //
    // This read "seven ... five" until the count was checked by hand:
    // "HIP-MATCH" is a QUOTED key, so a pattern matching bare identifiers finds
    // seven and calls the eighth missing. See the warning on PANOS_CSV_HEADERS,
    // which records the same miscount happening twice on 2026-08-20.
    //
    // It went unnoticed because it was unreachable: an uploaded PAN-OS file was
    // classified "syslog" and parsed to zero events, so this branch never ran on
    // real input. The format-detection fix that routes PAN-OS here for the first
    // time is what exposed it - a fix uncovering the next defect down.
    //
    // The cost of leaving it: a GLOBALPROTECT or CONFIG export parses to
    // positional _0.._N, so field mapping sees `_3` instead of `type` and `_7`
    // instead of `src`, and the generated pack maps numbers.
    // panosLogTypeFrom, not `values[3]`: AUDIT omits the leading FUTURE_USE, so
    // its type sits at index 2 and index 3 holds the content-version number.
    // Read blindly at 3, an audit line asked for a column order named "2561"
    // and got none - which is why this said `values[3]` until 2026-08-25 and
    // AUDIT could not have been named even once its order was recorded.
    const logType = panosLogTypeFrom(values);
    // panosHeadersFor, not a plain index: real PAN-OS emits HIPMATCH while the
    // dictionary keys HIP-MATCH, so an index missed every HIP-Match event.
    const colNames: readonly string[] | null = panosHeadersFor(logType) ?? null;

    if (colNames) {
      colNames.forEach((name, i) => {
        if (i < values.length && !name.startsWith("future_use")) {
          record[name] = values[i] ?? "";
        }
      });
    } else {
      values.forEach((value, i) => {
        record[positionalFieldName(i)] = value;
      });
    }
    if (Object.keys(record).length > 1) {
      out.push(record);
      sourceLines?.push(line);
    }
  }
  return out;
}

/**
 * A key=value pair: the key is everything in the token up to the first `=`.
 *
 * THE KEY WAS `(\w+)` UNTIL 2026-09-02, AND THAT ATE FIELDS (DBT-79). `\w` is
 * `[A-Za-z0-9_]`, and `exec` scans FORWARD to the first position that matches -
 * so any other character in a key simply moved the match start past it and the
 * prefix vanished. Measured against the shipped parser, one line in:
 *
 *   src-ip=1.1.1.1 dst-ip=2.2.2.2 action=ACCEPT bytes=10
 *     -> { ip: "2.2.2.2", action: "ACCEPT", bytes: "10" }
 *
 * Four fields in, THREE out. `src-` and `dst-` were discarded, both keys landed
 * on `ip`, and the second overwrote the first - so the event lost a value with
 * no error and no note. The full survey, measured the same way, because the
 * cards recorded the cause as unknown rather than guessing it:
 *
 *   TRUNCATES to the trailing word run, and COLLIDES when two keys share it:
 *     `-` src-ip -> ip      `.` a.b -> b       `:` a:b -> b
 *     `/` a/b -> b          `@` @ts -> ts      `$` $id -> id
 *   DROPS THE PAIR ENTIRELY, because no `\w+` sits immediately before the `=`:
 *     `[`/`]` a[0]=1 -> nothing at all, whenever any OTHER pair on the line
 *     matched (a line with no matching pair fell through to the whitespace
 *     fallback below, which kept `a[0]` intact - so the two paths in this one
 *     function disagreed about the same input).
 *   UNAFFECTED: `_`, and a leading digit (`1field` is all `\w`).
 *
 * The key is now the whole token before the first `=`, which is what Cribl's own
 * `kvp` serde will see at runtime and therefore the only name worth reporting.
 * `=`, `,` and `"` are excluded because they are the pair/value delimiters, not
 * name characters; the value half is untouched (a comma splits only when NOT
 * followed by whitespace, so `a,b` stays one value and `a, b` does not).
 *
 * These names are frequently NOT valid Cribl property accessors - that is the
 * point of DBT-78 and is now said out loud at parse time rather than silently
 * mangled here; see accessor-names.ts.
 *
 * THE LEADING `(?<![^\s=,"])` IS AN ANCHOR, AND ITS ONLY JOB IS COST. It reads
 * "a key may not start in the MIDDLE of a token": the class it forbids is exactly
 * the key class, so an offset is legal iff the character before it is one a key
 * could never contain - whitespace, `"`, `,`, `=`, or the start of the line.
 *
 * WHY ANY ANCHOR. `[^\s=,"]+` is greedy, so with none, at every start offset it
 * ran to the end of the token, backtracked one character at a time looking for
 * `=`, failed, and `exec` advanced one character and did it again. Quadratic.
 * Re-measured 2026-09-03 through parseKv on one line carrying a bare JWT-shaped
 * token (base64url, no `=` padding, dots between segments) that is not the value
 * of any pair:
 *
 *     token  64000B   no anchor  6370ms   this anchor 1.1ms
 *     token  96000B   no anchor 14776ms   this anchor 1.3ms
 *     token 128000B   no anchor 24476ms   this anchor 1.6ms
 *
 * `\w+` never had this problem for that input because `.` and `-` broke every
 * scan short. parseSampleContent runs SYNCHRONOUSLY on the samples screen, so
 * those are seconds of frozen UI. This anchor is flat for the same reason it is
 * safe: every character it ALLOWS as a predecessor also TERMINATES the key class,
 * so between two consecutive terminators there is at most one legal offset and
 * its scan cannot run past the next terminator. The work is the sum of the gaps.
 *
 * IT MUST NOT COST A FIELD, AND THE FIRST ATTEMPT AT IT DID - `(?:^|\s)`, written
 * earlier in this same change, whitespace-only and CONSUMING. Put back and
 * re-measured: this package's suite passes with it, 3590 green and 7 skipped, and
 * the ONLY failure is the case added to kv-keys.test.ts for it. Measured through
 * parseSampleContent against this directory exported from HEAD, it dropped a pair
 * whenever the character before the key was not a space:
 *
 *     user=root msg="login ok",id=7 act=deny
 *       HEAD    4 fields [user, msg, id, act]  0 notes
 *       broken  3 fields [user, msg, act]      0 notes   <- id gone
 *     a="1"b="2" c=3 d=4
 *       HEAD    4 fields [a, b, c, d]          0 notes
 *       broken  3 fields [a, c, d]             0 notes   <- b gone
 *
 * THE PREMISE THAT PRODUCED IT WAS WRITTEN IN THIS COMMENT: "pairs are
 * whitespace-separated", so eating the one separating space is harmless. The
 * quoted-value branch of the pattern below disproves it. A quoted value ends ON
 * its closing quote, so `lastIndex` lands on whatever follows - the `,` in
 * `msg="ok",id=7`, the quote itself in `a="1"b="2"` - and a whitespace-only start
 * can never begin a key there. Only a QUOTED value strands a key this way: the
 * bare branch's `,(?=\S)` swallows `,X`, so a comma never survives to become a
 * predecessor. And the loss was SILENT, because the whitespace fallback in
 * parseKv runs only when the regex matched ZERO pairs - a PARTIAL loss leaves
 * `errors` empty. That is the same failure mode DBT-79 exists to fix.
 *
 * A CONSUMING CLASS CANNOT FIX IT, which is why this is a lookbehind rather than
 * a wider `(?:^|[\s",])`. That variant was measured and still loses `b` from
 * `a="1"b="2" c=3 d=4`: the closing quote was eaten by the VALUE, so it is not
 * there to be the next key's predecessor. Zero-width is a requirement here, not a
 * taste. The earlier note rejected a lookbehind because the package has none
 * elsewhere; that is a style preference and it loses to silent field loss. The
 * one thing worth CHECKING behind that preference was shipping, and it was: a
 * lookbehind is ES2018 against an ES2022/ES2023 tsconfig target, `vite build`
 * succeeds, and the assertion reaches the emitted bundle verbatim rather than
 * being lowered or dropped (grepped for, once, in the production chunk).
 *
 * WHAT THE ANCHOR CHANGES: nothing observable, which is the intended result for a
 * cost fix. THE REASON COMES FIRST, because the corpus is the weaker half of this
 * argument and the broken anchor above was cleared by trusting one: `exec`
 * returns the LEFTMOST match, and a match starting mid-token implies one starting
 * a character earlier (greedy from k-1 reaches the same `=`), so the leftmost
 * match never needed a forbidden offset. The anchor can only refuse offsets
 * `exec` was never going to return.
 *
 * The corpus CHECKS that reasoning, and is quoted with its CALIBRATION, because a
 * disagreement count on its own means nothing - the anchor that ate a field was
 * cleared by "16 lines, 0 disagreements", and every one of those 16 was blind to
 * it. Re-measured 2026-09-03, driving whole parsed RECORDS (keys and values, not
 * key names) through parseKv over 200000 fuzzed lines, from an alphabet holding
 * every character this anchor reasons about - quote, comma, `=`, space, brackets
 * - with a syslog PRI on a third of them:
 *
 *     vs NO anchor              0 disagreements   <- the claim
 *     vs `(?:^|\s)`         71494 disagreements   <- corpus CAN express the loss
 *     vs `(?:^|[\s",])`     48105 disagreements   <- ...and the near-miss too
 *
 * The bottom two lines are what make the top one worth reading. An earlier
 * revision of this note cited "12452 lines" over a grid it also described; the
 * grid it names is 8*9*7*4*2 = 4032, and every kv-ish line in this directory adds
 * 210, so that total never reconstructed and has been replaced rather than
 * re-derived.
 *
 * `<189>date=...` IS NOT WHAT THE ANCHOR IS FOR, though an earlier version of
 * this note filed it under correctness. The PRI and the key are ONE token, so no
 * anchor can separate them; KV_SYSLOG_PRI in parseKv does that, and does it
 * alone.
 *
 * NOT the whitespace-split-plus-indexOf("=") loop that the fallback below uses,
 * which would have collapsed the two paths into one for real. It cannot carry
 * `msg="login ok"`: splitting on whitespace cuts a quoted value in half, and
 * that shape is pinned. Collapsing them needs a quote-aware tokenizer, which is
 * a bigger change than this defect is paying for.
 *
 * THE VALUE BRANCH IS `*`, NOT `+`, AND THAT IS LOAD-BEARING. An EMPTY value is
 * a real pair: `note=` says the field exists and carries nothing, which is not
 * the same as the field being absent, and dropping it hides a field the operator
 * cannot then map.
 *
 * It is written here because `+` cost a silent field loss, found by comparing
 * this parser against HEAD over 400,000 generated lines. With `+`,
 * `a[0]=1 a[1]=` returned only `a[0]`, where the COMMITTED parser returned both.
 * The committed parser was not better on purpose - it was better BY ACCIDENT.
 * Its `\w+` key class could not match before the `]` in `a[0]=`, so it matched
 * ZERO pairs on that line, which is the only condition under which the
 * whitespace fallback below runs, and the fallback returned both keys whole.
 * Widening the key class made the regex match once, which switched the fallback
 * off, which exposed the `+`.
 *
 * So the regression and its cause sat in different clauses, and that is the
 * thing worth remembering: a fallback that fires only on TOTAL failure hides
 * every partial failure above it, and widening anything upstream can silently
 * cash in that hiding. The empty-value drop was pre-existing - `user=root note=`
 * loses `note` on the committed parser too - and `*` closes both at once.
 */
const KV_PAIR = /(?<![^\s=,"])([^\s=,"]+)=(?:"([^"]*)"|((?:[^\s,]|,(?=\S))*))/g;

/**
 * Grouping punctuation a key may inherit from the text around it - a syslog
 * message reading `... (retries=3)` has token `(retries`, and the paren belongs
 * to the sentence, not the field. Only LEADING openers are trimmed: a trailing
 * subscript like `a[0]` is part of the name, and everything after the `=` is the
 * value's problem.
 *
 * parseKv ONLY. parseCef shared this for one revision and no longer does; the
 * argument for removing it is on the assignment inside parseCef, and the short
 * version is that a trimmed key can COLLIDE with a real one and the assignment is
 * last-write-wins.
 *
 * IT HAS THE SAME COLLISION HERE, and this note says so rather than implying the
 * whitespace-bounded value makes it safe. The value damage IS bounded in KV - a
 * parenthetical contributes one token, not the rest of the line - but the KEY
 * does not care what bounded the value. Measured through parseKv on committed
 * code, unchanged by anything in this wave:
 *
 *   act=deny msg=blocked (act=drop) src=1.1.1.1  ->  act = "drop)"
 *   suser=root msg=escalated (suser=admin) ...   ->  suser = "admin)"
 *
 * The device said `deny`; the operator is shown `drop)`, with `errors` empty.
 * NOT FIXED HERE, deliberately: this trim is pinned committed behaviour
 * (kv-keys.test.ts), removing it changes every KV sample's field names, and
 * "found while fixing something else" is not a licence to spend that. Filed.
 */
const KV_KEY_LEADING_GROUPING = /^[([{<]+/;

/**
 * A bare syslog priority glued to the front of the line - `<189>date=...`, which
 * is FortiGate's DEFAULT wire format and the shape most KV samples arrive in.
 *
 * STRIPPED HERE RATHER THAN BY THE MODULE'S OWN {@link stripSyslogPrefix}, which
 * is what this reached for first. Two measured reasons:
 *
 *   IT DOES NOT DO IT. `stripSyslogPrefix` handles RFC 5424 (`<PRI>VERSION` and
 *     six fields), RFC 3164, and the PAN-OS positional start. A bare `<PRI>`
 *     with the message welded straight on matches none of those three, so
 *     `stripSyslogPrefix("<189>date=...")` returns the line UNCHANGED. It could
 *     not have fixed this.
 *   ITS PAN-OS BRANCH IS AN UNANCHORED SEARCH and would corrupt KV lines it was
 *     handed. `/(\d+,\d{4}\/\d{2}\/\d{2}.*)/` matches ANYWHERE, so
 *     `msg="1,2024/01/01 ok" other=2` strips to `1,2024/01/01 ok" other=2` and
 *     the `msg` field is gone. Measured.
 *
 * So this is deliberately the NARROWEST strip that closes the defect, and it is
 * the same one `parseKvLine` in ./splitting has done since legacy. The
 * space-separated prefixes need nothing: their first real key is preceded by
 * whitespace, so the anchor on KV_PAIR already starts the key in the right
 * place.
 *
 * WHAT IS STILL NOT HANDLED, said plainly rather than discovered later: any
 * OTHER prefix welded to the first key with no whitespace - `[2024-01-01]user=x`
 * yields key `2024-01-01]user`. It is not silent (that name is not an accessor,
 * so DBT-78's parse note names it), and the honest reason it is not "fixed" is
 * that the widened key class is justified by matching what Cribl's own `kvp`
 * serde will see at runtime, and this could not be checked against a live Cribl.
 * Guessing which prefixes kvp discards and then pinning the guess is how a wrong
 * answer acquires credibility.
 */
const KV_SYSLOG_PRI = /^\s*<\d+>/;

/**
 * Parse key=value lines (Palo Alto, FortiGate, ...).
 *
 * NOT the same function as `parseKvLine` in ./splitting, which became a sibling
 * when the splitter was rehomed here (ADR 0003). That one is a cheap probe used
 * only to find a DISCRIMINATOR field; this one is full field extraction and is
 * what feeds the schema. They are deliberately separate: merging them would put
 * the splitter's log-type naming - which is the tagged-sample store's KEY - on
 * this function's change budget, and re-keying an operator's stored samples is
 * silent. If you touch one, do not assume the other should follow.
 *
 * THEY NOW DISAGREE, which they did not before, and the divergence is chosen
 * rather than overlooked. `parseKvLine` still truncates keys on `\w+`. Fixing it
 * too would change which field the splitter SELECTS as a discriminator: a vendor
 * emitting `log-type=TRAFFIC` currently truncates to `type`, which is the second
 * entry in DISCRIMINATOR_FIELDS, so today's split works by accident and a
 * correct key (`log-type`, in no list) would stop matching and re-key every
 * stored sample. That is exactly the blast radius the note above warns about, so
 * it is a separate card, not a drive-by.
 */
export function parseKv(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // `\r?\n`, not `\n` - see the CRLF note on {@link parseCef}. The PAIRS were
  // always safe here (the value class excludes whitespace, `\r` included); the
  // line pushed into `sourceLines` was not.
  for (const line of content.trim().split(/\r?\n/).filter(Boolean)) {
    const record: Record<string, unknown> = {};
    // The transport prefix comes off BEFORE any pair extraction, and BOTH paths
    // below read the same stripped body - the regex one and the whitespace
    // fallback. Two paths in this function disagreeing about the same input is
    // the exact defect the bracket pin in kv-keys.test.ts records; do not let
    // one of them read `line` again.
    const body = line.replace(KV_SYSLOG_PRI, "");
    // A FRESH matcher per line. A module-level /g regex carries `lastIndex`
    // between calls, so reusing one would start line N+1 wherever line N
    // finished and drop the pairs before that point. The original built the
    // literal inside this loop for the same reason; the pattern moved out to
    // carry its documentation, the per-line construction did not.
    const regex = new RegExp(KV_PAIR.source, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      const key = (match[1] ?? "").replace(KV_KEY_LEADING_GROUPING, "");
      // An empty key means the token was pure punctuation before the `=`; there
      // is no field there to lose.
      if (key === "") continue;
      record[key] = match[2] ?? match[3] ?? "";
    }
    if (Object.keys(record).length === 0) {
      for (const pair of body.split(/\s+/)) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          record[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }
    if (Object.keys(record).length > 0) {
      out.push(record);
      // The ORIGINAL line, prefix and all. `sourceLines` is what becomes
      // `rawEvents`, i.e. the vendor's bytes as they arrived - stripping the
      // transport for extraction must not rewrite what we claim we received.
      sourceLines?.push(line);
    }
  }
  return out;
}

/**
 * A CEF extension pair. CEF's extension is `k1=v1 k2=v2 ...`, and unlike KV a
 * VALUE MAY CONTAIN SPACES (`msg=Blocked by rule 5`, `rt=Jan 01 2024 00:00:00`),
 * so a value ends only where the NEXT key begins. That is why this is a lazy
 * `.*?` bounded by a lookahead rather than KV_PAIR's whitespace-terminated value
 * class - reusing KV_PAIR here was tried and measured, and it truncates
 * `msg=Blocked by rule 5` to `Blocked`, dropping the rest of the value on the
 * floor. The two patterns are the same idea over different grammars.
 *
 * THE PATTERN WAS `/(\w+)=(.*?)(?=\s\w+=|$)/g` UNTIL 2026-09-03 (DBT-80), AND IT
 * HAS TWO SEPARATE `\w+`s THAT FAIL DIFFERENTLY. This is the measurement the card
 * asked for, taken against this directory exported from HEAD before anything was
 * changed, and it does not match the guess on the card:
 *
 *   THE CAPTURE `\w+` TRUNCATES. `exec` scans forward to the first offset that
 *     matches, so any non-word character in a key moved the match start past it.
 *     Surveyed one character at a time as the key `a` + CHAR + `b`, all 29 of
 *     `- . : / @ $ [ ] # % + * ~ ^ ! & ' ( ) { } < > ? ; \ | " ,` came back
 *     named `b`. Count preserved, name destroyed.
 *   THE LOOKAHEAD `\w+` SWALLOWS, and this is the half that loses fields. The
 *     value runs until it can see ` <word>=` ahead. A NEXT key that is not all
 *     word characters is not a visible boundary, so the value keeps expanding
 *     THROUGH it to the pair after that - taking the key, the `=` and the value
 *     with it:
 *
 *       first=1 a-b=2 tail=3   ->  { first: "1 a-b=2", tail: "3" }
 *
 *     Three pairs in, TWO out, and `first` now carries another field's text as
 *     if it were data. Nothing is reported. The reported line, same measurement:
 *
 *       src-ip=1.1.1.1 dst-ip=2.2.2.2 action=ACCEPT bytes=10
 *         -> { ip: "1.1.1.1 dst-ip=2.2.2.2", action: "ACCEPT", bytes: "10" }
 *
 *     Four in, three out, with both halves of the defect visible at once: the
 *     name truncated to `ip` AND the second pair eaten into its value. Worse than
 *     DBT-79's KV collision, which at least left a clean value behind.
 *
 * A key breaking in the FIRST position only truncates (there is no preceding
 * value to swallow it); from the second position on it also swallows. A leading
 * `@`, `$` or `#` on any later key swallows the whole pair the same way.
 * `_` and a leading digit were unaffected - both are `\w`.
 *
 * THE ESCAPED EQUALS IS NOT THE CAUSE, though the card named it as the likely
 * one. Measured on HEAD: `msg=x y\=z dst=2.2.2.2` yields `{ msg: "x y\=z",
 * dst: "2.2.2.2" }` - correct pairing, because the `\` before the `=` is not a
 * `\w`, so the old lookahead never mistook `\=` for a boundary. The escape
 * survives UNEXPANDED in the value (`\=` is not turned back into `=`); that is a
 * real gap, it is a VALUE question rather than a key one, and it is filed rather
 * than fixed here - see the note on parseCef.
 *
 * THE FIVE TRAPS - four DBT-79 paid for, re-measured for CEF rather than assumed
 * to carry over, and a fifth CEF invented on its own (trap 5):
 *
 *   1. NO LEADING PREFIX ABSORBED. Two characters had to leave the key class or
 *      the widened class ate them:
 *        `|` is CEF's header delimiter, and BOTH this parser and the pack it
 *          generates reach the extension as `split("|").slice(7).join("|")`
 *          (pipeline-conf.ts builds exactly that expression for `__cefExtension`),
 *          so a `|` inside a key is always header wreckage, never a name. With it
 *          in the class, `a|b=2 dst=3` named a field `a|b` and the extension of a
 *          header carrying an escaped `\|` named one `5|src`; HEAD names them `b`
 *          and `src`, and excluding `|` keeps HEAD's names exactly.
 *        `\` is CEF's escape character, so a key ending in `\` means the `=` after
 *          it was ESCAPED and is not a separator at all. With `\` in the class,
 *          `msg=x y\=z dst=2.2.2.2` invented a field `y\` = `z` and cut `msg`
 *          down to `x` - a pair manufactured out of an escape. Excluding it
 *          reproduces HEAD.
 *      Re-measured after the DBT-80 round-2 change below: allowing `\` back into the key
 *      class moves 7692 of 200000 corpus lines off this pattern's answer (it is
 *      still `y\` manufactured out of an escape), and allowing `|` back moves
 *      66367 (`a|b` where HEAD names `b`, and `5|{` out of header wreckage).
 *   2. NO MID-TOKEN RESTART. Same quadratic blowup as KV, and CEF is WORSE off
 *      than KV was because HEAD is already quadratic here. Measured through this
 *      pattern on a bare token sitting before the first pair, RE-TAKEN for the
 *      round-2 pattern rather than carried over from the round-1 one:
 *
 *        word-only token   16000B  HEAD   238ms   unanchored   524ms   this 0.2ms
 *                          32000B  HEAD   901ms   unanchored  1472ms   this 0.6ms
 *                          64000B  HEAD  2815ms   unanchored  5358ms   this 0.9ms
 *                         128000B  HEAD 13595ms   unanchored 22024ms   this 1.4ms
 *        JWT-ish (dotted)  64000B  HEAD     5ms   unanchored  7043ms   this 1.1ms
 *                         128000B  HEAD     7ms   unanchored 17882ms   this 1.2ms
 *
 *      8x the bytes costs HEAD 57x the time and this pattern 7x. So the anchor is
 *      not merely paying for the widened class - it retires a pre-existing freeze
 *      on the samples screen, which runs parseSampleContent SYNCHRONOUSLY. The
 *      dotted row is the shape DBT-79 hit: `\w` broke every scan short, so HEAD
 *      looked fine there and only the wider class exposes it. The absolute
 *      numbers are this machine's and drift between runs; the GROWTH is the
 *      evidence, and 64000B through the real parseCef costs 1.18ms.
 *   3. A KEY MAY START AFTER A NON-SPACE. The anchor is a zero-width lookbehind
 *      forbidding EXACTLY the key class, so a legal offset is one whose
 *      predecessor is whitespace, `=`, `|`, `\`, or the line start. The
 *      whitespace-only `(?:^|\s)` that ate a field in DBT-79 does it again here,
 *      differently and just as silently: over the 200000-line corpus below it
 *      returned FEWER keys than HEAD on 9403 lines and dropped a HEAD key
 *      outright on 25054, because a key reached through header wreckage
 *      (`a|b=2 dst=3` -> HEAD `b`) has no space in front of it. This anchor: 0
 *      and 110, and the 110 are trap 5's residue rather than the anchor's.
 *      AND CEF SEPARATES THE TWO LESSONS KV COULD NOT. There the fix was read as
 *      "be zero-width"; here `(?<!\S)` - zero-width, but whitespace-only - loses
 *      the SAME 25054 lines. Being a lookbehind is not what makes this work; the
 *      forbidden class matching the key class is. Measured side by side.
 *   4. AN EMPTY VALUE IS A PAIR. `.*?` already admits one and HEAD already kept
 *      them - `a=1 note= b=2` and `a= b= c=1` are identical on both. Written down
 *      because DBT-79 shipped a `+` here and lost `a[1]=`, and because the
 *      lookahead widening is exactly the kind of change that could have taken the
 *      empty case with it. It did not; the pin says so out loud.
 *   5. A KEY MUST CONTAIN A WORD CHARACTER, in BOTH halves - `(?=[^\s=|\\]*\w)`
 *      before the capture and again inside the lookahead. THIS ONE COST TEXT, and
 *      it is the round-2 half of this pattern rather than round 1's.
 *
 *      Without it in the LOOKAHEAD, a bare punctuation token followed by `=` is a
 *      visible boundary, so the value ends there - and since the key then trims
 *      or matches to something unusable, the rest of the message goes with it:
 *
 *        msg=Disk usage <= 90 percent on /var suser=root
 *          HEAD  msg = "Disk usage <= 90 percent on /var"
 *          DBT-80 pattern + the grouping trim it shipped with
 *                msg = "Disk usage"     and `<= 90 percent on /var` in NO field
 *
 *      `<=` `(=` `[=` `{=` lost the text outright (the trimmed key was empty and
 *      the pair was dropped); `>=` `!=` `~=` `:=` `/=` kept it under a field
 *      literally named `>` or `!`. Requiring the word character in the lookahead
 *      makes none of them a boundary, so the value stays whole. Corpus: 80978
 *      lines lose HEAD value text without it, 0 with it.
 *
 *      Without it in the CAPTURE, the same token at the START of an extension -
 *      the one place no preceding value has swallowed it - becomes the key:
 *      `(=1 a=2` yields a field named `(`. Corpus: 81701 lines gain a
 *      pure-punctuation field name without it, 0 with it, AND those fields open
 *      values that then swallow the next pair, which is the whole of the gap
 *      between 2857 and 110 HEAD keys lost.
 *
 *      HONEST ABOUT COVERAGE. The corpus reaches the CAPTURE half only through a
 *      dedicated LEAD slot, because a bare `(=` is a legal start offset only at
 *      the head of an extension - anywhere else a preceding value has already
 *      consumed it, so no amount of fuzzing in the middle of a line can express
 *      it. The 81701 figure above is therefore a count of lines whose lead slot
 *      drew one, not evidence that the shape is common; the case for this half is
 *      `(=1 a=2` naming a field `(`, which is pinned directly in cef-keys.test.ts
 *      rather than inferred from a corpus count.
 *
 * WHAT IT COSTS, stated rather than discovered later: an UNESCAPED `=` inside a
 * space-separated value now splits where it did not. `msg=see http://h/p?a=b more
 * dst=1` was `{ msg: "see http://h/p?a=b more", dst: "1" }` and is now
 * `{ msg: "see", "http://h/p?a": "b more", dst: "1" }`. This is not a new class of
 * error - HEAD splits the same line the same way the moment the token is
 * word-shaped (`msg=see foo=bar more dst=1` gives `{msg:"see", foo:"bar more",
 * dst:"1"}` on HEAD and here alike) - it is the existing behaviour reaching
 * further. CEF REQUIRES that `=` to be written `\=`, and when it is, trap 1's `\`
 * exclusion keeps the value whole. A URL that is the whole value -
 * `request=http://h/p?a=b` - has no interior space and is untouched, measured.
 *
 * THE MITIGATION IS NARROWER THAN THIS NOTE ONCE CLAIMED, and the correction is
 * the point of DBT-80's second round. It read "the result gains a field rather than losing one;
 * and the invented name is not a Cribl accessor, so DBT-78's parse note SAYS SO",
 * both halves unqualified, both false outside the one shape that had been tested:
 *
 *   IT COULD LOSE TEXT, not merely gain a field. Trap 5 above is the measurement:
 *     with the shipped grouping trim, a `<=` inside a message took the rest of
 *     the message with it and `errors` stayed empty. The word requirement closes
 *     that, and the claim now holds - but it holds BECAUSE of trap 5, not by
 *     itself, and it was written before trap 5 existed.
 *   THE INVENTED NAME IS OFTEN A PERFECTLY GOOD ACCESSOR, so no note fires.
 *     `msg=start (retries=3) end=1` invents `retries` under the trim; `retries`,
 *     `action`, `reason`, `ref` and `src` are all valid accessor paths and
 *     unaddressableFieldNote returns null for every one of them. The note fires
 *     for `http://h/p?a` because THAT shape happens to carry a `/` and a `.` -
 *     the mitigation was generalised from a URL query string and does not
 *     generalise. Keeping the bracket (`(retries`) is what puts the name back
 *     outside the accessor grammar, which is why parseCef no longer trims.
 *
 * EQUIVALENCE, with the calibration that makes the number mean something, since
 * DBT-79 was cleared twice by corpora blind to the defect and DBT-80's own corpus
 * was blind to trap 5. REGENERATED for DBT-80 round 2: 200000 fuzzed lines over an
 * alphabet holding every character this pattern reasons about (`|`, `\`, quote,
 * comma, brackets, spaces in values, escaped equals, four headers including a
 * syslog-wrapped one and one with an escaped `\|`) AND, new, the four grouping
 * openers reachable as complete key tokens - `(=1` `<=2` `[=3` `{=4` and the
 * `>= != := /= ~=` family, in a LEAD slot, because anywhere else a preceding
 * value has already swallowed them and the failure cannot be expressed. Fragments
 * are deduplicated by field name so a line cannot lose text to its own
 * last-write-wins. Driving whole parsed RECORDS, keys and values:
 *
 *                                     fewer   HEAD-key   HEAD value    keys named
 *                                      keys       lost   text lost   pure punct
 *   clone driven with HEAD's pattern       0          0           0            0  <- calibration
 *   clone driven with THIS pattern vs the real parseCef: 0 disagreements       <- calibration
 *   THIS pattern                           0        110           0            0  <- the claim
 *   DBT-80 pattern + grouping trim       443       2857       89772        76394  <- what it fixes
 *   ...word requirement in lookahead only  0       2857           0        81701  <- trap 5
 *   ...word requirement in capture only    0        110       80978            0  <- trap 5
 *   `(?:^|\s)` anchor                   9403      25054       24125            0  <- trap 3
 *
 * Keys: HEAD 511048, this 682295. The two calibration rows are what make the rest
 * readable - the first says the harness reproduces HEAD, the second says the
 * pattern it measured is the one in this file and not a retyped approximation.
 *
 * THE BAR IS NOT ZERO, AND THIS NOTE USED TO SAY IT WAS. "HEAD keys neither kept
 * nor extended" is 110 lines, not 0, and the earlier 0 was a corpus that could not
 * reach the shape. The 110 are ONE mechanism and it is not trap 5's:
 *
 *   a[0]=7 5|src=1.1.1.1 dpt=80
 *     HEAD  { src: "1.1.1.1", dpt: "80" }
 *     this  { "a[0]": "7 5|src=1.1.1.1", dpt: "80" }        <- `src` gone
 *
 * The ANCHOR lets a key start after `|`, but the LOOKAHEAD still demands
 * whitespace before the next key, so a key reached through header wreckage is not
 * a visible boundary - and the widened capture class opens a pair at `a[0]` that
 * HEAD never opened, whose value then runs straight through it. HEAD does exactly
 * the same thing whenever it DOES open the pair (`first=1 5|src=1.1.1.1 dpt=80`
 * gives `first: "1 5|src=1.1.1.1"` on HEAD too), so this is HEAD's own swallow
 * re-exposed by the wider class, not a new one.
 *
 * THE OBVIOUS FIX WAS MEASURED AND IS WORSE, which is why the 110 stands rather
 * than being closed in passing. Making the lookahead accept the same predecessors
 * the anchor does - `(?=[\s|\\]<key>=|$)` - takes HEAD-key-lost to 0, and buys it
 * by dropping the separator character itself out of the record on 18437 lines:
 *
 *   msg=a|b=2 dst=3    HEAD/this { msg: "a|b=2", dst: "3" }
 *                      wide      { msg: "a", b: "2", dst: "3" }   <- `|` in no field
 *
 * That is the trade this whole note exists to refuse: a key gained at the cost of
 * text that appears nowhere. It is filed as its own card with this measurement
 * attached, not smuggled in here as a third behaviour change in one wave.
 *
 * "FEWER KEYS" IS A MASKABLE METRIC and is kept only because it is cheap. A line
 * that loses one pair and gains two reads as a gain, which is why the DBT-80
 * pattern scores 443 here while losing text on 89772 lines. The value-text column
 * is the one that cannot be masked: every whitespace token of every HEAD value
 * must still appear inside some `key=value` of the new record.
 */
const CEF_EXT_PAIR =
  /(?<![^\s=|\\])((?=[^\s=|\\]*\w)[^\s=|\\]+)=(.*?)(?=\s(?=[^\s=|\\]*\w)[^\s=|\\]+=|$)/g;

/**
 * Parse CEF (CEF:0|vendor|product|...|extension).
 *
 * The header split is UNCHANGED and still naive, which is a real defect and is
 * left deliberately: `CEF:0|V\|W|P|...` escapes the pipe per spec, this splits on
 * it anyway, and every header field after it shifts by one (`DeviceVendor` reads
 * `V\`, `DeviceProduct` reads `W`). It is not fixed HERE because the pack this app
 * generates reaches the same bytes the same way - pipeline-conf.ts emits
 * `_raw.substring(indexOf('CEF:')).split('|')` and `__cefParts.slice(7).join('|')`
 * - so correcting one side alone would make the screen promise header fields the
 * installed pipeline cannot produce, which is a worse failure than the shift.
 * Measured: the shift damages header NAMES only; the extension pairs still parse,
 * because `slice(7).join("|")` puts the pipe back. Filed as its own card.
 *
 * THE LINE SPLIT IS `\r?\n`, NOT `\n`, AND THAT WAS A SILENT FIELD LOSS (DBT-80).
 * A CRLF file left a carriage return welded to the end of every line but the
 * last. `.` does not match `\r` and `$` without the `m` flag does not match
 * before it, so the FINAL value of each such line could never satisfy
 * CEF_EXT_PAIR's lookahead and the last pair simply did not exist. Measured on
 * this function, identical before and after the DBT-80 pattern change - this is
 * not a regression, it is the card's own symptom and it was undocumented:
 *
 *   ...|a=1 b=2 CRLF ...|a=3 b=4   ->  [{a:"1"}, {a:"3", b:"4"}]      b LOST
 *   ...|a=1     CRLF ...|a=3       ->  [{},      {a:"3"}]      the WHOLE ext
 *   ...|a=1 b=2 LF   ...|a=3 b=4   ->  [{a:"1",b:"2"}, {...}]         control
 *
 * IT IS MASKED END TO END, which is what made it worth chasing rather than
 * shrugging at. parseSampleContent UNIONS field names across records, so the
 * last record - the one with no `\r` - contributes the missing name and the field
 * list reads complete while record 0 lacks the field and `errors` is empty. The
 * pin therefore asserts record 0's own keys AND VALUES; the unioned list is what
 * hides it.
 *
 * THE SIBLINGS WERE CHECKED RATHER THAN ASSUMED, and checking them cost the
 * first version of this note its own claim. It read "parseKv and parseCsv were
 * measured CLEAN"; they are clean in their parsed FIELDS - KV's value class
 * excludes whitespace, CSV trims every cell - and that is not the whole surface.
 * EVERY line parser also pushes its line into `sourceLines`, which becomes
 * `rawEvents`, which is what the generated pack is previewed and shipped against.
 * Measured across all six on a CRLF file:
 *
 *   parseCef     last extension pair LOST
 *   parseLeef    last VALUE carried the `\r`
 *   parseSyslog  `_raw` and the raw event carried it
 *   parseKv      fields clean, raw event `"a=1 b=2\r"`
 *   parseCsv     cells clean, raw event `"1,2,3\r"` (both branches)
 *   parseNdjson  clean, and takes no accumulator
 *
 * So all five line parsers that pair a source line now split on `\r?\n`, and the
 * lesson is the one this file keeps relearning: "the fields are fine" is not the
 * same statement as "the record we claim to have received is fine".
 */
export function parseCef(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split(/\r?\n/)) {
    if (!line.includes("CEF:")) continue;
    {
      const cefStart = line.indexOf("CEF:");
      const cefPart = line.slice(cefStart);
      const parts = cefPart.split("|");
      const record: Record<string, unknown> = {};
      if (parts.length >= 7) {
        record["CEFVersion"] = parts[0].replace("CEF:", "");
        record["DeviceVendor"] = parts[1];
        record["DeviceProduct"] = parts[2];
        record["DeviceVersion"] = parts[3];
        record["DeviceEventClassID"] = parts[4];
        record["Name"] = parts[5];
        record["Severity"] = parts[6];
        if (parts.length > 7) {
          const extension = parts.slice(7).join("|");
          // A FRESH matcher per line, for the reason spelled out in parseKv: a
          // module-level /g regex carries `lastIndex` between calls and would
          // start the next line wherever this one stopped. The literal moved to
          // module scope to carry its documentation; the per-use construction
          // did not move with it.
          const kvRegex = new RegExp(CEF_EXT_PAIR.source, "g");
          let match: RegExpExecArray | null;
          while ((match = kvRegex.exec(extension)) !== null) {
            // NO GROUPING TRIM HERE, AND THAT IS THE POINT (DBT-80). The token
            // is written to the record VERBATIM, brackets and all.
            //
            // For one revision this shared {@link KV_KEY_LEADING_GROUPING} with
            // parseKv, on the argument that one vendor's field should not get two
            // spellings. The argument was wrong in the only way that matters:
            // ASSIGNMENT HERE IS LAST-WRITE-WINS, so a trimmed key is a key that
            // can COLLIDE WITH A REAL ONE, and prose quoted inside `msg` then
            // overwrote the device's own field with the wrong value. Measured
            // through this function:
            //
            //   act=deny msg=blocked (act=drop) src=1.1.1.1
            //     trimmed  act="drop)"   <- the device said deny
            //     verbatim act="deny", "(act"="drop)"
            //   suser=root msg=escalated (suser=admin) dst=8.8.8.8
            //     trimmed  suser="admin)"   verbatim suser="root"
            //
            // AND NOTHING DOWNSTREAM COULD SEE IT. Through parseSampleContent the
            // trimmed parse and HEAD reported the SAME three extension field
            // names, the same count, and `errors` empty on both - the only
            // difference between a correct event and a falsified one was a value
            // nobody was comparing. A lost field is recoverable; a plausible wrong
            // value reported as clean is not.
            //
            // KEEPING THE BRACKET IS WHAT MAKES IT LOUD. `(act` is not a Cribl
            // property accessor, so unaddressableFieldNote names it beside the
            // field list (DBT-78) - where the trimmed `act` was a perfectly valid
            // accessor and therefore silent. The trim was not merely unsafe, it
            // was the thing SUPPRESSING the only warning available.
            //
            // NOT A GUARD ON `record[key] !== undefined` INSTEAD, which was the
            // other option: that protects the real field only when it happens to
            // appear BEFORE the parenthetical, and a line with no real `act` at
            // all still mints an accessor-shaped `act` holding prose, silently.
            //
            // parseKv STILL TRIMS, so the two parsers now spell this token
            // differently on purpose. That divergence is not the whole story and
            // the honest version is on {@link KV_KEY_LEADING_GROUPING}: parseKv
            // has the SAME overwrite, measured, on committed code - it is filed
            // rather than fixed here because its trim is pinned behaviour with a
            // blast radius of its own.
            //
            // NO EMPTY-KEY GUARD IS NEEDED ANY MORE. The pattern requires a word
            // character in the key, so `(=1` never forms a pair at all and there
            // is no "" to write. A guard that can never fire is a claim about the
            // code that has stopped being true.
            record[match[1]] = match[2].trim();
          }
        }
      }
      if (cefStart > 0) {
        record["_syslogHeader"] = line.slice(0, cefStart).trim();
      }
      if (Object.keys(record).length > 0) {
        out.push(record);
        sourceLines?.push(line);
      }
    }
  }
  return out;
}

/**
 * Parse LEEF (LEEF:ver|vendor|product|...|tab-delimited kvp). Verbatim, except
 * for the `\r?\n` split - see the CRLF note on {@link parseCef}. Here the
 * carriage return did not lose the pair, it CORRUPTED the value: measured on a
 * CRLF file, `LEEF:1.0|V|P|1|100|a=1\tb=2` yielded `b` = "2\r", because
 * `indexOf("=")` and `slice` neither know nor care what terminates the line.
 */
export function parseLeef(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split(/\r?\n/)) {
    if (!line.includes("LEEF:")) continue;
    {
      const leefStart = line.indexOf("LEEF:");
      const parts = line.slice(leefStart).split("|");
      const record: Record<string, unknown> = {};
      if (parts.length >= 5) {
        record["LEEFVersion"] = parts[0].replace("LEEF:", "");
        record["DeviceVendor"] = parts[1];
        record["DeviceProduct"] = parts[2];
        record["DeviceVersion"] = parts[3];
        record["EventID"] = parts[4];
        if (parts.length > 5) {
          const ext = parts.slice(5).join("|");
          for (const pair of ext.split("\t")) {
            const eqIdx = pair.indexOf("=");
            if (eqIdx > 0) {
              record[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
            }
          }
        }
      }
      if (Object.keys(record).length > 0) {
        out.push(record);
        sourceLines?.push(line);
      }
    }
  }
  return out;
}

/**
 * Parse RFC 3164 / RFC 5424 syslog lines. Verbatim from legacy, except for the
 * `\r?\n` split - see the CRLF note on {@link parseCef}. The parsed FIELDS were
 * already safe here (`.` cannot match `\r`, so `Message` stopped short of it),
 * but `_raw` and the `sourceLines` entry - which becomes the sample's rawEvents,
 * i.e. what the generated pack is previewed against - carried the stray carriage
 * return on every line but the last.
 */
export function parseSyslog(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split(/\r?\n/).filter(Boolean)) {
    {
      const record: Record<string, unknown> = { _raw: line };
      const rfc3164 = line.match(
        /^(?:<(\d+)>)?(\w{3}\s+\d+\s+\d+:\d+:\d+)\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s*(.*)/,
      );
      if (rfc3164) {
        if (rfc3164[1]) {
          record["Priority"] = parseInt(rfc3164[1], 10);
        }
        record["Timestamp"] = rfc3164[2];
        record["Hostname"] = rfc3164[3];
        record["Program"] = rfc3164[4];
        if (rfc3164[5]) {
          record["PID"] = parseInt(rfc3164[5], 10);
        }
        record["Message"] = rfc3164[6];
        if (rfc3164[1]) {
          const pri = parseInt(rfc3164[1], 10);
          record["Facility"] = Math.floor(pri / 8);
          record["Severity"] = pri % 8;
        }
      }
      const rfc5424 = line.match(
        /^<(\d+)>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)/,
      );
      if (rfc5424 && !rfc3164) {
        record["Priority"] = parseInt(rfc5424[1], 10);
        record["Version"] = parseInt(rfc5424[2], 10);
        record["Timestamp"] = rfc5424[3];
        record["Hostname"] = rfc5424[4];
        record["AppName"] = rfc5424[5];
        record["ProcID"] = rfc5424[6];
        record["MsgID"] = rfc5424[7];
        record["Message"] = rfc5424[8];
      }
      if (Object.keys(record).length > 1) {
        out.push(record);
        sourceLines?.push(line);
      }
    }
  }
  return out;
}

/**
 * Dispatch to the parser for a known format, or - for 'unknown' - try each
 * parser in the legacy fallback order and return the first that yields records
 * with more than one field. Verbatim ordering from legacy parseContent.
 */
export function parseByFormat(
  content: string,
  format: SampleFormat,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  switch (format) {
    case "json":
      return parseJson(content);
    case "ndjson":
      return parseNdjson(content);
    case "csv":
      return parseCsv(content, sourceLines);
    case "kv":
      return parseKv(content, sourceLines);
    case "cef":
      return parseCef(content, sourceLines);
    case "leef":
      return parseLeef(content, sourceLines);
    case "syslog":
      return parseSyslog(content, sourceLines);
    case "positional":
      // DBT-77. Named columns when the shape is recognisable (VPC Flow v2),
      // field1..fieldN when it is not - see positional.ts for why naming is
      // the hard half and why declining to name is the honest answer.
      //
      // `sourceLines` WAS MISSING FROM THIS ONE CASE (GEN-6) while the
      // five above it all threaded it. rawEventsFor's length equality then
      // failed - 0 lines against N records - and every positional sample fell
      // back to JSON.stringify, so the pack shipped a JSON object string as its
      // raw event. Measured: a VPC Flow sample's first raw event was
      // `{"version":"2","account_id":...}` where a CEF sample's was the real CEF
      // line, and running the generated positional extract over that shipped
      // event recovered 1 field of 14 - JSON.stringify emits no spaces, so the
      // whitespace split returns a single element. The header on parse-sample.ts
      // already names this defect for LEEF, syslog and PAN-OS CSV; positional
      // was simply left out of that fix.
      return parsePositional(content, sourceLines);
    default: {
      // Annotated so the JSON/NDJSON parsers (which take no accumulator and
      // never need one) sit in the same array as the line-oriented ones.
      const fallback: Array<
        (c: string, s?: string[]) => Array<Record<string, unknown>>
      > = [
        parseJson,
        parseNdjson,
        parseCef,
        parseLeef,
        parseKv,
        parseCsv,
        parseSyslog,
      ];
      for (const parser of fallback) {
        try {
          // Each attempt gets a FRESH accumulator: a parser that produces
          // unusable records still pushed lines into it, and those must not
          // survive into the attempt that wins.
          const attemptLines: string[] = [];
          const result = parser(content, attemptLines);
          if (result.length > 0 && Object.keys(result[0]).length > 1) {
            sourceLines?.push(...attemptLines);
            return result;
          }
        } catch {
          continue;
        }
      }
      return [];
    }
  }
}
