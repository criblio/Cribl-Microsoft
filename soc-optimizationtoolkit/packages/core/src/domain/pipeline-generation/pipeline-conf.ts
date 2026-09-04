/**
 * generatePipelineConf - the pure conf.yml builder - porting-plan Unit 17, task
 * item (b) (ENG-01/03 emission).
 *
 * Ported from legacy IS/pack-builder.ts (generatePipelineConf 254-813,
 * generateReductionPipelineConf 822-958, generateFallbackReductionConf 966-1017,
 * buildCoercionExpr 220-232, detectTimestampField 234-252, escapeYamlFilter
 * 960-964). The format-specific extraction knowledge is preserved VERBATIM:
 *   - CEF: a two-step EVAL (parse the pipe-delimited header, avoiding
 *     regex_extract) + serde kvp for the extension key=value pairs;
 *   - LEEF: serde kvp with a tab delimiter;
 *   - CSV: strip the syslog prefix, split on comma, then either the PAN-OS
 *     positional map (now sourced from Unit 12's canonical PANOS_CSV_HEADERS
 *     dictionary instead of the legacy hard-coded subset) or a generic serde;
 *   - JSON/KV: serde json/kvp.
 * ONE format is NOT legacy knowledge and was added 2026-09-03 (GEN-6):
 *   - POSITIONAL: an eval that splits _raw on runs of whitespace and assigns
 *     the SAME column names sample-parsing/positional.ts produced. Before it,
 *     a positional sample fell to the trailing else and got a JSON serde over
 *     a whitespace line, which extracted nothing while every screen reported
 *     success. See positionalColumns / positionalExtractFunctions.
 * Timestamp logic (candidate list, CrowdStrike eval-first + backup
 * auto_timestamp, CEF `rt` override), buildCoercionExpr's type map, the
 * `Type=<table>` enrichment, the fixed cleanup field list, and escapeYamlFilter
 * ordering are all verbatim.
 *
 * PINNED STEP ORDER (contract, section 3 item 12): REDUCTION runs BEFORE RENAME
 * so its filters see RAW vendor field names. Reordering silently breaks every KB
 * filter.
 *
 * THREE fixes vs legacy, all pinned by pipeline-conf.test.ts:
 *   1. SUPPRESS honors maxEvents. Legacy's live path emitted `allow: rule.allow
 *      || 1` - `allow` is not a field of SuppressRule, so it was always
 *      undefined and every suppress rule collapsed to allow:1, discarding the
 *      KB's maxEvents. The only code that read maxEvents was dead. We emit
 *      `allow: rule.maxEvents ?? 1` (porting-plan decision (3); no customer
 *      artifact depends on allow:1).
 *   2. CEF indexOf(-1) guard. `(_raw||'').substring((_raw||'').indexOf('CEF:'))`
 *      returns the last character when 'CEF:' is absent (indexOf -> -1), yielding
 *      a garbage __cefParts split. The header eval now guards indexOf>=0 and
 *      emits [] otherwise, so a non-CEF line cleanly produces undefined header
 *      fields instead of garbage.
 *   3. CEF PIPE ESCAPE (DBT-98, 2026-09-04). The header eval emitted
 *      `.split('|')`, which splits on the `\|` the CEF specification requires for
 *      a literal pipe inside a header value - shifting every header field after
 *      it by one position in the INSTALLED pipeline, silently, because the field
 *      names all stay right. It now emits sample-parsing's CEF_HEADER_PATTERN
 *      verbatim, the same characters the analyzer parses with. See cefHeaderAdds.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import {
  CEF_HEADER_ESCAPE,
  CEF_HEADER_PATTERN,
  PANOS_CSV_HEADERS,
  VPC_FLOW_V2_FIELDS,
} from "../sample-parsing";
import type { OverflowConfig } from "../field-matcher";
import { CEF_IDENTITY_FIELDS, overrideValueFor } from "../cef-identity";
import type { CefIdentityOverride } from "../cef-identity";
import type { PipelineFieldMapping, TablePlan } from "./models";
import type { TableReductionRules } from "./reduction-rules";

/**
 * A vendor-research field mapping as consumed by the emitter (Unit 15 shape).
 * still compile. `action` is one of "map" | "enrich" | "drop".
 */
export interface PipelineVendorMapping {
  sourceName: string;
  destName: string;
  sourceType: string;
  destType: string;
  action: string;
  description?: string;
}

/** Build a type coercion expression for the Cribl Eval function (verbatim). */
export function buildCoercionExpr(
  fieldName: string,
  sourceType: string,
  targetType: string,
): string | null {
  if (sourceType === targetType) return null;
  const t = targetType.toLowerCase();
  const escaped = fieldName.replace(/'/g, "\\'");
  if (t === "int" || t === "long") return `Number(${escaped}) || 0`;
  if (t === "real") return `parseFloat(${escaped}) || 0.0`;
  if (t === "boolean") return `Boolean(${escaped})`;
  if (t === "datetime") return `${escaped}`;
  if (t === "string") return `String(${escaped} || '')`;
  if (t === "dynamic")
    return `typeof ${escaped} === 'string' ? JSON.parse(${escaped}) : ${escaped}`;
  return null;
}

/** Detect the most likely timestamp field from the field list (verbatim). */
export function detectTimestampField(fields: PipelineFieldMapping[]): string {
  const candidates = [
    "EdgeStartTimestamp",
    "Datetime",
    "Timestamp",
    "EventTime",
    "TimeGenerated",
    "timestamp",
    "time",
    "eventTime",
    "created_at",
    "CreatedDateTime",
    "StartTime",
    "GeneratedDateTime",
  ];
  for (const candidate of candidates) {
    if (fields.some((f) => f.source === candidate || f.target === candidate)) {
      return candidate;
    }
  }
  // Fall back to any field with "time" or "date" in the name
  const timeField = fields.find((f) => {
    const lower = (f.source || f.target).toLowerCase();
    return (
      lower.includes("time") ||
      lower.includes("date") ||
      lower.includes("timestamp")
    );
  });
  return timeField ? timeField.source || timeField.target : "TimeGenerated";
}

/** Escape backslashes and double quotes for YAML string embedding (verbatim). */
export function escapeYamlFilter(expr: string | undefined | null): string {
  if (!expr) return "true";
  return expr.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The Eval function that forces DeviceVendor / DeviceProduct to the operator's
 * values, or null when the override names nothing.
 *
 * Values are emitted as QUOTED JS STRING LITERALS, not interpolated bare: a
 * vendor name legitimately contains spaces ("Palo Alto Networks") and can
 * contain an apostrophe, and an unescaped one would produce a Cribl expression
 * that fails to parse - breaking the whole pipeline over a punctuation mark.
 *
 * A blank value emits nothing, matching applyCefIdentityOverride: "leave it" is
 * expressible, "clear it" deliberately is not, because an empty DeviceVendor
 * makes CEF reconstruction fail.
 */
export function buildCefIdentityOverrideFn(
  override: CefIdentityOverride | undefined,
): string | null {
  if (override === undefined) {
    return null;
  }
  const adds: string[] = [];
  for (const field of CEF_IDENTITY_FIELDS) {
    // The blank rule is NOT re-derived here: overrideValueFor owns it, so the
    // emitted pipeline and the event path cannot disagree about the same
    // override (architecture audit 2026-08-10).
    const value = overrideValueFor(override, field);
    if (value === null) {
      continue;
    }
    adds.push(`        - name: ${field}`);
    adds.push(`          value: "${JSON.stringify(value).slice(1, -1).replace(/"/g, '\\"')}"`);
  }
  if (adds.length === 0) {
    return null;
  }
  return [
    "  - id: eval",
    '    filter: "true"',
    "    disabled: false",
    "    conf:",
    "      add:",
    ...adds,
    "    description: Override CEF identity so Sentinel content matches",
    "    groupId: extract",
  ].join("\n");
}

/**
 * The seven CEF header fields, in header order, under the names the pipeline
 * gives them. `Name` and `Severity` are emitted as `Activity` and `LogSeverity`
 * because those are Sentinel's CommonSecurityLog columns; the analyzer screen
 * shows the CEF spellings. That mapping is verbatim from the legacy emitter.
 */
const CEF_HEADER_ADD_NAMES = [
  "CEFVersion",
  "DeviceVendor",
  "DeviceProduct",
  "DeviceVersion",
  "DeviceEventClassID",
  "Activity",
  "LogSeverity",
];

/**
 * The `add:` entries of the CEF header eval (DBT-98).
 *
 * WHY THIS IS BUILT RATHER THAN WRITTEN OUT. Until 2026-09-04 these nine `add`
 * entries were literals ending in `.split('|')` and `.slice(7).join('|')` - the naive
 * header split, emitted into every generated pack. `CEF:0|V\|W|P|1.0|100|worm|5|`
 * escapes that pipe exactly as the CEF specification requires, the split cut on
 * it anyway, and every header field from DeviceVendor down shifted one position
 * at RUNTIME, in the installed pipeline, for the seven fields an operator is
 * most likely to map to a destination column. sample-parsing/parsers.ts had the
 * same defect and carries the measured before/after on CEF_HEADER_PATTERN.
 *
 * FIXING ONE SIDE ALONE WOULD HAVE BEEN WORSE THAN THE SHIFT, which is why the
 * pattern is IMPORTED and its `.source` emitted verbatim instead of a second
 * regex being typed here. The screen and the shipped pack now reach the seven
 * header fields through literally the same characters, so they cannot drift into
 * the state GEN-6 closed: an app that promises fields the pack cannot produce.
 * The pin for that is an equality between the emitted text and the constant, not
 * an eyeball.
 *
 * WHAT RUNS IN CRIBL, stated as narrowly as it was checked. The expressions use
 * `indexOf`, `substring`, `match`, `slice` and `replace` with a regex literal and
 * a `'$1'` backreference - ES5-level constructs, and the same class this emitter
 * already ships (`__posParts` splits on `/\s+/`, the PAN-OS CSV step replaces
 * with `'$1'`). NOT VERIFIED AGAINST A LIVE CRIBL INSTANCE in this change; what
 * is verified is that the emitted text, YAML-unescaped and evaluated, reproduces
 * parseCef's header record byte for byte (pipeline-conf.test.ts).
 *
 * THE UNESCAPE IS IMPORTED FOR THE SAME REASON AND WAS NARROWED ON 2026-09-04.
 * `CEF_HEADER_ESCAPE` resolves `\\` and `\|` and nothing else; while it was the
 * wider `/\\([\s\S])/g` this emitter shipped a pipeline that DELETED every lone
 * backslash in a header value at runtime - `C:\Program Files\Acme` reached the
 * destination column as `C:Program FilesAcme` - while the kvp serde below left
 * the identical bytes in the extension alone. Because the emitter reads the
 * constant rather than spelling a second regex, the installed pack and the
 * analyzer screen changed in the same commit; the pin is the `.source` equality
 * in pipeline-conf.test.ts, and the measured before/after is on the constant.
 *
 * `.slice(1)` DROPS THE WHOLE-MATCH ELEMENT, so `__cefParts[0..6]` are the seven
 * header fields and `__cefParts[7]` is the extension - one index left of the raw
 * match, and the same slots the `length > N` guards below already used. It also
 * turns the match object into a PLAIN array, so nothing downstream depends on
 * Cribl preserving a match array's `index`/`input`/`groups` properties.
 *
 * The extension is `__cefParts[7]` VERBATIM, not a re-join: group 8 is everything
 * after the seventh unescaped pipe. `.slice(7).join('|')` only ever reconstituted
 * the extension because the split it undid had been naive.
 */
function cefHeaderAdds(): string[] {
  const headerRe = `/${CEF_HEADER_PATTERN.source}/`;
  const unescape = `.replace(/${CEF_HEADER_ESCAPE.source}/g, '$1')`;
  const raw = "(_raw || '')";
  const adds = [
    "        - name: __cefParts",
    `          value: "${escapeYamlFilter(
      `${raw}.indexOf('CEF:') >= 0 ? (${raw}.substring(${raw}.indexOf('CEF:')).match(${headerRe}) || []).slice(1) : []`,
    )}"`,
  ];
  for (let i = 0; i < CEF_HEADER_ADD_NAMES.length; i++) {
    adds.push(`        - name: ${CEF_HEADER_ADD_NAMES[i]}`);
    adds.push(
      `          value: "${escapeYamlFilter(
        `(__cefParts && __cefParts.length > ${i}) ? __cefParts[${i}]${unescape} : undefined`,
      )}"`,
    );
  }
  // The same guard shape as the seven above, and for the same reason: it tests
  // whether the header matched AT ALL (`[]` slices to length 0). A header that
  // matched with no extension leaves the element itself undefined, which Cribl
  // already treats as "do not set the field" - so an extra `!== undefined` test
  // was written here first and then removed, because it could never change an
  // answer, and a guard that cannot fire is a claim about the code that has
  // stopped being true. MEASURED rather than argued, both spellings run over
  // seven shapes - extension present, absent, empty, short header, non-CEF line,
  // escaped pipe, dangling backslash: the guard changed the answer on 0 of 7.
  adds.push("        - name: __cefExtension");
  adds.push(
    `          value: "${escapeYamlFilter(
      "(__cefParts && __cefParts.length > 7) ? __cefParts[7] : undefined",
    )}"`,
  );
  return adds;
}

/** One whitespace-positional column: the name to mint and the slot it sits in. */
interface PositionalColumn {
  readonly name: string;
  readonly index: number;
}

/**
 * The positional columns this pipeline must mint, derived from the field names
 * THE PARSER ALREADY PRODUCED (GEN-6).
 *
 * WHY DERIVE RATHER THAN RE-DETECT. sample-parsing/positional.ts decides once,
 * from the bytes, whether a file is recognisable VPC Flow v2 - and that decision
 * is deliberately strict (every row, 14 columns, version literally "2", a
 * log-status from the closed vocabulary). Re-running any part of that judgement
 * here would be a SECOND opinion about the same file, and two opinions drift:
 * the failure mode is a pipeline that extracts `srcaddr` from a file the
 * analyzer called `field4`, so the gap analysis the operator approved and the
 * pack they install disagree about what the columns are. The plan's `source`
 * names ARE the parser's output, so reading them back is one opinion, not two.
 *
 * WHY MINTING A NAME IS SAFE HERE AND NOT FOR JSON/KV (DBT-78's distinction,
 * and the reason this branch can exist at all). The emitted eval splits `_raw`
 * itself and puts the name on the LEFT of the assignment, so the parsed name and
 * the runtime name are the same name by construction. For JSON and key=value
 * Cribl's own serde mints the names from the vendor's bytes, which is why the
 * parser must not sanitise those - see sample-parsing/accessor-names.ts.
 *
 * THE TWO SHAPES, matching parsePositional exactly:
 *   RECOGNISED   the 14 VPC_FLOW_V2_FIELDS, imported rather than re-spelled.
 *                All 14 are emitted even when the plan carries only some of
 *                them: the layout is known, an unextracted column cannot be
 *                serialized into the catch-all or removed by cleanup, and the
 *                plan's field list is not evidence about the FILE's width.
 *   UNRECOGNISED `field1..fieldN`, each at its own slot. No width is inferred
 *                from the highest name seen - a plan carrying a subset would
 *                make that a guess, and a guessed width invents columns.
 *
 * Returns EMPTY when the sources are neither shape, or are somehow both: that
 * means these names did not come from one positional parse, and there is no
 * honest column order to emit. The caller makes that case loud rather than
 * quietly emitting an extraction that names nothing.
 */
export function positionalColumns(
  fields: readonly PipelineFieldMapping[],
): PositionalColumn[] {
  const sources = [
    ...new Set(fields.map((f) => f.source).filter((s) => s !== "")),
  ];
  const recognised = sources.some((s) => VPC_FLOW_V2_FIELDS.includes(s));
  const numbered: PositionalColumn[] = [];
  for (const source of sources) {
    const m = /^field(\d+)$/.exec(source);
    const slot = m === null ? 0 : Number(m[1]);
    if (slot >= 1) numbered.push({ name: source, index: slot - 1 });
  }
  // Both shapes at once is not a positional parse we produced; refuse rather
  // than pick a half.
  if (recognised && numbered.length > 0) return [];
  if (recognised) {
    return VPC_FLOW_V2_FIELDS.map((name, index) => ({ name, index }));
  }
  return numbered.sort((a, b) => a.index - b.index);
}

/**
 * The extract-group functions for a whitespace-positional source.
 *
 * WHY THIS BRANCH EXISTS (GEN-6). Without it a positional sample fell to the
 * trailing `else` and got `serde type: json` over `_raw`. A whitespace line is
 * not JSON, so the step extracted NOTHING - and every step after it addressed
 * fields that no event carried. The parse was right, the gap analysis was right,
 * the build reported success, and the installed pack produced empty events. That
 * is the failure this codebase is organised against, so the extraction has to
 * reproduce the parse rather than merely differ from JSON.
 *
 * The split mirrors splitPositional: trim, then split on RUNS of whitespace, so
 * a hand-edited sample carrying a tab or a doubled space does not shift every
 * column right. `__posParts` is consumed in the same function that creates it
 * (the CEF header eval's `__cefParts` precedent).
 *
 * WHEN NO COLUMN NAMES COULD BE DERIVED the pipeline says so instead of
 * pretending. It still splits - so the operator sees the columns in `__posParts`
 * in Cribl's preview rather than an empty event - and carries a Comment function
 * stating that nothing was named and what to do. Emitting nothing at all here
 * would be the original defect wearing a different mask.
 */
function positionalExtractFunctions(
  columns: readonly PositionalColumn[],
  groupId: string,
): string[] {
  const split =
    "        - name: __posParts\n" +
    `          value: "(_raw || '').trim().split(/\\\\s+/)"`;

  if (columns.length === 0) {
    return [
      [
        "  - id: eval",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      add:",
        split,
        "      remove: []",
        "    description: Split whitespace-positional columns from _raw",
        `    groupId: ${groupId}`,
      ].join("\n"),
      [
        "  - id: comment",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      comment: >",
        "        This source was read as a whitespace-positional log, but no",
        "        positional column names reached the pack builder, so no column",
        "        could be named. The split values are left in __posParts. Name",
        "        the columns here before installing, or every event will reach",
        "        the destination with no vendor fields at all.",
        `    groupId: ${groupId}`,
      ].join("\n"),
    ];
  }

  const assignments = columns.map(
    (c) =>
      `        - name: ${c.name}\n          value: "(__posParts && __posParts.length > ${c.index}) ? __posParts[${c.index}] : undefined"`,
  );
  return [
    [
      "  - id: eval",
      '    filter: "true"',
      "    disabled: false",
      "    conf:",
      "      add:",
      split,
      ...assignments,
      "      remove:",
      "        - __posParts",
      "    description: Split whitespace-positional columns from _raw and name them",
      `    groupId: ${groupId}`,
    ].join("\n"),
  ];
}

/**
 * Generate the transformation pipeline conf.yml. Groups: Field Extraction,
 * (Volume Reduction), Enrich & Classify, (Overflow Collection), Sentinel
 * Cleanup. See the file header for the verbatim knowledge and the two fixes.
 */
export function generatePipelineConf(
  _pipelineName: string,
  solutionName: string,
  tableName: string,
  fields: PipelineFieldMapping[],
  vendorMappings?: PipelineVendorMapping[],
  sourceFormat?: string,
  overflowConfig?: OverflowConfig,
  reductionRules?: TableReductionRules | null,
  logType?: string,
  identityOverride?: CefIdentityOverride,
): string {
  const functions: string[] = [];

  // If vendor mappings exist, use them for authoritative source->dest transformation
  const hasVendorMappings = vendorMappings && vendorMappings.length > 0;

  const activeFields = fields.filter(
    (f) => f.action !== "drop" && f.action !== "overflow",
  );
  // UNION FIX (2026-07-09, pinned): the legacy either/or made ANY vendor
  // mapping (including enrichment constants riding this channel) silently
  // discard every preset rename/coercion. Vendor map entries stay
  // authoritative per source name; preset entries not covered by one still
  // apply.
  const vendorRenames = hasVendorMappings
    ? vendorMappings.filter(
        (m) => m.action === "map" && m.sourceName !== m.destName,
      )
    : [];
  const vendorRenameSources = new Set(
    vendorRenames.map((m) => m.sourceName.toLowerCase()),
  );
  const presetRenames = activeFields.filter(
    (f) =>
      f.action === "rename" &&
      f.source !== f.target &&
      !vendorRenameSources.has(f.source.toLowerCase()),
  );
  const vendorCoercions = hasVendorMappings
    ? vendorMappings.filter(
        (m) => m.action === "map" && m.sourceType !== m.destType,
      )
    : [];
  const vendorCoercionDests = new Set(
    vendorCoercions.map((m) => m.destName.toLowerCase()),
  );
  const presetCoercions = activeFields.filter(
    (f) =>
      f.action === "coerce" &&
      !vendorCoercionDests.has((f.target || f.source).toLowerCase()),
  );
  // Base64-decode fields (2026-09 decode action): emitted as an Eval below.
  const decodeFields = activeFields.filter(
    (f) => f.action === "decode" && f.target !== "",
  );

  let timestampField = hasVendorMappings
    ? vendorMappings.find((m) => m.destName === "TimeGenerated")?.sourceName ||
      detectTimestampField(fields)
    : detectTimestampField(fields);
  // FDR uses epoch ms in "timestamp"; override a non-standard detection.
  if (
    solutionName.toLowerCase().includes("crowdstrike") &&
    timestampField !== "timestamp"
  ) {
    timestampField = "timestamp";
  }
  // CEF uses 'rt' (ReceiptTime); fall back to it when detection found nothing.
  if (sourceFormat === "cef" && timestampField === "TimeGenerated") {
    timestampField = "rt";
  }

  // Step 1 (extract group): Parse fields from _raw
  if (sourceFormat === "cef") {
    // CEF two-step extraction: (1) eval to parse the pipe-delimited header
    // (avoids regex_extract conf differences across Cribl versions); (2) serde
    // kvp for the extension key=value pairs. The __cefParts value GUARDS the
    // indexOf(-1) garbage case (see file header, fix 2).
    functions.push(
      [
        "  - id: eval",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      add:",
        ...cefHeaderAdds(),
        "      remove:",
        "        - __cefParts",
        "    description: Parse CEF header from _raw",
        "    groupId: extract",
      ].join("\n"),
    );

    // Parse CEF extension key=value pairs
    functions.push(
      [
        "  - id: serde",
        '    filter: "__cefExtension != undefined"',
        "    disabled: false",
        "    conf:",
        "      mode: extract",
        "      type: kvp",
        "      srcField: __cefExtension",
        '      delimChar: " "',
        '      pairDelim: "="',
        "    description: Parse CEF extension fields",
        "    groupId: extract",
      ].join("\n"),
    );

    // Clean up temporary __cefExtension field
    functions.push(
      [
        "  - id: eval",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      add: []",
        "      remove:",
        "        - __cefExtension",
        "    description: Remove temporary parsing field",
        "    groupId: extract",
      ].join("\n"),
    );
  } else if (sourceFormat === "leef") {
    // LEEF: serde kvp with a tab delimiter
    functions.push(
      [
        "  - id: serde",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      mode: extract",
        "      type: kvp",
        "      srcField: _raw",
        '      delimChar: "\\t"',
        '      pairDelim: "="',
        "    description: Parse LEEF fields from _raw",
        "    groupId: extract",
      ].join("\n"),
    );
  } else if (sourceFormat === "csv") {
    // CSV: strip the syslog prefix, split on comma, assign positional names.
    const isPanOS =
      solutionName.toLowerCase().includes("paloalto") ||
      solutionName.toLowerCase().includes("pan_os") ||
      solutionName.toLowerCase().includes("palo alto");

    // Step 1: Strip syslog prefix and split CSV
    functions.push(
      [
        "  - id: eval",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      add:",
        "        - name: __csvRaw",
        // Strip syslog prefix: find first digit-comma-4digit pattern (PAN-OS) or use as-is
        `          value: "(_raw || '').replace(/^.*?(\\\\d+,\\\\d{4}\\\\/)/, '$1')"`,
        "        - name: __csvParts",
        `          value: "(__csvRaw || '').split(',')"`,
        "      remove:",
        "        - __csvRaw",
        "    description: Strip syslog prefix and split CSV fields",
        "    groupId: extract",
      ].join("\n"),
    );

    if (isPanOS) {
      // PAN-OS positional map, sourced from Unit 12's canonical dictionary.
      // Pick the log-type dictionary (default TRAFFIC), then emit one named
      // assignment per non-future_use column at its documented index. The dict
      // index aligns with __csvParts index because future_use1 sits at 0 and the
      // syslog-prefix strip keeps that leading field.
      const dictKey = (logType || "").toUpperCase();
      const cols: readonly string[] =
        (dictKey && PANOS_CSV_HEADERS[dictKey]) || PANOS_CSV_HEADERS["TRAFFIC"];

      const colAssignments: string[] = [];
      for (let idx = 0; idx < cols.length; idx++) {
        const name = cols[idx];
        if (name.startsWith("future_use")) continue;
        colAssignments.push(
          `        - name: ${name}\n          value: "(__csvParts && __csvParts.length > ${idx}) ? __csvParts[${idx}] : undefined"`,
        );
      }

      functions.push(
        [
          "  - id: eval",
          '    filter: "true"',
          "    disabled: false",
          "    conf:",
          "      add:",
          ...colAssignments,
          "      remove:",
          "        - __csvParts",
          "    description: Assign PAN-OS CSV columns to named fields",
          "    groupId: extract",
        ].join("\n"),
      );
    } else {
      // Generic CSV: serde which creates _0, _1, _2, etc.
      functions.push(
        [
          "  - id: serde",
          '    filter: "true"',
          "    disabled: false",
          "    conf:",
          "      mode: extract",
          "      type: csv",
          "      srcField: _raw",
          '      delimChar: ","',
          "      hasHeaderRow: false",
          "    description: Parse CSV from _raw",
          "    groupId: extract",
        ].join("\n"),
      );
    }
  } else if (sourceFormat === "positional") {
    // GEN-6. See positionalExtractFunctions - this branch is the whole fix, and
    // its absence is why a positional sample used to be handed to a JSON serde.
    functions.push(...positionalExtractFunctions(positionalColumns(fields), "extract"));
  } else {
    const serdeType = sourceFormat === "kv" ? "kvp" : "json";
    const serdeDesc =
      serdeType === "json"
        ? "Parse JSON from _raw"
        : "Parse key-value pairs from _raw";

    functions.push(
      [
        "  - id: serde",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      mode: extract",
        `      type: ${serdeType}`,
        "      srcField: _raw",
        ...(serdeType === "kvp"
          ? ['      delimChar: " "', '      pairDelim: "="']
          : []),
        `    description: ${serdeDesc}`,
        "    groupId: extract",
      ].join("\n"),
    );
  }

  // Step 1.5 (extract group): CEF IDENTITY OVERRIDE.
  //
  // Placed HERE, and the position is the whole point. The CEF branch above sets
  // DeviceVendor/DeviceProduct FROM the raw header, so an override emitted
  // before it would be overwritten by the extraction it was meant to correct.
  // Everything after this - reduction filters (which match on raw vendor field
  // names), renames, overflow - sees the corrected value.
  //
  // Without this the override would only ever have changed the ANALYSIS, and
  // deployed data would still carry the vendor string the rules do not match:
  // the same invisible failure the feature exists to remove, one layer down.
  const identityOverrideFn = buildCefIdentityOverrideFn(identityOverride);
  if (identityOverrideFn !== null) {
    functions.push(identityOverrideFn);
  }

  // Step 2 (extract group): Extract timestamp.
  // CrowdStrike FDR "timestamp" is epoch ms; eval-first is position-independent,
  // then a backup auto_timestamp catches events the eval missed.
  const isFdrTimestamp =
    timestampField === "timestamp" &&
    solutionName.toLowerCase().includes("crowdstrike");

  if (isFdrTimestamp) {
    functions.push(
      [
        "  - id: eval",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      add:",
        "        - disabled: false",
        "          name: _time",
        '          value: "Number(timestamp) / 1000 || Number(ContextTimeStamp) || Date.now() / 1000"',
        "      remove: []",
        "    description: Extract _time from FDR timestamp with fallback to ContextTimeStamp",
        "    groupId: extract",
      ].join("\n"),
    );

    functions.push(
      [
        "  - id: auto_timestamp",
        '    filter: "!_time || _time <= 0"',
        "    disabled: false",
        "    conf:",
        "      srcField: _raw",
        "      dstField: _time",
        "      defaultTimezone: UTC",
        '      timeExpression: "time.getTime() / 1000"',
        "      offset: 0",
        "      maxLen: 15000",
        "      defaultTime: now",
        "      latestDateAllowed: +1week",
        "      earliestDateAllowed: -420weeks",
        "    description: Backup timestamp extraction when eval misses",
        "    groupId: extract",
      ].join("\n"),
    );
  } else {
    functions.push(
      [
        "  - id: auto_timestamp",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        `      srcField: ${timestampField}`,
        "      dstField: _time",
        "      defaultTimezone: UTC",
        '      timeExpression: "time.getTime() / 1000"',
        "      offset: 0",
        "      maxLen: 150",
        "      defaultTime: now",
        "      latestDateAllowed: +1week",
        "      earliestDateAllowed: -420weeks",
        `    description: Extract _time from ${timestampField}`,
        "    groupId: extract",
      ].join("\n"),
    );
  }

  // Step 2.5 (reduce group): Volume reduction - keep/drop/suppress. Runs BEFORE
  // field rename so filters operate on RAW vendor field names. Present only when
  // reductionRules is provided.
  if (reductionRules) {
    // Keep: tag analytics-critical events
    if (reductionRules.keep.length > 0) {
      const keepConditions = reductionRules.keep
        .map((r) => `(${r.filter})`)
        .join(" || ");
      functions.push(
        [
          "  - id: eval",
          `    filter: "${escapeYamlFilter(keepConditions)}"`,
          "    disabled: false",
          "    conf:",
          "      add:",
          "        - name: __keep",
          '          value: "true"',
          "      remove: []",
          "    description: Tag analytics-critical events",
          "    groupId: reduce",
        ].join("\n"),
      );
    }

    // Drop: eliminate events with no analytics value
    for (const rule of reductionRules.drop) {
      functions.push(
        [
          "  - id: drop",
          `    filter: "!__keep && (${escapeYamlFilter(rule.filter)})"`,
          "    disabled: false",
          "    conf: {}",
          `    description: DROP ${rule.description || "low-value events"}`,
          "    groupId: reduce",
        ].join("\n"),
      );
    }

    // Suppress: aggregate noisy events. FIX: honor maxEvents (see file header).
    for (const rule of reductionRules.suppress) {
      functions.push(
        [
          "  - id: suppress",
          `    filter: "!__keep && (${escapeYamlFilter(rule.filter)})"`,
          "    disabled: false",
          "    conf:",
          `      allow: ${rule.maxEvents ?? 1}`,
          `      suppressPeriodSec: ${rule.windowSec || 300}`,
          `      keyExpr: "${escapeYamlFilter(rule.groupKey || "SourceIP")}"`,
          "      dropEventsMode: true",
          `    description: SUPPRESS ${rule.description || "noisy events"}`,
          "    groupId: reduce",
        ].join("\n"),
      );
    }

    // Clean up __keep tag
    functions.push(
      [
        "  - id: eval",
        '    filter: "__keep"',
        "    disabled: false",
        "    conf:",
        "      add: []",
        "      remove:",
        "        - __keep",
        "    description: Remove internal __keep tag before enrichment",
        "    groupId: reduce",
      ].join("\n"),
    );
  }

  // Step 3 (enrich group): Rename source fields to destination names
  if (vendorRenames.length + presetRenames.length > 0) {
    let entries: string[];
    if (hasVendorMappings) {
      entries = vendorRenames.map(
        (m) =>
          `        - currentName: ${m.sourceName}\n          newName: ${m.destName}`,
      );
    } else {
      entries = [];
    }
    entries.push(
      ...presetRenames.map(
        (f) =>
          `        - currentName: ${f.source}\n          newName: ${f.target}`,
      ),
    );
    functions.push(
      [
        "  - id: rename",
        '    filter: "true"',
        "    disabled: false",
        "    description: Rename source fields to DCR schema",
        "    groupId: enrich",
        "    conf:",
        "      rename:",
        ...entries,
      ].join("\n"),
    );
  }

  // Step 3a2 (enrich group): base64-decode documented encoded fields into
  // their destination columns (e.g. Zscaler b64url -> RequestURL). A rename
  // would carry base64 text where rules expect decoded content; the source
  // field is consumed (removed) once decoded.
  if (decodeFields.length > 0) {
    const decodeAdds = decodeFields.map(
      (f) =>
        `        - disabled: false\n          name: ${f.target}\n          value: "C.Decode.base64(${f.source})"`,
    );
    const decodeRemoves = decodeFields.map((f) => `        - ${f.source}`);
    functions.push(
      [
        "  - id: eval",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      add:",
        ...decodeAdds,
        "      remove:",
        ...decodeRemoves,
        "    description: Decode base64 source fields into DCR schema",
        "    groupId: enrich",
      ].join("\n"),
    );
  }

  // Step 3b (enrich group): Enrichment fields (derived from source data)
  if (hasVendorMappings) {
    const enrichFields = vendorMappings.filter((m) => m.action === "enrich");
    if (enrichFields.length > 0) {
      const enrichExprs = enrichFields.map((m) => {
        return `        - disabled: false\n          name: ${m.destName}\n          value: "'${m.description}'"`;
      });
      functions.push(
        [
          "  - id: eval",
          '    filter: "true"',
          "    disabled: false",
          "    conf:",
          "      add:",
          ...enrichExprs,
          "      remove: []",
          "    description: Add enrichment fields",
          "    groupId: enrich",
        ].join("\n"),
      );
    }
  }

  // Step 4 (enrich group): Type coercion where source type != dest type
  const coercionExprs: string[] = [];
  for (const m of vendorCoercions) {
    if (m.sourceType === m.destType) continue;
    const fieldName = m.destName; // Coerce after rename
    const expr = buildCoercionExpr(fieldName, m.sourceType, m.destType);
    if (expr) {
      coercionExprs.push(
        `        - name: ${fieldName}\n          value: "${expr}"`,
      );
    }
  }
  for (const f of presetCoercions) {
    const expr = buildCoercionExpr(f.target || f.source, "string", f.type);
    if (expr) {
      coercionExprs.push(
        `        - name: ${f.target || f.source}\n          value: "${expr}"`,
      );
    }
  }

  // Step 4b: Value normalization is intentionally empty (legacy note preserved:
  // the curly-brace lookup exprs broke some Cribl YAML parsers; deferred to a
  // future Lookup function).
  const valueNormExprs: string[] = [];

  // Enrich eval: Type classification + coercions + (empty) value normalizations
  const enrichAdd: string[] = [
    "        - disabled: false",
    "          name: Type",
    `          value: "'${tableName}'"`,
    ...coercionExprs,
    ...valueNormExprs,
  ];

  functions.push(
    [
      "  - id: eval",
      '    filter: "true"',
      "    disabled: false",
      "    conf:",
      "      add:",
      ...enrichAdd,
      "      remove: []",
      `    description: Set Type and classify for ${tableName}`,
      "    groupId: enrich",
    ].join("\n"),
  );

  // Step 5 (overflow group): Serialize unmatched source fields into the overflow
  // field using native Serialize with exclusion patterns (!field) + wildcard (*).
  const hasOverflow =
    overflowConfig?.enabled && overflowConfig.sourceFields.length > 0;

  if (hasOverflow) {
    const ofc = overflowConfig;
    const excludeFields = new Set<string>();
    // Cribl envelope
    for (const f of [
      "_raw",
      "_time",
      "source",
      "sourcetype",
      "host",
      "index",
      "cribl_breaker",
    ])
      excludeFields.add(f);
    // Schema fields (renamed dest names + kept source names)
    for (const f of activeFields) {
      excludeFields.add(f.target || f.source);
      if (f.action === "keep") excludeFields.add(f.source);
    }
    // DROPPED fields never enter the catch-all (2026-07-13 live fix: they
    // were being serialized into AdditionalExtensions and shipped anyway).
    for (const f of fields) {
      if (f.action === "drop") excludeFields.add(f.source);
    }
    if (hasVendorMappings) {
      for (const m of vendorMappings) {
        if (m.action === "map") excludeFields.add(m.destName);
      }
    }
    // Standard pipeline fields + the overflow field itself
    for (const f of ["Type", "TimeGenerated", ofc.fieldName])
      excludeFields.add(f);

    functions.push(
      [
        "  - id: serialize",
        '    filter: "true"',
        "    disabled: false",
        "    conf:",
        "      type: json",
        `      dstField: ${ofc.fieldName}`,
        "      fields:",
        // Exclude Cribl internals (__ prefix), schema fields, then include (*)
        '        - "!__*"',
        ...[...excludeFields].map((f) => `        - "!${f}"`),
        '        - "*"',
        `    description: Serialize unmapped fields into ${ofc.fieldName} as JSON`,
        "    groupId: overflow",
      ].join("\n"),
    );
  }

  // Step 6 (cleanup group): Remove Cribl internal fields and transport metadata.
  const vendorDropFields = hasVendorMappings
    ? vendorMappings.filter((m) => m.action === "drop").map((m) => m.sourceName)
    : [];
  // Reviewer/policy drops arrive as preset fields (2026-07-13 live fix).
  //
  // Marking a row `drop` excludes the field from the serialize above AND
  // removes it here, so a dropped field is gone from both places while
  // everything else still reaches AdditionalExtensions. That lever is
  // unchanged.
  const presetDropFields = fields
    .filter((f) => f.action === "drop")
    .map((f) => f.source)
    .filter((source) => !vendorDropFields.includes(source));

  // The serialized originals are removed too (user decision 2026-08-13,
  // REVERSING the 2026-08-12 call to keep them).
  //
  // Cribl's Serialize COPIES rather than moves, so every overflow field was
  // being sent twice: once inside the AdditionalExtensions JSON and again at
  // top level, where the DCR has no column for it and silently ignores it. For
  // Zscaler that is 59 duplicated fields on a firewall event and 133 on a web
  // event - bytes paid for and discarded, in a toolkit whose purpose is
  // reducing exactly that.
  //
  // The earlier decision assumed removing them would empty the catch-all,
  // making the choice all-or-nothing. It does not: ORDER IS WHAT MAKES THIS
  // SAFE - the serialize runs in the `overflow` group, this eval in `cleanup`
  // immediately after, so the values are already inside the JSON string before
  // anything is removed. Selectivity is unaffected, because an explicit `drop`
  // still excludes a field from the serialize itself.
  //
  // Only fields that were actually serialized: a field the serialize excluded
  // is either already in presetDropFields or is a real DCR column, and
  // removing a mapped column would delete data the DCR wants.
  const serializedOverflowFields = hasOverflow
    ? fields
        .filter((f) => f.action === "overflow")
        .map((f) => f.source)
        .filter(
          (source) =>
            !vendorDropFields.includes(source) &&
            !presetDropFields.includes(source),
        )
    : [];
  const dropEntries = [
    "_raw",
    "_time",
    "cribl_*",
    "__header*",
    "__inputId",
    "__criblMetrics",
    "__final",
    "__channel",
    "__dest*",
    "__span*",
    "source",
    "host",
    "port",
    "index",
    "cribl_breaker",
    "sourcetype",
    ...vendorDropFields,
    ...presetDropFields,
    ...serializedOverflowFields,
  ];

  functions.push(
    [
      "  - id: eval",
      '    filter: "true"',
      "    disabled: false",
      "    conf:",
      "      add: []",
      "      remove:",
      ...dropEntries.map((f) => `        - ${f}`),
      "    description: Remove internal fields",
      "    groupId: cleanup",
    ].join("\n"),
  );

  return [
    "output: default",
    "streamtags: []",
    "groups:",
    "  extract:",
    "    name: Field Extraction",
    "    disabled: false",
    ...(reductionRules
      ? ["  reduce:", "    name: Volume Reduction", "    disabled: false"]
      : []),
    "  enrich:",
    "    name: Enrich & Classify",
    "    disabled: false",
    ...(hasOverflow
      ? ["  overflow:", "    name: Overflow Collection", "    disabled: false"]
      : []),
    "  cleanup:",
    "    name: Sentinel Cleanup",
    "    disabled: false",
    "asyncFuncTimeout: 1000",
    "functions:",
    ...functions,
    "",
  ].join("\n");
}

/**
 * Emit the transformation conf.yml for a resolved {@link TablePlan} - the clean
 * entrypoint plan consumers use (no reduction rules; the transform-only path).
 */
export function generatePipelineConfForPlan(
  table: TablePlan,
  solutionName: string,
): string {
  return generatePipelineConf(
    table.pipelineName,
    solutionName,
    table.sentinelTable,
    table.fields,
    table.vendorMappings as PipelineVendorMapping[] | undefined,
    table.sourceFormat,
    table.overflowConfig,
    null,
    table.logType,
    // The corrected CEF identity, if the reviewer set one. Threaded here rather
    // than left to the caller: this is the entry point the pack build and the
    // pipeline preview both use, and an override the preview showed but the
    // build dropped would be the worst possible version of this feature.
    table.identityOverride,
  );
}

/**
 * Emit the self-contained REDUCTION conf.yml for a resolved {@link TablePlan}:
 * the full transformation pipeline WITH the reduce group inserted (when rules
 * exist), else the no-op fallback pipeline.
 */
export function generateReductionConfForPlan(
  table: TablePlan,
  solutionName: string,
): string {
  return table.reductionRules
    ? generatePipelineConf(
        table.reductionPipelineId,
        solutionName,
        table.sentinelTable,
        table.fields,
        table.vendorMappings as PipelineVendorMapping[] | undefined,
        table.sourceFormat,
        table.overflowConfig,
        table.reductionRules,
        table.logType,
      )
    : generateFallbackReductionConf(
        solutionName,
        table.sentinelTable,
        table.sourceFormat,
        // GEN-6: the fallback's triage step exists so the filters an operator
        // adds can SEE fields, and for a positional source it was the same JSON
        // serde over a whitespace line. It needs the plan's field names to mint
        // the columns, so they are threaded here rather than left behind.
        table.fields,
      );
}

/**
 * A no-op reduction pipeline emitted when no rules match the table/vendor.
 * Ported verbatim from legacy generateFallbackReductionConf, with ONE change:
 * a positional source gets the GEN-6 split-and-name extraction instead of a
 * serde, because its whole purpose is to let a hand-written drop filter read a
 * field, and a JSON serde over a whitespace-positional line produces none.
 * `fields` is optional so the legacy 3-argument call still compiles and still
 * behaves identically for every non-positional format.
 */
export function generateFallbackReductionConf(
  solutionName: string,
  tableName: string,
  sourceFormat?: string,
  fields: readonly PipelineFieldMapping[] = [],
): string {
  const serdeType =
    sourceFormat === "csv"
      ? "csv"
      : sourceFormat === "kv" ||
          sourceFormat === "cef" ||
          sourceFormat === "leef"
        ? "kvp"
        : "json";
  const triage =
    sourceFormat === "positional"
      ? positionalExtractFunctions(positionalColumns(fields), "triage")
      : [
          [
            "  - id: serde",
            '    filter: "true"',
            "    disabled: false",
            "    conf:",
            "      mode: extract",
            `      type: ${serdeType}`,
            "      srcField: _raw",
            ...(serdeType === "kvp"
              ? ['      delimChar: " "', '      pairDelim: "="']
              : []),
            `    description: Parse ${sourceFormat || "JSON"} from _raw so reduction filters can inspect fields.`,
            "    groupId: triage",
          ].join("\n"),
        ];
  return [
    `# Reduction Pipeline: ${solutionName} - ${tableName}`,
    "#",
    "# No pre-built reduction rules found for this table/vendor.",
    "# Add custom drop/suppress functions below to reduce ingestion volume.",
    "#",
    "# Recommended approach:",
    "#   1. Analyze which events your Sentinel analytics rules actually query",
    "#   2. Add drop functions for event types not referenced by any rule",
    "#   3. Add suppress functions for noisy events that can be sampled",
    "#",
    "# Generated by Cribl SOC Optimization Toolkit",
    "",
    "output: default",
    "streamtags: []",
    "groups:",
    "  triage:",
    "    name: Event Triage",
    "    disabled: false",
    "  drop:",
    "    name: Event Elimination",
    "    disabled: false",
    "  suppress:",
    "    name: Event Suppression",
    "    disabled: false",
    "asyncFuncTimeout: 1000",
    "functions:",
    ...triage,
    "  - id: comment",
    '    filter: "true"',
    "    disabled: true",
    "    conf:",
    "      comment: >",
    "        No built-in reduction rules for this table. Add custom drop and",
    "        suppress functions here based on your Sentinel analytics rules.",
    "    groupId: drop",
    "",
  ].join("\n");
}
