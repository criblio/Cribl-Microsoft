/**
 * analyzeSiemExport usecase (porting-plan Unit 26): the IO half of the SIEM
 * Migration analyzer - parse (pure), identify + fuzzy-map against LIVE
 * Sentinel solution names, then enrich each mapped solution with its actual
 * analytics rules, all over the SentinelContent port (the legacy read a
 * local full-repo mirror; this reads lazily per solution, capped).
 *
 * GRACEFUL DEGRADATION: an absent content port, an unreachable GitHub, or a
 * failed per-solution read never fails the analysis - the plan simply skips
 * the fuzzy tier and/or ships without enrichment for that solution, exactly
 * as the legacy degraded when the repo clone was not ready.
 *
 * Pure orchestration over the ports: no IO of its own.
 */

import {
  assembleMigrationPlan,
  enrichPlanWithAnalyticRules,
  parseSiemExport,
} from "../../domain/siem-migration/index";
import type {
  MigrationPlan,
  SentinelAnalyticRuleMatch,
  SiemPlatform,
} from "../../domain/siem-migration/index";
import { parseAnalyticRuleYaml } from "../../domain/coverage-analysis/index";
import type { SentinelContent } from "../../ports/sentinel-content";
import type { Logger } from "../../ports/logger";

/** The ports {@link analyzeSiemExport} orchestrates. */
export interface AnalyzeSiemExportPorts {
  /**
   * OPTIONAL lazy Sentinel content (Unit 14). Absent = the static knowledge
   * bases still map; the fuzzy tier and rule enrichment are skipped.
   */
  content?: SentinelContent;
  /** Optional diagnostics (absent = no-op). */
  logger?: Logger;
}

/** Input for {@link analyzeSiemExport}. */
export interface AnalyzeSiemExportInput {
  /** The raw export text (Splunk JSON or QRadar CSV). */
  content: string;
  platform: SiemPlatform;
  fileName: string;
}

/**
 * The rule-directory variants tried in order under a solution (first that
 * yields files wins) - mirrors @soc/ui's ANALYTIC_RULE_DIR_VARIANTS, which
 * cannot be imported here (core never depends on ui).
 */
const RULE_DIR_VARIANTS: readonly string[] = [
  "Analytic Rules",
  "Analytics Rules",
  "AnalyticRules",
];

/** Bound on rule YAMLs read per solution (matches rule-coverage's cap). */
const RULE_FILE_CAP = 40;

/** Bound on solutions enriched per analysis (an 1800-rule export maps many). */
const SOLUTION_ENRICH_CAP = 20;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRuleYaml(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

/**
 * Analyze a SIEM export end to end: parse, identify + merge, fuzzy-map
 * against live solution names, and enrich mapped solutions with their
 * Sentinel analytics rules.
 */
export async function analyzeSiemExport(
  ports: AnalyzeSiemExportPorts,
  input: AnalyzeSiemExportInput,
): Promise<MigrationPlan> {
  const rules = parseSiemExport(input.content, input.platform);
  ports.logger?.info("siem-migration: parsed export", {
    platform: input.platform,
    rules: rules.length,
  });

  let solutionNames: string[] = [];
  if (ports.content !== undefined) {
    try {
      solutionNames = (await ports.content.listSolutions()).map((s) => s.name);
    } catch (err) {
      ports.logger?.warn("siem-migration: solution listing failed (fuzzy tier skipped)", {
        error: errText(err),
      });
    }
  }

  const plan = assembleMigrationPlan({
    rules,
    platform: input.platform,
    fileName: input.fileName,
    solutionNames,
  });

  if (ports.content === undefined || solutionNames.length === 0) {
    return plan;
  }

  // Enrichment: per unique mapped solution (capped), fuzzy-match the plan's
  // solution name to an actual solution directory, then read its rule YAMLs
  // through the port (first rule-directory variant that yields files).
  const uniqueSolutions = [
    ...new Set(
      plan.dataSources
        .filter((ds) => ds.sentinelSolution !== "")
        .map((ds) => ds.sentinelSolution),
    ),
  ];
  const skipped = uniqueSolutions.length - SOLUTION_ENRICH_CAP;
  if (skipped > 0) {
    ports.logger?.warn("siem-migration: enrichment capped", {
      solutions: uniqueSolutions.length,
      cap: SOLUTION_ENRICH_CAP,
    });
  }

  const rulesBySolution = new Map<string, SentinelAnalyticRuleMatch[]>();
  for (const solution of uniqueSolutions.slice(0, SOLUTION_ENRICH_CAP)) {
    const target = normName(solution);
    const dirName = solutionNames.find((n) => {
      const k = normName(n);
      return k === target || k.includes(target) || target.includes(k);
    });
    if (dirName === undefined) {
      rulesBySolution.set(solution.toLowerCase(), []);
      continue;
    }
    const matches: SentinelAnalyticRuleMatch[] = [];
    try {
      for (const variant of RULE_DIR_VARIANTS) {
        const files = await ports.content.listSolutionFiles(dirName, variant);
        const yamls = files.filter((f) => isRuleYaml(f.name)).slice(0, RULE_FILE_CAP);
        if (yamls.length === 0) continue;
        for (const file of yamls) {
          const text = await ports.content.readFile(file.path);
          if (text === null) continue;
          const parsed = parseAnalyticRuleYaml(text, file.name);
          matches.push({
            name: parsed.name,
            severity: parsed.severity,
            tactics: parsed.tactics,
            query: parsed.query,
          });
        }
        break; // first variant that yielded files (the legacy first-dir rule)
      }
    } catch (err) {
      ports.logger?.warn("siem-migration: rule enrichment failed for a solution", {
        solution: dirName,
        error: errText(err),
      });
    }
    rulesBySolution.set(solution.toLowerCase(), matches);
  }

  return enrichPlanWithAnalyticRules(plan, rulesBySolution);
}
