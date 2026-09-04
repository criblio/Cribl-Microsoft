/**
 * checkCriblYaml - the Cribl-safe YAML acceptance validator - porting-plan
 * Unit 17 (compatibility contract, section 3 item 7).
 *
 * Extracted VERBATIM from the legacy UAT harness (test-uat-pack-build.ts
 * checkCriblYaml, lines 71-131) and promoted to a CORE validator with its own
 * tests. These are the rules Cribl's YAML loader is known to reject; the pipeline
 * conf.yml, route.yml, and inputs.yml this unit generates MUST pass it
 * (asserted in cribl-yaml-validator.test.ts and each emitter's test).
 *
 * Rules enforced (each returns a human-readable "Line N: ..." issue):
 *   - no `description: >` multiline blocks;
 *   - no double-quoted descriptions;
 *   - no colon+space (YAML mapping) or `=` in an unquoted description;
 *   - no tab characters;
 *   - no single-quoted field names in add/remove/rename (name/currentName/newName);
 *   - no field name that Cribl cannot build a property accessor for (DBT-78),
 *     selected by ENCLOSING BLOCK rather than by the shape of the value, so a
 *     group / route / breaker display name is not mistaken for one (GEN-4).
 *
 * Every rule reads lines split on LF, CRLF or CR alike - see the note at the
 * split in {@link checkCriblYaml} for the fail-open hole that bought.
 *
 * ONE addition vs the legacy extraction, per contract item 7 ("route key
 * `filter:` never `condition:`"): when the content is a ROUTE file (it contains a
 * top-level `routes:` key), any `condition:` line is flagged. This is gated on
 * route content so a legitimate breakers.yml `condition:` (Unit 19) is not
 * falsely flagged.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { isCriblAccessorSafe } from "../sample-parsing";

/**
 * The stack of YAML block keys ABOVE each line, by line index (`[]` = document
 * root). Line i's own key is NOT in its own path; `        - name: Foo` nested
 * under `conf:` -> `add:` returns `["functions", "conf", "add"]`.
 *
 * WHY THIS EXISTS, and why a line-oriented scan is enough here. `name:` names
 * two unrelated things in the same file, and until this function the validator
 * could not tell them apart. MEASURED 2026-09-03 by generating a full pack
 * (buildPipelinePlan -> scaffoldPack) and printing every `name:`/`currentName:`
 * /`newName:` line in every emitted .yml - four groups, and only the last is a
 * field name Cribl will address:
 *
 *   groups: -> <groupId>: -> name:   Field Extraction, Volume Reduction,
 *                                    Enrich & Classify, Overflow Collection,
 *                                    Sentinel Cleanup, Event Triage, Event
 *                                    Elimination, Event Suppression  (prose)
 *   rules:  -> - id: -> name:        JSON Array Breaker, JSON Newline
 *                                    Delimited  (breakers.yml, prose)
 *   routes: -> - id: -> name:        "Transform: TRAFFIC"  (route.yml, prose)
 *   conf:   -> add:/rename: -> name:/currentName:/newName:
 *                                    __cefParts, Type, SourcePort, src, and
 *                                    every vendor field a rename touches
 *                                    (ACCESSOR PATHS)
 *
 * So the separator is the ENCLOSING BLOCK, not the indentation and not the
 * spelling of the value. Indentation happens to separate them too in today's
 * emitters (prose names sit at column 4, field names at column 10), but that is
 * a fact about how deep these particular files nest, whereas `conf: -> add:` is
 * a fact about CRIBL'S FUNCTION SCHEMA: `add` and `rename` are the two conf
 * blocks whose `name`/`currentName`/`newName` Cribl parses as a property
 * accessor. A new emitter branch that adds fields (GEN-6's positional extract
 * step is one, in flight) writes them under `conf: -> add:` like every other,
 * so it is covered without being anticipated.
 *
 * The PARENT is checked as well as the key ({@link isAccessorNameBlock}) so a
 * pipeline group whose id happened to be `add` could not masquerade as an Eval
 * conf: a group id sits under `groups:`, never under `conf:`.
 *
 * Blank and comment lines are given the enclosing path unchanged rather than
 * their own indentation, which is zero and would otherwise close every block
 * above them.
 *
 * A key with an INLINE value opens nothing, which is what keeps `add: []`,
 * `conf: {}` and route.yml's `groups: {}` from being read as blocks, and keeps
 * a folded scalar's continuation lines (`comment: >` in the fallback reduction
 * conf) under `conf:` rather than under a block of their own.
 *
 * NOT A YAML PARSER, and it does not need to be for what this validator asks of
 * it: block-style mappings and sequences, indented with spaces, which is all
 * these emitters produce (a tab is refused outright by the rule above). It is
 * exported because it is the primitive the REMAINING hole in the accessor rule
 * needs - GEN-5 has to read `remove:` bullets, which this already reports as
 * `[..., "conf", "remove"]`.
 *
 * `lines` is expected to be already split AND line-ending normalised;
 * {@link checkCriblYaml} does both in one place so this and the rules read the
 * same array. A trailing carriage return does not in fact break this function -
 * measured, its opener ends `\s*$` and it returned the same path with and
 * without one - but an outside caller that splits its own content should
 * normalise, because the rules that consume this path do not all tolerate it.
 */
export function enclosingBlockPath(lines: readonly string[]): string[][] {
  const paths: string[][] = [];
  const open: Array<{ column: number; key: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      paths.push(open.map((o) => o.key));
      continue;
    }

    // The column at which this line's own CONTENT starts. A sequence bullet is
    // structure, not content: in `        - name: x` the key `name` begins at
    // column 10, and column 10 is what nests it under the block above.
    //
    // This differs from plain indentation ONLY when a sequence is indented
    // level with its own key (`add:` at column 2, `- name: Foo` at column 2) -
    // valid YAML for the same structure, and a style these emitters never
    // write, so mutating this line to plain indentation breaks no generated
    // conf. Measured, and pinned on the level-indented form instead of claimed
    // here.
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const bullet = /^ *(-\s+)/.exec(line);
    const column = bullet === null ? indent : indent + bullet[1].length;

    while (open.length > 0 && open[open.length - 1].column >= column) {
      open.pop();
    }
    paths.push(open.map((o) => o.key));

    const opener = /^ *(?:-\s+)?([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (opener !== null) {
      open.push({ column, key: opener[1] });
    }
  }

  return paths;
}

/**
 * Whether `path` is a block in which Cribl reads a `name:` as a PROPERTY
 * ACCESSOR rather than as a display string - the Eval function's `add:` list
 * and the Rename function's `rename:` list, both of which sit directly under a
 * function's `conf:`.
 */
function isAccessorNameBlock(path: readonly string[]): boolean {
  const key = path[path.length - 1];
  return (key === "add" || key === "rename") && path[path.length - 2] === "conf";
}

/**
 * Return the list of Cribl-YAML acceptance issues in `content` (empty = clean).
 * `fileName` is used only in messages; route detection is content-based.
 */
export function checkCriblYaml(content: string, fileName: string): string[] {
  const issues: string[] = [];

  // EVERY LINE ENDING IS NORMALISED ONCE, HERE, and every rule below - plus
  // {@link enclosingBlockPath} - reads the SAME array. No rule can be defeated
  // by the shape of a line break, because no rule ever sees one.
  //
  // This is not tidying; it closes a FAIL-OPEN hole GEN-4 opened in the same
  // change that closed the whitespace one, caught in review before it was
  // committed. GEN-4 replaced the accessor rule's value class
  // `([^'"\s][^\s]*)\s*$` with `(.+?) *$`, and in JavaScript a carriage return
  // is a LINE TERMINATOR, so `.` does not match one and a literal-space class
  // does not consume one either. On CRLF the matcher returned null for every
  // `name:`/`currentName:`/`newName:` line and the accessor rule reported the
  // file CLEAN. MEASURED 2026-09-03, one rename line, issue counts, the
  // pre-GEN-4 regex replicated alongside the current one in one vitest process:
  //
  //   name          LF old  LF new  CRLF old  CRLF new-before  CRLF new-after
  //   account-id         1       1         1               0               1
  //   a.b                1       1         1               0               1
  //   Source IP          0       1         0               0               1
  //   account_id         0       0         0               0               0
  //
  // The old regex survived CRLF by ACCIDENT - its `\s*$` tail absorbed the
  // carriage return - so GEN-4 traded a whitespace hole for a line-ending one,
  // in the direction this validator exists to prevent: silence on bad input.
  //
  // BOTH FIXES ARE APPLIED - this normalisation AND the accessor rule's `\s*$`
  // tail - and the first attempt applied only this one, on the argument that
  // doing both "would make removal of the normalisation undetectable by any
  // pin". THAT ARGUMENT WAS MEASURED FALSE. With the tail restored, deleting
  // this normalisation still fails a pin: the lone-carriage-return case, which
  // the ROUTE rule needs and which no tail can reach (1 failed of 28).
  //
  // They are not substitutes, they cover different sets, and the residual the
  // normalisation alone left is real. `.` does not match U+2028 LINE SEPARATOR
  // or U+2029 PARAGRAPH SEPARATOR either - they are JavaScript line terminators
  // - but `split(/\r\n|\n|\r/)` does not break on them, so normalisation never
  // reaches them. Measured on one rename line, trailing character appended,
  // issue counts from this function:
  //
  //   trailing   none  CR  NEL U+0085  LS U+2028  PS U+2029  TAB  SPACE
  //   normalise     1   1           1          0          0    2      1
  //   + `\s*$`      1   1           1          1          1    2      1
  //
  // Reachability is lower than CRLF's - no emitter writes U+2028 and YAML 1.2
  // does not treat it as a break, so it would have to arrive INSIDE a vendor
  // field name - which is why it was a residual rather than a live defect. But
  // the direction is the bad one, and "fixes the class" was the claim that left
  // it open. Two cheap guards covering different sets beat one elegant guard
  // covering most of them.
  // {@link enclosingBlockPath} was NOT the culprit and never went wrong here:
  // its opener still ends `\s*$`, and it returned ["conf","rename"] for the
  // CRLF rename line exactly as for the LF one. It is fed the normalised array
  // anyway so it cannot become one.
  //
  // NO SHIPPING CALLER PASSES CRLF TODAY - the emitters join with "\n" and
  // pipeline-preview-state.ts feeds this their output - so what was fixed is
  // LATENT, on the line ending this repo's own platform produces. Restoring
  // `\s*$` would have fixed exactly this regex and left the next `$`-anchored
  // rule to rediscover it; normalising fixes the class.
  //
  // A LONE CARRIAGE RETURN IS SPLIT ON TOO, and that one is not merely
  // defensive. Measured the same day, per rule, on `\r`-joined content: the
  // route-key rule also read 0, because `isRouteFile` needs `^routes:` on a
  // line of its own and a `\r`-joined document is ONE line. Splitting on all
  // three forms puts LF, CRLF and CR on identical counts AND identical
  // "Line N:" numbers.
  //
  // WHAT THIS DOES NOT DECIDE: whether Cribl's own loader minds CRLF. Not
  // measured, so nothing here flags it. This normalisation is about what the
  // rules below can SEE; it is not a claim that a CRLF pack is safe to ship.
  const lines = content.split(/\r\n|\n|\r/);
  const blockPaths = enclosingBlockPath(lines);

  // A route file uses `filter:`, never `condition:` (contract item 7). Detect
  // route content by a top-level `routes:` key so breakers.yml is unaffected.
  const isRouteFile = lines.some((l) => /^routes:\s*$/.test(l));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // description: > multiline (Cribl rejects)
    if (line.match(/^\s+description: >/)) {
      issues.push(`Line ${lineNum}: description: > multiline block (use single-line)`);
    }

    // description: "quoted" (Cribl rejects)
    if (line.match(/^\s+description: "[^"]+"/)) {
      issues.push(`Line ${lineNum}: description: "quoted" (use unquoted)`);
    }

    // special chars in unquoted descriptions
    if (line.match(/^\s+description: [^"'].*([:=()])/)) {
      const match = line.match(/description: (.+)/);
      if (match) {
        const desc = match[1];
        if (desc.includes(":") && !desc.startsWith("description")) {
          if (/[A-Za-z]:[ ]/.test(desc)) {
            issues.push(
              `Line ${lineNum}: description has colon+space (YAML mapping): ${desc.slice(0, 60)}`,
            );
          }
        }
        if (desc.includes("=") && !desc.startsWith('"')) {
          issues.push(
            `Line ${lineNum}: description has equals sign: ${desc.slice(0, 60)}`,
          );
        }
      }
    }

    // tabs
    if (line.includes("\t")) {
      issues.push(`Line ${lineNum}: contains tab character`);
    }

    // single-quoted field names in add/remove/rename
    if (line.match(/^\s+- name: '[^']+'/)) {
      issues.push(
        `Line ${lineNum}: single-quoted name (use unquoted): ${line.trim()}`,
      );
    }
    if (line.match(/^\s+- currentName: '[^']+'/)) {
      issues.push(`Line ${lineNum}: single-quoted currentName: ${line.trim()}`);
    }
    if (line.match(/^\s+- newName: '[^']+'/)) {
      issues.push(`Line ${lineNum}: single-quoted newName: ${line.trim()}`);
    }

    // A FIELD NAME CRIBL CANNOT BUILD AN ACCESSOR FOR (DBT-78).
    //
    // Cribl parses these as PROPERTY ACCESSOR PATHS, not as literal strings, so
    // a name that is not a bare identifier fails AT RUNTIME rather than at
    // load. A user hit exactly this with AWS VPC Flow Logs, whose AWS-documented
    // field names carry hyphens:
    //
    //   Failed to build property accessor, path="account-id",
    //   err=invalid property accessor path="account-id"
    //
    // The pipeline loaded fine and then renamed nothing. THIS RULE EXISTS TO
    // MOVE THAT FAILURE FORWARD - a build that would die in Cribl now fails
    // here, where the message can say which field and why.
    //
    // A DOT IS THE DANGEROUS ONE and is why this cannot be relaxed to "warn":
    // `a.b` IS a valid accessor, for a NESTED field. So a flat field literally
    // named `a.b` does not error - it silently addresses something that does
    // not exist, renames nothing, and reports success. Hyphens fail loudly;
    // dots fail quietly, which is worse.
    //
    // Scope note: quoting is NOT the escape hatch here - the three rules above
    // forbid it, because Cribl's YAML loader rejects those forms. Where the app
    // MINTS the runtime name (positional splits, PAN-OS CSV column assignment)
    // the fix is to mint an addressable one, as positional.ts does for VPC Flow.
    // Where Cribl's own serde mints it from the vendor's bytes (JSON, NDJSON,
    // key=value) there is no such move, and this refusal is the answer - see the
    // header of sample-parsing/accessor-names.ts.
    //
    // THE PREDICATE IS IMPORTED, not re-spelled: this rule was written here and
    // again for the parse-time note, and one rule in two regexes is the drift
    // this codebase keeps paying for.
    //
    // WHICH LINES THIS READS, and why it is not a regex over `name:`. Cribl
    // uses `name:` for two unrelated things: an accessor path inside an Eval's
    // `add:` or a Rename's `rename:`, and a DISPLAY STRING for a pipeline
    // group, a breaker rule and a route. The display ones carry prose - "Field
    // Extraction", "JSON Array Breaker" - so a matcher wide enough to see a
    // field name containing a space sees those too. This rule therefore selects
    // on the ENCLOSING BLOCK ({@link enclosingBlockPath}, whose header carries
    // the measured inventory of all four kinds), and the value class is then
    // free to be `.+`.
    //
    // Until 2026-09-03 the value class was `[^'"\s][^\s]*` and the selection
    // was the class itself: no block check, and whitespace names simply never
    // matched. That shipped a rename Cribl cannot address with a green build
    // (GEN-4). Measured on a rename line with this file's own test helper:
    //
    //   "Source IP"  -> 0 issues   NOT refused   <- the defect
    //   "account-id" -> 1 issue    refused
    //   "a.b"        -> 1 issue    refused
    //   "account_id" -> 0 issues   correct
    //
    // and after the change "Source IP" -> 1 issue, the other three unchanged.
    //
    // WHAT THAT IS WORTH THROUGH THE REAL CHAIN, because a rule's reach is not
    // its regex. Measured 2026-09-03 by running parseSampleContent ->
    // matchSampleToSchema -> buildPipelinePlan -> generatePipelineConfForPlan
    // -> checkCriblYaml on a one-field JSON sample against a one-column schema,
    // counting issues on the whole conf before and after:
    //
    //   source          column        action  before  after
    //   "Source IP"     SourceIP      rename       0      1   <- now refused
    //   "Device Action" DeviceAction  rename       0      1   <- now refused
    //   "Event Type"    EventType     rename       0      1   <- now refused
    //   "src-ip"        SrcIpAddr     rename       1      1   unchanged
    //   "Source IP"     SrcIpAddr     drop         0      0   unchanged, GEN-5
    //
    // The three that moved are the ordinary shape of a space-headed CSV read
    // against a Sentinel schema: a header row of prose names and CamelCase
    // columns that are those names with the spaces taken out. The matcher pairs
    // them, emits `- currentName: Source IP`, and until this change the build
    // said nothing.
    //
    // The last row is the one to read carefully: whether a whitespace name gets
    // as far as a rename line is the MATCHER'S decision, not this rule's. Paired
    // with SrcIpAddr the same name is not similar enough, takes action `drop`,
    // and leaves no rename line for anything here to inspect. That is GEN-5's
    // hole, and it is unmoved by this change.
    //
    // WIDENING THE CLASS ALONE DOES NOT WORK, which is why the block check came
    // first rather than instead. Measured 2026-09-03 by running a `[^'"].*`
    // class over the confs two existing tests build ("group structure and
    // cleanup > passes the checkCriblYaml core validator" and "CEF identity
    // override > still emits valid Cribl YAML"): each conf gains exactly 3
    // false issues, and they are the same three both times - Field Extraction,
    // Enrich & Classify, Sentinel Cleanup, the group headers this emitter
    // writes unconditionally. Two more headers are conditional (Volume
    // Reduction with reduction rules, Overflow Collection with an overflow
    // field), and a conf carrying those was generated and confirmed to hold
    // five. The block check removes all of them, because none is under a
    // `conf:`.
    //
    // A QUOTED VALUE IS UNQUOTED BEFORE THE CHECK. The old class refused to
    // look at one at all (`[^'"\s]` as the first character); the widened class
    // sees it, and the quotes belong to YAML's loader rather than to Cribl -
    // `currentName: "Source IP"` reaches Cribl as the accessor path
    // `Source IP`.
    //
    // WHAT THE UNQUOTING STEP ACTUALLY BUYS, measured rather than assumed: NOT
    // the catch. A quote character is not accessor-safe either, so an
    // unaddressable quoted name is refused with or without this step - mutating
    // it away leaves every "quoted and unaddressable" pin passing. What it
    // changes is `currentName: "SourceIP"`, which is a working conf: read with
    // its quotes it looks unaddressable and would be REFUSED, and refusing a
    // conf that runs is this rule's own failure mode pointed the other way.
    // That is the case pinned, and it is the only one that moves.
    //
    // The three single-quote rules above still fire on their own forms, so a
    // single-quoted unaddressable name yields two issues - one for the quoting
    // Cribl's loader rejects, one for the name Cribl cannot address - and both
    // are true.
    //
    // KNOWN GAP - THIS RULE STILL REACHES LESS THAN ITS MESSAGE IMPLIES, in one
    // way rather than the two recorded here before. The remaining one is not in
    // the imported predicate and not in the line matcher; it is that the conf
    // never presents the name.
    //
    // GAP - THE ONLY SOURCE FIELD THIS RULE EVER SEES IS A RENAMED ONE. It
    // reads names off `name:`/`currentName:`/`newName:` lines, and a rename is
    // the only thing that puts a SOURCE field name on one. A field the matcher
    // could not place appears solely as a bullet in the cleanup eval's
    // `remove:` list; a field kept under its own name appears nowhere in the
    // conf at all. The rule is not idle on those confs - it still reads the
    // `name: Type` the enrich eval adds, and every other name this app mints -
    // but a minted name is a bare identifier by construction, so reading it
    // costs nothing and catches nothing. Measured
    // 2026-09-03 by running parseSampleContent -> matchSampleToSchema ->
    // buildPipelinePlan -> generatePipelineConfForPlan -> checkCriblYaml and
    // counting issues on the WHOLE conf:
    //
    //   src-ip/dst-ip/account-id renamed to SrcIpAddr/
    //     DstIpAddr/AccountId                            -> 3 issues  refused
    //   aws.account, no destination column (drop; its
    //     only trace is `- aws.account` under `remove:`)  -> 0 issues  ships
    //   src-ip and vendor-thing, both unmatched           -> 0 issues  ships
    //   a.b matched to a column also named a.b (keep)     -> 0 issues  ships
    //
    // So an awkward vendor name is refused only when the matcher RENAMES it,
    // which needs a destination column AND a different spelling - the LAST row
    // above had a column and still shipped, because a.b needed no rename.
    // Closing this means checking names the conf does not present as
    // identifiers - `remove:` bullets - which is a NEW rule, not a wider class
    // here, and it has to decide what a drop of an unaddressable name even means
    // (the remove is a glob list, not an accessor). {@link enclosingBlockPath}
    // is the half of that work this change already did: a `remove:` bullet
    // arrives as `[..., "conf", "remove"]`, so the rule can be pointed at it
    // without another scan. What it still needs is a LIVE Cribl measurement of
    // what a glob list does with an unaddressable name, which is why it is not
    // done here.
    //
    // BOTH GAPS ARE ON CARDS, and they are different cards. Checked against
    // docs/board.json 2026-09-04: GEN-5 carries the unmatched/kept hole, still
    // open, with the chain measurement behind it; GEN-4 carried the whitespace
    // hole that this rule now closes. An earlier draft of this sentence read
    // "THAT GAP IS ON A CARD, and this one no longer is", which was false in
    // both halves - it denied a card that exists, two lines before naming it.
    // (DBT-78, the older card, is about the ESCAPE SYNTAX question - what Cribl
    // accepts for a non-identifier path - and is about neither.)
    //
    // While GEN-5 is open, the DBT-78 parse note is the only warning an
    // unmatched or a kept name gets. A SPACED name on a rename line is no
    // longer in that list - this rule refuses it - so the note's wording is now
    // narrower than what the build catches; see unaddressableFieldNote in
    // sample-parsing/accessor-names.ts.
    //
    // THE ` *$` TAIL IS SAFE ONLY BECAUSE THE SPLIT ABOVE NORMALISED THE LINE
    // ENDING. Neither `.` nor a literal-space class consumes a carriage return,
    // so this matcher reads null on every CRLF line if that normalisation is
    // removed - which is a rule that reports CLEAN, not a rule that misreads.
    // The pin for it is "a line ending cannot silence a rule" in this file's
    // test.
    // The tail is `\s*$`, not ` *$`, AND the content is normalised above. Both,
    // deliberately - see the BOTH FIXES note in checkCriblYaml's header.
    const fieldName = /^ *(?:-\s+)?(?:name|currentName|newName): (.+?)\s*$/.exec(
      line,
    );
    if (fieldName !== null && isAccessorNameBlock(blockPaths[i])) {
      // YAML's quotes are the loader's, not Cribl's: the accessor path Cribl
      // builds is the value INSIDE them.
      const name = fieldName[1].replace(/^(['"])(.*)\1$/, "$2");
      if (!isCriblAccessorSafe(name)) {
        issues.push(
          `Line ${lineNum}: field name "${name}" is not a valid Cribl ` +
            `property accessor - Cribl will fail to build an accessor for it at ` +
            `runtime (or, for a dotted name, silently address a nested field ` +
            `that does not exist): ${line.trim()}`,
        );
      }
    }

    // route key must be `filter:`, never `condition:`
    if (isRouteFile && line.match(/^\s+condition:/)) {
      issues.push(
        `Line ${lineNum}: route uses condition: (use filter:): ${line.trim()}`,
      );
    }
  }

  // fileName is retained in the signature for caller-side diagnostics parity with
  // the legacy harness; a leading mention keeps it load-bearing for tooling.
  void fileName;

  return issues;
}
