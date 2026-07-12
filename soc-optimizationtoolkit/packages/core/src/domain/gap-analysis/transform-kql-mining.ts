/**
 * THE ONE transformKql field-pair miner (2026-07-12 audit finding: the
 * Sentinel-DCR pack generator and the runtime kql-parser each parsed DCR
 * transformKql with their own regex and had already diverged - the runtime
 * saw zero renames in a DCR that projects `Dest = tostring(src)`).
 *
 * Shared by:
 *  - scripts/generate-sentinel-dcr-packs.mjs (dev time): Node 23.6+ runs
 *    this file NATIVELY via type stripping - which is why this module must
 *    stay DEPENDENCY-FREE (no imports, no JSON, erasable syntax only).
 *  - domain/gap-analysis/kql-parser.ts (runtime): parseTransformKql mines
 *    PROJECT-stage pairs so a CCP DCR's projection map counts as DCR-side
 *    renames (the DCR Handles tile; Cribl must not duplicate them).
 *
 * Accepted right-hand shapes (everything else - lookup dicts, iff(), now(),
 * constants - is skipped):
 *   Dest = source_field
 *   Dest = toXxx(source_field)
 *   Dest = column_ifexists('source_field', ...)
 *   Dest = datetime(1970-01-01) + (source_field * 1ms)   (epoch-ms fields)
 * Case-only renames (Status=status) are skipped: the matcher's
 * case-insensitive ladder already treats them as the same column.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto, NO IMPORTS (see above).
 */

/** One mined pair: the DCR consumes sourceName and emits destName. */
export interface TransformFieldPair {
  sourceName: string;
  destName: string;
}

/** The KQL stages a mining pass may read. */
export type TransformStage = "project" | "project-rename" | "extend";

/** The generator's default: every stage that can carry a pair. */
const ALL_STAGES: readonly TransformStage[] = [
  "project",
  "project-rename",
  "extend",
];

/** Split a KQL stage's argument list on TOP-LEVEL commas. */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of text) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const RHS_PATTERNS: readonly RegExp[] = [
  new RegExp(`^(${IDENT})$`), // bare identifier
  new RegExp(`^to\\w+\\(\\s*(${IDENT})\\s*\\)$`), // toXxx(field)
  new RegExp(`^column_ifexists\\(\\s*'(${IDENT})'`), // column_ifexists('field',...)
  // datetime(1970-01-01) + (field * 1ms)  - epoch-ms conversion
  new RegExp(
    `^datetime\\([^)]*\\)\\s*\\+\\s*\\(\\s*(${IDENT})\\s*\\*\\s*1ms\\s*\\)$`,
  ),
];

/**
 * Extract dest<-source pairs from one transformKql string, reading only the
 * given `stages` (default: all three - the generator's behavior; the runtime
 * parser passes ["project"] because it already owns project-rename and
 * extend-coercion extraction).
 */
export function mineTransformFieldPairs(
  transformKql: string,
  stages: readonly TransformStage[] = ALL_STAGES,
): TransformFieldPair[] {
  const wanted = new Set<string>(stages);
  const pairs: TransformFieldPair[] = [];
  for (const stage of transformKql.split("|")) {
    const trimmed = stage.trim();
    const m = trimmed.match(/^(project-rename|project|extend)\s+([\s\S]+)$/);
    if (m === null || !wanted.has(m[1])) continue;
    for (const item of splitTopLevelCommas(m[2])) {
      const eq = item.match(
        new RegExp(`^\\s*(${IDENT})\\s*=\\s*([\\s\\S]+?)\\s*$`),
      );
      if (eq === null) continue;
      const destName = eq[1];
      const rhs = eq[2];
      for (const pattern of RHS_PATTERNS) {
        const hit = rhs.match(pattern);
        if (hit !== null) {
          if (hit[1].toLowerCase() !== destName.toLowerCase()) {
            pairs.push({ sourceName: hit[1], destName });
          }
          break;
        }
      }
    }
  }
  return pairs;
}
