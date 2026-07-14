/**
 * SIEM export parsers (porting-plan Unit 26): the Splunk saved-search JSON
 * parser and the RFC-4180 QRadar CSV parser, ported verbatim from the legacy
 * siem-migration.ts (lines 242-437; both characterized by the legacy
 * regression suite). Platform detection is IMPROVED over the legacy
 * extension-only check: content sniffing breaks the tie when the extension
 * is missing or foreign.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  QRADAR_EXTENSION_MAP,
  SPLUNK_INTERNAL_MACROS,
  isSplunkFilterMacro,
} from "./knowledge-bases";
import type { ParsedRule, SiemPlatform } from "./models";

/**
 * RFC-4180-compliant CSV parser (handles quoted multi-line fields and
 * escaped quotes) - QRadar rule exports carry multi-line Test definitions.
 */
export function parseRfc4180Csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
        row.push(field);
        field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
        if (ch === "\r") i++; // skip \r\n
      } else {
        field += ch;
      }
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  return rows;
}

/**
 * Parse a Splunk saved-search/alert JSON export. Accepts the three observed
 * shapes: result.alertrules, bare alertrules, or a top-level array.
 * @throws on invalid JSON (the usecase surfaces the message).
 */
export function parseSplunkExport(jsonContent: string): ParsedRule[] {
  const parsed = JSON.parse(jsonContent) as {
    result?: { alertrules?: unknown[] };
    alertrules?: unknown[];
  };
  const alertRules =
    parsed?.result?.alertrules ??
    parsed?.alertrules ??
    (Array.isArray(parsed) ? (parsed as unknown[]) : []);
  const rules: ParsedRule[] = [];

  for (const raw of alertRules) {
    const rule = raw as Record<string, unknown>;
    const search = typeof rule.search === "string" ? rule.search : "";
    const title = typeof rule.title === "string" ? rule.title : "";

    // Extract macros (backtick-wrapped) - skip internal and filter macros.
    const macros: string[] = [];
    const macroRegex = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = macroRegex.exec(search)) !== null) {
      const macro = m[1];
      if (
        !SPLUNK_INTERNAL_MACROS.has(macro) &&
        macro.length > 2 &&
        !isSplunkFilterMacro(macro)
      ) {
        macros.push(macro);
      }
    }

    // Extract data models.
    const dataModels: string[] = [];
    const dmRegex = /datamodel=([A-Za-z_.]+)/g;
    while ((m = dmRegex.exec(search)) !== null) {
      dataModels.push(m[1]);
    }

    // Extract sourcetypes.
    const sourcetypes: string[] = [];
    const stRegex = /sourcetype\s*=\s*"?([^\s"',)]+)/gi;
    while ((m = stRegex.exec(search)) !== null) {
      sourcetypes.push(m[1]);
    }

    // Prefer macros over data models as the data-source identifier (a macro
    // names the specific source; the data model is the abstract schema).
    // Sub-data-models collapse to top level (Endpoint.Processes -> Endpoint).
    const collapsedDMs = dataModels.map((dm) => dm.split(".")[0]);
    const dataSources =
      macros.length > 0
        ? [...new Set([...macros, ...sourcetypes])]
        : [...new Set([...collapsedDMs, ...sourcetypes])];

    const sev = rule["alert.severity"];
    const severity =
      sev === 1
        ? "Low"
        : sev === 2
          ? "Medium"
          : sev === 3
            ? "High"
            : sev === 4
              ? "Critical"
              : "Unknown";

    rules.push({
      name: title,
      platform: "splunk",
      enabled: true, // Splunk export only includes enabled alerts.
      dataSources,
      macros,
      dataModels,
      sourcetypes,
      contentExtension: "",
      eventCategories: [],
      mitreTactics: [],
      mitreTechniques: [],
      severity,
      description: typeof rule.description === "string" ? rule.description : "",
      rawSearch: search,
      isRule: true,
    });
  }

  return rules;
}

/** Parse a QRadar rule CSV export. */
export function parseQRadarExport(csvContent: string): ParsedRule[] {
  const rows = parseRfc4180Csv(csvContent);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const ruleNameIdx = col("Rule name");
  const enabledIdx = col("Rule enabled");
  const isRuleIdx = col("Is rule");
  const notesIdx = col("Notes");
  const categoryIdx = col("High-level.low-level category");
  const descIdx = col("Event description");
  const testDefIdx = col("Test definition");
  const tacticIdx = col("Tactic");
  const techniqueIdx = col("Technique");
  const extNameIdx = col("Content extension name");

  const rules: ParsedRule[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 5) continue; // skip malformed rows

    const get = (idx: number) => (idx >= 0 && idx < r.length ? r[idx].trim() : "");

    const ruleName = get(ruleNameIdx);
    if (!ruleName) continue;

    const enabled = get(enabledIdx).toUpperCase() === "TRUE";
    const isRule = get(isRuleIdx).toUpperCase() === "TRUE";
    const contentExt = get(extNameIdx);
    const category = get(categoryIdx);
    const tactic = get(tacticIdx);
    const technique = get(techniqueIdx);
    const testDef = get(testDefIdx);
    const description = get(descIdx) || get(notesIdx);

    // Data source from the content extension.
    const dataSources: string[] = [];
    if (contentExt) {
      const mapped = QRADAR_EXTENSION_MAP[contentExt];
      if (mapped?.solution) dataSources.push(mapped.solution);
      else dataSources.push(`extension:${contentExt}`);
    }

    const eventCategories = category
      ? category.split(".").map((c) => c.trim()).filter(Boolean)
      : [];

    rules.push({
      name: ruleName,
      platform: "qradar",
      enabled,
      dataSources: [...new Set(dataSources)],
      macros: [],
      dataModels: [],
      sourcetypes: [],
      contentExtension: contentExt,
      eventCategories,
      mitreTactics: tactic ? [tactic] : [],
      mitreTechniques: technique ? [technique] : [],
      severity: "Unknown",
      description,
      rawSearch: testDef,
      isRule,
    });
  }

  return rules;
}

/** Parse an export for the given platform (the one dispatcher). */
export function parseSiemExport(
  content: string,
  platform: SiemPlatform,
): ParsedRule[] {
  return platform === "splunk"
    ? parseSplunkExport(content)
    : parseQRadarExport(content);
}

/**
 * Detect the export platform: extension first (the pinned legacy rule:
 * .csv = qradar, .json = splunk), then content sniffing for anything else
 * (JSON-looking = splunk; a QRadar header row = qradar; default splunk,
 * matching the legacy default).
 */
export function detectSiemPlatform(
  fileName: string,
  content: string,
): SiemPlatform {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "qradar";
  if (lower.endsWith(".json")) return "splunk";
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "splunk";
  if (content.slice(0, 2000).includes("Rule name")) return "qradar";
  return "splunk";
}
