/**
 * PLACEHOLDER ROUTE FILTERS - what a log type gets when nothing in the samples
 * can tell it apart from its siblings.
 *
 * There are three things a generator can do with an undiscriminable log type,
 * and two of them are bad:
 *
 *   MATCH-ALL (`true`) - what this used to emit. Every route is final, so the
 *   first match-all swallows every unmatched event and runs them through ITS
 *   pipeline: the wrong renames, and for CEF web logs no base64 decode. The
 *   data reaches Sentinel mis-shaped, nothing errors, and the only symptom is
 *   detections that quietly match nothing. Measured on Zscaler: 7 of 10 routes.
 *
 *   DROP THE LOG TYPE - honest, but it throws away a route and pipeline the
 *   operator may need. Zscaler firewall and DNS are exactly the log types a SOC
 *   cares most about; silently having no path for them is not better.
 *
 *   PLACEHOLDER - emit the full route and pipeline, with a filter that CANNOT
 *   match until a human edits it. The pack carries everything needed, nothing
 *   is mis-shaped, nothing is dropped by surprise, and the remaining work is
 *   visible in the app before the build and in route.yml after it.
 *
 * WHY IT MUST EVALUATE FALSE. `__UNSET__` is not a field any vendor sends, so
 * the comparison is `undefined === '<logType>'` - false, always. An inert route
 * cannot hijack a sibling's events, which is the failure mode being fixed; a
 * placeholder that accidentally matched would be worse than the match-all it
 * replaces. It is also a plain identifier-and-string expression: no comment
 * syntax, no regex, nothing for the Cribl loader or the YAML escaper to trip on.
 *
 * The log type is embedded so the operator reading route.yml knows what the
 * filter is supposed to select, not merely that it is unfinished.
 *
 * Generic, not per-vendor: any vendor whose log types share a schema and differ
 * by a value the samples do not cover lands here - Zscaler, Palo Alto,
 * Fortinet. See route-value-discriminator for the strategies tried first.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** The sentinel field name. Never sent by a vendor, so comparisons are false. */
const UNSET_FIELD = "__UNSET__";

/** Escape a value for a single-quoted JS string literal. */
function jsString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The filter for a log type nothing could discriminate.
 *
 * Never matches, names the log type, and is recognisable by
 * {@link isPlaceholderFilter} so callers can report what still needs a human.
 */
export function placeholderRouteFilter(logType: string): string {
  return `${UNSET_FIELD} === ${jsString(logType)}`;
}

/**
 * Whether a route condition is one of ours awaiting an edit.
 *
 * Matched on the sentinel field alone: an operator who has replaced the filter
 * has removed `__UNSET__`, and the log type stops being reported. That is the
 * intended way for the warning to clear - by the work being done, not by a
 * separate flag someone has to remember to unset.
 */
export function isPlaceholderFilter(routeCondition: string): boolean {
  return routeCondition.includes(UNSET_FIELD);
}

/**
 * WHY a log type will need a hand-written route filter - and the reason some
 * formats get their own answer (HON-5, GEN-8).
 *
 *   evidence  the samples did not separate it from a sibling THIS TIME. More
 *             or better samples can fix it, and often do.
 *   format    it can NEVER be separated automatically, whatever the samples
 *             say. At route time the event is unparsed, so a filter can only
 *             test the raw text; when NONE of a format's field names occurs in
 *             that text, both discriminators return null - see
 *             route-discriminator and route-value-discriminator, which each ask
 *             {@link formatCanDiscriminate} rather than restating the rule.
 *
 * Collapsing these into one warning is the failure this exists to avoid. Told
 * "no discriminator found", such an operator will go and collect more samples,
 * which cannot possibly help; told the truth, they write one filter and move
 * on. The generic placeholder message is right for every other format and
 * wrong for these.
 *
 * TWO MECHANISMS SHARE THE `format` CAUSE and they do NOT share wording, which
 * is why {@link csvRoutingWarning} returns two texts:
 *
 *   column order (csv, positional)  the names come from a column POSITION.
 *   regex capture (syslog)          the names come from a regex over the line.
 *
 * Same verdict, different sentence: a syslog operator handed the column-order
 * text would go looking for columns their events do not have, which is the same
 * wrong-cause failure this type exists to prevent, one step further down.
 */
export type PlaceholderCause = "evidence" | "format";

/**
 * The formats whose events carry values in COLUMN ORDER and no field names.
 *
 * "csv" was only ever one half of this set, and the other half shipped without
 * it (GEN-6 taught the parser and the pipeline about whitespace-positional logs
 * and left the router believing they were routable).
 */
const COLUMN_ORDER_FORMATS: ReadonlySet<string> = new Set(["csv", "positional"]);

/**
 * The formats whose field names are all minted by a REGEX CAPTURE.
 *
 * `parseSyslog` matches one RFC 3164 or RFC 5424 pattern per line and names the
 * capture groups: Timestamp, Hostname, Program, PID, Message, Facility,
 * Severity, and for RFC 5424 Priority, Version, AppName, ProcID, MsgID. None of
 * those words is in the line. The ONE key it copies verbatim is `_raw`, the
 * whole line, and it separates nothing either: every syslog log type in the
 * pack carries `_raw`, so the presence path can never find it unique.
 *
 * Same verdict as column order, different mechanism, so it is a second set
 * rather than a widening of the first - {@link csvRoutingWarning} has to tell
 * these two operators different things.
 */
const REGEX_CAPTURE_FORMATS: ReadonlySet<string> = new Set(["syslog"]);

/**
 * Per format, the names minted from a HEADER POSITION rather than read out of
 * the event text. Exactly what `parseCef` and `parseLeef` assign before they
 * reach the extension pairs (sample-parsing/parsers.ts).
 *
 * `_syslogHeader` is on the CEF list and is easy to miss: parseCef adds it
 * whenever a CEF line has a syslog prefix, it is a perfectly valid JS
 * identifier, and it is long enough to outrank the short extension names a
 * firewall event actually carries in the length-first sort in
 * route-discriminator - which is the ONE place the character counts are
 * stated, so this comment does not restate them. Measured on a two-log-type
 * CEF plan where only one type had the prefix, the presence path emitted
 * `_syslogHeader !== undefined || ... _raw.indexOf('_syslogHeader=')` and
 * matched 0 of that type's 2 events at route time.
 *
 * parseLeef assigns no `_syslogHeader`, so the LEEF list does not carry one.
 */
const MINTED_HEADER_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "cef",
    new Set([
      "cefversion",
      "devicevendor",
      "deviceproduct",
      "deviceversion",
      "deviceeventclassid",
      "name",
      "severity",
      "_syslogheader",
    ]),
  ],
  [
    "leef",
    new Set([
      "leefversion",
      "devicevendor",
      "deviceproduct",
      "deviceversion",
      "eventid",
    ]),
  ],
]);

/**
 * Whether this format can EVER route automatically.
 *
 * FALSE when NO field name of the format reaches the route. A route is
 * evaluated BEFORE the pipeline extracts, so the only things a filter can test
 * are the raw text and whatever the source already parsed - and for these
 * formats every name is minted downstream of the route, either from a column
 * POSITION or from a REGEX CAPTURE.
 *
 * MEASURED by parsing events per format and asking which of the field names the
 * parser produced occur anywhere in the raw line (2026-09-03), then by building
 * the filter the two discriminators actually emit and evaluating it against an
 * unparsed route-time event (2026-09-04, GEN-8):
 *
 *   positional, AWS VPC Flow v2      14 names, 14 absent (version, account_id,
 *                                    interface_id, srcaddr, dstaddr, ...)
 *   positional, unrecognised shape    6 names,  6 absent (field1..field6)
 *   csv, headerless PAN-OS            6 names,  6 absent (receive_time, serial,
 *                                    type, subtype, generated_time, src)
 *   syslog, sshd vs CRON              value path chose `Program === 'sshd'`,
 *                                    matched 0 of 2 of its OWN events
 *   json / ndjson / kv                0 absent - the name is IN the event text
 *
 * So on a two-log-type positional plan `deriveRouteDiscriminator` emitted
 * `interface_id !== undefined || (typeof _raw === 'string' &&
 * _raw.indexOf('interface_id=') !== -1) || ...` - every disjunct false for
 * every event, a route that DEAD-ENDS. That was worse than the CSV case sitting
 * next to it, because a filter WAS produced: the log type was therefore neither
 * a placeholder nor reported unreachable, and the pack previewed clean. Syslog
 * failed identically, and had a second shape besides: with ONE event per log
 * type and the log type tagged from the text of the message, the value path
 * chose `Message === 'Failed password for root'` - a whole message string, so
 * a filter over-fitted to one sampled event on top of being untestable at route
 * time. (`_raw` was NOT what it picked, though it qualifies on every guard:
 * `Message` outranks it on the field-name tiebreak. Measured, because the
 * plausible version of that sentence was wrong.)
 *
 * Kept as a predicate over the format string rather than a list of formats
 * elsewhere, because both discriminators call THIS and a third opinion about
 * which formats cannot route is how they drift apart.
 *
 * NOT THE ONLY NAMES THAT ARE MINTED, and the rest are deliberately NOT folded
 * in here, because they are not whole-format facts:
 *
 *   cef      the HEADER names are minted and the EXTENSION pairs are genuinely
 *   leef     in the text, so these formats stay routable and lose only the
 *            headers - a per-FIELD answer, {@link isMintedHeaderField}.
 *   json     the string an UNDETECTED sample arrives as, and so the real
 *            carrier of the remaining gap. `normalizeSourceFormat`
 *            (pipeline-preview-state.ts) erases "unknown" to "json" before the
 *            plan input is built, so neither this predicate nor either
 *            discriminator is ever handed "unknown" - only csvRoutingWarning
 *            is, from the samples screen, which passes the DETECTED format.
 *            Whether such a sample's names are minted depends on the CONTENT,
 *            and "json" cannot say, because a real JSON document's names ARE in
 *            its text. See {@link isMintedHeaderField} for the measurements and
 *            for what stays open.
 */
export function formatCanDiscriminate(format: string): boolean {
  const f = format.toLowerCase();
  return !COLUMN_ORDER_FORMATS.has(f) && !REGEX_CAPTURE_FORMATS.has(f);
}

/**
 * Whether this field's NAME is one the format mints from a header position -
 * present in the parsed record, absent from the text a route filter can see.
 *
 * THE PER-FIELD HALF OF GEN-8, and the reason cef and leef are not in
 * {@link formatCanDiscriminate}'s sets. A CEF event carries its extension pairs
 * as `name=value` in the raw text - `act=Allowed` is right there - so CEF packs
 * route perfectly well on extension fields and excluding the whole format would
 * throw away working routing. Only the seven pipe-delimited header values (plus
 * `_syslogHeader`) have names that exist nowhere but the parser.
 *
 * WHY THE DISCRIMINATORS PREFER EXACTLY THE UNUSABLE HALF, which is what made
 * this silent rather than merely lossy:
 *
 *   presence path  sorts candidates LONGEST NAME FIRST, so every CEF header
 *                  name outranks the `act` / `src` / `dst` a firewall event
 *                  actually carries, by construction. The character counts are
 *                  stated ONCE, on that sort in route-discriminator, and are
 *                  deliberately not restated here: restating them is how this
 *                  comment came to call `_syslogHeader` 14 characters while the
 *                  two other copies said 13 and the string is 13.
 *   value path     requires the value to NAME the log type, and a CEF header is
 *                  where a vendor puts exactly that. Measured on AUTH vs
 *                  TRAFFIC sharing one extension schema, it chose
 *                  `DeviceEventClassID === 'AUTH'`, which matched 0 of 2 of its
 *                  own events at route time; LEEF's `EventID` behaved the same.
 *
 * MATCHED CASE-INSENSITIVELY, which is a deliberate trade rather than tidiness.
 * The names arriving here come from vendor mappings, which need not preserve the
 * parser's capitalisation; and parseCef assigns extensions AFTER headers, so a
 * vendor that really does send an extension pair `Name=...` overwrites the
 * header and loses a genuinely-present name to this exclusion. That costs a
 * placeholder, which the operator is told about. The other way round costs a
 * route that matches nothing and reports clean, which nobody sees.
 *
 * THE UNDETECTED-SAMPLE GAP IS KEYED ON "json", NOT "unknown". This comment said
 * "unknown" until 2026-09-04, which pointed the gap, its pin and its card at a
 * string the product never delivers to this function: `normalizeSourceFormat`
 * (pipeline-preview-state.ts) turns "unknown", "" and undefined into "json"
 * before `reportToPlanInput` builds the plan, so the planner and both
 * discriminators only ever see "json". "unknown" reaches exactly one caller on
 * this surface - csvRoutingWarning, from the samples screen, which is handed the
 * DETECTED format.
 *
 * MEASURED THROUGH THE REAL CHAIN with planFormat = "json" (2026-09-04):
 * parseByFormat's try-each fallback over the content, fieldValuesFromRecords,
 * the value path, then the emitted filter evaluated against an unparsed
 * route-time event carrying only `_raw`. Two log types, two events each, all
 * four parsed in every case:
 *
 *   CEF content, AUTH vs TRAFFIC      `DeviceEventClassID === 'AUTH'`   0 of 2
 *   RFC 3164 syslog, sshd vs CRON     `Program === 'sshd'`              0 of 2
 *   headerless PAN-OS CSV             `_2 === 'TRAFFIC'`                0 of 2
 *
 * CALIBRATION, and the reason those zeros mean anything: the same harness on
 * JSON content whose names really ARE in the text emitted `authField !==
 * undefined || (typeof _raw === 'string' && _raw.indexOf('"authField"') !== -1)`
 * and matched 2 of 2. It can return true.
 *
 * All three produced a FILTER, so each log type counted as neither a placeholder
 * nor unreachable and the pack previewed clean - GEN-8's exact failure, and this
 * fix does not touch it. Worse than a dead disjunct, in fact: for json and
 * ndjson deriveValueDiscriminator suppresses the `_raw` fallback outright (a
 * bare value token would match anywhere in a JSON document), so what ships is a
 * BARE field test with no second disjunct at all.
 *
 * WHY THIS PREDICATE STILL CANNOT ANSWER IT, re-argued on the corrected premise.
 * The signature DOES receive the string that carries the gap, so "the format
 * string cannot see it" was never the reason. The reason is that the string it
 * receives is "json", and json is a format whose names genuinely are in the
 * text: a JSON document carrying `Name`, `Severity` or `Timestamp` is ordinary,
 * and applying the CEF or LEEF sets to "json" would delete real routing from
 * every genuine JSON pack in order to rescue the undetected ones. The fix is
 * unchanged - key the exclusion on the parser that actually RAN rather than on
 * the declared format - and it still needs the effective format carried out of
 * sample-parsing and through plan.ts, which is a change to neither of the two
 * functions this predicate serves.
 */
export function isMintedHeaderField(field: string, format: string): boolean {
  const minted = MINTED_HEADER_FIELDS.get(format.toLowerCase());
  return minted !== undefined && minted.has(field.toLowerCase());
}

/**
 * The warning for a log type that WILL placeholder because of its FORMAT, or
 * null when there is nothing to say.
 *
 * THE NAME IS NARROWER THAN THE FUNCTION as of 2026-09-03, and narrower again
 * since GEN-8: it answers for "positional" and "syslog" too. Renaming it would
 * edit the pipeline-generation barrel and the samples screen, which are outside
 * this change's scope, so the name is left and the rename is GEN-9. The
 * behaviour is defined by {@link formatCanDiscriminate}, not by this identifier.
 *
 * NOTHING IS SAID HERE FOR cef OR leef, on purpose. Those formats route fine on
 * extension fields, so a format-level warning would fire on every CEF pack in
 * the product - crying wolf about packs that work, which is the DBT-19 failure
 * this repo has already had twice.
 *
 * WHAT A CEF HEADER-ONLY LOG TYPE ACTUALLY GETS, since the reason for a silence
 * has to be true or the silence is unargued: this function returns null, and the
 * log type lands in `placeholderLogTypes` (route-yml) like every other
 * placeholder. The pipeline preview renders ONE hardcoded banner for that whole
 * list - "Nothing in these samples separates X from the others, so the pack
 * ships them with a placeholder filter that matches nothing" - so the operator
 * is told something, and what they are told is evidence-flavoured.
 *
 * THAT BANNER IS NOT DERIVED FROM {@link PlaceholderCause}, and this comment
 * claimed it was until 2026-09-04 ("reports the generic `evidence` cause
 * instead"). Nothing in this repo ever reports a PlaceholderCause: the type has
 * exactly two references, this declaration and its type-only re-export from the
 * pipeline-generation barrel. No function returns one, no state stores one, no
 * screen renders one. The banner is a literal string in
 * pipeline-preview-section.tsx that happens to say what the `evidence` cause
 * would have meant, and it says it for every placeholder regardless of format.
 *
 * THE SILENCE STILL STANDS on the corrected premise, which is worth arguing
 * separately from the mechanism. "Nothing in these samples" is the right thing
 * to tell a CEF operator in the ordinary case: a wider sample really can turn up
 * an extension field that separates the log type, where no sample can ever help
 * a CSV or syslog pack. It is not honest in the narrow one - the operator whose
 * vendor distinguishes its log types ONLY by DeviceEventClassID is being sent to
 * collect samples that cannot help - and fixing THAT needs the placeholder
 * report to carry a per-field reason, which is a wider surface than the two
 * arguments below and does not exist in any form today.
 *
 * `siblingCount` is load-bearing and the reason this is not a one-line format
 * check. A single-log-type pack keeps its match-all and routes correctly -
 * plan.ts only runs the discriminator ladder `if (tables.length > 1)` - so
 * warning there would be crying wolf about a pack that works, which is the
 * failure mode this repo has already hit twice with over-eager reports.
 *
 * @param format       the log type's source format
 * @param siblingCount how many OTHER log types share the pack
 */
export function csvRoutingWarning(
  format: string,
  siblingCount: number,
): string | null {
  if (formatCanDiscriminate(format)) return null;
  if (siblingCount < 1) return null;
  if (REGEX_CAPTURE_FORMATS.has(format.toLowerCase())) {
    // ITS OWN TEXT, because its own mechanism: there are no columns to point at
    // and the names come off a regex.
    //
    // `_raw` IS NAMED AS THE ANSWER, which is the reverse of what this comment
    // argued until 2026-09-04. It used to say that naming `_raw` was "what stops
    // an operator concluding they could just filter on it" - steering them away
    // from the one filter that works - and the text ended "no filter can tell
    // this log type from the others in the pack", which is FALSE and contradicts
    // the sentence after it: an operator asked to complete a placeholder was
    // being told the work was impossible.
    //
    // What cannot separate these log types is the FIELD NAMES. The raw TEXT
    // separates them fine. MEASURED on the exact two-event fixture
    // route-value-discriminator.test.ts pins for this format (sshd vs CRON,
    // 2026-09-04): `typeof _raw === 'string' && _raw.indexOf('sshd[') !== -1`
    // is TRUE on the sshd line and FALSE on the CRON line, and the mirror on
    // 'CRON[' is exactly the reverse. So the text hands that form over.
    //
    // The narrower true claim is what "more samples will not change that" now
    // attaches to: nothing this tool BUILDS FROM THOSE NAMES can match, because
    // the names are minted by the regex however many events arrive.
    return (
      "Syslog log types cannot be routed automatically. Routes are evaluated " +
      "before the pipeline extracts, and at that point the event is a single " +
      "unparsed line. The field names shown here (Timestamp, Hostname, " +
      "Program, PID, Message, and the RFC 5424 additions) were captured by a " +
      "regex and appear nowhere in the line itself, so no filter built from " +
      "them can match anything, and more samples will not change that. Write " +
      "the filter over the raw line instead: _raw is the whole line and every " +
      "syslog log type in the pack carries it, so match text that only this " +
      "log type's lines contain. For example typeof _raw === 'string' && " +
      "_raw.indexOf('sshd[') !== -1 selects sshd lines and not CRON ones. Its " +
      "route ships with a placeholder filter for you to complete."
    );
  }
  // ONE MESSAGE FOR BOTH COLUMN-ORDER FORMATS, and every clause has to be true
  // of both. A CSV data row and a whitespace-positional line differ only in
  // their separator: each carries values in column order, and the field names
  // shown in the app were worked out from those positions rather than read out
  // of the event. Naming CSV alone - which this did until positional joined the
  // set - would have sent a VPC Flow operator looking for a CSV bug they do not
  // have.
  //
  // THIS TEXT STILL CARRIES THE FALSE CLAUSE THE SYSLOG BRANCH JUST LOST, and
  // saying so here is the loud part. "So no filter can tell this log type from
  // the others in the pack" is wrong for column order in exactly the way it was
  // wrong for syslog: it is the field NAMES that cannot separate them, and it
  // contradicts the sentence after it, which asks the operator to complete a
  // placeholder. MEASURED 2026-09-04 - headerless PAN-OS CSV,
  // `_raw.indexOf(',TRAFFIC,')` is TRUE on the TRAFFIC line and FALSE on the
  // THREAT line; AWS VPC Flow v2 positional, `_raw.indexOf(' ACCEPT ')` is TRUE
  // on the ACCEPT line and FALSE on the REJECT line. Both separate cleanly.
  //
  // FIXED 2026-09-04, and the argument for deferring it is recorded because it
  // was nearly right. The draft above said this string is HON-5's, live-verified
  // on 2026-08-30, that rewriting verified operator copy as a drive-by is how
  // wording gets worse than the defect, and that it was "filed instead".
  //
  // TWO THINGS BROKE THAT. NO CARD WAS FILED - the third time a comment in THIS
  // FILE has claimed a filing that did not happen, which is what GEN-8 exists
  // for. And the caution does not reach this clause: HON-5 verified that the
  // copy RENDERS and reads well, not that it is TRUE, and a clause measured
  // false is not protected by having once been reviewed. Leaving it would also
  // have left one function telling one operator the truth and another the false
  // version, from the same warning.
  //
  // The change is the minimum: the false clause is replaced with the narrow true
  // one and a worked example, matching the shape the syslog branch already uses.
  // HON-5's live verification no longer covers this sentence - GEN-10 records
  // that, so the next live pass knows to re-read it.
  return (
    "Column-order log types (CSV rows, whitespace-positional lines) cannot be " +
    "routed automatically. Routes are evaluated before the pipeline extracts, " +
    "and at that point the event is still unparsed: it carries values in column " +
    "order, and the field names shown here were worked out from those positions " +
    "rather than read out of the event. So nothing built from those field " +
    "names can separate this log type from the others, and more samples will " +
    "not change that. Write the filter over the raw line instead - for a " +
    "headerless CSV, _raw.indexOf(',TRAFFIC,') !== -1 selects TRAFFIC rows and " +
    "not THREAT ones. Its route ships with a placeholder filter for you to " +
    "complete."
  );
}
