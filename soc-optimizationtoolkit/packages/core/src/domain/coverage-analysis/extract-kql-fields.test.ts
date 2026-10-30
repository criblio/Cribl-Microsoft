/**
 * KQL Field Extraction - the legacy IS-T/regression.test.ts "KQL Field
 * Extraction" block RE-POINTED at the REAL relocated implementation
 * (porting-plan Unit 23 task item 2). The legacy suite ran an INLINE COPY of
 * extractKqlFields with a REDUCED builtins set; here the SAME vectors run
 * against the real extractKqlFields over the FULL KQL_BUILTINS set, and the
 * DIFFERENCE the full set makes is pinned explicitly.
 */

import { describe, expect, it } from "vitest";

import { extractKqlFields } from "./extract-kql-fields";
import { KQL_BUILTINS } from "./kql-builtins";

// ---------------------------------------------------------------------------
// The reduced inline extractor the LEGACY regression suite used, reproduced
// verbatim so the full-vs-reduced difference can be pinned concretely.
// ---------------------------------------------------------------------------
const REDUCED_BUILTINS = new Set([
  "timegenerated", "tenantid", "sourcesystem", "type", "computer",
  "count", "count_", "sum", "sum_", "avg", "min", "max", "dcount",
  "arg_max", "arg_min", "make_set", "make_list",
  "tostring", "toint", "tolong", "todouble", "toreal", "tobool",
  "strlen", "tolower", "toupper", "trim", "substring", "split", "strcat",
  "startofday", "endofday", "ago", "now", "datetime", "datetime_diff", "bin",
  "ipv4_is_private", "isnotempty", "isempty", "isnull", "isnotnull",
  "iff", "iif", "case", "coalesce", "next", "prev", "serialize",
  "let", "where", "project", "extend", "summarize", "by", "on", "join",
  "union", "sort", "order", "asc", "desc", "top", "take", "limit",
  "distinct", "and", "or", "not", "in", "has", "contains",
  "true", "false", "null", "dynamic",
]);

function extractReduced(kql: string): string[] {
  const fields = new Set<string>();
  const computed = new Set<string>();
  const cleaned = kql
    .replace(/\/\/.*$/gm, "")
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/\b\d+(\.\d+)?\b/g, "0");
  for (const m of cleaned.matchAll(/\blet\s+(\w+)\s*=/gi)) {
    if (m[1]) computed.add(m[1]);
  }
  for (const m of cleaned.matchAll(/\bextend\s+(\w+)\s*=/gi)) {
    if (m[1]) computed.add(m[1]);
  }
  for (const m of cleaned.matchAll(
    /\bsummarize\b[^|]*?(\w+)\s*=\s*(?:count|sum|avg|min|max|dcount|arg_max|arg_min|make_set|make_list)/gi,
  )) {
    if (m[1]) computed.add(m[1]);
  }
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
      for (const part of match[1].split(/\s*,\s*/)) {
        const f = part.trim().split(/\s+/)[0];
        if (
          f &&
          f.length > 1 &&
          /^[A-Za-z_]/.test(f) &&
          !REDUCED_BUILTINS.has(f.toLowerCase()) &&
          !computed.has(f)
        ) {
          fields.add(f);
        }
      }
    }
  }
  return [...fields].sort();
}

// ---------------------------------------------------------------------------
// The verbatim legacy vectors, now against the REAL extractor.
// ---------------------------------------------------------------------------
describe("KQL Field Extraction (re-pointed at the real impl)", () => {
  it("extracts fields from where clause", () => {
    const fields = extractKqlFields(
      'CommonSecurityLog | where DeviceVendor == "Palo Alto"',
    );
    expect(fields).toContain("DeviceVendor");
  });

  it("extracts fields from project", () => {
    const fields = extractKqlFields(
      "T | project SourceIP, DestinationIP, SourcePort",
    );
    expect(fields).toContain("SourceIP");
    expect(fields).toContain("DestinationIP");
    expect(fields).toContain("SourcePort");
  });

  it("extracts fields from summarize by", () => {
    const fields = extractKqlFields(
      "T | summarize count() by DeviceName, SourceIP",
    );
    expect(fields).toContain("DeviceName");
    expect(fields).toContain("SourceIP");
  });

  it("excludes computed extend variables", () => {
    const fields = extractKqlFields(`
      T | extend AccountName = tostring(split(UserName, "@")[0])
      | where SourceIP != ""
    `);
    expect(fields).not.toContain("AccountName");
    expect(fields).toContain("SourceIP");
  });

  it("excludes let variables", () => {
    const fields = extractKqlFields(`
      let threshold = 25;
      T | where EventCount > threshold
    `);
    expect(fields).not.toContain("threshold");
    expect(fields).toContain("EventCount");
  });

  it("excludes summarize-computed variables", () => {
    const fields = extractKqlFields(`
      T | summarize TotalEvents = count(), FirstSeen = min(TimeGenerated) by SourceIP
    `);
    expect(fields).not.toContain("TotalEvents");
    expect(fields).not.toContain("FirstSeen");
    expect(fields).toContain("SourceIP");
  });

  it("excludes Azure system fields", () => {
    const fields = extractKqlFields(
      'T | where TimeGenerated > ago(1h) | where Type == "X"',
    );
    expect(fields).not.toContain("TimeGenerated");
    expect(fields).not.toContain("Type");
  });
});

// ---------------------------------------------------------------------------
// DBT-215: EVERY operand of a where predicate, not just the first token after
// `where`. The legacy pattern read `where A > 1 and B == "x"` as referencing A
// alone, so a rule needing B read as satisfied when B was missing. Exact lists
// (toEqual), because a stray extra or a dropped operand is the whole defect.
// Single-letter names are filtered by the extractor (length > 1), so the
// card's `A`/`B` shape is written with real column names.
// ---------------------------------------------------------------------------
describe("where-predicate operands (DBT-215)", () => {
  it("reads both sides of `and`: where A > 1 and B == \"x\"", () => {
    expect(
      extractKqlFields('T | where EventCount > 1 and DeviceAction == "x"'),
    ).toEqual(["DeviceAction", "EventCount"]);
  });

  it("reads every operand through nested parentheses and `or`", () => {
    expect(
      extractKqlFields(
        'T | where (SrcIp == "1" or (DstIp != "2" and DstPort in (80, 443))) | project Action',
      ),
    ).toEqual(["Action", "DstIp", "DstPort", "SrcIp"]);
  });

  it("reads inside not(), and drops the function name around an operand", () => {
    expect(
      extractKqlFields(
        'T | where not(UserName has "svc") and isnotempty(ProcessName)',
      ),
    ).toEqual(["ProcessName", "UserName"]);
  });

  it("covers the comparison and string operators, both sides of a column compare", () => {
    expect(
      extractKqlFields(
        [
          "T",
          '| where Url contains "x" or Path startswith "/a" or Agent endswith "b"',
          '    or Method =~ "get" or Verb !~ "post" or Status >= 400',
          "    or Bytes <= 0 or Port < 1024 or Retries > 2",
          '    or Host !contains "z" or Tag in~ ("a") or Zone !in ("b")',
          '    or Act has_any ("c") or Msg matches regex "d" or Level between (1 .. 3)',
          "    or SentBytes == ReceivedBytes",
        ].join("\n"),
      ),
    ).toEqual([
      "Act",
      "Agent",
      "Bytes",
      "Host",
      "Level",
      "Method",
      "Msg",
      "Path",
      "Port",
      "ReceivedBytes",
      "Retries",
      "SentBytes",
      "Status",
      "Tag",
      "Url",
      "Verb",
      "Zone",
    ]);
  });

  it("excludes string, number and time literals and every function name", () => {
    expect(
      extractKqlFields(
        'T | where Status == "Failed" and strlen(CommandLine) > 100 and Ts > ago(1d) and ipv6_is_match(SrcIpv6, "::1")',
      ),
    ).toEqual(["CommandLine", "SrcIpv6", "Status", "Ts"]);
  });

  it("takes the column, not the property, of a dotted access", () => {
    expect(
      extractKqlFields('T | where AdditionalFields.Foo == "x" and tostring(Props.Bar) == "y"'),
    ).toEqual(["AdditionalFields", "Props"]);
  });

  it("still excludes let/extend names used as operands", () => {
    expect(
      extractKqlFields(
        'let threshold = 5; T | extend Ratio = SentBytes / 2 | where Ratio > threshold and DeviceName == "x"',
      ),
    ).toEqual(["DeviceName"]);
  });

  // Reading every operand reaches the computed columns AFTER the first one an
  // operator creates. The legacy detection took only the first assignment of
  // an extend or summarize, which the first-token where never got past, so
  // these used to be invisible; now they would be reported as missing
  // destination fields unless every assignment counts as computed.
  // A comparison inside the assignment (`DeviceName ==`) is not an assignment.
  it("excludes every column an extend creates, not only the first", () => {
    expect(
      extractKqlFields(
        'T | extend AcctName = tostring(Upn), HostLabel = iff(DeviceName == "z", Dev, "") | where AcctName has "x" and HostLabel != "" and DeviceName == "y"',
      ),
    ).toEqual(["DeviceName"]);
  });

  it("excludes every column a summarize creates, not only the first", () => {
    expect(
      extractKqlFields(
        "T | summarize StartTime = min(TimeGenerated), EndTime = max(TimeGenerated), Total = count() by DeviceHost | where Total > 5 and EndTime > StartTime",
      ),
    ).toEqual(["DeviceHost"]);
  });

  it("excludes the columns a project-rename, mv-expand or parse creates", () => {
    expect(
      extractKqlFields(
        [
          "T",
          "| project-rename SrcName = SourceName, DstName = DestName",
          "| mv-expand Entry = Entries",
          '| parse SyslogMessage with * "src=" SrcAddr " user=" UserText:string " " *',
          '| where SrcName == "a" and DstName == "b" and Entry != "" and SrcAddr != "" and UserText != "" and Proto == "c"',
        ].join("\n"),
      ),
    ).toEqual(["Proto"]);
  });

  it("stops at the pipe, and reads a where inside a join subquery", () => {
    expect(
      extractKqlFields(
        'T | where Alpha == 1 | summarize count() by Beta | join (S | where Gamma == "x") on Delta',
      ),
    ).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
  });

  it("reads past a parenthesized subquery, without taking its table for a column", () => {
    expect(
      extractKqlFields(
        "T | where Alpha in ((Syslog | where Gamma == 1 | project Gamma)) and Beta > 0",
      ),
    ).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("ends a subquery's predicate at the paren that closes it", () => {
    expect(
      extractKqlFields(
        "union (Syslog | where Gamma == 1 and Epsilon == 2), Heartbeat",
      ),
    ).toEqual(["Epsilon", "Gamma"]);
  });
});

// ---------------------------------------------------------------------------
// The pinned difference: the FULL set excludes more builtins than the reduced
// inline copy. All seven original vectors are IDENTICAL under both sets (none
// reference an extra builtin), but a query referencing a builtin present ONLY
// in the full set diverges - which is exactly why the real impl is
// authoritative.
// ---------------------------------------------------------------------------
describe("full builtins set vs the legacy reduced inline copy", () => {
  const legacyVectors = [
    'CommonSecurityLog | where DeviceVendor == "Palo Alto"',
    "T | project SourceIP, DestinationIP, SourcePort",
    "T | summarize count() by DeviceName, SourceIP",
    "T | extend AccountName = tostring(split(UserName, \"@\")[0]) | where SourceIP != \"\"",
    "let threshold = 25; T | where EventCount > threshold",
    "T | summarize TotalEvents = count(), FirstSeen = min(TimeGenerated) by SourceIP",
    'T | where TimeGenerated > ago(1h) | where Type == "X"',
  ];

  it("agrees with the reduced copy on every original regression vector", () => {
    for (const kql of legacyVectors) {
      expect(extractKqlFields(kql)).toEqual(extractReduced(kql));
    }
  });

  it("DIVERGES on a builtin present only in the full set (e.g. 'render')", () => {
    // 'render' is in the FULL KQL_BUILTINS but NOT the legacy reduced copy.
    expect(KQL_BUILTINS.has("render")).toBe(true);
    expect(REDUCED_BUILTINS.has("render")).toBe(false);

    const kql = "T | where render == 5";
    // The reduced copy wrongly treats 'render' as a table column...
    expect(extractReduced(kql)).toContain("render");
    // ...the real full-set impl correctly excludes it.
    expect(extractKqlFields(kql)).not.toContain("render");
  });

  it("holds the full builtins set (>= 120 unique entries)", () => {
    expect(KQL_BUILTINS.size).toBeGreaterThanOrEqual(120);
  });
});
