/**
 * KQL built-in functions, operators, keywords, and Azure system-populated
 * fields to EXCLUDE from field extraction (porting-plan Unit 23 task item 2).
 *
 * Ported VERBATIM from legacy sentinel-repo.ts (the ~130-entry KQL_BUILTINS
 * Set). Entries are lowercase because extractKqlFields checks membership with
 * `.toLowerCase()`. Duplicate literals (e.g. `count_`, `sum_`) are preserved
 * exactly as written in the legacy source - the Set dedups them harmlessly and
 * preserving them keeps this a byte-faithful port.
 *
 * This is the FULL set. The legacy regression suite (IS-T/regression.test.ts)
 * tested against an INLINE COPY with a REDUCED set; Unit 23 re-points those
 * vectors at the real extractKqlFields over THIS full set and pins the
 * difference (see extract-kql-fields.test.ts).
 *
 * Pure data: no IO, no fetch, no React, no Date/crypto.
 */

/** The verbatim legacy KQL_BUILTINS exclusion set (~130 entries). */
export const KQL_BUILTINS: ReadonlySet<string> = new Set<string>([
  // Azure auto-populated fields (never in raw vendor data, populated at ingestion time)
  // Lowercase because extractKqlFields checks with .toLowerCase()
  "timegenerated", "tenantid", "sourcesystem", "mg", "managementgroupname",
  "_resourceid", "_subscriptionid", "_itemid", "_isbillable", "_billedsize",
  "type", "computer", "collectorhostname", "timecollected",
  // Functions
  "count", "count_", "sum", "sum_", "avg", "min", "max", "dcount", "arg_max", "arg_min",
  "make_set", "make_list", "make_bag", "percentile", "stdev", "variance",
  "tostring", "toint", "tolong", "todouble", "toreal", "tobool", "todatetime", "totimespan", "todynamic",
  "strlen", "tolower", "toupper", "trim", "substring", "replace", "split", "strcat", "strcat_delim",
  "parse_json", "parse_url", "parse_path", "parse_csv", "extract", "extract_all",
  "startofday", "startofweek", "startofmonth", "startofyear", "endofday", "endofweek",
  "ago", "now", "datetime", "datetime_diff", "format_datetime", "bin", "floor", "ceiling",
  "ipv4_is_private", "ipv4_is_match", "ipv4_compare", "isnotempty", "isempty", "isnull", "isnotnull",
  "iff", "iif", "case", "coalesce", "pack", "pack_all", "bag_keys",
  "next", "prev", "row_number", "serialize",
  // Operators and keywords
  "let", "where", "project", "extend", "summarize", "by", "on", "join", "union", "sort", "order",
  "asc", "desc", "top", "take", "limit", "distinct", "render", "lookup", "mv_expand", "mv-expand",
  "evaluate", "search", "find", "datatable", "print", "range", "invoke", "externaldata",
  "kind", "inner", "outer", "leftouter", "rightouter", "fullouter", "leftanti", "rightanti", "leftsemi", "rightsemi",
  "and", "or", "not", "in", "has", "contains", "startswith", "endswith", "matches", "between",
  "true", "false", "null", "dynamic",
  // Time literals
  "1h", "1d", "2d", "7d", "14d", "30d", "1m", "5m", "10m", "15m", "30m",
  // Common computed column suffixes
  "count_", "sum_", "avg_", "min_", "max_", "dcount_",
]);
