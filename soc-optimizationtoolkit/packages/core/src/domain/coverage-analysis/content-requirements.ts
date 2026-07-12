/**
 * CONTENT REQUIREMENTS - which fields the solution's analytics rules and
 * workbooks actually NEED (user direction 2026-07-12: analyze rule coverage
 * first, then workbook coverage, and default to DROPPING source fields
 * neither requires instead of folding everything into AdditionalExtensions).
 *
 * Distinguishes HOW content consumes data:
 *  - DIRECT columns: bare table-column references (extractKqlFields) - the
 *    column must exist, and any source field mapped onto it is required.
 *    KQL transformations over a column (split(RequestURL,...),
 *    extract(..., DeviceCustomString1)) count the BASE column as direct -
 *    dropping the raw field would break the derivation.
 *  - CATCH-ALL keys: content that mines the AdditionalExtensions catch-all
 *    for specific key=value pairs (extract(@"key=..."), has/contains
 *    "key=", parse_json(AdditionalExtensions)["key"]). Those SOURCE fields
 *    must stay in the overflow - they are consumed by name.
 *  - OPAQUE catch-all use: AdditionalExtensions is referenced but no key can
 *    be determined (a generic parse/projection). Dropping ANY overflow field
 *    could break such content, so the caller must not auto-drop.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { extractKqlFields } from "./extract-kql-fields";
import { KQL_BUILTINS } from "./kql-builtins";
import type { ContentItem } from "./models";

/** What the solution's content requires of the data. */
export interface ContentRequirements {
  /** Lowercased column/field names content references directly. */
  columns: ReadonlySet<string>;
  /** Lowercased key names content extracts from the catch-all column. */
  catchAllKeys: ReadonlySet<string>;
  /**
   * True when the catch-all is referenced without determinable keys -
   * auto-dropping overflow fields is then unsafe.
   */
  opaqueCatchAll: boolean;
  /** How many content items (rules + workbook queries) were read. */
  itemCount: number;
}

/** The catch-all column names content mines keys out of. */
const CATCH_ALL_COLUMNS = ["AdditionalExtensions", "AdditionalData"];

/** An empty requirements value (no content read yet). */
export const EMPTY_CONTENT_REQUIREMENTS: ContentRequirements = {
  columns: new Set<string>(),
  catchAllKeys: new Set<string>(),
  opaqueCatchAll: false,
  itemCount: 0,
};

/**
 * Columns consumed as TRANSFORMATION arguments (split(RequestURL,...),
 * extract(..., 1, DeviceCustomString1), parse_json(Column)...).
 * extractKqlFields deliberately skips these; for requirement purposes the
 * base column IS required - dropping the raw field breaks the derivation.
 * Over-capture is safe here: an extra name only prevents a drop.
 */
function transformationBaseColumns(kql: string, columns: Set<string>): void {
  const cleaned = kql
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");
  const patterns = [
    /(?:^|[^A-Za-z0-9_.])(?:split|parse_json|todynamic|parse_url|parse_csv|parse_xml|tolower|toupper|trim|substring|url_decode|base64_decode_tostring|bin|strlen)\(\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    /(?:^|[^A-Za-z0-9_.])extract(?:_all)?\([^,]*,\s*\d+\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g,
  ];
  for (const pattern of patterns) {
    for (const m of cleaned.matchAll(pattern)) {
      const name = m[1];
      if (name.length > 1 && !KQL_BUILTINS.has(name.toLowerCase())) {
        columns.add(name.toLowerCase());
      }
    }
  }
}

/** Extract `key=` names from a KQL snippet's string literals. */
function keysFromLiterals(snippet: string, keys: Set<string>): number {
  let found = 0;
  for (const m of snippet.matchAll(/["'@]+([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    keys.add(m[1].toLowerCase());
    found++;
  }
  return found;
}

/**
 * Derive the requirements from the solution's content items (rules +
 * workbook queries).
 */
export function deriveContentRequirements(
  items: readonly ContentItem[],
): ContentRequirements {
  const columns = new Set<string>();
  const catchAllKeys = new Set<string>();
  let opaqueCatchAll = false;
  let itemCount = 0;

  for (const item of items) {
    for (const kql of item.queries) {
      itemCount++;
      for (const field of extractKqlFields(kql)) {
        columns.add(field.toLowerCase());
      }
      transformationBaseColumns(kql, columns);
      for (const catchAll of CATCH_ALL_COLUMNS) {
        if (!kql.includes(catchAll)) continue;
        let keysFound = 0;
        // extract(@"key=([^;]+)", 1, AdditionalExtensions) and friends:
        // scan every call/expression line that mentions the catch-all for
        // key= literals.
        for (const line of kql.split("\n")) {
          if (!line.includes(catchAll)) continue;
          keysFound += keysFromLiterals(line, catchAllKeys);
        }
        // parse_json(AdditionalExtensions)["key"] / .key accessors.
        for (const m of kql.matchAll(
          new RegExp(
            `(?:parse_json|todynamic)\\(\\s*${catchAll}\\s*\\)\\s*(?:\\[["']([A-Za-z_][A-Za-z0-9_]*)["']\\]|\\.([A-Za-z_][A-Za-z0-9_]*))`,
            "g",
          ),
        )) {
          catchAllKeys.add((m[1] ?? m[2]).toLowerCase());
          keysFound++;
        }
        if (keysFound === 0) opaqueCatchAll = true;
      }
    }
  }

  return { columns, catchAllKeys, opaqueCatchAll, itemCount };
}

/**
 * Merge requirements from several sources (the rules instance and the
 * workbooks instance report independently).
 */
export function mergeContentRequirements(
  parts: readonly ContentRequirements[],
): ContentRequirements {
  const columns = new Set<string>();
  const catchAllKeys = new Set<string>();
  let opaqueCatchAll = false;
  let itemCount = 0;
  for (const part of parts) {
    for (const c of part.columns) columns.add(c);
    for (const k of part.catchAllKeys) catchAllKeys.add(k);
    opaqueCatchAll = opaqueCatchAll || part.opaqueCatchAll;
    itemCount += part.itemCount;
  }
  return { columns, catchAllKeys, opaqueCatchAll, itemCount };
}
