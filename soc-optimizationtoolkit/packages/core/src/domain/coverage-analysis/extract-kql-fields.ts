/**
 * extractKqlFields - RELOCATED into the analysis domain (porting-plan Unit 23
 * task item 2). This is DOMAIN logic that lived in the repo adapter
 * (sentinel-repo.ts) purely for filesystem proximity; it is a pure string
 * function and belongs here, exercised directly by the re-pointed regression
 * vectors.
 *
 * Ported VERBATIM from the legacy implementation: same cleaning passes, same
 * computed-variable detection, same extraction patterns, same filtering rules.
 * Two changes since. Where KQL_BUILTINS comes from (the shared module) - which
 * is the FULL set the legacy real code always used (the legacy TEST ran a
 * reduced inline copy; see extract-kql-fields.test.ts for the pinned diff).
 * And the WHERE PREDICATE (DBT-215): the legacy `where\s+(\w+)` read only the
 * first token after `where`, so `where A > 1 and B == "x"` never reported B
 * and Rule Coverage read a rule as satisfied when B was missing. Every operand
 * of the predicate is now read (see wherePredicateOperands), and a function
 * name the old pattern took for a column (`where ipv4_is_in_range(...)`) no
 * longer is.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { KQL_BUILTINS } from "./kql-builtins";

/**
 * Operator words a where predicate can hold that KQL_BUILTINS does not list
 * (it carries has/contains/startswith/endswith/in/between/matches but not
 * their case-sensitive, negated or any/all forms). Kept local rather than
 * added to KQL_BUILTINS so the other patterns, and the verbatim builtins port,
 * are unchanged. Lowercase; checked with `.toLowerCase()`.
 */
const WHERE_OPERATOR_WORDS: ReadonlySet<string> = new Set([
  "has_cs", "has_any", "has_all", "hasprefix", "hasprefix_cs", "hassuffix",
  "hassuffix_cs", "contains_cs", "notcontains", "notcontains_cs",
  "startswith_cs", "endswith_cs", "notbetween", "regex",
]);

/**
 * Every identifier operand of every `where` predicate in an already-cleaned
 * query (strings, numbers and comments blanked). A predicate runs from `where`
 * to the next `|` or `;` at its own paren depth, or to a `)` that closes a
 * paren the predicate did not open (a `join (S | where ...)` subquery ends
 * there). A `|` INSIDE the predicate's parens is a subquery (`A in ((S | ...))
 * and B > 0`), so the operands after it are still read. Inside it an
 * identifier is an operand unless it is a FUNCTION NAME (followed by `(`), a
 * TABULAR SOURCE (followed by `|`), a PROPERTY of a dotted access (preceded by
 * `.`; the column is the part before the dot), or a `$left`/`$right` style
 * reference. Operator words, keywords and literals are left to the caller's
 * builtin filter.
 */
function wherePredicateOperands(cleaned: string): string[] {
  const operands: string[] = [];
  const whereRe = /\bwhere\b/gi;
  let start: RegExpExecArray | null;
  while ((start = whereRe.exec(cleaned)) !== null) {
    let depth = 0;
    let end = start.index + start[0].length;
    for (; end < cleaned.length; end++) {
      const ch = cleaned[end];
      if ((ch === "|" || ch === ";") && depth === 0) break;
      if (ch === "(") depth++;
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    const predicate = cleaned.slice(start.index + start[0].length, end);
    for (const m of predicate.matchAll(/(?<![\w.$])([A-Za-z_]\w*)\b(?!\s*[(|])/g)) {
      if (m[1] !== undefined) operands.push(m[1]);
    }
  }
  return operands;
}

/**
 * Extract field/column names referenced in a KQL query. Identifies computed
 * variables (let, extend, summarize assignments) and excludes them so only
 * actual table columns are returned. Returns a sorted, de-duplicated list with
 * ORIGINAL CASING preserved.
 */
export function extractKqlFields(kql: string): string[] {
  const fields = new Set<string>();
  const computed = new Set<string>(); // fields created by let/extend (not table columns)

  // Remove comments and string literals to avoid false matches
  const cleaned = kql
    .replace(/\/\/.*$/gm, "") // line comments
    .replace(/"[^"]*"/g, '""') // double-quoted strings
    .replace(/'[^']*'/g, "''") // single-quoted strings
    .replace(/\b\d+(\.\d+)?\b/g, "0"); // numbers

  // Step 1: Identify computed variables (not real table columns)
  // let varName = ...
  const letMatches = cleaned.matchAll(/\blet\s+(\w+)\s*=/gi);
  for (const m of letMatches) {
    if (m[1]) computed.add(m[1]);
  }
  // extend NewField = ...
  const extMatches = cleaned.matchAll(/\bextend\s+(\w+)\s*=/gi);
  for (const m of extMatches) {
    if (m[1]) computed.add(m[1]);
  }
  // summarize NewCol = func(...) -- left side of assignment in summarize
  const sumAssignMatches = cleaned.matchAll(
    /\bsummarize\b[^|]*?(\w+)\s*=\s*(?:count|sum|avg|min|max|dcount|arg_max|arg_min|make_set|make_list)/gi,
  );
  for (const m of sumAssignMatches) {
    if (m[1]) computed.add(m[1]);
  }

  // Step 2: Extract field references. The where predicate is read by
  // wherePredicateOperands (DBT-215), not by a pattern here.
  const candidates: string[] = wherePredicateOperands(cleaned);
  const patterns = [
    /\bproject(?:-rename|-away)?\s+([\w,\s]+?)(?:\||$)/gim,
    /\bby\s+([\w,\s]+?)(?:\||$)/gim,
    /\bon\s+(\w+)/gi,
    /\b(\w+)\s*[!=]=~/g,
    /\bisnotempty\s*\(\s*(\w+)\s*\)/gi,
    /\bisempty\s*\(\s*(\w+)\s*\)/gi,
    /\bmake_(?:set|list)\s*\(\s*(\w+)\s*\)/gi,
    /\b(?:min|max|sum|avg|dcount)\s*\(\s*(\w+)\s*\)/gi,
    /\barg_(?:max|min)\s*\([^,]+,\s*(\w+)\s*\)/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleaned)) !== null) {
      const captured = match[1];
      const parts = captured.split(/\s*,\s*/);
      for (const part of parts) {
        const fieldName = part.trim().split(/\s+/)[0];
        if (fieldName) candidates.push(fieldName);
      }
    }
  }

  for (const fieldName of candidates) {
    if (
      fieldName.length > 1 &&
      /^[A-Za-z_]/.test(fieldName) &&
      !KQL_BUILTINS.has(fieldName.toLowerCase()) &&
      !WHERE_OPERATOR_WORDS.has(fieldName.toLowerCase()) &&
      !computed.has(fieldName)
    ) {
      fields.add(fieldName);
    }
  }

  return [...fields].sort();
}
