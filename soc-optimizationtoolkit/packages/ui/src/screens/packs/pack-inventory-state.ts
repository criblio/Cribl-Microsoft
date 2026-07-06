/**
 * Pack inventory state - the PURE decision layer behind the ONE merged pack
 * inventory screen (porting-plan Unit 19, GUI-19/20 folded). Kept out of the
 * component so the inventory projection, the deployed-badge derivation, the
 * scoped delete-id validation, the regenerate-vs-cached choice, and the
 * storage/retention summary are unit-testable without a DOM.
 *
 * @soc/core owns the install/deploy TRUTH: {@link deployedGroups} derives which
 * worker groups a pack (by name) is installed on from each group's LIVE packs
 * list, and {@link applyRetention} is the per-pack keep-newest policy. This
 * module only projects those into rows the screen renders and enforces the
 * screen's own guards.
 *
 * DELETE VALIDATION (task item B): a delete targets a build RECORD by its id -
 * there is NO path semantics. {@link validateDeleteId} rejects anything
 * path-like and requires the id to be a KNOWN record (never a filesystem path),
 * so a bad caller fails loudly and no traversal is possible.
 *
 * REGENERATE-VS-CACHED (the 2026-07-04 decision): cloud stores the pack
 * DEFINITION and regenerates bytes deterministically (no archive bytes in KV);
 * local may cache the bytes. {@link resolveBytesSource} is that pure choice.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto, no Math.random. Deployed
 * status flows in as a fetched snapshot; time/format come in as inputs.
 */

import { applyRetention, deployedGroups } from "@soc/core";
import type { PackBuildRecord } from "@soc/core";
import type { DeployedGroupPacks, StoredPack } from "../../ports-context";

// ---------------------------------------------------------------------------
// Inventory projection
// ---------------------------------------------------------------------------

/** One rendered inventory row: a build record plus its live deployed groups. */
export interface PackInventoryRow {
  /** Build record id (`{packName}_{version}` sanitized) - the delete/select key. */
  id: string;
  packName: string;
  displayName: string;
  version: string;
  solutionName: string;
  /** Caller-supplied build timestamp (ms); the screen formats it. */
  builtAtMs: number;
  /** Destination Sentinel tables this pack targets. */
  tables: string[];
  crblFileName: string;
  crblSizeBytes: number;
  /**
   * Worker groups this pack (matched by NAME) is currently installed on, from
   * the live packs API - the deployed-status truth, never a persisted flag.
   */
  deployedGroups: string[];
  /** Whether the .crbl will be regenerated (no cached bytes) or served cached. */
  bytesSource: BytesSource["kind"];
}

/**
 * Project the stored packs + a fetched deployed snapshot into rendered rows,
 * newest build first (then version, descending, as a stable tiebreak). A pack
 * is "deployed" on a group when a pack with the SAME NAME appears in that
 * group's live packs list (core {@link deployedGroups} matches the Cribl pack
 * id, which is the pack name).
 */
export function deriveInventoryRows(
  packs: readonly StoredPack[],
  groupPacks: readonly DeployedGroupPacks[],
): PackInventoryRow[] {
  const groups = [...groupPacks];
  return packs
    .map((p): PackInventoryRow => {
      const r = p.record;
      return {
        id: r.id,
        packName: r.packName,
        displayName: r.displayName,
        version: r.version,
        solutionName: r.solutionName,
        builtAtMs: r.builtAtMs,
        tables: [...r.tables],
        crblFileName: r.crblFileName,
        crblSizeBytes: r.crblSizeBytes,
        deployedGroups: deployedGroups(r.packName, groups),
        bytesSource: resolveBytesSource(p).kind,
      };
    })
    .sort((a, b) =>
      b.builtAtMs !== a.builtAtMs
        ? b.builtAtMs - a.builtAtMs
        : b.version < a.version
          ? -1
          : b.version > a.version
            ? 1
            : 0,
    );
}

// ---------------------------------------------------------------------------
// Deployed-badge derivation
// ---------------------------------------------------------------------------

/** The rendered deployed-badge for one row. */
export interface DeployedBadge {
  /** True when the pack is installed on at least one worker group. */
  deployed: boolean;
  /** How many worker groups it is installed on. */
  count: number;
  /** The badge sentence (verbatim inventory vocabulary). */
  label: string;
  /** Tone hint for styling (never a color literal here). */
  tone: "deployed" | "not-deployed";
}

/** Derive the deployed-badge for a row from its (already-derived) group list. */
export function deriveDeployedBadge(row: PackInventoryRow): DeployedBadge {
  const count = row.deployedGroups.length;
  if (count === 0) {
    return {
      deployed: false,
      count: 0,
      label: "Not deployed",
      tone: "not-deployed",
    };
  }
  return {
    deployed: true,
    count,
    label: `Deployed on ${count} group${count === 1 ? "" : "s"}: ${row.deployedGroups.join(", ")}`,
    tone: "deployed",
  };
}

// ---------------------------------------------------------------------------
// Scoped delete-id validation (no path semantics)
// ---------------------------------------------------------------------------

/** The result of validating a delete target id. */
export type DeleteIdCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a delete target. A delete addresses a build RECORD by its id - it is
 * NOT a filesystem path. The id must be non-empty, must carry no path syntax
 * (no `/`, `\`, `..`, or NUL), and must name a record actually present in the
 * inventory. This is the scoped-record-id guard the task requires: it makes
 * traversal impossible and a stale/unknown id fail loudly instead of deleting
 * something unexpected.
 */
export function validateDeleteId(
  id: string,
  packs: readonly StoredPack[],
): DeleteIdCheck {
  if (id === "") {
    return { ok: false, error: "No pack selected to delete." };
  }
  if (/[/\\]/.test(id) || id.includes("..") || id.includes("\0")) {
    return {
      ok: false,
      error: `Refusing to delete '${id}': a pack id is a record id, not a path.`,
    };
  }
  if (!packs.some((p) => p.record.id === id)) {
    return {
      ok: false,
      error: `No pack build with id '${id}' in the inventory - refresh and retry.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Regenerate-vs-cached choice
// ---------------------------------------------------------------------------

/** Where a row's .crbl bytes come from when the operator downloads/installs. */
export type BytesSource =
  /** Regenerate deterministically from the stored pack definition. */
  | { kind: "regenerate" }
  /** Serve the cached base64 bytes verbatim. */
  | { kind: "cached"; base64: string };

/**
 * Choose how to obtain a stored pack's .crbl bytes: serve the cached bytes when
 * present and non-empty (local only), otherwise regenerate deterministically
 * from the definition (cloud always lands here - it never persists bytes). Pure
 * so the choice is testable and identical across shells.
 */
export function resolveBytesSource(pack: StoredPack): BytesSource {
  const cached = pack.cachedCrblBase64;
  if (typeof cached === "string" && cached !== "") {
    return { kind: "cached", base64: cached };
  }
  return { kind: "regenerate" };
}

// ---------------------------------------------------------------------------
// Storage / retention summary
// ---------------------------------------------------------------------------

/** The storage + retention summary shown above the inventory list. */
export interface StorageSummary {
  /** Total stored build records. */
  totalPacks: number;
  /** Distinct pack names. */
  distinctNames: number;
  /** Sum of the stored .crbl sizes (bytes). */
  totalBytes: number;
  /** Record ids retained under the keep-newest-per-pack policy. */
  retainedIds: string[];
  /** Record ids the policy would evict (older than keepPerPack for their name). */
  evictableIds: string[];
}

/**
 * Summarize storage and the per-pack retention policy over the stored packs.
 * Retention reuses core {@link applyRetention} (keep the newest `keepPerPack`
 * builds per pack name) so the inventory's eviction preview matches exactly
 * what a retention sweep would remove. Pure - the caller decides whether to act
 * on `evictableIds`.
 */
export function deriveStorageSummary(
  packs: readonly StoredPack[],
  keepPerPack: number,
): StorageSummary {
  const records: PackBuildRecord[] = packs.map((p) => p.record);
  const { kept, removed } = applyRetention(records, keepPerPack);
  const names = new Set(records.map((r) => r.packName));
  return {
    totalPacks: records.length,
    distinctNames: names.size,
    totalBytes: records.reduce((sum, r) => sum + r.crblSizeBytes, 0),
    retainedIds: kept.map((r) => r.id),
    evictableIds: removed.map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Human-readable byte size (binary units), e.g. 786432 -> "768.0 KiB". */
export function formatCrblSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** One-line destination-tables summary for a row. */
export function tablesSummary(tables: readonly string[]): string {
  if (tables.length === 0) {
    return "no destination tables";
  }
  return `${tables.length} table${tables.length === 1 ? "" : "s"}: ${tables.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Empty-state reason when no builds have been recorded yet. */
export const PACK_INVENTORY_EMPTY_REASON =
  "No packs built yet. Build a pack from the Integrate flow; each build is " +
  "recorded here with its destination tables, size, and deployed status.";

/** Explains why the pack surface is unavailable (no store bound). */
export const PACK_INVENTORY_UNAVAILABLE_REASON =
  "The pack inventory is unavailable in this context - no pack store is " +
  "connected.";

/** The note under the storage/retention summary. */
export const PACK_RETENTION_NOTE =
  "Retention keeps the newest builds per pack name; older builds can be " +
  "deleted to reclaim space. Deployed status is read live from the Cribl " +
  "packs API, not from this list.";
