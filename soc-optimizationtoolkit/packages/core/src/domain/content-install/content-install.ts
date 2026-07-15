/**
 * Sentinel content-install domain (user feature 2026-07-14): the PURE
 * transforms behind enabling a solution's content in the workspace -
 * analytics rules and workbooks - plus installed-state partitioning and the
 * per-item outcome vocabulary the UI reports success/failure with.
 *
 *  - {@link alertRuleResourceFromParsed}: a repo/custom ParsedAnalyticRule ->
 *    the ARM alertRules PUT body. Kinds Scheduled (the YAML default) and NRT
 *    are supported; anything else returns an honest unsupported reason
 *    instead of a doomed PUT. YAML durations ("1h") convert to ISO8601
 *    ("PT1H"), YAML operators ("gt") to ARM spellings ("GreaterThan"),
 *    "None" tactics/techniques are dropped, entity mappings pass through
 *    when the tolerant parse produced them.
 *  - {@link workbookResourceBody}: a workbook document (the repo template
 *    file body IS the serializedData) -> the ARM workbooks PUT body linked
 *    to the workspace.
 *  - {@link parseWorkbookUpload}: accept a user-uploaded workbook as either
 *    a raw gallery-template JSON or a portal ARM export (template or single
 *    resource) and extract {displayName, serializedData}.
 *  - {@link partitionByInstalled}: case-insensitive display-name matching of
 *    available content against what the workspace already has - "which ones
 *    COULD I install".
 *  - {@link ContentInstallOutcome} + {@link summarizeInstallOutcomes}: the per-item
 *    success/failure feedback contract.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto (ids are shell-minted).
 */

import type { ParsedAnalyticRule } from "../coverage-analysis/index";

/** One install attempt's outcome - the UI's per-item feedback row. */
export interface ContentInstallOutcome {
  /** Display name of the rule/workbook/solution. */
  name: string;
  ok: boolean;
  /** Success detail ("created") or the verbatim failure (HTTP status + body). */
  detail: string;
}

/** "N installed, M failed" (+ skip note when present). */
export function summarizeInstallOutcomes(
  outcomes: readonly ContentInstallOutcome[],
  skipped = 0,
): string {
  const ok = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - ok;
  const parts = [`${ok} installed`];
  if (failed > 0) parts.push(`${failed} FAILED`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(", ");
}

/**
 * Convert a Sentinel-YAML duration ("1h", "30m", "5d", or already-ISO
 * "PT1H"/"P1D") to ISO8601. Unparseable input yields `fallback` - a doomed
 * PUT is worse than a sane default the reviewer can edit in the portal.
 */
export function toIsoDuration(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.startsWith("P")) return trimmed;
  const m = trimmed.match(/^(\d+)\s*([MHD])$/);
  if (!m) return fallback;
  const n = m[1];
  switch (m[2]) {
    case "M":
      return `PT${n}M`;
    case "H":
      return `PT${n}H`;
    default:
      return `P${n}D`;
  }
}

/** YAML trigger operator ("gt") or ARM spelling -> the ARM enum value. */
export function toArmTriggerOperator(raw: string | undefined): string {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "gt":
    case "greaterthan":
      return "GreaterThan";
    case "lt":
    case "lessthan":
      return "LessThan";
    case "eq":
    case "equal":
      return "Equal";
    case "ne":
    case "notequal":
      return "NotEqual";
    default:
      return "GreaterThan";
  }
}

const VALID_SEVERITIES = new Set(["High", "Medium", "Low", "Informational"]);

/** Normalize a parsed severity to the ARM enum (unknown -> Medium). */
export function toArmSeverity(raw: string): string {
  const cased = raw.trim().replace(/^\w/, (c) => c.toUpperCase());
  return VALID_SEVERITIES.has(cased) ? cased : "Medium";
}

/** Drop "None"/empty entries (the YAML placeholder) and dedupe. */
function cleanList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((v) => v && v !== "None"))];
}

/**
 * Tactics for ARM are the space-free enum spelling ("Lateral Movement" ->
 * "LateralMovement"); YAML usually already omits spaces but not always.
 */
function cleanTactics(values: readonly string[] | undefined): string[] {
  return cleanList(values).map((t) => t.replace(/\s+/g, ""));
}

const GUID_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ARM alertRules PUT body, or an honest unsupported reason. */
export type AlertRuleResource =
  | { supported: true; kind: "Scheduled" | "NRT"; body: Record<string, unknown> }
  | { supported: false; reason: string };

/**
 * Build the alertRules PUT body from a parsed rule. Scheduled rules carry
 * the full scheduling block (defaults: PT1H frequency/period, GreaterThan 0
 * trigger, suppression off at PT5H - the portal's own defaults); NRT rules
 * MUST omit the scheduling block. Template linkage (alertRuleTemplateName +
 * templateVersion) is included only when the YAML id is a GUID.
 */
export function alertRuleResourceFromParsed(
  rule: ParsedAnalyticRule,
): AlertRuleResource {
  const kindRaw = (rule.kind ?? "Scheduled").trim();
  const kind = kindRaw.toLowerCase();
  if (kind !== "scheduled" && kind !== "nrt") {
    return {
      supported: false,
      reason:
        `kind "${kindRaw}" is not installable here (only Scheduled and NRT rules; ` +
        "Fusion/MicrosoftSecurityIncidentCreation rules are managed by their own connectors)",
    };
  }
  if (rule.query.trim() === "") {
    return { supported: false, reason: "the rule has no query body" };
  }

  const common: Record<string, unknown> = {
    displayName: rule.name,
    description: rule.description ?? "",
    severity: toArmSeverity(rule.severity),
    enabled: true,
    query: rule.query,
    suppressionEnabled: false,
    suppressionDuration: "PT5H",
    tactics: cleanTactics(rule.tactics),
    techniques: cleanList(rule.techniques),
    ...(rule.entityMappings !== undefined && rule.entityMappings.length > 0
      ? { entityMappings: rule.entityMappings }
      : {}),
    ...(GUID_RULE.test(rule.id)
      ? {
          alertRuleTemplateName: rule.id,
          ...(rule.version !== undefined ? { templateVersion: rule.version } : {}),
        }
      : {}),
  };

  if (kind === "nrt") {
    return { supported: true, kind: "NRT", body: { kind: "NRT", properties: common } };
  }
  return {
    supported: true,
    kind: "Scheduled",
    body: {
      kind: "Scheduled",
      properties: {
        ...common,
        queryFrequency: toIsoDuration(rule.queryFrequency, "PT1H"),
        queryPeriod: toIsoDuration(rule.queryPeriod, "PT1H"),
        triggerOperator: toArmTriggerOperator(rule.triggerOperator),
        triggerThreshold: rule.triggerThreshold ?? 0,
      },
    },
  };
}

/** Inputs for {@link workbookResourceBody}. */
export interface WorkbookResourceInput {
  displayName: string;
  /** The workbook document JSON text (a repo template file body verbatim). */
  serializedData: string;
  /** Full ARM resource id of the Log Analytics workspace (the sourceId link). */
  workspaceResourceId: string;
  /** Azure region of the workspace (workbooks are regional resources). */
  location: string;
}

/** The ARM Microsoft.Insights/workbooks PUT body (Sentinel-linked, shared). */
export function workbookResourceBody(
  input: WorkbookResourceInput,
): Record<string, unknown> {
  return {
    location: input.location,
    kind: "shared",
    properties: {
      displayName: input.displayName,
      serializedData: input.serializedData,
      category: "sentinel",
      sourceId: input.workspaceResourceId,
      version: "Notebook/1.0",
    },
  };
}

/** A parsed workbook upload: what install needs. */
export interface ParsedWorkbookUpload {
  displayName: string;
  serializedData: string;
}

/**
 * Parse a user-uploaded workbook file: a raw gallery-template JSON (the
 * document itself - used verbatim as serializedData), a portal ARM template
 * export (resources[] containing a Microsoft.Insights/workbooks entry whose
 * properties carry serializedData), or a single exported workbook resource.
 * Returns null for anything else.
 */
export function parseWorkbookUpload(
  fileName: string,
  text: string,
): ParsedWorkbookUpload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const fallbackName = fileName.replace(/\.json$/i, "");

  // Raw gallery template: the document itself ("version": "Notebook/1.0"
  // and/or an items[] array).
  if (Array.isArray(obj.items) || obj.version === "Notebook/1.0") {
    return { displayName: fallbackName, serializedData: text };
  }

  // ARM shapes: single resource or a template's resources[].
  const candidates: unknown[] = Array.isArray(obj.resources)
    ? obj.resources
    : [obj];
  for (const raw of candidates) {
    if (typeof raw !== "object" || raw === null) continue;
    const res = raw as Record<string, unknown>;
    const type = typeof res.type === "string" ? res.type.toLowerCase() : "";
    if (!type.endsWith("microsoft.insights/workbooks")) continue;
    const props = res.properties as Record<string, unknown> | undefined;
    const data = props?.serializedData;
    if (typeof data !== "string" || data === "") continue;
    const displayName =
      typeof props?.displayName === "string" && props.displayName !== ""
        ? props.displayName
        : fallbackName;
    return { displayName, serializedData: data };
  }
  return null;
}

/** One installable rule extracted from a portal ARM export upload. */
export interface ArmExportRule {
  displayName: string;
  /** PUT body: kind + properties, near-verbatim from the export. */
  body: Record<string, unknown>;
  /** Whether the export was an NRT rule (drives the preview api-version). */
  isNrt: boolean;
}

/** The savedSearches Function body a solution parser installs as. */
export interface ParserResource {
  /** The functionAlias rules/workbooks reference (savedSearch id-safe). */
  alias: string;
  displayName: string;
  query: string;
  /** functionParameters string (empty when the parser takes none). */
  functionParameters: string;
}

/**
 * Extract the installable parser (savedSearches Function) from a Sentinel
 * repo parser YAML. Tolerant regex-over-YAML, same approach as the rule and
 * parser-coverage parsers: pull the alias (FunctionAlias, else FunctionName),
 * the FunctionQuery body, the display name, and optional FunctionParameters.
 * Returns null when it is not an installable function file (no alias/query).
 *
 * Parsers are a DEPENDENCY of the content, not a user choice: an analytics
 * rule or workbook that queries `Cloudflare` (the function) fails to save or
 * run if the function is absent, so the install flow installs the solution's
 * parsers alongside its rules/workbooks - mirroring Content Hub, which
 * installs parsers automatically with a solution.
 */
export function parserResourceFromYaml(text: string): ParserResource | null {
  const alias =
    text.match(/^FunctionAlias:\s*["']?([A-Za-z_][\w-]*)/m)?.[1] ??
    text.match(/^FunctionName:\s*["']?([A-Za-z_][\w-]*)/m)?.[1];
  if (alias === undefined) return null;

  const query = text.match(
    /^FunctionQuery:\s*\|?-?\s*\n([\s\S]*?)(?=^[A-Za-z]|(?![\s\S]))/m,
  )?.[1];
  if (query === undefined || query.trim() === "") return null;

  const displayName =
    text.match(/^FunctionName:\s*["']?([^"'\n]+)/m)?.[1]?.trim() ??
    text.match(/^(?:Function )?Title:\s*["']?([^"'\n]+)/m)?.[1]?.trim() ??
    alias;
  const functionParameters =
    text.match(/^FunctionParameters:\s*["']?([^"'\n]*)/m)?.[1]?.trim() ?? "";

  return {
    alias,
    displayName: displayName.replace(/["']$/, ""),
    query: dedentBlock(query),
    functionParameters,
  };
}

/** Strip the common YAML block-scalar indentation from a query body. */
function dedentBlock(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => l.match(/^ */)?.[0].length ?? 0);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n").trim();
}

/** The ARM savedSearches PUT body for a parser Function. */
export function parserResourceBody(
  parser: ParserResource,
): Record<string, unknown> {
  return {
    properties: {
      category: "Function",
      displayName: parser.displayName,
      functionAlias: parser.alias,
      query: parser.query,
      functionParameters: parser.functionParameters,
      version: 2,
    },
  };
}

/** Partition available content into already-installed vs installable. */
export function partitionByInstalled<T>(
  available: readonly T[],
  installedNames: ReadonlySet<string>,
  nameOf: (item: T) => string,
): { installed: T[]; installable: T[] } {
  const installed: T[] = [];
  const installable: T[] = [];
  for (const item of available) {
    (installedNames.has(nameOf(item).toLowerCase()) ? installed : installable).push(
      item,
    );
  }
  return { installed, installable };
}
