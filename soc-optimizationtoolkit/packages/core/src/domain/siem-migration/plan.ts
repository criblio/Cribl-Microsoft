/**
 * SIEM Migration plan assembly (porting-plan Unit 26): data-source
 * identification + same-solution merging, the pure fuzzy solution mapper,
 * the MITRE rollup, and the MigrationPlan builder - ported from the legacy
 * siem-migration.ts (lines 443-723) with the two Unit-26 decisions applied:
 *
 *  - THE NORMALIZATION FIX: the legacy identify pass keyed sources with
 *    [^a-z0-9.] while the unmapped-rules check used [^a-z0-9], so dotted
 *    identifiers never matched their own key and inflated unmappedRules.
 *    {@link normalizeSourceKey} is now the ONE normalization both sides use
 *    (pinned).
 *  - PERSISTENCE CAP: unmapped rules carry a rawSearch EXCERPT
 *    (MIGRATION_RAW_SEARCH_CAP) because the plan persists to a plain KV
 *    entry; the UI and report only render names + data sources.
 *
 * Enrichment (Sentinel analytics rules per solution) is IO and lives in the
 * analyze-siem-export usecase; {@link enrichPlanWithAnalyticRules} is the
 * pure fold it applies.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  QRADAR_EXTENSION_MAP,
  SPLUNK_DATAMODEL_MAP,
  SPLUNK_MACRO_MAP,
  SPLUNK_SKIP_MACROS,
  resolveSplunkMacro,
} from "./knowledge-bases";
import { MIGRATION_RAW_SEARCH_CAP } from "./models";
import type {
  IdentifiedDataSource,
  MigrationConfidence,
  MigrationPlan,
  MitreTacticCoverage,
  ParsedRule,
  SentinelAnalyticRuleMatch,
  SiemPlatform,
} from "./models";

/**
 * The ONE data-source key normalization (the legacy fork between
 * [^a-z0-9.] and [^a-z0-9] is the pinned Unit-26 bug fix). Dots survive so
 * dotted identifiers stay distinct; everything else foreign collapses to _.
 */
export function normalizeSourceKey(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9.]/g, "_");
}

const CONFIDENCE_ORDER: Record<MigrationConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/**
 * Group rules by data-source identifier, resolve each to a Sentinel
 * solution/table (static map, then prefix map, then datamodel map), and
 * MERGE sources resolving to the same solution into one entry (kube_audit +
 * kube_container_falco -> one "Azure Kubernetes Service"). Sorted by rule
 * count, descending.
 */
export function identifyDataSources(
  rules: readonly ParsedRule[],
  platform: SiemPlatform,
): IdentifiedDataSource[] {
  const sourceMap = new Map<
    string,
    { rawId: string; rules: Set<string>; tactics: Set<string>; techniques: Set<string> }
  >();

  for (const rule of rules) {
    if (!rule.isRule && platform === "qradar") continue;

    for (const ds of rule.dataSources) {
      if (!ds) continue;
      if (platform === "splunk") {
        const mapped = SPLUNK_MACRO_MAP[ds];
        if (mapped && !mapped.solution) continue; // Splunk internal
        if (SPLUNK_SKIP_MACROS.has(ds)) continue;
      }

      const key = normalizeSourceKey(ds);
      const existing =
        sourceMap.get(key) ??
        { rawId: ds, rules: new Set<string>(), tactics: new Set<string>(), techniques: new Set<string>() };
      existing.rules.add(rule.name);
      rule.mitreTactics.forEach((t) => existing.tactics.add(t));
      rule.mitreTechniques.forEach((t) => existing.techniques.add(t));
      sourceMap.set(key, existing);
    }
  }

  const dataSources: IdentifiedDataSource[] = [];
  for (const [key, data] of sourceMap) {
    const rawId = data.rawId;
    let sentinelSolution = "";
    let sentinelTable = "";
    let confidence: MigrationConfidence = "none";

    if (platform === "splunk") {
      const resolved = resolveSplunkMacro(rawId) ?? SPLUNK_DATAMODEL_MAP[rawId];
      if (resolved?.solution) {
        sentinelSolution = resolved.solution;
        sentinelTable = resolved.table;
        confidence = SPLUNK_MACRO_MAP[rawId] ? "high" : "medium";
      }
    } else {
      const resolved = QRADAR_EXTENSION_MAP[rawId];
      if (resolved?.solution) {
        sentinelSolution = resolved.solution;
        sentinelTable = resolved.table;
        confidence = "high";
      } else if (!rawId.startsWith("extension:")) {
        // The QRadar parser already resolved this extension to its solution
        // name at parse time; recover the table via reverse lookup so the
        // mapping is deterministic WITHOUT the fuzzy tier (the legacy left
        // these 'none' and relied on the live-repo fuzzy map to rescue them).
        const target = Object.values(QRADAR_EXTENSION_MAP).find(
          (t) => t.solution === rawId,
        );
        sentinelSolution = rawId;
        sentinelTable = target?.table ?? "";
        confidence = "high";
      }
    }

    dataSources.push({
      id: key,
      name: rawId,
      platform,
      platformIdentifiers: [rawId],
      ruleCount: data.rules.size,
      rules: [...data.rules],
      mitreTactics: [...data.tactics].sort(),
      mitreTechniques: [...data.techniques].sort(),
      sentinelSolution,
      sentinelTable,
      confidence,
      sentinelAnalyticRules: [],
    });
  }

  // Merge same-solution sources into one entry; unmapped stay separate.
  const mergedMap = new Map<string, IdentifiedDataSource>();
  for (const ds of dataSources) {
    const mergeKey = ds.sentinelSolution
      ? ds.sentinelSolution.toLowerCase().trim()
      : ds.id;

    const existing = mergedMap.get(mergeKey);
    if (existing) {
      existing.platformIdentifiers.push(...ds.platformIdentifiers);
      for (const r of ds.rules) {
        if (!existing.rules.includes(r)) existing.rules.push(r);
      }
      for (const t of ds.mitreTactics) {
        if (!existing.mitreTactics.includes(t)) existing.mitreTactics.push(t);
      }
      for (const t of ds.mitreTechniques) {
        if (!existing.mitreTechniques.includes(t)) existing.mitreTechniques.push(t);
      }
      if (!existing.sentinelTable && ds.sentinelTable) {
        existing.sentinelTable = ds.sentinelTable;
      }
      if (CONFIDENCE_ORDER[ds.confidence] > CONFIDENCE_ORDER[existing.confidence]) {
        existing.confidence = ds.confidence;
      }
    } else {
      mergedMap.set(mergeKey, { ...ds, platformIdentifiers: [...ds.platformIdentifiers] });
    }
  }

  const merged = [...mergedMap.values()];
  for (const ds of merged) {
    ds.rules = [...new Set(ds.rules)];
    ds.ruleCount = ds.rules.length;
    ds.mitreTactics.sort();
    ds.mitreTechniques.sort();
  }

  merged.sort((a, b) => b.ruleCount - a.ruleCount);
  return merged;
}

/**
 * Fuzzy-map still-unmapped data sources against live Sentinel solution
 * names (tier 2). PURE: returns new entries, never mutates the input.
 * Exact/substring normalized match = high/medium; a >=2-word partial (or a
 * single meaningful word) = low.
 */
export function applyFuzzySolutionMap(
  dataSources: readonly IdentifiedDataSource[],
  solutionNames: readonly string[],
): IdentifiedDataSource[] {
  if (solutionNames.length === 0) {
    return dataSources.map((ds) => ({ ...ds }));
  }
  return dataSources.map((ds) => {
    if (ds.confidence !== "none") return { ...ds };

    const out = { ...ds };
    const searchName = ds.name.toLowerCase().replace(/[^a-z0-9]/g, "");

    for (const sol of solutionNames) {
      const solLower = sol.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        solLower === searchName ||
        solLower.includes(searchName) ||
        searchName.includes(solLower)
      ) {
        out.sentinelSolution = sol;
        out.confidence = searchName === solLower ? "high" : "medium";
        return out;
      }
    }

    const words = ds.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    for (const sol of solutionNames) {
      const solLower = sol.toLowerCase();
      const matchCount = words.filter((w) => solLower.includes(w)).length;
      if (matchCount >= 2 || (words.length === 1 && matchCount === 1)) {
        out.sentinelSolution = sol;
        out.confidence = "low";
        return out;
      }
    }
    return out;
  });
}

/** Tactic -> {techniqueCount, ruleCount} rollup, sorted by rule count. */
export function buildMitreCoverage(
  rules: readonly ParsedRule[],
): MitreTacticCoverage[] {
  const tacticMap = new Map<string, { techniques: Set<string>; ruleCount: number }>();

  for (const rule of rules) {
    for (const tactic of rule.mitreTactics) {
      if (!tactic || tactic === "None") continue;
      const existing = tacticMap.get(tactic) ?? { techniques: new Set<string>(), ruleCount: 0 };
      existing.ruleCount++;
      for (const tech of rule.mitreTechniques) {
        if (tech && tech !== "None") existing.techniques.add(tech);
      }
      tacticMap.set(tactic, existing);
    }
  }

  return [...tacticMap.entries()]
    .map(([tactic, data]) => ({
      tactic,
      techniqueCount: data.techniques.size,
      ruleCount: data.ruleCount,
    }))
    .sort((a, b) => b.ruleCount - a.ruleCount);
}

/** Cap a rule's rawSearch for the persisted plan. */
function capRawSearch(rule: ParsedRule): ParsedRule {
  if (rule.rawSearch.length <= MIGRATION_RAW_SEARCH_CAP) {
    return { ...rule };
  }
  return { ...rule, rawSearch: `${rule.rawSearch.slice(0, MIGRATION_RAW_SEARCH_CAP)}...` };
}

/** Inputs for {@link assembleMigrationPlan}. */
export interface AssembleMigrationPlanInput {
  rules: readonly ParsedRule[];
  platform: SiemPlatform;
  fileName: string;
  /** Live Sentinel solution names for the tier-2 fuzzy map ([] = skip). */
  solutionNames?: readonly string[];
}

/**
 * Assemble the full plan from parsed rules: identify + merge, fuzzy-map,
 * unmapped-rule detection (through the ONE normalizeSourceKey), and the
 * MITRE rollup. Analytics-rule enrichment (IO) is applied afterwards by the
 * usecase via {@link enrichPlanWithAnalyticRules}.
 */
export function assembleMigrationPlan(
  input: AssembleMigrationPlanInput,
): MigrationPlan {
  const { rules, platform, fileName } = input;

  const identified = identifyDataSources(rules, platform);
  const dataSources = applyFuzzySolutionMap(identified, input.solutionNames ?? []);

  // Rules whose EVERY data source failed to resolve. Same normalization as
  // the identify pass - the pinned fix (see the module header).
  const mappedSourceIds = new Set(
    dataSources.filter((ds) => ds.sentinelSolution).map((ds) => ds.id),
  );
  const mappedIdentifiers = new Set(
    dataSources
      .filter((ds) => ds.sentinelSolution)
      .flatMap((ds) => ds.platformIdentifiers.map(normalizeSourceKey)),
  );
  const unmappedRules = rules
    .filter(
      (r) =>
        r.isRule &&
        r.dataSources.every((ds) => {
          const key = normalizeSourceKey(ds);
          return !mappedSourceIds.has(key) && !mappedIdentifiers.has(key);
        }),
    )
    .map(capRawSearch);

  const actualRules = rules.filter((r) => r.isRule);
  const buildingBlocks = rules.filter((r) => !r.isRule);

  return {
    platform,
    fileName,
    totalRules: actualRules.length,
    enabledRules: actualRules.filter((r) => r.enabled).length,
    buildingBlocks: buildingBlocks.length,
    dataSources,
    unmappedRules,
    mitreCoverage: buildMitreCoverage(actualRules),
    totalSentinelRules: 0,
  };
}

/**
 * Fold per-solution Sentinel analytics rules into the plan (pure; the
 * usecase fetches them). Keys are LOWERCASED solution names. Each solution
 * counts once toward totalSentinelRules, matching the legacy count.
 */
export function enrichPlanWithAnalyticRules(
  plan: MigrationPlan,
  rulesBySolution: ReadonlyMap<string, SentinelAnalyticRuleMatch[]>,
): MigrationPlan {
  const counted = new Set<string>();
  let totalSentinelRules = 0;
  const dataSources = plan.dataSources.map((ds) => {
    if (!ds.sentinelSolution) return { ...ds };
    const key = ds.sentinelSolution.toLowerCase();
    const matches = rulesBySolution.get(key) ?? [];
    if (!counted.has(key)) {
      counted.add(key);
      totalSentinelRules += matches.length;
    }
    return { ...ds, sentinelAnalyticRules: matches };
  });
  return { ...plan, dataSources, totalSentinelRules };
}
