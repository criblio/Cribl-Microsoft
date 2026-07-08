/**
 * AI coverage advisory - the PURE half of advisories A2/A3
 * (docs/ai-assisted-analysis-plan.md): prompt construction and response
 * parsing for the "why is this really missing / how to close it" explanation
 * of one analytics rule's or workbook's coverage gaps. One module serves both
 * content types - they flow through the same coverage analyzer.
 *
 * Same contracts as mapping-advisory: redacted egress (field names, the item's
 * KQL truncated to {@link KQL_MAX_CHARS} - the rule/workbook query is public
 * repo content, never user event data), never-trusted parsing (typed error,
 * no throw), advisory-only (annotates the panel; the analyzer's counts and the
 * RULE badges stay authoritative).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** Max characters of the item's KQL sent for context (public repo content). */
export const KQL_MAX_CHARS = 4000;

/** Max characters kept per fix suggestion / summary (defensive bound). */
export const ADVICE_MAX_CHARS = 300;

/** Output cap for a coverage advisory call (fits the 30s proxy budget). */
export const COVERAGE_ADVISORY_MAX_TOKENS = 1024;

/** The advisory input for ONE coverage item (rule or workbook). */
export interface CoverageAdvisoryInput {
  itemName: string;
  /** "alert-rule" or "workbook" - steers the wording, not the schema. */
  itemType: string;
  /** The fields the item references that the mapping does not produce. */
  missingFields: string[];
  /** The fields the mapped pipeline DOES produce (the availability set). */
  availableFields: string[];
  /** The item's KQL (truncated here before egress); may be empty. */
  queries: string[];
}

/** One concrete fix for one missing field. */
export interface CoverageFix {
  field: string;
  suggestion: string;
}

/** The validated coverage advice. */
export interface CoverageAdvice {
  /** One-or-two-sentence overall read of the gap. */
  summary: string;
  /** Per-missing-field concrete fixes (subset of the missing fields). */
  fixes: CoverageFix[];
}

/**
 * Build the {system, user} prompt pair for one item's coverage advisory.
 */
export function buildCoveragePrompt(input: CoverageAdvisoryInput): {
  system: string;
  user: string;
} {
  const noun = input.itemType === "workbook" ? "workbook" : "analytics rule";
  const consequence =
    input.itemType === "workbook"
      ? "workbook tiles rendering empty"
      : "the detection not firing";
  const system = [
    `You are an expert in Microsoft Sentinel KQL and Cribl Stream pipelines.`,
    `A Sentinel ${noun} references fields that the user's mapped pipeline`,
    "does not currently produce, risking " + consequence + ". Given the",
    `${noun}'s KQL, its missing fields, and the fields the pipeline DOES`,
    "produce, explain the real impact and propose the most concrete fix for",
    "each missing field (e.g. rename an available source field, add an",
    "enrichment, or note when the field is genuinely absent from the source",
    "data). Consider semantic equivalents among the available fields.",
    "",
    "Respond with ONLY a JSON object (no markdown fences, no prose) matching:",
    '{"summary":string,"fixes":[{"field":string,"suggestion":string}]}',
    "",
    "summary: one or two sentences on the overall gap and its impact.",
    "fixes: one entry per missing field you can address, suggestion is one",
    "short actionable sentence.",
  ].join("\n");

  const kql = input.queries.join("\n\n");
  const user = JSON.stringify({
    itemName: input.itemName,
    itemType: input.itemType,
    missingFields: input.missingFields,
    availableFields: input.availableFields,
    kql: kql.length <= KQL_MAX_CHARS ? kql : `${kql.slice(0, KQL_MAX_CHARS)}...`,
  });

  return { system, user };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The typed parse result: validated advice or a user-facing error. */
export type CoverageParseResult =
  | { ok: true; advice: CoverageAdvice }
  | { ok: false; error: string };

/**
 * Parse and validate the model's raw text into {@link CoverageAdvice}. TOTAL:
 * garbage yields `{ ok: false, error }`, never a throw. Fixes for fields that
 * are NOT in `missingFields` are dropped (never-trusted rule); text is
 * length-bounded.
 */
export function parseCoverageAdvice(
  text: string,
  missingFields: readonly string[],
): CoverageParseResult {
  // Reuse the same tolerant extraction as the mapping advisory.
  let root: unknown = null;
  const trimmed = text.trim();
  for (const candidate of jsonCandidates(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        root = parsed;
        break;
      }
    } catch {
      // Try the next extraction strategy.
    }
  }
  if (!isRecord(root)) {
    return { ok: false, error: "The model did not return a JSON object." };
  }
  const summaryRaw = root["summary"];
  const summary =
    typeof summaryRaw === "string" ? summaryRaw.slice(0, ADVICE_MAX_CHARS * 2) : "";
  const missing = new Set(missingFields);
  const fixesRaw = root["fixes"];
  const fixes: CoverageFix[] = [];
  if (Array.isArray(fixesRaw)) {
    const seen = new Set<string>();
    for (const raw of fixesRaw) {
      if (!isRecord(raw)) continue;
      const field = raw["field"];
      const suggestion = raw["suggestion"];
      if (
        typeof field !== "string" ||
        typeof suggestion !== "string" ||
        suggestion === "" ||
        !missing.has(field) ||
        seen.has(field)
      ) {
        continue;
      }
      seen.add(field);
      fixes.push({ field, suggestion: suggestion.slice(0, ADVICE_MAX_CHARS) });
    }
  }
  if (summary === "" && fixes.length === 0) {
    return { ok: false, error: "The response carried no usable advice." };
  }
  return { ok: true, advice: { summary, fixes } };
}

/** The three extraction strategies, most-specific first. */
function jsonCandidates(trimmed: string): string[] {
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence !== null) {
    candidates.push(fence[1].trim());
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  return candidates;
}
