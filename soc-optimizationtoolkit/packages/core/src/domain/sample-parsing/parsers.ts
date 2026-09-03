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
  const lines = content.trim().split("\n").filter(Boolean);
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
  for (const line of content.trim().split("\n").filter(Boolean)) {
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

/** Parse CEF (CEF:0|vendor|product|...|extension). Verbatim from legacy. */
export function parseCef(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n")) {
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
          const kvRegex = /(\w+)=(.*?)(?=\s\w+=|$)/g;
          let match: RegExpExecArray | null;
          while ((match = kvRegex.exec(extension)) !== null) {
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

/** Parse LEEF (LEEF:ver|vendor|product|...|tab-delimited kvp). Verbatim. */
export function parseLeef(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n")) {
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

/** Parse RFC 3164 / RFC 5424 syslog lines. Verbatim from legacy. */
export function parseSyslog(
  content: string,
  sourceLines?: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
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
      return parsePositional(content);
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
