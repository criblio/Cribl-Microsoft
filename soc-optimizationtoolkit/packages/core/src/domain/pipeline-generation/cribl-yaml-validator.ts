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
    // forbid it, because Cribl's YAML loader rejects those forms. The fix for a
    // source that genuinely carries such names is to give the PARSER an
    // addressable name, as the positional parser does for VPC Flow.
    const fieldName = line.match(
      /^\s+-?\s*(?:name|currentName|newName): ([^'"\s][^\s]*)\s*$/,
    );
    if (fieldName !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName[1] ?? "")) {
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
