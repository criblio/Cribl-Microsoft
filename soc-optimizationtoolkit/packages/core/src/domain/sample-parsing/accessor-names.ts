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
 * stops ONE case of them - a field the matcher RENAMES - and that is not the
 * ordinary fate of an awkward vendor name. `checkCriblYaml` only ever reads a
 * name that LANDS ON a `name:`/`currentName:`/`newName:` line, and a rename is
 * the only thing that puts a VENDOR name on one. Other such lines do exist and
 * the rule does read them - each generated conf below carries `name: Type`
 * from its enrich eval - but those names are minted by this app and are bare
 * identifiers by construction. So the shipping rows below read 0 issues
 * because nothing UNADDRESSABLE reached the rule, not because nothing reached
 * it: with the predicate mutated to reject every name, each of the two
 * SHIPPING confs yields exactly 1 issue - that `Type` line - while the refused
 * one goes from 3 issues to 7. Measured 2026-09-03 by
 * running the whole chain (parseSampleContent -> matchSampleToSchema ->
 * buildPipelinePlan -> generatePipelineConfForPlan -> checkCriblYaml) and
 * counting issues on the FULL generated conf:
 *
 *   RENAMED   src-ip/dst-ip/account-id -> SrcIpAddr/DstIpAddr/AccountId, so
 *             `- currentName: src-ip` is emitted           3 issues  REFUSED
 *   UNMATCHED aws.account with no destination column: the
 *             only trace is a bullet in the cleanup eval's
 *             `remove:` list, which is not a name: line    0 issues  ships
 *   KEPT      a.b matched to a column also named a.b: no
 *             rename is emitted, so no line at all         0 issues  ships
 *
 * And one more, measured on a rename line rather than a generated conf,
 * because it is a property of the line matcher and needs no chain to show:
 *
 *   SPACED    "Source IP" ON a rename line - the line
 *             matcher `([^'"\s][^\s]*)\s*$` cannot match a
 *             value containing a space                     0 issues  ships
 *
 * So the refusal is conditional on the FATE OF THE FIELD, not on the name: an
 * awkward name the schema has a column for is refused, and the same name with
 * no column - every vendor field the destination table has no home for, which
 * is the whole reason a gap analysis exists - builds clean with this note as its
 * only warning. The note therefore states the FACT (not an accessor, fix it
 * upstream) and claims no safety net - a note asserting a guarantee the build
 * does not honour is worse than no note, because the operator stops looking.
 *
 * NEITHER GAP IS CLOSED HERE. The unmatched/kept one needs the validator to
 * read names the conf does not present as identifiers (`remove:` bullets), which
 * is a NEW rule rather than a wider class. And widening the class for the spaced
 * one has a trap worth recording: `[^\s]*` is load-bearing. Widening it alone
 * makes the rule match pipeline GROUP headers, which are `name:` lines carrying
 * prose. Measured on four generated confs (kv, json, ndjson; renamed, dropped
 * and kept fates): each carries exactly the three group headers pipeline-conf.ts
 * emits unconditionally - "Field Extraction", "Enrich & Classify", "Sentinel
 * Cleanup" - a widened class matches all three, and none is an identifier, so
 * every pack would gain three false failures. Read from the emitter rather than
 * measured: two more headers are conditional ("Volume Reduction" with reduction
 * rules, "Overflow Collection" with an overflow field), so a pack carrying those
 * would gain five. Teaching the validator whitespace names first requires
 * telling a GROUP `name:` apart from a field
 * `name:`/`currentName:`/`newName:`, which is its own change with its own pins.
 *
 * NEITHER GAP IS ON A CARD. Checked against docs/board.json 2026-09-03: DBT-78
 * is the only card in this neighbourhood and it is about the ESCAPE SYNTAX
 * question (what Cribl accepts for a non-identifier path), not about either
 * hole in the rule's reach. Until cards exist this comment and the one in
 * cribl-yaml-validator.ts are the record - do not read "tracked elsewhere"
 * into them.
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
 *            the field's fate, and of the four fates measured only one produces
 *            one: a RENAMED field. A name with no destination column, a name
 *            kept as-is, and a name containing whitespace all build clean (see
 *            the header's table). For those this note is the ONLY warning that
 *            will ever exist.
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
