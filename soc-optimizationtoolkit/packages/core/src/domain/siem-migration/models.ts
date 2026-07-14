/**
 * SIEM Migration models (porting-plan Unit 26, ENG-40): the typed shapes of
 * the migration analyzer, ported from the legacy Electron app's
 * siem-migration.ts (deprecated/Cribl-Microsoft_IntegrationSolution/
 * src/main/ipc/siem-migration.ts lines 13-63) with one deliberate change:
 * the persisted plan CAPS each unmapped rule's rawSearch excerpt (the legacy
 * kept full SPL bodies in memory only; the rebuilt plan persists to a plain
 * KV entry, so a 1800-rule export must stay small).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** The SIEM platforms the analyzer understands. */
export type SiemPlatform = "splunk" | "qradar";

/** One detection rule parsed from a Splunk or QRadar export. */
export interface ParsedRule {
  name: string;
  platform: SiemPlatform;
  enabled: boolean;
  /** Normalized data source identifiers. */
  dataSources: string[];
  /** Splunk: backtick-wrapped macro names. */
  macros: string[];
  /** Splunk: datamodel references. */
  dataModels: string[];
  /** Splunk: sourcetype values. */
  sourcetypes: string[];
  /** QRadar: Content extension name. */
  contentExtension: string;
  /** QRadar: High-level.low-level category. */
  eventCategories: string[];
  mitreTactics: string[];
  mitreTechniques: string[];
  severity: string;
  description: string;
  /** Splunk: SPL query / QRadar: Test definition (capped in the plan). */
  rawSearch: string;
  /** QRadar: true = rule, false = building block. */
  isRule: boolean;
}

/** One Sentinel analytics rule matched to an identified data source. */
export interface SentinelAnalyticRuleMatch {
  name: string;
  severity: string;
  tactics: string[];
  /** KQL query for preview. */
  query: string;
}

/** Confidence of a data-source -> Sentinel-solution mapping. */
export type MigrationConfidence = "high" | "medium" | "low" | "none";

/** One identified data source - the migration plan's primary item. */
export interface IdentifiedDataSource {
  /** Normalized key. */
  id: string;
  /** Display name (the raw macro / extension / datamodel). */
  name: string;
  platform: SiemPlatform;
  /** Original macro/extension names merged into this entry. */
  platformIdentifiers: string[];
  ruleCount: number;
  /** Rule names referencing this source. */
  rules: string[];
  mitreTactics: string[];
  mitreTechniques: string[];
  /** Matched Sentinel solution name (empty = unmapped). */
  sentinelSolution: string;
  /** Destination table (e.g. CommonSecurityLog, Okta_CL). */
  sentinelTable: string;
  confidence: MigrationConfidence;
  /** Matched Sentinel analytics rules (enrichment; empty until enriched). */
  sentinelAnalyticRules: SentinelAnalyticRuleMatch[];
}

/** One tactic's MITRE coverage rollup. */
export interface MitreTacticCoverage {
  tactic: string;
  techniqueCount: number;
  ruleCount: number;
}

/** The full migration plan - what the screen renders and persists. */
export interface MigrationPlan {
  platform: SiemPlatform;
  fileName: string;
  totalRules: number;
  enabledRules: number;
  /** QRadar only. */
  buildingBlocks: number;
  dataSources: IdentifiedDataSource[];
  unmappedRules: ParsedRule[];
  mitreCoverage: MitreTacticCoverage[];
  /** Total matched Sentinel analytics rules across all sources. */
  totalSentinelRules: number;
}

/**
 * The rawSearch excerpt cap applied to the plan's unmappedRules (the plan
 * persists to a plain KV entry; full SPL bodies of an 1800-rule export would
 * blow the entry). The UI and report only render rule names + data sources.
 */
export const MIGRATION_RAW_SEARCH_CAP = 400;

/** Serialize a plan for the plain-KV persistence entry. */
export function serializeMigrationPlan(plan: MigrationPlan): string {
  return JSON.stringify(plan);
}

/**
 * Tolerantly parse a persisted plan: null for anything that is not a
 * plausible MigrationPlan (absent entry, corrupt JSON, foreign shape) so a
 * bad entry reads as "no saved plan", never a crash.
 */
export function parseMigrationPlan(raw: string | null): MigrationPlan | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const plan = parsed as Partial<MigrationPlan>;
  if (
    (plan.platform !== "splunk" && plan.platform !== "qradar") ||
    typeof plan.fileName !== "string" ||
    typeof plan.totalRules !== "number" ||
    !Array.isArray(plan.dataSources) ||
    !Array.isArray(plan.unmappedRules) ||
    !Array.isArray(plan.mitreCoverage)
  ) {
    return null;
  }
  return plan as MigrationPlan;
}
