/**
 * ai-advisory pins (docs/ai-assisted-analysis-plan.md P1/P2): prompt
 * construction carries the redacted input and the strict-JSON contract;
 * parsing is TOTAL (fence-tolerant, typed error on garbage, never a throw);
 * sanitization enforces the never-trusted rule (unknown sources/dests
 * dropped, no-ops removed, confidence clamped); the usecases NEVER reject.
 */

import { describe, expect, it } from "vitest";

import type { LlmAssist } from "../../ports/llm-assist";
import {
  EXAMPLE_MAX_CHARS,
  buildMappingPrompt,
  extractJsonBlock,
  parseMappingSuggestion,
  sanitizeMappingSuggestion,
  truncateExample,
} from "./mapping-advisory";
import type { MappingAdvisoryInput, MappingSuggestion } from "./mapping-advisory";
import { buildCoveragePrompt, parseCoverageAdvice } from "./coverage-advisory";
import { adviseCoverage, adviseMapping } from "../../usecases/ai-advisory/ai-advisory";

const INPUT: MappingAdvisoryInput = {
  logType: "TRAFFIC",
  tableName: "CommonSecurityLog",
  candidateTables: ["CommonSecurityLog", "Syslog"],
  fields: [
    { name: "src_ip", type: "string", example: "10.0.0.1" },
    { name: "dst_port", type: "int" },
    { name: "weird_field", type: "string" },
  ],
  currentMappings: [
    { source: "src_ip", dest: "SourceIP", action: "rename", confidence: "alias" },
    { source: "dst_port", dest: "", action: "overflow", confidence: "unmatched" },
    { source: "weird_field", dest: "", action: "overflow", confidence: "unmatched" },
  ],
  destColumns: [
    { name: "SourceIP", type: "string" },
    { name: "DestinationPort", type: "int" },
  ],
};

describe("buildMappingPrompt", () => {
  it("carries the redacted fields, mappings, schema, and the strict-JSON contract", () => {
    const { system, user } = buildMappingPrompt(INPUT);
    expect(system).toContain("ONLY a JSON object");
    expect(system).toContain('"suggestions"');
    const parsed = JSON.parse(user) as Record<string, unknown>;
    expect(parsed.logType).toBe("TRAFFIC");
    expect(parsed.currentTable).toBe("CommonSecurityLog");
    expect(user).toContain("src_ip");
    expect(user).toContain("DestinationPort");
    // The example value went through, truncated form available.
    expect(user).toContain("10.0.0.1");
  });

  it("truncates example values to the egress bound", () => {
    const long = "x".repeat(EXAMPLE_MAX_CHARS + 40);
    expect(truncateExample(long)).toHaveLength(EXAMPLE_MAX_CHARS + 3);
    const { user } = buildMappingPrompt({
      ...INPUT,
      fields: [{ name: "f", type: "string", example: long }],
    });
    expect(user).not.toContain(long);
  });
});

describe("extractJsonBlock / parseMappingSuggestion", () => {
  const GOOD = JSON.stringify({
    suggestions: [
      {
        source: "dst_port",
        dest: "DestinationPort",
        action: "rename",
        confidence: 0.9,
        reason: "Direct semantic match.",
      },
    ],
    tableRanking: ["CommonSecurityLog", "Syslog"],
    notes: "",
  });

  it("parses clean JSON", () => {
    const result = parseMappingSuggestion(GOOD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestion.suggestions[0].dest).toBe("DestinationPort");
    }
  });

  it("parses fenced JSON and JSON wrapped in prose", () => {
    for (const wrapped of [
      "```json\n" + GOOD + "\n```",
      "Here you go:\n" + GOOD + "\nHope that helps.",
    ]) {
      const result = parseMappingSuggestion(wrapped);
      expect(result.ok).toBe(true);
    }
  });

  it("returns a typed error on garbage - never throws", () => {
    for (const garbage of ["", "not json", "[1,2,3]", '{"foo": 1}']) {
      const result = parseMappingSuggestion(garbage);
      expect(result.ok).toBe(false);
    }
    expect(extractJsonBlock("no json here")).toBeNull();
  });

  it("defaults unknown actions to rename and clamps confidence", () => {
    const sloppy = JSON.stringify({
      suggestions: [
        { source: "a", dest: "B", action: "transmogrify", confidence: 7 },
        { source: "c", dest: "D", action: "drop", confidence: -2 },
      ],
    });
    const result = parseMappingSuggestion(sloppy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestion.suggestions[0].action).toBe("rename");
      expect(result.suggestion.suggestions[0].confidence).toBe(1);
      expect(result.suggestion.suggestions[1].confidence).toBe(0);
    }
  });
});

describe("sanitizeMappingSuggestion (never-trusted rule)", () => {
  const raw: MappingSuggestion = {
    suggestions: [
      // Valid change: overflow field to a real column.
      { source: "dst_port", dest: "DestinationPort", action: "rename", confidence: 0.9, reason: "" },
      // Unknown source field: dropped.
      { source: "hallucinated", dest: "SourceIP", action: "rename", confidence: 0.9, reason: "" },
      // Nonexistent destination column: dropped.
      { source: "weird_field", dest: "NotAColumn", action: "rename", confidence: 0.9, reason: "" },
      // No-op (already the current mapping): dropped.
      { source: "src_ip", dest: "SourceIP", action: "rename", confidence: 0.9, reason: "" },
      // Duplicate source (first wins): dropped.
      { source: "dst_port", dest: "SourceIP", action: "rename", confidence: 0.2, reason: "" },
    ],
    tableRanking: ["CommonSecurityLog", "MadeUpTable"],
    notes: "n",
  };

  it("keeps only verifiable, changed suggestions and known tables", () => {
    const clean = sanitizeMappingSuggestion(raw, INPUT);
    expect(clean.suggestions).toHaveLength(1);
    expect(clean.suggestions[0]).toMatchObject({
      source: "dst_port",
      dest: "DestinationPort",
    });
    expect(clean.tableRanking).toEqual(["CommonSecurityLog"]);
  });

  it("allows destless drop/overflow suggestions", () => {
    const clean = sanitizeMappingSuggestion(
      {
        suggestions: [
          { source: "weird_field", dest: "", action: "drop", confidence: 0.8, reason: "noise" },
        ],
        tableRanking: [],
        notes: "",
      },
      INPUT,
    );
    expect(clean.suggestions).toHaveLength(1);
    expect(clean.suggestions[0].action).toBe("drop");
  });
});

describe("coverage advisory", () => {
  it("builds a prompt with the item, fields, and truncated KQL", () => {
    const { system, user } = buildCoveragePrompt({
      itemName: "Palo Alto - beaconing",
      itemType: "alert-rule",
      missingFields: ["DeviceVendor"],
      availableFields: ["SourceIP"],
      queries: ["CommonSecurityLog | where DeviceVendor == 'Palo Alto'"],
    });
    expect(system).toContain("analytics rule");
    expect(system).toContain("ONLY a JSON object");
    expect(user).toContain("DeviceVendor");
  });

  it("parses advice and filters fixes to REAL missing fields", () => {
    const text = JSON.stringify({
      summary: "The rule keys on vendor identification.",
      fixes: [
        { field: "DeviceVendor", suggestion: "Enrich a constant DeviceVendor." },
        { field: "NotMissing", suggestion: "Should be dropped." },
      ],
    });
    const result = parseCoverageAdvice(text, ["DeviceVendor"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.advice.fixes).toHaveLength(1);
      expect(result.advice.fixes[0].field).toBe("DeviceVendor");
    }
  });

  it("returns a typed error on garbage", () => {
    expect(parseCoverageAdvice("nope", ["A"]).ok).toBe(false);
    expect(parseCoverageAdvice('{"summary":"","fixes":[]}', ["A"]).ok).toBe(false);
  });
});

describe("advisory usecases NEVER reject (deterministic fallback)", () => {
  it("adviseMapping resolves ok:false when the port throws", async () => {
    const llm: LlmAssist = {
      complete: async () => {
        throw new Error("HTTP 401 - no valid Anthropic API key");
      },
    };
    const result = await adviseMapping(llm, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("401");
    }
  });

  it("adviseMapping resolves ok:false on unparseable model text", async () => {
    const llm: LlmAssist = {
      complete: async () => ({ text: "I refuse.", inputTokens: 10, outputTokens: 2 }),
    };
    const result = await adviseMapping(llm, INPUT);
    expect(result.ok).toBe(false);
  });

  it("adviseMapping sanitizes and carries token counts on success", async () => {
    const llm: LlmAssist = {
      complete: async () => ({
        text: JSON.stringify({
          suggestions: [
            { source: "dst_port", dest: "DestinationPort", action: "rename", confidence: 0.9, reason: "match" },
            { source: "hallucinated", dest: "SourceIP", action: "rename", confidence: 0.9, reason: "" },
          ],
          tableRanking: [],
          notes: "",
        }),
        inputTokens: 120,
        outputTokens: 45,
      }),
    };
    const result = await adviseMapping(llm, INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestion.suggestions).toHaveLength(1);
      expect(result.inputTokens).toBe(120);
      expect(result.outputTokens).toBe(45);
    }
  });

  it("adviseCoverage resolves ok:false when the port throws", async () => {
    const llm: LlmAssist = {
      complete: async () => {
        throw new Error("timed out");
      },
    };
    const result = await adviseCoverage(llm, {
      itemName: "wb",
      itemType: "workbook",
      missingFields: ["A"],
      availableFields: [],
      queries: [],
    });
    expect(result.ok).toBe(false);
  });
});
