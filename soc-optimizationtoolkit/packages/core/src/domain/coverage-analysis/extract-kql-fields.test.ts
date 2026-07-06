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
