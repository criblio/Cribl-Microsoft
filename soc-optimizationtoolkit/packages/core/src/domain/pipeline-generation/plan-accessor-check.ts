/**
 * checkPlanFieldAccessors - GEN-5, KEPT LEG: refuse a source field the
 * pipeline reads by its OWN spelling when that spelling is not a Cribl
 * property accessor, even though no conf line ever names it.
 *
 * WHY THIS IS A PLAN CHECK AND NOT A YAML RULE. checkCriblYaml's accessor rule
 * (DBT-78, GEN-4) reads names off `name:`/`currentName:`/`newName:` lines, and
 * a field kept under its own name is on none of them - the transform conf
 * leaves it where it is, so there is no line to read. Measured 2026-09-03 and
 * again 2026-10-02 through the real chain (parseSampleContent ->
 * matchSampleToSchema -> buildPipelinePlan -> generatePipelineConfForPlan ->
 * checkCriblYaml): `a.b` and `Source IP` kept against a same-named column
 * gave 0 YAML issues, and the preview reported the build valid. The name is
 * therefore read off the PLAN, which is what the conf was generated from.
 *
 * WHICH FIELDS, each one measured rather than assumed:
 *   - `keep`: never presented by any conf line.
 *   - `rename` whose source equals its target: the matcher emits this for a
 *     same-named column whose TYPE differs (`[{"a.b":5}]` against a string
 *     column `a.b`), and the emitter skips a rename onto its own name, so it
 *     is a keep in every way the conf can see.
 *   - `coerce` whose coercion the emitter cannot express: buildCoercionExpr
 *     returns null (a guid column, say) and no line is written. A coercion it
 *     CAN express writes `- name: <field>` under the enrich eval's `add:`,
 *     which checkCriblYaml already refuses - reporting that one here too would
 *     count one field twice, so it is skipped.
 * A rename onto a DIFFERENT name is presented on a `currentName:` line and is
 * checkCriblYaml's to refuse, also skipped here.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER - GEN-5's DROP leg. An unmatched field
 * appears only as a bullet under the cleanup eval's `remove:` list, and
 * whether Cribl's glob list accessor-parses that bullet at all is unmeasured.
 * The operator decided 2026-10-02 to measure it on a live Cribl before
 * building anything, so a `drop` (and an `overflow`) is never reported here.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { isCriblAccessorSafe } from "../sample-parsing";
import type { PipelineFieldMapping, TablePlan } from "./models";
import { buildCoercionExpr } from "./pipeline-conf";

/**
 * Whether the generated conf reads `f` by its own source spelling WITHOUT any
 * conf line presenting that spelling to checkCriblYaml's accessor rule.
 * Mirrors the emitter's choices in pipeline-conf.ts (presetRenames skips a
 * self-rename; presetCoercions writes a line only when buildCoercionExpr
 * returns an expression) - the pins in accessor-names.test.ts drive both
 * through the real emitter so a drift between the two shows up as a count.
 */
function isReadUnpresented(f: PipelineFieldMapping): boolean {
  if (f.action === "keep") return true;
  if (f.action === "rename") return f.source === f.target;
  if (f.action === "coerce") {
    return buildCoercionExpr(f.target || f.source, "string", f.type) === null;
  }
  return false;
}

/**
 * Return one issue per kept / self-renamed / unexpressed-coerce field of
 * `table` whose source name Cribl cannot build a property accessor for (empty
 * = clean). Wording parallels checkCriblYaml's accessor message, so the two
 * read as the same refusal in the preview's issue list.
 */
export function checkPlanFieldAccessors(table: TablePlan): string[] {
  const where =
    table.logType !== "" && table.logType !== table.sentinelTable
      ? `${table.sentinelTable} (${table.logType})`
      : table.sentinelTable;
  const issues: string[] = [];
  for (const f of table.fields) {
    if (!isReadUnpresented(f) || isCriblAccessorSafe(f.source)) continue;
    issues.push(
      `${where}: field name "${f.source}" (${f.action}) is not a valid Cribl ` +
        `property accessor - Cribl will fail to build an accessor for it at ` +
        `runtime (or, for a dotted name, silently address a nested field that ` +
        `does not exist). It is kept under its own spelling, so no conf line ` +
        `names it; map it to a column with an addressable name instead.`,
    );
  }
  return issues;
}
