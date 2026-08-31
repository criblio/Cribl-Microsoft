/**
 * Content-coverage ACQUISITION usecase (porting-plan Unit 23) - the port
 * orchestration that feeds the pure shared analyzer
 * (domain/coverage-analysis.analyzeContentCoverage). Two acquisition sources,
 * ONE engine:
 *
 *   - ALERT RULES via the Unit 14 SentinelContent port: list the solution's
 *     Analytic-Rules directory (the three dir-name variants, ANALYTIC_RULE_DIR_
 *     NAMES), read each YAML, parse it with the PINNED regex extraction, project
 *     to ContentItem. Replaces the legacy fs-mirror listAnalyticRules.
 *   - WORKBOOKS via the SAME SentinelContent port: list the solution's Workbooks
 *     directory, read each .json template (whose body IS the workbook document),
 *     defensively mine the buried KQL, project to ContentItem.
 *
 * BOTH SOURCES ARE THE SOLUTION REPO, and that is a decision rather than an
 * accident (user direction 2026-07-12). An ARM acquirer that enumerated the
 * SUBSCRIPTION's deployed workbooks was built here and DELETED 2026-08-31
 * (DBT-57) without ever having been called: a shared subscription carries
 * everyone's dashboards - a live report 2026-07-09 had FortiGate and Cisco
 * dashboards polluting a Zscaler review - and deployed copies drift from the
 * repo templates. Coverage describes the SOLUTION, so the repo is the source of
 * record for workbooks exactly as it already was for rules.
 *
 * Both yield the SAME ContentItem shape, so a caller can analyze rules alone,
 * workbooks alone, or both together through analyzeContentCoverage. This usecase
 * only ACQUIRES + projects; the coverage math stays in the pure domain.
 *
 * Pure orchestration over the ports: no IO of its own, no fetch, no React, no
 * Date/crypto. The IO lives entirely behind the injected adapters.
 */

import type { SentinelContent } from "../../ports/sentinel-content";
import type { Logger } from "../../ports/logger";
import { ANALYTIC_RULE_DIR_NAMES } from "../../domain/sentinel-content/discovery";
import {
  analyticRuleToContentItem,
  extractWorkbookQueries,
  parseAnalyticRuleYaml,
  workbookToContentItem,
} from "../../domain/coverage-analysis/index";
import type { ContentItem } from "../../domain/coverage-analysis/index";

// ---------------------------------------------------------------------------
// Alert-rule acquisition (SentinelContent port)
// ---------------------------------------------------------------------------

/**
 * Acquire a solution's analytic rules as {@link ContentItem}s. Tries each
 * Analytic-Rules directory-name variant in order and reads the .yaml/.yml files
 * from the FIRST variant that has any (mirroring the legacy first-match rule).
 * Unreadable files are skipped; a solution with no rules directory resolves to
 * `[]`. Never throws for a content miss - only a genuine transport failure from
 * the port propagates.
 */
export async function acquireAnalyticRules(
  content: SentinelContent,
  solutionName: string,
  logger?: Logger,
): Promise<ContentItem[]> {
  for (const dirName of ANALYTIC_RULE_DIR_NAMES) {
    const files = await content.listSolutionFiles(solutionName, dirName);
    const yamlFiles = files.filter(
      (f) => f.name.endsWith(".yaml") || f.name.endsWith(".yml"),
    );
    if (yamlFiles.length === 0) continue;

    const items: ContentItem[] = [];
    for (const file of yamlFiles) {
      const text = await content.readFile(file.path);
      if (text === null) {
        logger?.debug("coverage-analysis: rule file unreadable", {
          solution: solutionName,
          file: file.name,
        });
        continue;
      }
      const rule = parseAnalyticRuleYaml(text, file.name);
      items.push(analyticRuleToContentItem(rule, false));
    }
    logger?.info("coverage-analysis: acquired analytic rules", {
      solution: solutionName,
      dir: dirName,
      count: items.length,
    });
    return items;
  }
  logger?.debug("coverage-analysis: no analytic-rules directory", {
    solution: solutionName,
  });
  return [];
}

// ---------------------------------------------------------------------------
// Workbook acquisition (SentinelContent port - the solution's SHIPPED workbooks)
// ---------------------------------------------------------------------------

/**
 * The Workbooks directory-name variants a solution may use, probed in order
 * (mirrors the ANALYTIC_RULE_DIR_NAMES first-match rule). The Azure-Sentinel
 * repo standard is "Workbooks"; the singular is tolerated defensively.
 */
export const WORKBOOK_DIR_NAMES: readonly string[] = ["Workbooks", "Workbook"];

/**
 * Whether a solution file is a workbook TEMPLATE json (not the WorkbooksMetadata
 * manifest that ships alongside them). A repo workbook file's json body IS the
 * workbook document - the ARM `serializedData` equivalent - so it feeds
 * extractWorkbookQueries directly.
 */
export function isWorkbookTemplateFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".json") && !lower.includes("metadata");
}

/** The display name for a repo workbook: its file name minus the .json suffix. */
export function workbookNameFromFile(fileName: string): string {
  return fileName.replace(/\.json$/i, "");
}

/**
 * Acquire a solution's SHIPPED workbooks from the Sentinel repo as
 * {@link ContentItem}s - the exact parallel to {@link acquireAnalyticRules},
 * over the SentinelContent port (NO new external surface). Tries each Workbooks
 * directory-name variant and reads the .json templates from the FIRST that has
 * any. A repo workbook file's json body is the workbook document itself, so it
 * is fed straight to extractWorkbookQueries, which recursively mines every
 * type:3 KQL step. Unreadable files are skipped; a solution with no Workbooks
 * directory resolves to `[]`. Never throws for a content miss.
 */
export async function acquireSolutionWorkbooks(
  content: SentinelContent,
  solutionName: string,
  logger?: Logger,
): Promise<ContentItem[]> {
  for (const dirName of WORKBOOK_DIR_NAMES) {
    const files = await content.listSolutionFiles(solutionName, dirName);
    const templates = files.filter((f) => isWorkbookTemplateFile(f.name));
    if (templates.length === 0) continue;

    const items: ContentItem[] = [];
    for (const file of templates) {
      const text = await content.readFile(file.path);
      if (text === null) {
        logger?.debug("coverage-analysis: workbook file unreadable", {
          solution: solutionName,
          file: file.name,
        });
        continue;
      }
      const extraction = extractWorkbookQueries(text);
      items.push(
        workbookToContentItem(
          file.path,
          workbookNameFromFile(file.name),
          extraction,
        ),
      );
    }
    logger?.info("coverage-analysis: acquired solution workbooks", {
      solution: solutionName,
      dir: dirName,
      count: items.length,
    });
    return items;
  }
  logger?.debug("coverage-analysis: no workbooks directory", {
    solution: solutionName,
  });
  return [];
}

// The ARM workbook acquirer (`acquireWorkbooks`, `AcquireWorkbooksInput`,
// `WORKBOOKS_API_VERSION`) stood here until 2026-08-31 and was DELETED by
// DBT-57. It enumerated Microsoft.Insights/workbooks across the subscription -
// the behaviour the 2026-07-12 direction recorded above reversed - and it had
// never had a caller: rule-coverage-section has always used
// `acquireSolutionWorkbooks`. Its section header and docstring nonetheless
// described subscription enumeration as a shipped capability, which is why the
// dead code read as intentional rather than as a leftover.
//
// Nothing else in THIS FILE touches AzureManagement, so the port,
// `listAllPages` and `asString` imports went with it - coverage acquisition is
// now a SentinelContent-only usecase, which is the honest shape of a
// repo-sourced analysis.
//
// NOT the toolkit's last use of the ARM workbooks surface, and an earlier
// draft of this comment said it was (review, 2026-08-31). `content-install.ts`
// both LISTS `/providers/Microsoft.Insights/workbooks` and PUTs to it, and did
// so before any of this work. That claim mattered because it invites the next
// reader to tidy away "the now-unused ARM workbooks adapter" and break content
// install; `grep -rn "Microsoft.Insights/workbooks"` settles it in one call.
