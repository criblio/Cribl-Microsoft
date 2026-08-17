/**
 * analyzeSiemExport usecase (porting-plan Unit 26): the IO half of the SIEM
 * Migration analyzer - parse (pure), identify, and fuzzy-map against LIVE
 * Sentinel solution names over the SentinelContent port.
 *
 * ENRICHMENT IS LAZY (live regression 2026-07-14: the eager per-solution
 * rule fetch stalled the analyze on "running" for minutes - a demo export
 * mapping to many solutions meant hundreds of SEQUENTIAL proxied GitHub
 * reads; the legacy read a local repo clone). {@link analyzeSiemExport}
 * performs exactly ONE content call (listSolutions, for the fuzzy tier) and
 * returns immediately; callers enrich ONE solution at a time on demand via
 * {@link fetchSolutionAnalyticRules} + the pure enrichPlanWithAnalyticRules
 * fold, with per-solution progress in the UI.
 *
 * GRACEFUL DEGRADATION: an absent content port or an unreachable GitHub
 * never fails the analysis - the plan simply skips the fuzzy tier, exactly
 * as the legacy degraded when the repo clone was not ready.
 *
 * Pure orchestration over the ports: no IO of its own.
 */

import {
  assembleMigrationPlan,
  parseSiemExport,
} from "../../domain/siem-migration/index";
import type {
  MigrationPlan,
  SentinelAnalyticRuleMatch,
  SiemPlatform,
} from "../../domain/siem-migration/index";
import { parseAnalyticRuleYaml } from "../../domain/coverage-analysis/index";
// The rule-directory variants and the YAML predicate live in the
// sentinel-content domain now. They used to be restated here with a comment
// saying ui's copies "cannot be imported" - true, but the knowledge was never
// ui's to own (audit finding 1, 2026-08-17).
import {
  ANALYTIC_RULE_DIR_VARIANTS,
  isRuleYamlFileName,
} from "../../domain/sentinel-content/index";
import type { SentinelContent } from "../../ports/sentinel-content";
import type { Logger } from "../../ports/logger";

/** The ports {@link analyzeSiemExport} orchestrates. */
export interface AnalyzeSiemExportPorts {
  /**
   * OPTIONAL lazy Sentinel content (Unit 14). Absent = the static knowledge
   * bases still map; the fuzzy tier is skipped.
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
 * Rule YAMLs analysed per solution here.
 *
 * This used to carry the comment "matches rule-coverage's cap". It does not,
 * and never did (audit 2026-08-17): rule-coverage reads up to its
 * RULE_DECODE_CAP of 150 rule files, and the 40 below happens to match its
 * UNRELATED parser cap. So a solution with more than 40 rules is analysed in
 * full by the coverage screen and truncated here, and the two report different
 * coverage for the same solution with nothing saying why.
 *
 * Left at 40 rather than quietly raised to 150: which bound is right is a
 * product question about how much a migration analysis should read, not a
 * defect to paper over by picking the larger number. Recorded in the backlog.
 */
const RULE_FILE_CAP = 40;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Analyze a SIEM export: parse, identify + merge, and fuzzy-map against the
 * live solution list (ONE content call). Analytics-rule enrichment is NOT
 * performed here - it is per-solution and on demand
 * ({@link fetchSolutionAnalyticRules}), so a large export renders its plan
 * immediately instead of stalling behind hundreds of sequential reads.
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
      ports.logger?.warn(
        "siem-migration: solution listing failed (fuzzy tier skipped)",
        { error: errText(err) },
      );
    }
  }

  return assembleMigrationPlan({
    rules,
    platform: input.platform,
    fileName: input.fileName,
    solutionNames,
  });
}

/**
 * Fetch ONE solution's analytics rules through the content port: fuzzy-match
 * the plan's solution name to an actual solution directory (the legacy
 * normalized-containment rule), then read its rule YAMLs from the first
 * rule-directory variant that yields files, capped at {@link RULE_FILE_CAP}.
 * Resolves [] when the solution cannot be matched or carries no rules;
 * REJECTS on a read failure so the caller can surface it (the analysis
 * itself is unaffected - enrichment is per solution and on demand).
 *
 * `onProgress` (optional) reports (read, total) as each YAML lands - the
 * per-card progress line.
 */
export async function fetchSolutionAnalyticRules(
  content: SentinelContent,
  solutionDirNames: readonly string[],
  solutionName: string,
  onProgress?: (read: number, total: number) => void,
): Promise<SentinelAnalyticRuleMatch[]> {
  const target = normName(solutionName);
  const dirName = solutionDirNames.find((n) => {
    const k = normName(n);
    return k === target || k.includes(target) || target.includes(k);
  });
  if (dirName === undefined) {
    return [];
  }
  const matches: SentinelAnalyticRuleMatch[] = [];
  for (const variant of ANALYTIC_RULE_DIR_VARIANTS) {
    const files = await content.listSolutionFiles(dirName, variant);
    const yamls = files.filter((f) => isRuleYamlFileName(f.name)).slice(0, RULE_FILE_CAP);
    if (yamls.length === 0) continue;
    let read = 0;
    for (const file of yamls) {
      const text = await content.readFile(file.path);
      read++;
      onProgress?.(read, yamls.length);
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
  return matches;
}
