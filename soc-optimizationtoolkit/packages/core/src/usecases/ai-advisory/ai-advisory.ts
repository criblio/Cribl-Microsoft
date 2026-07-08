/**
 * AI advisory ACQUISITION usecases (docs/ai-assisted-analysis-plan.md P1/P2) -
 * the thin orchestration between the pure domain/ai-advisory half (prompt
 * build, parse, sanitize) and the impure LlmAssist port.
 *
 * NEVER-THROW CONTRACT (the deterministic-fallback guardrail): a transport
 * failure, an auth failure, or an unparseable response all resolve to
 * `{ ok: false, error }` - an LLM problem is NEVER a feature failure; the
 * calling UI keeps the deterministic analysis and shows the advisory error
 * inline. Token counts ride every success for cost visibility.
 */

import type { LlmAssist } from "../../ports/llm-assist";
import type { Logger } from "../../ports/logger";
import {
  MAPPING_ADVISORY_MAX_TOKENS,
  buildMappingPrompt,
  parseMappingSuggestion,
  sanitizeMappingSuggestion,
} from "../../domain/ai-advisory/mapping-advisory";
import type {
  MappingAdvisoryInput,
  MappingSuggestion,
} from "../../domain/ai-advisory/mapping-advisory";
import {
  COVERAGE_ADVISORY_MAX_TOKENS,
  buildCoveragePrompt,
  parseCoverageAdvice,
} from "../../domain/ai-advisory/coverage-advisory";
import type {
  CoverageAdvice,
  CoverageAdvisoryInput,
} from "../../domain/ai-advisory/coverage-advisory";

/** The mapping advisory outcome (A1). */
export type MappingAdvisoryResult =
  | {
      ok: true;
      suggestion: MappingSuggestion;
      inputTokens: number;
      outputTokens: number;
    }
  | { ok: false; error: string };

/**
 * Run advisory A1 for one log type: build the redacted prompt, one model
 * call, parse, sanitize against the real input. Resolves `{ok:false}` on any
 * failure - never rejects.
 */
export async function adviseMapping(
  llm: LlmAssist,
  input: MappingAdvisoryInput,
  logger?: Logger,
): Promise<MappingAdvisoryResult> {
  const { system, user } = buildMappingPrompt(input);
  let text: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const result = await llm.complete({
      system,
      user,
      maxTokens: MAPPING_ADVISORY_MAX_TOKENS,
    });
    text = result.text;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.warn("ai-advisory: mapping call failed", {
      logType: input.logType,
      error,
    });
    return { ok: false, error };
  }
  const parsed = parseMappingSuggestion(text);
  if (!parsed.ok) {
    logger?.warn("ai-advisory: mapping response unparseable", {
      logType: input.logType,
      error: parsed.error,
    });
    return { ok: false, error: parsed.error };
  }
  const suggestion = sanitizeMappingSuggestion(parsed.suggestion, input);
  logger?.info("ai-advisory: mapping advice", {
    logType: input.logType,
    suggestions: suggestion.suggestions.length,
    inputTokens,
    outputTokens,
  });
  return { ok: true, suggestion, inputTokens, outputTokens };
}

/** The coverage advisory outcome (A2/A3). */
export type CoverageAdvisoryResult =
  | {
      ok: true;
      advice: CoverageAdvice;
      inputTokens: number;
      outputTokens: number;
    }
  | { ok: false; error: string };

/**
 * Run advisory A2/A3 for one coverage item (rule or workbook): build the
 * prompt, one model call, parse with fixes filtered to the REAL missing
 * fields. Resolves `{ok:false}` on any failure - never rejects.
 */
export async function adviseCoverage(
  llm: LlmAssist,
  input: CoverageAdvisoryInput,
  logger?: Logger,
): Promise<CoverageAdvisoryResult> {
  const { system, user } = buildCoveragePrompt(input);
  let text: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const result = await llm.complete({
      system,
      user,
      maxTokens: COVERAGE_ADVISORY_MAX_TOKENS,
    });
    text = result.text;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.warn("ai-advisory: coverage call failed", {
      item: input.itemName,
      error,
    });
    return { ok: false, error };
  }
  const parsed = parseCoverageAdvice(text, input.missingFields);
  if (!parsed.ok) {
    logger?.warn("ai-advisory: coverage response unparseable", {
      item: input.itemName,
      error: parsed.error,
    });
    return { ok: false, error: parsed.error };
  }
  logger?.info("ai-advisory: coverage advice", {
    item: input.itemName,
    fixes: parsed.advice.fixes.length,
    inputTokens,
    outputTokens,
  });
  return { ok: true, advice: parsed.advice, inputTokens, outputTokens };
}
