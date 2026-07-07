/**
 * Sentinel-repo sample resolution (ENG-42) - porting-plan Unit 16. Ported from
 * legacy default-samples.ts `findSentinelRepoSamples`, with the filesystem
 * walk lifted out: this module is a PURE resolver over ALREADY-FETCHED candidate
 * files (the shell/usecase lists the Sample Data directories via the Unit 14
 * SentinelContent port and passes {@link RepoSampleCandidate}s in).
 *
 * VERBATIM knowledge pinned here:
 * - SENTINEL_SCHEMA_MARKERS + the 3+-hits {@link detectPreIngested} rule (a
 *   sample already transformed into a Sentinel table schema is NOT raw vendor
 *   data and is dropped).
 * - The THREE user-facing result messages ({@link buildRepoSampleMessage}).
 * - ABBREVIATIONS (~70 vendors) and EXCLUDE_PATTERNS.
 * - Scoring thresholds: short keywords (< 4 chars) are suppressed for substring
 *   matching, and only files scoring >= 8 survive.
 * - Original-raw-line preservation for cef/leef/syslog (the pack needs the raw
 *   line in _raw, not the parsed JSON).
 * - CrowdStrike-style consolidation: when a solution defines custom tables and a
 *   file explodes into many event_simpleName splits, merge them per destination
 *   table via the injected routing.
 *
 * Reuses the Unit 11/12 parser (parseSampleContent), the unified discriminator
 * selector, and the deduplicated PAN-OS id map.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  parseSampleContent,
  selectDiscriminatorField,
  PANOS_LOG_TYPES,
} from "../sample-parsing/index";
import type { DiscoveredField, SampleFormat } from "../sample-parsing/models";

// ---------------------------------------------------------------------------
// Pre-ingested detection (SENTINEL_SCHEMA_MARKERS + 3+-hits rule)
// ---------------------------------------------------------------------------

/**
 * Sentinel schema fingerprint: fields that only appear in POST-ingestion data.
 * Raw CEF carries src/dst/spt/dpt/act; ingested data carries
 * SourceIP/DestinationIP/SourcePort/DeviceAction. Ported verbatim from legacy.
 */
export const SENTINEL_SCHEMA_MARKERS: ReadonlySet<string> = new Set([
  "SourceIP",
  "DestinationIP",
  "SourcePort",
  "DestinationPort",
  "DeviceAction",
  "ApplicationProtocol",
  "DestinationHostName",
  "SourceTranslatedAddress",
  "DestinationTranslatedAddress",
  "DeviceCustomString1",
  "DeviceCustomString2",
  "DeviceCustomString3",
  "DeviceCustomNumber1",
  "DeviceCustomNumber2",
  "SourceUserName",
  "DestinationUserName",
  "AdditionalExtensions",
  "ExternalID",
  "CommunicationDirection",
  "DeviceAddress",
  "FlexString1",
  "FlexString2",
  "MaliciousIP",
  "ThreatConfidence",
  "ThreatDescription",
  "IndicatorThreatType",
]);

/** A sample with this many schema markers is already ingested (not raw). */
export const PREINGESTED_MARKER_THRESHOLD = 3;

/**
 * True when `fieldNames` contain >= {@link PREINGESTED_MARKER_THRESHOLD} Sentinel
 * schema markers - i.e. the sample is post-ingestion, not raw vendor data.
 * Verbatim from legacy `detectPreIngested` (short-circuits at the threshold).
 */
export function detectPreIngested(fieldNames: readonly string[]): boolean {
  let hits = 0;
  for (const f of fieldNames) {
    if (SENTINEL_SCHEMA_MARKERS.has(f)) hits++;
    if (hits >= PREINGESTED_MARKER_THRESHOLD) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Keyword derivation + scoring (ENG-42)
// ---------------------------------------------------------------------------

/**
 * Vendor abbreviations and alternate names (~70 vendors). Maps a keyword found
 * in the solution name to additional filename-search terms. Ported verbatim
 * from legacy default-samples.ts ABBREVIATIONS.
 */
export const ABBREVIATIONS: Record<string, string[]> = {
  // Firewall / Network Security
  palo: ["paloalto", "panos", "cdlevent", "paloaltopanos", "paloaltonetworks"],
  fortinet: ["fortigate", "fortinet", "forti", "fortindr"],
  checkpoint: ["checkpoint", "cbs"],
  sonicwall: ["sonicwall"],
  watchguard: ["watchguard", "firebox"],
  juniper: ["juniper", "srx"],
  barracuda: ["barracuda", "barracudawaf"],
  sophos: ["sophos"],

  // Endpoint / EDR
  crowdstrike: ["crowdstrike", "falcon", "cs", "fdr"],
  symantec: ["symantec", "broadcom", "sep"],
  trend: ["trendmicro", "trend", "apexone"],
  mcafee: ["mcafee", "trellix", "epo", "nsp"],
  cylance: ["cylance", "cylanceprotect", "blackberry"],
  morphisec: ["morphisec"],
  kaspersky: ["kaspersky", "kasperskysc"],
  fireeye: ["fireeye", "mandiant", "trellix"],
  carbon: ["carbonblack", "carbon", "vmwarecarbon"],

  // Cloud / SaaS
  cisco: ["cisco", "meraki", "asa", "ise", "firepower", "stealthwatch", "ucs", "wsa", "aci", "seg"],
  microsoft: ["microsoft", "azure", "defender", "sentinel", "copilot", "aad", "purview"],
  zscaler: ["zscaler", "zpa", "zia"],
  cloudflare: ["cloudflare", "cf"],
  okta: ["okta", "auth0"],
  netskope: ["netskope"],

  // Infrastructure / VM
  vmware: ["vmware", "esxi", "vsphere", "sase", "sdwan", "veco"],
  citrix: ["citrix", "citrixanalytics", "adc"],
  pulse: ["pulse", "pulseconnect", "ivanti"],
  infoblox: ["infoblox", "nios", "cdc"],
  forescout: ["forescout"],

  // SIEM / Observability
  darktrace: ["darktrace", "aia"],
  vectra: ["vectra", "vectrastream", "aivectra"],
  dynatrace: ["dynatrace"],
  cribl: ["cribl"],
  gitlab: ["gitlab", "githubscan"],

  // IoT / OT
  armis: ["armis"],
  claroty: ["claroty", "clarotydome"],
  nozomi: ["nozomi"],
  cynerio: ["cynerio"],
  phosphorus: ["phosphorus"],

  // Identity / Access
  forgerock: ["forgerock"],
  securid: ["securid", "rsa"],
  delinea: ["delinea", "thycotic"],
  ping: ["pingfederate", "ping"],

  // Data Protection
  varonis: ["varonis"],
  digital: ["digitalguardian"],
  egress: ["egress", "egressdefend"],
  commvault: ["commvault", "securityiq"],
  talon: ["talon"],

  // Threat Intel
  intel471: ["intel471"],
  doppel: ["doppel"],
  arista: ["arista", "awake"],
  illumio: ["illumio"],
  mimecast: ["mimecast"],

  // Mobile / Remote
  jamf: ["jamf", "jamfprotect"],
  samsung: ["samsung", "knox"],
  nordpass: ["nordpass"],
  garrison: ["garrison", "ultra"],
  knowbe4: ["knowbe4", "defend"],

  // Other
  wiz: ["wiz"],
  perimeter81: ["perimeter81"],
  onapsis: ["onapsis"],
  ossec: ["ossec", "wazuh"],
  akamai: ["akamai"],
  apache: ["apache", "httpserver", "tomcat"],
  oracle: ["oracle", "weblogic"],
  wirex: ["wirex"],
  tenable: ["tenable"],
  veeam: ["veeam"],
  abnormal: ["abnormal"],
  prancer: ["prancer"],
  valence: ["valence"],
  sevco: ["sevco"],
  salem: ["salemcyber", "salem"],
  ridge: ["ridgesecurity", "ridge"],
};

/**
 * Filename patterns to exclude (false positives from unrelated solutions).
 * Ported verbatim from legacy EXCLUDE_PATTERNS.
 */
export const EXCLUDE_PATTERNS: readonly RegExp[] = Object.freeze([
  /prismacloud/i, // PrismaCloud != PAN-OS
  /prisma\s*cloud/i,
  /sanitized/i, // Redacted/sanitized audit files
  /\.schema\./i, // Schema definition files
]);

/** Keywords shorter than this are suppressed for substring matching. */
export const SHORT_KEYWORD_MIN = 4;

/** A file must score at least this to survive (reduces partial-overlap noise). */
export const REPO_MATCH_MIN_SCORE = 8;

const MAX_TOP_FILES = 20;
const MAX_EVENTS_PER_TABLE = 10;

/**
 * Build the filename-search keywords for a solution. Verbatim from legacy: base
 * words (>= 4 chars), concatenated first-2 / first-3 / all-words forms, plus any
 * matched ABBREVIATIONS expansions. De-duplicated, order preserved.
 */
export function buildSampleKeywords(solutionName: string): string[] {
  const words = solutionName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const keywords = words.filter((w) => w.length >= SHORT_KEYWORD_MIN);
  if (words.length >= 2) keywords.push(words.slice(0, 2).join(""));
  if (words.length >= 3) keywords.push(words.slice(0, 3).join(""));
  keywords.push(words.join(""));

  for (const [key, abbrs] of Object.entries(ABBREVIATIONS)) {
    if (words.some((w) => abbrs.includes(w) || w.includes(key))) {
      keywords.push(...abbrs);
    }
  }
  return [...new Set(keywords)];
}

/**
 * Score a filename against the keyword set. Verbatim from legacy: normalize the
 * filename to alnum-only, and for each keyword >= {@link SHORT_KEYWORD_MIN}
 * chars that is a substring, add the keyword's length (longer keyword ==
 * stronger match). Short keywords are ignored (avoids "pan" matching "Company").
 */
export function scoreFileName(fileName: string, keywords: readonly string[]): number {
  const fileLower = fileName.toLowerCase().replace(/[^a-z0-9]/g, "");
  let score = 0;
  for (const kw of keywords) {
    if (kw.length < SHORT_KEYWORD_MIN) continue;
    if (fileLower.includes(kw)) score += kw.length;
  }
  return score;
}

/**
 * True when a candidate filename is eligible before scoring: right extension,
 * not a schema/readme file, and neither the file nor its directory matches an
 * EXCLUDE_PATTERN. Verbatim from the legacy scan loop.
 */
export function isEligibleRepoFile(fileName: string, dirName?: string): boolean {
  if (!/\.(json|csv|txt|ndjson)$/i.test(fileName)) return false;
  if (/schema|readme|_schema/i.test(fileName)) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(fileName))) return false;
  if (dirName && EXCLUDE_PATTERNS.some((re) => re.test(dirName))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** An already-fetched candidate Sample-Data file. */
export interface RepoSampleCandidate {
  /** Bare file name (used for scoring + log-type derivation). */
  fileName: string;
  /** Full file text. */
  content: string;
  /** Immediate parent directory name (checked against EXCLUDE_PATTERNS). */
  dirName?: string;
  /** Extra score to add (legacy boosted local curated vendor samples). */
  boost?: number;
}

/** One resolved sentinel-repo sample. */
export interface RepoSample {
  vendor: string;
  logType: string;
  format: SampleFormat;
  eventCount: number;
  fieldCount: number;
  rawEvents: string[];
  timestampField: string;
  source: string;
  fields: DiscoveredField[];
  preIngested: boolean;
}

/** The resolution result (mirrors the legacy handler return). */
export interface RepoSampleResult {
  success: boolean;
  samples: RepoSample[];
  skippedPreIngested: number;
  filesSearched: number;
  message: string;
}

/** Options that widen resolution to per-table consolidation. */
export interface ResolveRepoOptions {
  /** Custom tables the solution defines (enables consolidation). */
  solutionTables?: ReadonlySet<string>;
  /** event_simpleName -> destination table routing (from DCR analysis). */
  eventToTable?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Messages (the THREE user-facing result messages)
// ---------------------------------------------------------------------------

/** Inputs for {@link buildRepoSampleMessage}. */
export interface RepoMessageInput {
  finalCount: number;
  finalEventTotal: number;
  skippedCount: number;
  matchedCount: number;
  rawSampleCount: number;
  hasSolutionTables: boolean;
}

/**
 * Build the user-facing result message. Verbatim from legacy: the THREE branches
 * are (1) found N samples (with optional "Skipped M pre-ingested." and
 * "Consolidated X event types into Y table groups." suffixes), (2) all matches
 * were pre-ingested Sentinel-schema data, (3) files matched but none parsed.
 */
export function buildRepoSampleMessage(input: RepoMessageInput): string {
  const { finalCount, finalEventTotal, skippedCount, matchedCount, rawSampleCount, hasSolutionTables } =
    input;
  if (finalCount > 0) {
    let msg = `Found ${finalCount} sample(s) with ${finalEventTotal} total events.`;
    if (skippedCount > 0) msg += ` Skipped ${skippedCount} pre-ingested.`;
    if (hasSolutionTables && rawSampleCount > finalCount) {
      msg += ` Consolidated ${rawSampleCount} event types into ${finalCount} table groups.`;
    }
    return msg;
  }
  if (skippedCount > 0) {
    return `All ${skippedCount} sample(s) are in Sentinel schema format. Upload raw vendor samples or capture live data.`;
  }
  return `Found ${matchedCount} matching file(s) but none could be parsed.`;
}

// ---------------------------------------------------------------------------
// Per-file split (with original-raw-line preservation)
// ---------------------------------------------------------------------------

function splitRepoFile(
  candidate: RepoSampleCandidate,
  solutionName: string,
  keywords: readonly string[],
): RepoSample[] {
  const { fileName, content } = candidate;
  if (!content.trim()) return [];

  const parsed = parseSampleContent(content, { sourceName: fileName });
  if (parsed.eventCount === 0) return [];

  const originalRawLines = content
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  const isCefOrLeef =
    parsed.format === "cef" || parsed.format === "leef" || parsed.format === "syslog";

  const eventObjects: Array<Record<string, unknown>> = [];
  for (const rawStr of parsed.rawEvents) {
    try {
      eventObjects.push(JSON.parse(rawStr) as Record<string, unknown>);
    } catch {
      // skip unparseable
    }
  }

  const discriminator =
    eventObjects.length > 0 ? selectDiscriminatorField(eventObjects) : undefined;

  const out: RepoSample[] = [];

  if (discriminator && eventObjects.length > 0) {
    const groups = new Map<string, Array<{ evt: Record<string, unknown>; rawLine: string }>>();
    for (let i = 0; i < eventObjects.length; i++) {
      const evt = eventObjects[i];
      const val = String(evt[discriminator] ?? "unknown");
      if (!groups.has(val)) groups.set(val, []);
      const rawLine =
        isCefOrLeef && i < originalRawLines.length ? originalRawLines[i] : JSON.stringify(evt);
      groups.get(val)!.push({ evt, rawLine });
    }

    for (const [typeValue, entries] of groups) {
      let logType = typeValue
        .replace(/[^a-zA-Z0-9_\- ]/g, "")
        .replace(/\s+/g, "_")
        .replace(/^_+|_+$/g, "");
      if (!logType) logType = "default";
      if (discriminator === "DeviceEventClassID" && PANOS_LOG_TYPES[logType]) {
        logType = PANOS_LOG_TYPES[logType];
      }

      const rawEvents = entries.map((e) => e.rawLine);
      const jsonEvents = entries.map((e) => JSON.stringify(e.evt));
      const groupParsed = parseSampleContent(jsonEvents.join("\n"), {
        sourceName: `${fileName}:${logType}`,
      });
      const fieldNames = groupParsed.fields.map((f) => f.name);

      out.push({
        vendor: solutionName,
        logType,
        format: isCefOrLeef ? parsed.format : groupParsed.format || parsed.format,
        eventCount: entries.length,
        fieldCount: groupParsed.fields.length,
        rawEvents,
        timestampField: groupParsed.timestampField || parsed.timestampField || "",
        source: `${fileName} [${discriminator}=${typeValue}]`,
        fields: groupParsed.fields,
        preIngested: detectPreIngested(fieldNames),
      });
    }
    return out;
  }

  // No discriminator: whole file as one log type, derived from the filename.
  let logType = fileName.replace(/\.[^.]+$/, "");
  for (const kw of keywords) {
    if (kw.length < SHORT_KEYWORD_MIN) continue;
    logType = logType.replace(new RegExp(`^${kw}[_\\-]?`, "i"), "");
  }
  logType = logType
    .replace(/_CL$/i, "")
    .replace(/_?RawLogs$/i, "")
    .replace(/_?IngestedLogs$/i, "")
    .replace(/_?SampleData$/i, "")
    .replace(/_?sample$/i, "")
    .replace(/^_+|_+$/g, "");
  if (!logType) logType = fileName.replace(/\.[^.]+$/, "");

  out.push({
    vendor: solutionName,
    logType,
    format: parsed.format,
    eventCount: parsed.eventCount,
    fieldCount: parsed.fields.length,
    rawEvents: isCefOrLeef ? originalRawLines.slice(0, parsed.eventCount) : parsed.rawEvents,
    timestampField: parsed.timestampField || "",
    source: fileName,
    fields: parsed.fields,
    preIngested: detectPreIngested(parsed.fields.map((f) => f.name)),
  });
  return out;
}

// ---------------------------------------------------------------------------
// Consolidation (CrowdStrike-style: many event types -> one per table)
// ---------------------------------------------------------------------------

/**
 * Merge many discriminator samples into one sample per destination table via the
 * event_simpleName -> table routing. Verbatim from legacy: up to 2 raw events
 * per source type, capped at {@link MAX_EVENTS_PER_TABLE}, merging the field set;
 * unmapped samples pass through (first 5). Returns the consolidated list.
 */
export function consolidateByTableRouting(
  rawSamples: readonly RepoSample[],
  eventToTable: ReadonlyMap<string, string>,
  solutionName: string,
): RepoSample[] {
  const tableGroups = new Map<string, RepoSample[]>();
  const unmapped: RepoSample[] = [];

  for (const sample of rawSamples) {
    const table = eventToTable.get(sample.logType);
    if (table) {
      if (!tableGroups.has(table)) tableGroups.set(table, []);
      tableGroups.get(table)!.push(sample);
    } else {
      unmapped.push(sample);
    }
  }

  const consolidated: RepoSample[] = [];
  for (const [tableName, tableSamples] of tableGroups) {
    const mergedRawEvents: string[] = [];
    const allFields = new Map<string, DiscoveredField>();
    for (const sample of tableSamples) {
      for (const raw of (sample.rawEvents || []).slice(0, 2)) {
        if (mergedRawEvents.length < MAX_EVENTS_PER_TABLE) mergedRawEvents.push(raw);
      }
      for (const field of sample.fields || []) {
        if (!allFields.has(field.name)) allFields.set(field.name, { ...field });
      }
    }
    consolidated.push({
      vendor: solutionName,
      logType: tableName.replace(/_CL$/, ""),
      format: tableSamples[0]?.format || "ndjson",
      eventCount: mergedRawEvents.length,
      fieldCount: allFields.size,
      rawEvents: mergedRawEvents,
      timestampField: tableSamples[0]?.timestampField || "",
      source: `${tableSamples.length} event types -> ${tableName}`,
      fields: [...allFields.values()],
      preIngested: false,
    });
  }

  for (const sample of unmapped.slice(0, 5)) {
    consolidated.push(sample);
  }

  return consolidated;
}

// ---------------------------------------------------------------------------
// Top-level resolver
// ---------------------------------------------------------------------------

/**
 * Resolve sentinel-repo samples for a solution from already-fetched candidate
 * files. Verbatim pipeline from legacy `findSentinelRepoSamples`: build
 * keywords, score + filter eligible files, keep the >= 8 scorers, take the top
 * 20, split each (with original-raw-line preservation), drop pre-ingested
 * samples, optionally consolidate per table, and compose the message.
 */
export function resolveRepoSamples(
  solutionName: string,
  candidates: readonly RepoSampleCandidate[],
  options: ResolveRepoOptions = {},
): RepoSampleResult {
  const keywords = buildSampleKeywords(solutionName);

  const scored: Array<{ candidate: RepoSampleCandidate; score: number }> = [];
  for (const candidate of candidates) {
    if (!isEligibleRepoFile(candidate.fileName, candidate.dirName)) continue;
    const score = scoreFileName(candidate.fileName, keywords) + (candidate.boost ?? 0);
    if (score > 0) scored.push({ candidate, score });
  }

  const matchedCount = scored.length;
  const strong = scored.filter((s) => s.score >= REPO_MATCH_MIN_SCORE);

  if (strong.length === 0) {
    return {
      success: true,
      samples: [],
      skippedPreIngested: 0,
      filesSearched: matchedCount,
      message: `No sample data found for "${solutionName}" in Sentinel repo.`,
    };
  }

  strong.sort((a, b) => b.score - a.score);
  const top = strong.slice(0, MAX_TOP_FILES);

  const samples: RepoSample[] = [];
  for (const { candidate } of top) {
    try {
      samples.push(...splitRepoFile(candidate, solutionName, keywords));
    } catch {
      // skip unparseable files
    }
  }

  const rawSamples = samples.filter((s) => !s.preIngested);
  const skippedCount = samples.length - rawSamples.length;

  const hasSolutionTables = (options.solutionTables?.size ?? 0) > 0;
  let finalSamples = rawSamples;
  if (
    hasSolutionTables &&
    rawSamples.length > 20 &&
    options.eventToTable &&
    options.eventToTable.size > 0
  ) {
    finalSamples = consolidateByTableRouting(rawSamples, options.eventToTable, solutionName);
  }

  const finalEventTotal = finalSamples.reduce((s, x) => s + x.eventCount, 0);
  const message = buildRepoSampleMessage({
    finalCount: finalSamples.length,
    finalEventTotal,
    skippedCount,
    matchedCount,
    rawSampleCount: rawSamples.length,
    hasSolutionTables,
  });

  return {
    success: true,
    samples: finalSamples,
    skippedPreIngested: skippedCount,
    filesSearched: matchedCount,
    message,
  };
}
