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
 * The pack NAME for a solution: `{prefix}-{vendor}`, e.g. "MS-Sentinel-Gigamon".
 *
 * WHY THE SOLUTION HAS TO BE IN IT (user report 2026-08-11). The name used to be
 * the destination prefix alone, so EVERY solution built a pack called
 * "MS-Sentinel". Building a second solution therefore landed on the first one's
 * name, and the only thing between that and a silent replacement was an operator
 * noticing the overwrite prompt and renaming by hand. The pack's DISPLAY name
 * was already solution-derived ("Gigamon Sentinel"), which made the collision
 * harder to spot: two packs reading as different things, fighting over one id.
 *
 * Vendor comes from {@link vendorPrefixFromSolution} rather than a second
 * sanitizer, so the pack name, the pipeline ids and the sample filenames all
 * shorten a vendor the same way. Its underscores become hyphens here to match
 * the prefix's separator - "Palo_Alto" would otherwise make
 * "MS-Sentinel-Palo_Alto", which reads like two conventions colliding.
 *
 * A blank solution name yields the prefix unchanged: before a solution is
 * chosen there is nothing to distinguish, and inventing a token would be worse
 * than the shared default it replaces.
 */
export function packNameForSolution(
  prefix: string,
  solutionName: string,
): string {
  const base = prefix.trim().replace(/[-_\s]+$/, "");
  if (solutionName.trim() === "") {
    return base;
  }
  const vendor = vendorPrefixFromSolution(solutionName).replace(/_/g, "-");
  if (vendor === "" || vendor === "vendor") {
    return base;
  }
  // A vendor already at the tail (re-deriving from an existing name, or a
  // prefix an operator built by hand) must not be doubled.
  if (base.toLowerCase().endsWith(`-${vendor.toLowerCase()}`)) {
    return base;
  }
  return base === "" ? vendor : `${base}-${vendor}`;
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
