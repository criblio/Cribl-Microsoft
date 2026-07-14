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
 *   - WORKBOOKS via the EXISTING AzureManagement port (NO new external surface):
 *     enumerate Microsoft.Insights/workbooks in the workspace's subscription,
 *     defensively mine the buried serializedData KQL, project to ContentItem.
 *
 * Both yield the SAME ContentItem shape, so a caller can analyze rules alone,
 * workbooks alone, or both together through analyzeContentCoverage. This usecase
 * only ACQUIRES + projects; the coverage math stays in the pure domain.
 *
 * Pure orchestration over the ports: no IO of its own, no fetch, no React, no
 * Date/crypto. The IO lives entirely behind the injected adapters.
 */

import type { SentinelContent } from "../../ports/sentinel-content";
import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import { ANALYTIC_RULE_DIR_NAMES } from "../../domain/sentinel-content/discovery";
import {
  analyticRuleToContentItem,
  extractWorkbookQueries,
  parseAnalyticRuleYaml,
  workbookToContentItem,
} from "../../domain/coverage-analysis/index";
import type { ContentItem } from "../../domain/coverage-analysis/index";
import { listAllPages } from "../azure-discovery/index";

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

// ---------------------------------------------------------------------------
// Workbook acquisition (AzureManagement port - existing ARM surface)
// ---------------------------------------------------------------------------

/** ARM api-version for Microsoft.Insights/workbooks list + get. */
export const WORKBOOKS_API_VERSION = "2023-06-01";

/** Inputs for {@link acquireWorkbooks}. */
export interface AcquireWorkbooksInput {
  /** Subscription id whose Sentinel-category workbooks to enumerate. */
  subscriptionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Enumerate the subscription's Sentinel workbooks via ARM
 * (Microsoft.Insights/workbooks, `category=sentinel`, `canFetchContent=true` so
 * the buried serializedData is included in the list) and project each to a
 * {@link ContentItem} whose KQL was defensively mined. A workbook whose
 * serializedData is missing or unreadable still yields an item (with 1
 * unparseable step counted), so nothing is silently dropped.
 *
 * Pagination follows ARM `nextLink` through the shared {@link listAllPages}.
 */
export async function acquireWorkbooks(
  azure: AzureManagement,
  input: AcquireWorkbooksInput,
  logger?: Logger,
): Promise<ContentItem[]> {
  const raw = await listAllPages(
    azure,
    {
      method: "GET",
      path: `/subscriptions/${input.subscriptionId}/providers/Microsoft.Insights/workbooks`,
      apiVersion: WORKBOOKS_API_VERSION,
      query: { category: "sentinel", canFetchContent: "true" },
    },
    "list workbooks",
  );

  const items: ContentItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = asString(entry["id"]) || asString(entry["name"]);
    const properties = isRecord(entry["properties"])
      ? entry["properties"]
      : undefined;
    const displayName = properties
      ? asString(properties["displayName"])
      : "";
    const name = displayName || asString(entry["name"]) || id;
    const serialized = properties ? properties["serializedData"] : undefined;

    // Defensive: a workbook without a serializedData string still becomes an
    // item, counting the whole document as one unparseable unit (surface, not
    // drop) - the same contract extractWorkbookQueries applies to bad JSON.
    const extraction =
      typeof serialized === "string"
        ? extractWorkbookQueries(serialized)
        : { queries: [], unparseableCount: 1 };

    items.push(workbookToContentItem(id, name, extraction));
  }

  logger?.info("coverage-analysis: acquired workbooks", {
    subscription: input.subscriptionId,
    count: items.length,
  });
  return items;
}
