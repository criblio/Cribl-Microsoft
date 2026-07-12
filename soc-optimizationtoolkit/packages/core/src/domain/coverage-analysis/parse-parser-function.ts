/**
 * Sentinel PARSER-FUNCTION reader (Wave D of
 * docs/sentinel-repo-mapping-sources.md). Solutions like SentinelOne bind
 * their analytic rules to a KQL FUNCTION (`SentinelOne | where ...`), never
 * to tables - the function unions the operative tables and renames vendor
 * columns to friendly names (`AlertId = column_ifexists('alertId_s', "")`).
 * Without resolving that indirection, rule coverage sees the friendly names
 * as unknown fields and the operative tables not at all.
 *
 * parseParserYaml extracts, with the same regex-over-YAML approach the
 * analytic-rule parser uses (no YAML dependency):
 *  - the function ALIAS rules reference (FunctionAlias, else FunctionName);
 *  - the TABLES the FunctionQuery reads (query head + union arguments);
 *  - the RENAMES it performs (column_ifexists pairs + project-rename pairs)
 *    as output -> source-column pairs.
 *
 * parserFieldSynonyms then answers the coverage question: which parser
 * OUTPUT names are effectively available because their SOURCE column is in
 * the availability set.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** One parsed parser function. */
export interface ParsedParserFunction {
  /** The name rules reference in their KQL (function alias). */
  alias: string;
  /** Table names the FunctionQuery reads (query head + union args). */
  tables: string[];
  /** Friendly-name renames the function performs. */
  renames: Array<{ output: string; source: string }>;
}

/** KQL tokens that appear where union ARGUMENTS do but are not tables. */
const UNION_STOPWORDS = new Set([
  "isfuzzy",
  "true",
  "false",
  "kind",
  "inner",
  "outer",
  "withsource",
  "hint",
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse one parser YAML file. Returns null when no alias or no query is
 * found (not a parser function file).
 */
export function parseParserYaml(text: string): ParsedParserFunction | null {
  const alias =
    text.match(/^FunctionAlias:\s*["']?([A-Za-z_][\w-]*)/m)?.[1] ??
    text.match(/^FunctionName:\s*["']?([A-Za-z_][\w-]*)/m)?.[1];
  if (alias === undefined) return null;

  // Same terminator as the analytic-rule parser: the block ends at the next
  // top-level key or end-of-input (never a literal \Z - the Zscaler lesson).
  const query = text.match(
    /^FunctionQuery:\s*\|?-?\s*\n([\s\S]*?)(?=^[A-Za-z]|(?![\s\S]))/m,
  )?.[1];
  if (query === undefined || query.trim() === "") return null;

  const tables = new Set<string>();
  const head = query.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(\||\n|$)/);
  if (head !== null && !UNION_STOPWORDS.has(head[1].toLowerCase())) {
    if (head[1] !== "union") tables.add(head[1]);
  }
  for (const m of query.matchAll(/\bunion\s+([^\n|]+)/g)) {
    for (const raw of m[1].split(",")) {
      const token = raw.trim().replace(/^isfuzzy\s*=\s*\w+\s+/i, "");
      if (IDENT_RE.test(token) && !UNION_STOPWORDS.has(token.toLowerCase())) {
        tables.add(token);
      }
    }
  }

  const renames: Array<{ output: string; source: string }> = [];
  const seenOutputs = new Set<string>();
  const push = (output: string, source: string) => {
    const key = output.toLowerCase();
    if (seenOutputs.has(key) || output === source) return;
    seenOutputs.add(key);
    renames.push({ output, source });
  };
  for (const m of query.matchAll(
    /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*column_ifexists\(\s*['"]([^'"]+)['"]/g,
  )) {
    push(m[1], m[2]);
  }
  for (const m of query.matchAll(/\bproject-rename\s+([^\n|]+)/g)) {
    for (const raw of m[1].split(",")) {
      const pair = raw.match(
        /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/,
      );
      if (pair !== null) push(pair[1], pair[2]);
    }
  }

  return { alias, tables: [...tables].sort(), renames };
}

/**
 * The parser OUTPUT names that are effectively AVAILABLE because the source
 * column they rename is in `availableLower` (lowercased availability set).
 * Sorted, deduplicated, excludes names already available under their own
 * name.
 */
export function parserFieldSynonyms(
  parsers: readonly ParsedParserFunction[],
  availableLower: ReadonlySet<string>,
): string[] {
  const synonyms = new Set<string>();
  for (const parser of parsers) {
    for (const rename of parser.renames) {
      const outputKey = rename.output.toLowerCase();
      if (availableLower.has(outputKey)) continue;
      if (availableLower.has(rename.source.toLowerCase())) {
        synonyms.add(rename.output);
      }
    }
  }
  return [...synonyms].sort();
}
