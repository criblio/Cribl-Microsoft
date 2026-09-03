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
 *   - no field name that Cribl cannot build a property accessor for (DBT-78).
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
 * Return the list of Cribl-YAML acceptance issues in `content` (empty = clean).
 * `fileName` is used only in messages; route detection is content-based.
 */
export function checkCriblYaml(content: string, fileName: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");

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
    // KNOWN GAPS - THIS RULE REACHES LESS THAN ITS MESSAGE IMPLIES. There are
    // TWO holes and neither is in the imported predicate; the first is the
    // bigger, and it is not in the line matcher below either.
    //
    // GAP 1 - THE ONLY SOURCE FIELD THIS RULE EVER SEES IS A RENAMED ONE. It
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
    // (the remove is a glob list, not an accessor).
    //
    // GAP 2 - A NAME CONTAINING WHITESPACE IS NOT SEEN EVEN ON A RENAME LINE,
    // and that one IS in the line matcher below. `([^'"\s][^\s]*)\s*$` cannot
    // match a value containing a space, so the rule never runs on one. Measured
    // with this file's own test helper:
    //
    //   "Source IP"  -> 0 issues     NOT refused
    //   "account-id" -> 1 issue      refused
    //   "a.b"        -> 1 issue      refused
    //
    // (A TAB name does produce one issue, but from the "contains tab character"
    // rule above - not from this one. Do not read that as coverage.)
    //
    // A space-headed CSV is a common source of such names, so this is not a
    // corner. It is recorded rather than fixed because `[^\s]*` IS LOAD-BEARING:
    // pipeline GROUP headers are `name:` lines carrying prose, and widening the
    // class alone makes this rule match them. Measured on four generated confs
    // (kv, json and ndjson; renamed, dropped and kept fates), each carries the
    // three headers this file's emitter writes unconditionally - "Field
    // Extraction", "Enrich & Classify", "Sentinel Cleanup" - a widened class
    // captures all three, none is an identifier, so every pack would gain three
    // false failures. Two more group headers are emitted conditionally
    // ("Volume Reduction", "Overflow Collection" - read from pipeline-conf.ts,
    // not measured here), so a pack carrying those would gain five. Closing
    // GAP 2 therefore requires distinguishing a GROUP `name:` from a field
    // `name:`/`currentName:`/`newName:` FIRST; that is its own change with its
    // own pins.
    //
    // NEITHER GAP IS ON A CARD. Checked against docs/board.json 2026-09-03:
    // DBT-78 is the only card here and it is about the ESCAPE SYNTAX question,
    // not about the rule's reach. This comment is the record until that
    // changes; it does not defer to a card that exists.
    //
    // While these are open, the DBT-78 parse note is the only warning an
    // unmatched, a kept or a spaced name gets, which is why that note
    // deliberately promises no build-time refusal - see unaddressableFieldNote
    // in sample-parsing/accessor-names.ts.
    //
    // The test in this module named "FLAGS a leading digit and a space" asserts
    // only the leading digit; its name is wrong, and believing it is how the
    // parse note came to claim a guarantee that does not exist.
    const fieldName = line.match(
      /^\s+-?\s*(?:name|currentName|newName): ([^'"\s][^\s]*)\s*$/,
    );
    if (fieldName !== null && !isCriblAccessorSafe(fieldName[1] ?? "")) {
      issues.push(
        `Line ${lineNum}: field name "${fieldName[1]}" is not a valid Cribl ` +
          `property accessor - Cribl will fail to build an accessor for it at ` +
          `runtime (or, for a dotted name, silently address a nested field ` +
          `that does not exist): ${line.trim()}`,
      );
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
