/**
 * Field names Cribl can ADDRESS, and the note for the ones it cannot (DBT-78).
 *
 * Cribl reads a field name in an add/remove/rename as a PROPERTY ACCESSOR PATH,
 * not as a literal string. Two failure shapes follow, and they are not equally
 * dangerous:
 *
 *   HYPHEN, LOUD.   `account-id` parses as `account` minus `id`, so the pipeline
 *                   loads and then dies at runtime with
 *                   `Failed to build property accessor, path="account-id"`.
 *                   A user hit exactly this on AWS VPC Flow Logs.
 *   DOT, SILENT.    `a.b` IS a valid accessor - for a NESTED field. A FLAT field
 *                   literally named `a.b` therefore produces no error at all:
 *                   the rename addresses something that does not exist, renames
 *                   nothing, and the build reports success. This is the one that
 *                   makes the rule non-negotiable rather than a warning.
 *
 * WHY THE PREDICATE LIVES IN sample-parsing rather than beside the validator
 * that enforces it. The rule was written twice - once as an inline regex in
 * pipeline-generation/cribl-yaml-validator.ts, once here for the parse-time note
 * - and two copies of one rule drift, which this codebase has already paid for
 * (see the producer/recogniser note on `positionalFieldName` in models.ts). The
 * import direction pipeline-generation -> sample-parsing already exists
 * (PANOS_CSV_HEADERS), so the shared home is here.
 *
 * WHY THE PARSER DOES NOT SIMPLY RENAME THESE TO SAFE NAMES, which is the route
 * positional.ts took for VPC Flow and the obvious thing to try next. It works
 * there and NOT here, and the difference is who mints the runtime field name:
 *
 *   POSITIONAL / PAN-OS CSV. The generated pipeline splits `_raw` itself and
 *     assigns each column with `- name: account_id / value: __csvParts[1]`. WE
 *     are on the left-hand side of that assignment, so choosing `account_id`
 *     makes the parsed name and the runtime name the same name by construction.
 *   JSON / NDJSON / KV. The generated pipeline extracts with Cribl's own serde
 *     (`type: json` or `type: kvp` over `_raw` - pipeline-conf.ts, the trailing
 *     `else` branch). The runtime field names come out of the VENDOR'S BYTES via
 *     Cribl's extractor, not out of us. Sanitising `src-ip` to `src_ip` in the
 *     parser would make the build pass and then emit a rename addressing a field
 *     no event carries - which is the identical silent failure, moved one layer
 *     down and now wearing a green build. Strictly worse than refusing.
 *
 * So for extractor-named formats the honest answer is to keep the vendor
 * spelling and say plainly that it cannot be addressed. NOT ATTEMPTED,
 * deliberately: an escape syntax. Quoting is out (the three rules above this one
 * in checkCriblYaml exist because Cribl's YAML loader rejects quoted field
 * names), and bracket notation in an eval expression (`__e['src-ip']`) could not
 * be checked against a live Cribl - guessing a syntax and then pinning the guess
 * is how a wrong answer acquires credibility.
 *
 * WHAT THIS NOTE MUST NOT PROMISE: that pack generation stops these names. It
 * stops ONE FATE of them - a field the matcher RENAMES - and that is not the
 * ordinary fate of an awkward vendor name. `checkCriblYaml` only ever reads a
 * name that lands on a `name:`/`currentName:`/`newName:` line UNDER a
 * function's `conf: -> add:`/`rename:`, and a rename is the only thing that
 * puts a VENDOR name on one.
 *
 * THE AXIS OF THIS GAP IS THE FATE, NOT THE CHARACTER CLASS, which is the part
 * of this note worth carrying forward. GEN-4 widened the class on 2026-09-03 -
 * a name containing WHITESPACE is now refused on a rename line, where before it
 * was not - and every row of the fate table below moved by exactly zero. Expect
 * the same of the next widening: the class decides WHICH names are refused once
 * the rule sees them, the fate decides WHETHER it sees them at all.
 *
 * Measured 2026-09-03, re-measured after GEN-4, by running the whole chain
 * (parseSampleContent -> matchSampleToSchema -> buildPipelinePlan ->
 * generatePipelineConfForPlan -> checkCriblYaml) and counting issues on the
 * FULL generated conf:
 *
 *   RENAMED   src-ip/dst-ip/account-id -> SrcIpAddr/DstIpAddr/AccountId, so
 *             `- currentName: src-ip` is emitted           3 issues  REFUSED
 *   RENAMED   "Device Action"/"Source IP"/"Destination IP"/
 *             "Source Port"/"Destination Port" -> the
 *             CommonSecurityLog columns spelled the same
 *             way without the spaces                       5 issues  REFUSED
 *   UNMATCHED aws.account, or "Source IP", with no
 *             destination column: the only trace is a
 *             bullet in the cleanup eval's `remove:` list,
 *             which is not a name: line                    0 issues  ships
 *   KEPT      a.b, or "Source IP", matched to a column of
 *             the very same name: no rename is emitted,
 *             so no line at all                            0 issues  ships
 *
 * The two whitespace entries are what moved on 2026-09-03, and only one of them
 * moved: the RENAMED one read 0 issues and shipped until GEN-4 taught the rule
 * to see a value containing a space. The unmatched and kept ones did not move
 * and CANNOT be moved by any character class - there is no line to read.
 *
 * THE REDUCTION CONF the same plan emits (generateReductionConfForPlan) agrees,
 * but only after you account for which of its TWO shapes you asked for, and the
 * numbers are misreadable otherwise. Measured against CommonSecurityLog, a
 * table that HAS reduction rules, the emitted conf is the full transformation
 * pipeline with the reduce group inserted: it carries the same
 * `- currentName:` lines and returns the same counts, 5 and 3. Measured against
 * TestTable_CL, which has none, it is the no-op FALLBACK pipeline, which
 * renames nothing at all and returns 0 - honestly, because there is no rename
 * in the file to refuse, not because the reduction path is a way around the
 * refusal. Both are pinned, the second on the absence of `currentName` rather
 * than on the 0, since the bare number reads like an escape hatch.
 *
 * THE SHIPPING ROWS READ 0 BECAUSE NOTHING UNADDRESSABLE REACHED THE RULE, not
 * because nothing reached it: every generated conf carries `name: Type` from
 * its enrich eval, which sits under `conf: -> add:` and IS read. Measured with
 * the predicate mutated to reject every name: each shipping TRANSFORM conf
 * yields exactly 1 issue - that `Type` line - while the hyphenated refused one
 * goes 3 -> 7 (three currentName, three newName, one `Type`) and the spaced one
 * 5 -> 11. The rules-carrying reduction conf (CommonSecurityLog again) holds
 * one more such line throughout and reads one higher: 2, 8 and 12.
 *
 * NOT read, and NOT because they are identifiers - they are not. Every conf
 * also carries three group headers unconditionally (`name: Field Extraction`,
 * `name: Enrich & Classify`, `name: Sentinel Cleanup`), all of them prose, and
 * a rule that read them would give every pack three false failures. They are
 * excluded by their ENCLOSING BLOCK - `groups:`, never `conf:` - and not by
 * their shape, which is exactly what let GEN-4 widen the value class to `.+`
 * without collecting them. Confirmed by the same mutation: reject every name
 * and a shipping conf still reports 1, not 4. See `enclosingBlockPath` in
 * pipeline-generation/cribl-yaml-validator.ts.
 *
 * So the refusal is conditional on the FATE OF THE FIELD, not on the name: an
 * awkward name the schema has a column for AND spells differently is refused,
 * and the same name with no column - every vendor field the destination table
 * has no home for, which is the whole reason a gap analysis exists - builds
 * clean with this note as its only warning. The note therefore states the FACT
 * (not an accessor, fix it upstream) and claims no safety net - a note
 * asserting a guarantee the build does not honour is worse than no note,
 * because the operator stops looking.
 *
 * ONE GAP REMAINS IN THE BUILD, WHERE THERE WERE TWO. The whitespace one is
 * closed IN THE CODE: the validator now tells a GROUP `name:` apart from a
 * field `name:`/`currentName:`/`newName:` by the enclosing block, and only then
 * widens the value class - the order mattered, since widening alone would have
 * collected the three group headers above. It has pins in
 * cribl-yaml-validator.test.ts and the asymmetry pin in this file's test.
 *
 * The unmatched/kept one is OPEN, and no character class can close it - there
 * is no line to read. It needs the validator to read names the conf does not
 * present as identifiers (`remove:` bullets), which is a NEW rule, and it needs
 * a LIVE Cribl measurement of what a glob list does with an unaddressable name.
 * Guessing that and pinning the guess is how a wrong answer acquires
 * credibility, which is the same reason DBT-78 declined to invent an escape
 * syntax.
 *
 * WHICH CARDS COVER WHAT, read from docs/board.json on 2026-09-03: GEN-4 is the
 * whitespace hole, GEN-5 the unmatched/kept one, and DBT-78 the original
 * hyphen/dot defect this whole module answers. STATUS IS DELIBERATELY NOT
 * RECORDED HERE. An earlier version of this comment and its counterpart in
 * cribl-yaml-validator.ts each asserted board state - "NEITHER GAP IS ON A
 * CARD" here against "THAT GAP IS ON A CARD, and this one no longer is" there -
 * and on 2026-09-03 they were flatly contradicting each other, both dated the
 * same day. A comment cannot keep a status in sync with a board that moves
 * without it, so this one names the CARD IDS and stops. Read the board for
 * where they stand.
 */

/**
 * Whether Cribl can build a property accessor for `name` - i.e. whether it is a
 * bare identifier. Deliberately the strictest reading: leading letter or
 * underscore, then letters, digits and underscores. Nothing else, including a
 * dot, because a dot is exactly the character that fails without saying so.
 *
 * The `_` cases are intentionally safe: `_raw`, `_time`, `_0`, `_extra_12` are
 * all addressable, and all of them are names this app itself mints.
 */
export function isCriblAccessorSafe(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** How many offending names the note spells out before it summarises. */
const MAX_LISTED = 5;

/**
 * The parse note for fields whose names Cribl cannot address, or null when every
 * name is fine.
 *
 * Carried in `ParsedSample.errors` - the same non-fatal-note channel DBT-77's
 * positional note uses, rendered as "Parse notes" by
 * ui/screens/samples/sample-intake-section.tsx. SAYING IT AT PARSE TIME is the
 * point, for two reasons and not one:
 *
 *   WHEN.    The operator picks the file in section 2 of the Integrate page,
 *            Add Sample Data; where checkCriblYaml does refuse the name it
 *            refuses seven sections later, in section 9 ("Cannot build: Cribl
 *            YAML validation found N issue(s)"). This note lands in section 2,
 *            while that file is still in hand. NOT because the build message is
 *            unclear: measured, it quotes the offending NAME right after its
 *            `Line N:` prefix and echoes the source line back - `Line 4: field
 *            name "account-id" is not a valid Cribl property accessor ... : -
 *            currentName: account-id`. Anyone reasoning from "it only gives a
 *            line number" is reasoning from a false premise.
 *   WHETHER. Whether there is a build refusal to be early to at all depends on
 *            the field's FATE, and of the fates measured only one produces one:
 *            a RENAMED field. A name with no destination column and a name kept
 *            as-is both build clean, whatever characters they contain (see the
 *            header's table). For those this note is the ONLY warning that will
 *            ever exist. A name containing WHITESPACE was in that list until
 *            2026-09-03 and is not any more - on a rename line GEN-4 refuses it
 *            - but whitespace was never what decided it, the fate was, so the
 *            note's job is unchanged.
 *
 * So the wording stops at what is true of every case: these are not accessors,
 * and the fix is upstream. It must not tell the operator the build will catch
 * it, because in the common case the build ships.
 */
export function unaddressableFieldNote(
  fieldNames: readonly string[],
): string | null {
  const bad = fieldNames.filter((name) => !isCriblAccessorSafe(name));
  if (bad.length === 0) return null;

  const listed = bad.slice(0, MAX_LISTED).join(", ");
  const rest = bad.length > MAX_LISTED ? `, and ${bad.length - MAX_LISTED} more` : "";
  return (
    `${bad.length} field ${bad.length === 1 ? "name is" : "names are"} not a ` +
    `Cribl property accessor: ${listed}${rest}. Cribl reads a field name as an ` +
    "accessor path, so a hyphen fails at runtime (invalid property accessor " +
    "path) and a dot is WORSE - it silently addresses a nested field that does " +
    "not exist, renames nothing, and reports success. Give the field an " +
    "addressable name upstream of this pipeline if you need to map it."
  );
}
