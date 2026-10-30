/**
 * A lint for customer-visible copy: no project history in what the reader sees.
 *
 * Standard: standards/info-affordances.md — "No project history in customer-visible text".
 *
 * Spike ids, phase numbers, decision ids, plan references and measurement dates belong in code
 * comments. In a label, a lead line or a tip they mean nothing to the reader and date the screen.
 * One shipped app made this a build gate after an owner directive (2026-09-24); this is that gate,
 * minus the app.
 *
 * Use it from a test over every visible string the app owns — tip texts, panel lead lines, empty
 * states — collected the same way the display freeze collects them (see the ui-testing skill).
 */

export interface CopyEntry {
  /** Where the text lives, for the failure message: a component, a key, a file:line. */
  where: string;
  text: string;
}

export interface CopyViolation {
  where: string;
  match: string;
  rule: string;
}

export interface CopyRuleOptions {
  /**
   * Hyphenated tokens that look like ids but are vocabulary, e.g. `SHA-256`. The default list
   * covers common standards and encodings; extend it rather than weakening the pattern.
   */
  allowIds?: readonly string[];
}

/** Prefixes of real-world names that share the shape of a project id (`ABC-12`). */
export const DEFAULT_ALLOWED_ID_PREFIXES: readonly string[] = [
  'SHA', 'UTF', 'ISO', 'AES', 'RFC', 'TLS', 'SSL', 'HTTP', 'MD', 'CVE', 'WCAG', 'IEEE', 'ECMA', 'RSA', 'CRC',
  'SC', // WCAG success criteria are written "SC 1.4.3", but some write SC-143
];

const RULES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  // 2026-09-24, 2026-09-24T10:00Z
  { rule: 'an ISO date (a measurement or decision date)', re: /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g },
  // A-SP21, I-D4, DBT-61, OPS-7a — uppercase prefix, a hyphen, optional letters, digits
  { rule: 'a project id (spike / decision / ticket)', re: /\b[A-Z]{1,5}-[A-Z]{0,4}\d+[a-z]?\b/g },
  // Phase 3, phase 0.5, Slice 1.6, Spike 2, Unit 4, Milestone 2
  { rule: 'a plan reference (phase / slice / spike / unit / milestone)', re: /\b(?:phase|slice|spike|unit|milestone)\s+\d+(?:\.\d+)?\b/gi },
];

/** Every violation in `entries`; an empty array when the copy is clean. */
export function findHistoryInCopy(entries: readonly CopyEntry[], opts: CopyRuleOptions = {}): CopyViolation[] {
  const allowed = new Set((opts.allowIds ?? DEFAULT_ALLOWED_ID_PREFIXES).map((p) => p.toUpperCase()));
  const out: CopyViolation[] = [];
  for (const { where, text } of entries) {
    for (const { rule, re } of RULES) {
      for (const m of text.matchAll(re)) {
        const match = m[0];
        if (rule.startsWith('a project id')) {
          const prefix = match.slice(0, match.indexOf('-')).toUpperCase();
          if (allowed.has(prefix)) continue;
        }
        out.push({ where, match, rule });
      }
    }
  }
  return out;
}

/** A readable failure message, one violation per line. */
export function describeViolations(v: readonly CopyViolation[]): string {
  return v.map((x) => `${x.where}: "${x.match}" is ${x.rule} — move it to a code comment`).join('\n');
}
