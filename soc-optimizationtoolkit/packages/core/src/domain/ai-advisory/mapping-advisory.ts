/**
 * AI mapping advisory - the PURE half of advisory A1
 * (docs/ai-assisted-analysis-plan.md): prompt construction, response parsing,
 * and suggestion sanitization for the DCR field-mapping proposal. The only
 * impure step (the model call) lives behind the LlmAssist port in the
 * usecases/ai-advisory orchestration.
 *
 * CONTRACTS:
 * - REDACTION BEFORE EGRESS: the prompt carries field NAMES, inferred TYPES,
 *   and at most ONE example value per field, truncated to
 *   {@link EXAMPLE_MAX_CHARS} - never raw events, never secrets.
 * - NEVER TRUSTED: the model's text is schema-validated by
 *   {@link parseMappingSuggestion} (fence-tolerant JSON extraction, typed
 *   error on garbage - never a throw) and then FILTERED against the real
 *   input by {@link sanitizeMappingSuggestion}: a suggestion for an unknown
 *   source field or a nonexistent destination column is dropped, actions are
 *   clamped to the existing MatchAction vocabulary, and no-op suggestions
 *   (already the current mapping) are removed.
 * - ADVISORY ONLY: nothing here changes a mapping; the UI applies accepted
 *   suggestions through the identical deterministic edit path.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { MatchAction } from "../field-matcher/models";

/** Max characters of ONE example value that may leave the app per field. */
export const EXAMPLE_MAX_CHARS = 60;

/** Max characters kept of a suggestion's reason (defensive display bound). */
export const REASON_MAX_CHARS = 240;

/** Output cap for a mapping advisory call (fits the 30s proxy budget). */
export const MAPPING_ADVISORY_MAX_TOKENS = 2048;

/** One redacted source field as it goes to the model. */
export interface AdvisoryField {
  name: string;
  type: string;
  /** At most one example value, already truncated by the caller or here. */
  example?: string;
}

/** One current mapping row (the deterministic result the model refines). */
export interface AdvisoryCurrentMapping {
  source: string;
  dest: string;
  action: string;
  confidence: string;
}

/** The full advisory input for one log type. */
export interface MappingAdvisoryInput {
  logType: string;
  /** The currently assigned destination table. */
  tableName: string;
  /** Other candidate tables the sample could align to (may be empty). */
  candidateTables: string[];
  /** The redacted source fields. */
  fields: AdvisoryField[];
  /** The deterministic mapping rows (source of truth being refined). */
  currentMappings: AdvisoryCurrentMapping[];
  /** The destination table's columns (name + type). */
  destColumns: Array<{ name: string; type: string }>;
}

/** One model-proposed mapping change, sanitized. */
export interface SuggestedMapping {
  source: string;
  dest: string;
  action: MatchAction;
  /** Clamped to [0, 1]. */
  confidence: number;
  reason: string;
}

/** The validated advisory result. */
export interface MappingSuggestion {
  suggestions: SuggestedMapping[];
  /** Candidate tables ranked best-first, when the model ranked them. */
  tableRanking: string[];
  /** A short free-text note, when the model added one. */
  notes: string;
}

/** Truncate ONE example value to the egress bound. */
export function truncateExample(value: string): string {
  return value.length <= EXAMPLE_MAX_CHARS
    ? value
    : `${value.slice(0, EXAMPLE_MAX_CHARS)}...`;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "rename",
  "keep",
  "coerce",
  "drop",
  "overflow",
]);

/**
 * Build the {system, user} prompt pair for one log type's mapping advisory.
 * The system prompt pins the role and the STRICT-JSON output contract; the
 * user prompt is the redacted input as compact JSON.
 */
export function buildMappingPrompt(input: MappingAdvisoryInput): {
  system: string;
  user: string;
} {
  const system = [
    "You are an expert in Microsoft Sentinel data engineering and Cribl",
    "Stream pipelines. You review a deterministic field-mapping from vendor",
    "log fields to a Sentinel destination table and propose improvements for",
    "the weak spots: unmatched/overflow fields that have a semantically",
    'correct destination column, fuzzy matches that look wrong, and fields',
    "that should be dropped. Only propose destination columns that exist in",
    "the provided schema. Prefer keeping the deterministic mapping unless a",
    "change is clearly better.",
    "",
    "Respond with ONLY a JSON object (no markdown fences, no prose) matching:",
    '{"suggestions":[{"source":string,"dest":string,"action":"rename"|"keep"|"coerce"|"drop"|"overflow","confidence":number,"reason":string}],',
    '"tableRanking":[string],"notes":string}',
    "",
    "suggestions: ONLY rows you would CHANGE from the current mapping (empty",
    "array when the mapping is already right). confidence is 0..1. reason is",
    "one short sentence. tableRanking: the candidate tables ranked best-first",
    "for this log type (include the current table). notes: one optional",
    "sentence of overall guidance, else an empty string.",
  ].join("\n");

  const user = JSON.stringify({
    logType: input.logType,
    currentTable: input.tableName,
    candidateTables: input.candidateTables,
    sourceFields: input.fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.example !== undefined && f.example !== ""
        ? { example: truncateExample(f.example) }
        : {}),
    })),
    currentMappings: input.currentMappings,
    destinationColumns: input.destColumns,
  });

  return { system, user };
}

/**
 * Extract the first JSON object from model text: direct parse, then fenced
 * (```json ... ```), then the outermost {...} substring. Null when nothing
 * parseable is found.
 */
export function extractJsonBlock(text: string): unknown | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  candidates.push(trimmed);
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence !== null) {
    candidates.push(fence[1].trim());
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Try the next extraction strategy.
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.min(1, Math.max(0, n));
}

/** The typed parse result: a validated suggestion or a user-facing error. */
export type MappingParseResult =
  | { ok: true; suggestion: MappingSuggestion }
  | { ok: false; error: string };

/**
 * Parse and validate the model's raw text into a {@link MappingSuggestion}.
 * TOTAL: garbage yields `{ ok: false, error }`, never a throw. Rows missing a
 * string source/dest are dropped; unknown actions default to "rename";
 * confidence is clamped; reasons are length-bounded.
 */
export function parseMappingSuggestion(text: string): MappingParseResult {
  const root = extractJsonBlock(text);
  if (root === null || !isRecord(root)) {
    return { ok: false, error: "The model did not return a JSON object." };
  }
  const rawSuggestions = root["suggestions"];
  if (!Array.isArray(rawSuggestions)) {
    return { ok: false, error: 'The response is missing a "suggestions" array.' };
  }
  const suggestions: SuggestedMapping[] = [];
  for (const raw of rawSuggestions) {
    if (!isRecord(raw)) continue;
    const source = raw["source"];
    const dest = raw["dest"];
    if (typeof source !== "string" || source === "" || typeof dest !== "string") {
      continue;
    }
    const actionRaw = raw["action"];
    const action: MatchAction =
      typeof actionRaw === "string" && VALID_ACTIONS.has(actionRaw)
        ? (actionRaw as MatchAction)
        : "rename";
    const reasonRaw = raw["reason"];
    const reason =
      typeof reasonRaw === "string" ? reasonRaw.slice(0, REASON_MAX_CHARS) : "";
    suggestions.push({
      source,
      dest,
      action,
      confidence: clamp01(raw["confidence"]),
      reason,
    });
  }
  const rankingRaw = root["tableRanking"];
  const tableRanking = Array.isArray(rankingRaw)
    ? rankingRaw.filter((t): t is string => typeof t === "string" && t !== "")
    : [];
  const notesRaw = root["notes"];
  const notes =
    typeof notesRaw === "string" ? notesRaw.slice(0, REASON_MAX_CHARS) : "";
  return { ok: true, suggestion: { suggestions, tableRanking, notes } };
}

/**
 * Filter a parsed suggestion against the REAL input - the never-trusted rule:
 *   - the source must be one of the input fields;
 *   - the dest must be a real destination column, UNLESS the action is
 *     drop/overflow (which have no destination);
 *   - suggestions identical to the current mapping (same dest AND action) are
 *     dropped - the UI shows only actual changes;
 *   - at most one suggestion per source (first wins);
 *   - tableRanking keeps only known candidate/current tables.
 */
export function sanitizeMappingSuggestion(
  suggestion: MappingSuggestion,
  input: MappingAdvisoryInput,
): MappingSuggestion {
  const fieldNames = new Set(input.fields.map((f) => f.name));
  const destNames = new Set(input.destColumns.map((c) => c.name));
  const currentBySource = new Map(
    input.currentMappings.map((m) => [m.source, m]),
  );
  const seen = new Set<string>();
  const suggestions = suggestion.suggestions.filter((s) => {
    if (!fieldNames.has(s.source) || seen.has(s.source)) {
      return false;
    }
    const destless = s.action === "drop" || s.action === "overflow";
    if (!destless && !destNames.has(s.dest)) {
      return false;
    }
    const current = currentBySource.get(s.source);
    if (
      current !== undefined &&
      current.dest === s.dest &&
      current.action === s.action
    ) {
      return false;
    }
    seen.add(s.source);
    return true;
  });
  const knownTables = new Set([input.tableName, ...input.candidateTables]);
  const tableRanking = suggestion.tableRanking.filter((t) => knownTables.has(t));
  return { suggestions, tableRanking, notes: suggestion.notes };
}
