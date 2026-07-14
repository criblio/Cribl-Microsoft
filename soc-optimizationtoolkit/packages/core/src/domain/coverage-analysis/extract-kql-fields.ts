/**
 * extractKqlFields - RELOCATED into the analysis domain (porting-plan Unit 23
 * task item 2). This is DOMAIN logic that lived in the repo adapter
 * (sentinel-repo.ts) purely for filesystem proximity; it is a pure string
 * function and belongs here, exercised directly by the re-pointed regression
 * vectors.
 *
 * Ported VERBATIM from the legacy implementation: same cleaning passes, same
 * computed-variable detection, same extraction patterns, same filtering rules.
 * The only change is where KQL_BUILTINS comes from (the shared module) - which
 * is the FULL set the legacy real code always used (the legacy TEST ran a
 * reduced inline copy; see extract-kql-fields.test.ts for the pinned diff).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { KQL_BUILTINS } from "./kql-builtins";

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

  // Step 2: Extract field references
  const patterns = [
    /\bwhere\s+(\w+)\b/gi,
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
        if (
          fieldName &&
          fieldName.length > 1 &&
          /^[A-Za-z_]/.test(fieldName) &&
          !KQL_BUILTINS.has(fieldName.toLowerCase()) &&
          !computed.has(fieldName)
        ) {
          fields.add(fieldName);
        }
      }
    }
  }

  return [...fields].sort();
}
