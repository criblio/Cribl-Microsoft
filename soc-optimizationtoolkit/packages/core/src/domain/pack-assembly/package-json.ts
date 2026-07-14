/**
 * Pack package.json builder + streamtags reader - porting-plan Unit 19
 * (ENG-06/09), and section 3 contract 2.
 *
 * Ported from legacy pack-builder.ts (1675-1690). The pack manifest carries the
 * Cribl pack fields (name, version, author, description, displayName,
 * tags.streamtags, exports, minLogStreamVersion). Emitted with the same
 * two-space JSON + trailing newline as the legacy so a rebuild is byte-stable.
 *
 * FIX + PIN (the second legacy defect this unit corrects): the pack INVENTORY
 * (`pack:list`, pack-builder.ts 2792-2795) read the tag list from the
 * TOP-LEVEL `pkg.streamtags` as a comma-joined STRING - but the manifest stores
 * them under `pkg.tags.streamtags` as an ARRAY, so that read was WRONG on both
 * the path and the type and ALWAYS returned empty. {@link streamtagsFromPackage}
 * reads the correct nested array (with the legacy shapes tolerated as
 * fallbacks), pinned by package-json.test.ts against a real generated manifest.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { PipelinePlan } from "../pipeline-generation";

/** The Cribl pack manifest object. */
export interface PackageJson {
  name: string;
  version: string;
  author: string;
  description: string;
  displayName: string;
  tags: { streamtags: string[] };
  exports: string[];
  minLogStreamVersion: string;
}

/** The minimum Log Stream version a Direct-DCR pack requires. */
export const MIN_LOG_STREAM_VERSION = "4.14.0";

/** Build the pack manifest object from a resolved pipeline plan. */
export function buildPackageJson(plan: PipelinePlan): PackageJson {
  const vendorWords = plan.vendorPrefix.replace(/_/g, " ");
  const uniqueTables = [...new Set(plan.tables.map((t) => t.sentinelTable))];
  const streamtags = [plan.solutionName.toLowerCase().replace(/\s+/g, "-"), "sentinel"];
  return {
    name: plan.packName,
    version: plan.version,
    author: "Cribl SOC Toolkit",
    description: `Transforms ${vendorWords} logs for ingestion into ${uniqueTables.join(", ")} via DCR`,
    displayName: `${vendorWords} Sentinel`,
    tags: { streamtags },
    exports: ["*"],
    minLogStreamVersion: MIN_LOG_STREAM_VERSION,
  };
}

/** Render package.json as the legacy did (2-space JSON + trailing newline). */
export function renderPackageJson(pkg: PackageJson): string {
  return JSON.stringify(pkg, null, 2) + "\n";
}

/**
 * Read the streamtags list from a parsed package.json. The FIX for the legacy
 * always-empty read: prefer the correct nested array `tags.streamtags`; then
 * tolerate a top-level array; then the legacy comma-joined top-level string.
 * Returns [] when none is present or shapes are unrecognized.
 */
export function streamtagsFromPackage(pkg: unknown): string[] {
  if (pkg == null || typeof pkg !== "object") return [];
  const rec = pkg as Record<string, unknown>;

  const nested = (rec.tags as Record<string, unknown> | undefined)?.streamtags;
  if (Array.isArray(nested)) {
    return nested.filter((t): t is string => typeof t === "string");
  }

  const top = rec.streamtags;
  if (Array.isArray(top)) {
    return top.filter((t): t is string => typeof t === "string");
  }
  if (typeof top === "string" && top.trim() !== "") {
    return top.split(",").map((t) => t.trim()).filter(Boolean);
  }

  return [];
}
