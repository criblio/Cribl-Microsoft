/**
 * SIEM Migration screen state (porting-plan Unit 26, GUI-22) - the PURE
 * projections behind the screen, kept out of the component so the tile
 * derivation, the mapped/unmapped split, and the persistence key contract
 * are unit-testable without a DOM.
 *
 * PERSISTENCE (the "bounce back and forth" requirement): the analyzed
 * MigrationPlan persists under {@link SIEM_MIGRATION_PLAN_KEY} through the
 * ContentCache port (the integrate screen's selected-solution convention:
 * a plain ~v1 key), so navigating away and back - including the pivot into
 * Sentinel Integration - restores the full analysis instead of losing it.
 *
 * Pure: no IO, no fetch, no React.
 */

import type { IdentifiedDataSource, MigrationPlan } from "@soc/core";

/** The plain persistence key for the analyzed plan (ContentCache port). */
export const SIEM_MIGRATION_PLAN_KEY = "siem-migration-plan~v1";

/** One stat tile of the results header. */
export interface MigrationStatTile {
  key: string;
  label: string;
  value: number;
  tone: "neutral" | "ok" | "warn" | "info";
}

/** The five legacy stat tiles, tones matching the legacy report colors. */
export function migrationStatTiles(plan: MigrationPlan): MigrationStatTile[] {
  const mapped = mappedSources(plan).length;
  const unmapped = unmappedSources(plan).length;
  return [
    { key: "rules", label: "Detection Rules", value: plan.totalRules, tone: "neutral" },
    { key: "sources", label: "Data Sources", value: plan.dataSources.length, tone: "neutral" },
    { key: "mapped", label: "Mapped", value: mapped, tone: mapped > 0 ? "ok" : "neutral" },
    { key: "unmapped", label: "Unmapped", value: unmapped, tone: unmapped > 0 ? "warn" : "neutral" },
    { key: "sentinel-rules", label: "Sentinel Rules", value: plan.totalSentinelRules, tone: "info" },
  ];
}

/** Data sources mapped to a Sentinel solution (the action cards). */
export function mappedSources(plan: MigrationPlan): IdentifiedDataSource[] {
  return plan.dataSources.filter((ds) => ds.sentinelSolution !== "");
}

/** Data sources no tier could map (the honest orange list). */
export function unmappedSources(plan: MigrationPlan): IdentifiedDataSource[] {
  return plan.dataSources.filter((ds) => ds.sentinelSolution === "");
}

/** Badge tone per mapping confidence (legacy color semantics). */
export function confidenceTone(
  confidence: IdentifiedDataSource["confidence"],
): "ok" | "info" | "warn" | "neutral" {
  switch (confidence) {
    case "high":
      return "ok";
    case "medium":
      return "info";
    case "low":
      return "warn";
    default:
      return "neutral";
  }
}

/** The identifier line of a solution card ("a, b, c +2"). */
export function identifierSummary(
  ds: IdentifiedDataSource,
  cap = 3,
): string {
  const shown = ds.platformIdentifiers.slice(0, cap).join(", ");
  const extra = ds.platformIdentifiers.length - cap;
  return extra > 0 ? `${shown} +${extra}` : shown;
}
