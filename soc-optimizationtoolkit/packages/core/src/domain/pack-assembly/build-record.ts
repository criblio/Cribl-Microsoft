/**
 * Pack build records + retention - porting-plan Unit 19, task item 8 (ENG-09).
 *
 * A build record is the small, KV/local-store-persistable descriptor of one
 * built pack: id, name, version, the caller-supplied build timestamp
 * (builtAt-as-input, keeping this module Date-free), the destination table list,
 * and the .crbl artifact name/size. The resolved plan (2026-07-04 decision:
 * cloud artifacts REGENERATE deterministically from stored pack definitions; the
 * bytes are NEVER persisted in KV) means the record + the pack definition are
 * enough to rebuild the identical .crbl on demand - so the record never carries
 * the archive bytes.
 *
 * DEPLOYED status is NOT tracked here: it is truth from the Cribl packs API
 * (see install.ts), never from a local flag.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { PipelinePlan } from "../pipeline-generation";

/** A persistable record of one pack build. */
export interface PackBuildRecord {
  /** Unique build id: `{packName}_{version}` (sanitized). */
  id: string;
  packName: string;
  displayName: string;
  version: string;
  solutionName: string;
  /** Caller-supplied deterministic build timestamp (ms). */
  builtAtMs: number;
  /** Destination Sentinel tables this pack targets (deduplicated). */
  tables: string[];
  /** The .crbl artifact filename. */
  crblFileName: string;
  /** Size of the built .crbl in bytes. */
  crblSizeBytes: number;
}

/** Sanitize a `{name}_{version}` stem the way the legacy .crbl namer did. */
function sanitizeStem(stem: string): string {
  return stem.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/** The build record id for a pack name + version. */
export function buildRecordId(packName: string, version: string): string {
  return sanitizeStem(`${packName}_${version}`);
}

/**
 * The .crbl filename for a pack name + version (legacy packagePack naming,
 * pack-builder.ts 1536): `{name}_{version}.crbl` with disallowed characters
 * replaced by `-`.
 */
export function crblFileName(packName: string, version: string): string {
  return `${sanitizeStem(`${packName}_${version}`)}.crbl`;
}

/** Build a persistable record from a resolved plan + build metadata. */
export function makeBuildRecord(
  plan: PipelinePlan,
  meta: { builtAtMs: number; crblSizeBytes: number; displayName?: string },
): PackBuildRecord {
  return {
    id: buildRecordId(plan.packName, plan.version),
    packName: plan.packName,
    displayName: meta.displayName ?? plan.packName,
    version: plan.version,
    solutionName: plan.solutionName,
    builtAtMs: meta.builtAtMs,
    tables: [...new Set(plan.tables.map((t) => t.sentinelTable))],
    crblFileName: crblFileName(plan.packName, plan.version),
    crblSizeBytes: meta.crblSizeBytes,
  };
}

/**
 * Apply per-pack retention: keep the newest `keepPerPack` records for each pack
 * name (by builtAtMs, then version as a stable tiebreak), evicting the rest.
 * Returns the kept and removed sets. Pure - the caller persists the result.
 */
export function applyRetention(
  records: PackBuildRecord[],
  keepPerPack: number,
): { kept: PackBuildRecord[]; removed: PackBuildRecord[] } {
  if (keepPerPack < 1) {
    return { kept: [], removed: [...records] };
  }
  const byPack = new Map<string, PackBuildRecord[]>();
  for (const r of records) {
    const group = byPack.get(r.packName) ?? [];
    group.push(r);
    byPack.set(r.packName, group);
  }
  const kept: PackBuildRecord[] = [];
  const removed: PackBuildRecord[] = [];
  for (const group of byPack.values()) {
    const sorted = [...group].sort((a, b) =>
      b.builtAtMs !== a.builtAtMs
        ? b.builtAtMs - a.builtAtMs
        : b.version < a.version
          ? -1
          : b.version > a.version
            ? 1
            : 0,
    );
    kept.push(...sorted.slice(0, keepPerPack));
    removed.push(...sorted.slice(keepPerPack));
  }
  return { kept, removed };
}
