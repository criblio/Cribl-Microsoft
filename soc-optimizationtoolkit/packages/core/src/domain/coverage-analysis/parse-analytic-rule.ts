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
 * KNOWN QUIRKS, PINNED (not silently fixed):
 *  - The query terminator `(?=^[a-zA-Z]|\Z)` uses a JS-literal `\Z`. JS regex
 *    has no `\Z` end-of-input anchor (that is Ruby/Python); in JS `\Z` matches
 *    a LITERAL "Z". So the lazy body stops at the first line beginning with a
 *    letter OR the first literal "Z" anywhere - a query containing a capital Z
 *    (e.g. a trailing `Z` UTC marker mid-line) truncates early. Pinned by a
 *    fixture; preserved because the real YAML upgrade is where it gets fixed.
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
import type { ContentItem, ParsedAnalyticRule } from "./models";

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
  content: string,
  fileName: string,
): ParsedAnalyticRule {
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

  // PINNED query terminator quirk: `\Z` is a literal "Z" in JS regex, not an
  // end-of-input anchor. Preserved verbatim from the legacy source; the
  // no-useless-escape warning is expected and characterized by a fixture, so it
  // is suppressed rather than "fixed" (fixing it here would change behavior).
  // eslint-disable-next-line no-useless-escape
  const queryMatch = content.match(/^query:\s*\|?\s*\n([\s\S]*?)(?=^[a-zA-Z]|\Z)/m);
  const query = queryMatch?.[1]?.trim() || "";

  // Entity-mapping column names - KQL-builtin names filtered out (verbatim from
  // listAnalyticRules; these are appended to the query-extracted fields).
  const entityFields: string[] = [];
  const colMatches = content.matchAll(/columnName:\s*(\w+)/g);
  for (const cm of colMatches) {
    if (cm[1] && !KQL_BUILTINS.has(cm[1].toLowerCase())) entityFields.push(cm[1]);
  }

  return { id, name, severity, tactics, dataTypes, query, entityFields, fileName };
}

/**
 * Parse a CUSTOM (user-uploaded) AnalyticRule YAML. Same regex extraction as
 * {@link parseAnalyticRuleYaml}. REDESIGN NOTE: the legacy
 * pack-builder.ts parse-rule-yaml discarded the query text in the coverage
 * merge (it set `query: ''` for custom rules, so the "View KQL Query"
 * expandable was empty for uploads). Here the query is PRESERVED so a custom
 * rule flows through the shared analyzer identically to a repo rule.
 */
export function parseCustomAnalyticRuleYaml(
  content: string,
  fileName: string,
): ParsedAnalyticRule {
  return parseAnalyticRuleYaml(content, fileName);
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
