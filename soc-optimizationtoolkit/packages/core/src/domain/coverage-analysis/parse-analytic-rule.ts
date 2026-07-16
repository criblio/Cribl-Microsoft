/**
 * AnalyticRule YAML parsing (porting-plan Unit 23 task item 3), plus the
 * projection of a parsed rule into the shared {@link ContentItem}.
 *
 * PIN-FIRST, PURITY-PRESERVING (Unit 23 + the core purity rule): this is the
 * legacy REGEX EXTRACTION (sentinel-repo.ts listAnalyticRules /
 * pack-builder.ts parse-rule-yaml), ported VERBATIM and characterized by
 * fixtures BEFORE any real-YAML-parser adoption. A real YAML parser is NOT
 * adopted here: adopting one would either pull an impure dependency into
 * packages/core (forbidden) or require vendoring a pure parser and re-pinning
 * every extraction quirk first. The upgrade path is documented at
 * {@link parseAnalyticRuleYaml}; until then the pinned regex is authoritative.
 *
 * QUIRK FIXED (2026-07-09, deliberate): the legacy query terminator
 * `(?=^[a-zA-Z]|\Z)` used a JS-literal `\Z` - JS regex has no `\Z`
 * end-of-input anchor (that is Ruby/Python), so it matched a LITERAL "Z" and
 * truncated any query at its first capital Z. Live evidence: EVERY Zscaler
 * rule died on its own vendor name (`=~ "ZScaler"`), collapsing the
 * referenced-field set to whatever preceded line 4 and making rule coverage
 * report a fake 100%. The terminator is now the next top-level key line or
 * the TRUE end of input (`(?![\s\S])`). The old truncation is pinned as
 * fixed in parse-analytic-rule.test.ts.
 *
 * DECISIONS (SURFACE, per the Unit 13/18 precedent - surface data loss, do not
 * drop silently):
 *  - The legacy `if (requiredFields.length > 0)` SILENTLY DROPPED any rule
 *    whose extracted fields did not intersect the destination schema. This
 *    parser does NOT drop: it returns every parsed rule. The three-way analyzer
 *    (analyze-coverage) then SURFACES a rule's non-schema fields as `unknown`
 *    rather than making the whole rule vanish. The legacy drop is characterized
 *    in a fixture so the behavior change is deliberate and visible.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { KQL_BUILTINS } from "./kql-builtins";
import type {
  ContentItem,
  ParsedAnalyticRule,
  ParsedEntityMapping,
} from "./models";

/**
 * Parse ONE AnalyticRule YAML document with the pinned regex extraction.
 *
 * UPGRADE PATH (documented, deliberately not taken here): to replace this with
 * a real YAML parse, (1) vendor a PURE, zero-IO YAML parser into packages/core
 * (no filesystem, no network, no Node built-ins), (2) add characterization
 * fixtures for every quirk below and prove the parser reproduces or
 * intentionally corrects each, (3) swap the body while keeping this signature.
 * Do NOT compromise core purity for the convenience of a runtime YAML library.
 */
export function parseAnalyticRuleYaml(
  contentRaw: string,
  fileName: string,
): ParsedAnalyticRule {
  // Normalize CRLF -> LF up front. JS regex `.` never matches `\r`, so a
  // list pattern like `(?:\s+-\s+.+\n)*` (tactics, dataTypes) silently matches
  // ZERO items on a CRLF file - `.+` stops before `\r` and the required `\n`
  // can't match `\r`. That dropped `tactics` on CRLF rules, so Azure rejected
  // the install ("No valid tactic corresponding to the technique ..."):
  // techniques were sent with an empty tactics field.
  const content = contentRaw.replace(/\r\n?/g, "\n");
  const id = content.match(/^id:\s*(.+)/m)?.[1]?.trim() || "";
  const name =
    content
      .match(/^name:\s*(.+)/m)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "") || fileName;
  const severity = content.match(/^severity:\s*(.+)/m)?.[1]?.trim() || "Unknown";

  const tactics: string[] = [];
  const tacticsMatch = content.match(/^tactics:\s*\n((?:\s+-\s+.+\n)*)/m);
  if (tacticsMatch) {
    for (const line of tacticsMatch[1].split("\n")) {
      const t = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
      if (t) tactics.push(t);
    }
  }

  const dataTypes: string[] = [];
  const dtMatches = content.matchAll(/dataTypes:\s*\n((?:\s+-\s+.+\n)*)/g);
  for (const dtm of dtMatches) {
    for (const line of dtm[1].split("\n")) {
      const dt = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
      if (dt) dataTypes.push(dt);
    }
  }

  // Terminator: the next top-level key line (a line starting with a letter)
  // or the TRUE end of input. The legacy `\Z` here was a literal "Z" in JS
  // regex and truncated queries at their first capital Z (fixed 2026-07-09;
  // see the module header).
  const queryMatch = content.match(
    /^query:\s*\|?\s*\n([\s\S]*?)(?=^[a-zA-Z]|(?![\s\S]))/m,
  );
  const query = queryMatch?.[1]?.trim() || "";

  // Entity-mapping column names - KQL-builtin names filtered out (verbatim from
  // listAnalyticRules; these are appended to the query-extracted fields).
  const entityFields: string[] = [];
  const colMatches = content.matchAll(/columnName:\s*(\w+)/g);
  for (const cm of colMatches) {
    if (cm[1] && !KQL_BUILTINS.has(cm[1].toLowerCase())) entityFields.push(cm[1]);
  }

  // --- INSTALL fields (content-enablement, 2026-07-14): additive optional
  // extraction with the same tolerant single-purpose regexes; a miss leaves
  // the field absent and the coverage path is untouched. ---
  const single = (key: string): string | undefined => {
    const value = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    if (value === undefined || value === "" || value === "|" || value === ">") {
      return undefined;
    }
    return value.replace(/^['"]|['"]$/g, "");
  };
  const block = (key: string): string | undefined => {
    const m = content.match(
      new RegExp(`^${key}:\\s*[|>]-?\\s*\\n([\\s\\S]*?)(?=^[a-zA-Z]|(?![\\s\\S]))`, "m"),
    );
    const text = m?.[1]
      ?.split("\n")
      .map((line) => line.replace(/^ {2,4}/, ""))
      .join("\n")
      .trim();
    return text === undefined || text === "" ? undefined : text;
  };
  const list = (key: string): string[] => {
    const out: string[] = [];
    const m = content.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, "m"));
    if (m) {
      for (const line of m[1].split("\n")) {
        const item = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
        if (item) out.push(item);
      }
    }
    return out;
  };

  const kind = single("kind");
  const description = block("description") ?? single("description");
  const queryFrequency = single("queryFrequency");
  const queryPeriod = single("queryPeriod");
  const triggerOperator = single("triggerOperator");
  const thresholdRaw = single("triggerThreshold");
  const triggerThreshold =
    thresholdRaw !== undefined && Number.isFinite(Number(thresholdRaw))
      ? Number(thresholdRaw)
      : undefined;
  const techniques = list("relevantTechniques");
  const version = single("version");
  const entityMappings = parseEntityMappings(content);

  return {
    id,
    name,
    severity,
    tactics,
    dataTypes,
    query,
    entityFields,
    fileName,
    ...(kind !== undefined ? { kind } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(queryFrequency !== undefined ? { queryFrequency } : {}),
    ...(queryPeriod !== undefined ? { queryPeriod } : {}),
    ...(triggerOperator !== undefined ? { triggerOperator } : {}),
    ...(triggerThreshold !== undefined ? { triggerThreshold } : {}),
    ...(techniques.length > 0 ? { techniques } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(entityMappings.length > 0 ? { entityMappings } : {}),
  };
}

/**
 * Tolerant structured parse of the `entityMappings:` block: each
 * `- entityType:` entry with its identifier/columnName pairs (paired in
 * document order). Anything surprising yields [] - the rule still installs,
 * just without entity mappings.
 */
function parseEntityMappings(content: string): ParsedEntityMapping[] {
  const blockMatch = content.match(
    /^entityMappings:\s*\n([\s\S]*?)(?=^[a-zA-Z]|(?![\s\S]))/m,
  );
  if (!blockMatch) return [];
  const out: ParsedEntityMapping[] = [];
  const entries = blockMatch[1].split(/(?=^\s*-\s+entityType:)/m);
  for (const entry of entries) {
    const entityType = entry.match(/entityType:\s*(.+)/)?.[1]?.trim();
    if (!entityType) continue;
    const fieldMappings: Array<{ identifier: string; columnName: string }> = [];
    const identifiers = [...entry.matchAll(/identifier:\s*(\w+)/g)];
    const columns = [...entry.matchAll(/columnName:\s*(\w+)/g)];
    for (let i = 0; i < Math.min(identifiers.length, columns.length); i++) {
      fieldMappings.push({
        identifier: identifiers[i][1],
        columnName: columns[i][1],
      });
    }
    if (fieldMappings.length > 0) {
      out.push({ entityType, fieldMappings });
    }
  }
  return out;
}

/**
 * Project a parsed rule into the shared {@link ContentItem}. The query is a
 * single-element `queries` array; entity fields become `extraFields`. NO
 * schema filtering and NO zero-field drop happen here - that is the analyzer's
 * three-way job (SURFACE, not drop).
 */
export function analyticRuleToContentItem(
  rule: ParsedAnalyticRule,
  custom = false,
): ContentItem {
  return {
    type: "alert-rule",
    id: rule.id || rule.name,
    name: rule.name,
    queries: rule.query ? [rule.query] : [],
    extraFields: rule.entityFields,
    severity: rule.severity,
    tactics: rule.tactics,
    custom,
  };
}

/**
 * Merge freshly-uploaded custom rules into an existing custom-rule list,
 * FIXING the legacy dedupe-by-name quirk (Unit 23 task item 5).
 *
 * LEGACY BUG (pinned as the "before" in the test): the upload handler did
 * `if (!merged.some((r) => r.name === rule.name)) merged.push(rule)` - a rule
 * whose name already existed was SILENTLY IGNORED, so a user could not
 * RE-UPLOAD an edited rule of the same name to update it. FIX: an incoming
 * rule REPLACES the existing rule of the same name (last-write-wins), and new
 * names are appended. Order is preserved: replacements keep their original
 * slot; genuinely-new rules append in upload order.
 */
export function mergeCustomContentItems(
  existing: readonly ContentItem[],
  incoming: readonly ContentItem[],
): ContentItem[] {
  const merged = existing.map((item) => ({ ...item }));
  for (const rule of incoming) {
    const at = merged.findIndex((r) => r.name === rule.name);
    if (at >= 0) merged[at] = { ...rule };
    else merged.push({ ...rule });
  }
  return merged;
}
