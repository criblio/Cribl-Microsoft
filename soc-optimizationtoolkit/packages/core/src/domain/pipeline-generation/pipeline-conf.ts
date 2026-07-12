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
 * Timestamp logic (candidate list, CrowdStrike eval-first + backup
 * auto_timestamp, CEF `rt` override), buildCoercionExpr's type map, the
 * `Type=<table>` enrichment, the fixed cleanup field list, and escapeYamlFilter
 * ordering are all verbatim.
 *
 * PINNED STEP ORDER (contract, section 3 item 12): REDUCTION runs BEFORE RENAME
 * so its filters see RAW vendor field names. Reordering silently breaks every KB
 * filter.
 *
 * TWO fixes vs legacy, both pinned by pipeline-conf.test.ts:
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
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { PANOS_CSV_HEADERS } from "../sample-parsing";
import type { OverflowConfig } from "../field-matcher";
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
): string {
  const functions: string[] = [];

  // If vendor mappings exist, use them for authoritative source->dest transformation
  const hasVendorMappings = vendorMappings && vendorMappings.length > 0;

  const activeFields = fields.filter((f) => f.action !== "drop");
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
        "        - name: __cefParts",
        `          value: "(_raw || '').indexOf('CEF:') >= 0 ? (_raw || '').substring((_raw || '').indexOf('CEF:')).split('|') : []"`,
        "        - name: CEFVersion",
        "          value: \"(__cefParts && __cefParts.length > 0) ? __cefParts[0].replace('CEF:','') : undefined\"",
        "        - name: DeviceVendor",
        '          value: "(__cefParts && __cefParts.length > 1) ? __cefParts[1] : undefined"',
        "        - name: DeviceProduct",
        '          value: "(__cefParts && __cefParts.length > 2) ? __cefParts[2] : undefined"',
        "        - name: DeviceVersion",
        '          value: "(__cefParts && __cefParts.length > 3) ? __cefParts[3] : undefined"',
        "        - name: DeviceEventClassID",
        '          value: "(__cefParts && __cefParts.length > 4) ? __cefParts[4] : undefined"',
        "        - name: Activity",
        '          value: "(__cefParts && __cefParts.length > 5) ? __cefParts[5] : undefined"',
        "        - name: LogSeverity",
        '          value: "(__cefParts && __cefParts.length > 6) ? __cefParts[6] : undefined"',
        "        - name: __cefExtension",
        "          value: \"(__cefParts && __cefParts.length > 7) ? __cefParts.slice(7).join('|') : undefined\"",
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
      if (f.action !== "drop") excludeFields.add(f.target || f.source);
      if (f.action === "keep") excludeFields.add(f.source);
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
      );
}

/**
 * A no-op reduction pipeline emitted when no rules match the table/vendor.
 * Ported verbatim from legacy generateFallbackReductionConf.
 */
export function generateFallbackReductionConf(
  solutionName: string,
  tableName: string,
  sourceFormat?: string,
): string {
  const serdeType =
    sourceFormat === "csv"
      ? "csv"
      : sourceFormat === "kv" ||
          sourceFormat === "cef" ||
          sourceFormat === "leef"
        ? "kvp"
        : "json";
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
