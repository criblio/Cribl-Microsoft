/**
 * Available-content acquisition for the install flow (2026-07-14): find the
 * Content Hub package for a solution (its catalog entry - contentId +
 * packageId + version + installedVersion), and read the solution's SHIPPED
 * analytics rules and workbooks from the Sentinel repo so they can be
 * installed. Rules reuse the pinned YAML parser; workbook TEMPLATE bodies
 * are the serializedData verbatim.
 *
 * Pure orchestration over the ports.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { SentinelContent } from "../../ports/sentinel-content";
import type { Logger } from "../../ports/logger";
import { listAllPages } from "../azure-discovery/index";
import {
  SECURITY_INSIGHTS_API_VERSION,
  workspaceResourceId,
} from "./content-install";
import type { WorkspaceScope } from "./content-install";
import { ANALYTIC_RULE_DIR_NAMES } from "../../domain/sentinel-content/index";
import { WORKBOOK_DIR_NAMES } from "../coverage-analysis/index";
import { parseAnalyticRuleYaml } from "../../domain/coverage-analysis/index";
import type { ParsedAnalyticRule } from "../../domain/coverage-analysis/index";
import { parserResourceFromYaml } from "../../domain/content-install/index";
import type { ParserResource } from "../../domain/content-install/index";

/** A Content Hub catalog entry for a solution. */
export interface SolutionCatalogEntry {
  /** contentPackages/-scoped package name (the deploy target). */
  packageId: string;
  /** The stable contentId (matches installed contentPackages). */
  contentId: string;
  displayName: string;
  version: string;
  /** Non-null when already installed (the catalog reports it). */
  installedVersion: string | null;
}

/** A solution workbook available to install (its document body). */
export interface AvailableWorkbook {
  displayName: string;
  serializedData: string;
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find the Content Hub catalog entry for `solutionName` (fuzzy display-name
 * match, the same normalized-containment rule the rest of the app uses).
 * Returns null when the catalog cannot be read or no entry matches.
 */
export async function findSolutionCatalogEntry(
  azure: AzureManagement,
  ws: WorkspaceScope,
  solutionName: string,
  logger?: Logger,
): Promise<SolutionCatalogEntry | null> {
  const scope =
    `/subscriptions/${ws.subscriptionId}/resourceGroups/${ws.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${ws.workspaceName}` +
    "/providers/Microsoft.SecurityInsights/contentProductPackages";
  let packages: unknown[];
  try {
    packages = await listAllPages(
      azure,
      { method: "GET", path: scope, apiVersion: SECURITY_INSIGHTS_API_VERSION },
      "list content product packages",
    );
  } catch (err) {
    logger?.warn("content-install: catalog listing failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const target = normName(solutionName);
  const match = packages.find((p) => {
    const dn = normName(str(prop(prop(p, "properties"), "displayName")));
    return dn === target || dn.includes(target) || target.includes(dn);
  });
  if (match === undefined) return null;
  const props = prop(match, "properties");
  const installed = prop(props, "installedVersion");
  return {
    packageId: str(prop(match, "name")),
    contentId: str(prop(props, "contentId")),
    displayName: str(prop(props, "displayName")),
    version: str(prop(props, "version")),
    installedVersion:
      typeof installed === "string" && installed !== "" ? installed : null,
  };
}

/**
 * Normalize a solution name to a deprecation-match key: strip a "(Deprecated)"
 * / "(Legacy)" marker, then normalize. The Content Hub package displayName
 * ("Cloudflare (Deprecated)") and the repo folder name ("Cloudflare") both
 * reduce to the same key, so a repo-listed solution can be matched against the
 * authoritative Content Hub deprecation flag.
 */
export function deprecatedSolutionKey(name: string): string {
  return normName(name.replace(/\(?\s*(?:deprecated|legacy)\s*\)?/gi, ""));
}

/**
 * The AUTHORITATIVE set of deprecated solutions from the workspace's Content
 * Hub catalog (contentProductPackages) - a package is deprecated when its
 * properties.isDeprecated is set or its displayName carries a Deprecated /
 * Legacy marker. Returned as {@link deprecatedSolutionKey} keys so the solution
 * browser (which lists REPO folder names) can tag rows the repo heuristics
 * miss - e.g. Cloudflare, deprecated in the Hub but current in the repo.
 * Best-effort: a failed listing yields an empty set (no tags), never throws.
 */
export async function listDeprecatedContentHubSolutions(
  azure: AzureManagement,
  ws: WorkspaceScope,
  logger?: Logger,
): Promise<Set<string>> {
  const scope =
    `/subscriptions/${ws.subscriptionId}/resourceGroups/${ws.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${ws.workspaceName}` +
    "/providers/Microsoft.SecurityInsights/contentProductPackages";
  const keys = new Set<string>();
  let packages: unknown[];
  try {
    packages = await listAllPages(
      azure,
      { method: "GET", path: scope, apiVersion: SECURITY_INSIGHTS_API_VERSION },
      "list content product packages",
    );
  } catch (err) {
    logger?.warn("content-install: deprecated-solutions listing failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return keys;
  }
  for (const p of packages) {
    const props = prop(p, "properties");
    const displayName = str(prop(props, "displayName"));
    const isDep = prop(props, "isDeprecated");
    const deprecated =
      isDep === true ||
      (typeof isDep === "string" && isDep.toLowerCase() === "true") ||
      /\b(?:deprecated|legacy)\b/i.test(displayName);
    if (deprecated && displayName !== "") keys.add(deprecatedSolutionKey(displayName));
  }
  logger?.info("content-install: content hub deprecated solutions", {
    count: keys.size,
  });
  return keys;
}

/**
 * Read a solution's shipped analytics rules from the Sentinel repo (first
 * rule-directory variant that yields YAMLs), parsed for install. Capped.
 */
export async function availableAnalyticRules(
  content: SentinelContent,
  solutionName: string,
  cap = 60,
): Promise<ParsedAnalyticRule[]> {
  for (const dir of ANALYTIC_RULE_DIR_NAMES) {
    const files = await content.listSolutionFiles(solutionName, dir);
    const yamls = files
      .filter((f) => /\.ya?ml$/i.test(f.name))
      .slice(0, cap);
    if (yamls.length === 0) continue;
    const rules: ParsedAnalyticRule[] = [];
    for (const file of yamls) {
      const text = await content.readFile(file.path);
      if (text !== null) rules.push(parseAnalyticRuleYaml(text, file.name));
    }
    return rules;
  }
  return [];
}

/**
 * Read a solution's shipped workbooks from the Sentinel repo (first Workbooks
 * directory variant that yields .json templates). A template file's body IS
 * the serializedData. Capped.
 */
export async function availableWorkbooks(
  content: SentinelContent,
  solutionName: string,
  cap = 40,
): Promise<AvailableWorkbook[]> {
  for (const dir of WORKBOOK_DIR_NAMES) {
    const files = await content.listSolutionFiles(solutionName, dir);
    const templates = files
      .filter(
        (f) =>
          /\.json$/i.test(f.name) && !f.name.toLowerCase().includes("metadata"),
      )
      .slice(0, cap);
    if (templates.length === 0) continue;
    const out: AvailableWorkbook[] = [];
    for (const file of templates) {
      const text = await content.readFile(file.path);
      if (text !== null) {
        out.push({
          displayName: file.name.replace(/\.json$/i, ""),
          serializedData: text,
        });
      }
    }
    return out;
  }
  return [];
}

/** The Parsers directory-name variants a solution may use. */
const PARSER_DIR_NAMES: readonly string[] = ["Parsers", "Parser"];

/**
 * Read a solution's SHIPPED parsers from the Sentinel repo (first Parsers
 * directory variant that yields installable function files). Parsers are the
 * DEPENDENCY the solution's rules/workbooks query by alias; the install flow
 * installs them automatically alongside the content. Capped. Files that are
 * not installable functions (no alias/query) are skipped.
 */
export async function availableParsers(
  content: SentinelContent,
  solutionName: string,
  cap = 60,
): Promise<ParserResource[]> {
  for (const dir of PARSER_DIR_NAMES) {
    const files = await content.listSolutionFiles(solutionName, dir);
    const candidates = files
      .filter((f) => /\.(ya?ml|txt|kql)$/i.test(f.name))
      .slice(0, cap);
    if (candidates.length === 0) continue;
    const out: ParserResource[] = [];
    for (const file of candidates) {
      const text = await content.readFile(file.path);
      if (text === null) continue;
      const parser = parserResourceFromYaml(text);
      if (parser !== null) out.push(parser);
    }
    return out;
  }
  return [];
}

// Re-export so a caller building workbook installs has the sourceId helper.
export { workspaceResourceId };
