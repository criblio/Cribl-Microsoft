/**
 * Pack / pipeline / route NAMING - porting-plan Unit 17, task item (d) and
 * porting-plan section 3 contract 2.
 *
 * The legacy scaffold computed the per-log-type suffix THREE different ways:
 *   - the transformation pipeline DIR used a stripped+sanitized+collapsed+capped
 *     suffix (pack-builder.ts 2112-2116);
 *   - the reduction pipeline dir and the route ids used a RAW sanitized suffix
 *     with NO `_CL` strip, NO `_+` collapse, and NO length cap
 *     (pack-builder.ts 2392, 2444).
 * When those diverged (a `_CL` table, or a log type over 25 chars, or one with
 * doubled separators), the emitted `route_*` route referenced
 * `pipeline: {vendorPrefix}_{rawSuffix}` while the pipeline was actually written
 * to a DIR named with the capped suffix - a dangling reference that silently
 * dropped the route. The porting plan classifies this as a DEFECT, not a
 * contract (section 3, item 2: "unify and pin the fixed behavior").
 *
 * This module is the SINGLE source of every generated name. The route emitter,
 * the pipeline-dir name, and the reduction id all call {@link pipelineSuffix},
 * so a route's `pipeline:` target can never diverge from the pipeline it names.
 * Pinned by route-yml.test.ts.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/**
 * The short vendor prefix used for pack naming, pipeline names, and sample
 * filenames. Verbatim from pack-builder.ts 1664-1673: strip noise words, keep
 * the first two words, collapse to underscores, cap at 20 chars, fall back to
 * "vendor".
 */
export function vendorPrefixFromSolution(solutionName: string): string {
  const name = solutionName
    .replace(
      /\b(connector|for|microsoft|sentinel|cloud|solution|integration|next-generation|firewall)\b/gi,
      "",
    )
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const parts = name.split("_").filter(Boolean).slice(0, 2);
  return parts.join("_").slice(0, 20) || "vendor";
}

/**
 * The ONE per-log-type suffix. Adopts the transformation-pipeline-dir rules
 * (the stricter, correct set) as the single canonical form: prefer the log type
 * over the table name, strip a trailing `_CL`, sanitize to `[A-Za-z0-9_-]`,
 * collapse runs of `_`, and cap at 25 chars. Used for the pipeline dir, the
 * reduction id, and every route id - so they can never diverge.
 */
export function pipelineSuffix(
  logType: string | undefined,
  sentinelTable: string,
): string {
  return (logType || sentinelTable)
    .replace(/_CL$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 25);
}

/** The transformation pipeline id/dir name: `{vendorPrefix}_{suffix}`. */
export function pipelineName(vendorPrefix: string, suffix: string): string {
  return `${vendorPrefix}_${suffix}`;
}

/** The reduction pipeline id/dir name: `Reduction_{vendorPrefix}_{suffix}`. */
export function reductionPipelineId(
  vendorPrefix: string,
  suffix: string,
): string {
  return `Reduction_${vendorPrefix}_${suffix}`;
}

/** The reduction route id: `reduction_{vendorPrefix}_{suffix}`. */
export function reductionRouteId(
  vendorPrefix: string,
  suffix: string,
): string {
  return `reduction_${vendorPrefix}_${suffix}`;
}

/** The passthrough (transform-only) route id: `route_{vendorPrefix}_{suffix}`. */
export function passthroughRouteId(
  vendorPrefix: string,
  suffix: string,
): string {
  return `route_${vendorPrefix}_${suffix}`;
}

/**
 * The Sentinel destination id for a table: `MS-Sentinel-{Table}-dest` with any
 * `_CL` suffix stripped (compatibility contract, section 3 item 3).
 */
export function destinationId(sentinelTable: string): string {
  return `MS-Sentinel-${sentinelTable.replace(/_CL$/i, "")}-dest`;
}

/**
 * The Cribl stream name for a table: `Custom-{Table}` with `_CL` stripped
 * (compatibility contract, section 3 item 3).
 */
export function streamName(sentinelTable: string): string {
  return `Custom-${sentinelTable.replace(/_CL$/i, "")}`;
}
