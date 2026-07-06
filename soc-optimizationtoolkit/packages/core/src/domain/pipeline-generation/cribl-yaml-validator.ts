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
 *   - no single-quoted field names in add/remove/rename (name/currentName/newName).
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
