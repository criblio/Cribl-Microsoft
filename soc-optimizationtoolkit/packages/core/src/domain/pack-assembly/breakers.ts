/**
 * Event breakers.yml knowledge base - porting-plan Unit 19, task item 3, and
 * section 3 contract 11.
 *
 * Ported VERBATIM from legacy pack-builder.ts (1695-1726). Two JSON breaker
 * rules (json_array for `[...]` payloads, json_newline for newline-delimited
 * objects). CrowdStrike FDR needs special handling and is detected by
 * solution-name substring:
 *   - maxEventBytes 786432 (768KB) because ScriptContent/ScriptContentBytes can
 *     be huge (default 51200 = 50KB otherwise);
 *   - the timestamp anchor targets the `"timestamp"` field directly (epoch ms),
 *     because the field position varies wildly across FDR event types (default
 *     anchor `/^/`).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** Default maximum event size (50KB). */
export const DEFAULT_MAX_EVENT_BYTES = 51200;

/** CrowdStrike FDR maximum event size (768KB). */
export const CROWDSTRIKE_MAX_EVENT_BYTES = 786432;

/** True when the solution name identifies a CrowdStrike feed. */
export function isCrowdStrikeSolution(solutionName: string): boolean {
  return solutionName.toLowerCase().includes("crowdstrike");
}

/**
 * Generate the pack's default/breakers.yml. `solutionName` selects the
 * CrowdStrike FDR tuning when it matches.
 */
export function generateBreakersYml(solutionName: string): string {
  const isCrowdStrike = isCrowdStrikeSolution(solutionName);
  const maxEventBytes = isCrowdStrike ? CROWDSTRIKE_MAX_EVENT_BYTES : DEFAULT_MAX_EVENT_BYTES;
  const timestampAnchor = isCrowdStrike ? '/"timestamp"\\s*:\\s*"/' : "/^/";

  return [
    "id: default",
    "rules:",
    "  - id: json_array",
    "    name: JSON Array Breaker",
    "    condition: /^\\[/",
    "    type: json_array",
    `    maxEventBytes: ${maxEventBytes}`,
    "    disabled: false",
    "  - id: json_newline",
    "    name: JSON Newline Delimited",
    "    condition: /^\\{/",
    "    type: regex",
    `    timestampAnchorRegex: ${timestampAnchor}`,
    "    eventBreakerRegex: /[\\n\\r]+(?=\\{)/",
    `    maxEventBytes: ${maxEventBytes}`,
    "    disabled: false",
    "",
  ].join("\n");
}
