/**
 * Tier precedence + the pure browse/load transforms - porting-plan Unit 16
 * (ENG-19, GUI-06 browse modal). The FETCH lives in the shell/usecase; every
 * function here is a pure transform over already-fetched file contents, so the
 * ID-STABILITY footgun (browse id === load id) is testable without any IO.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { SampleFormat } from "../sample-parsing/models";
import { detectSampleFormat } from "../sample-parsing/index";
import {
  type AvailableSample,
  type ResolvedSample,
  type SampleTier,
  TIER_PRECEDENCE,
  ELASTIC_EVENT_CAP,
  CRIBL_EVENT_CAP,
  USER_EVENT_CAP,
  PREVIEW_EVENT_COUNT,
} from "./models";
import {
  parseElasticFileContent,
  unwrapElasticEvents,
  logTypeFromFilename,
} from "./elastic-parsing";
import {
  splitSamplesByLogType,
  browseSampleId,
  hasNamedFields,
  convertPanosSplitAtLoad,
} from "./splitting";
import type { RepoSample, RepoSampleResult } from "./repo-samples";

// ---------------------------------------------------------------------------
// Tier precedence
// ---------------------------------------------------------------------------

/**
 * Pick the winning tier's samples by {@link TIER_PRECEDENCE} (user > cribl >
 * elastic > synthesized): the first tier that has any samples wins outright,
 * exactly like the legacy `resolveSamples` short-circuit chain. Returns [] when
 * every tier is empty.
 */
export function selectByPrecedence(
  byTier: ReadonlyMap<SampleTier, readonly ResolvedSample[]>,
): ResolvedSample[] {
  for (const tier of TIER_PRECEDENCE) {
    const samples = byTier.get(tier);
    if (samples && samples.length > 0) return [...samples];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Elastic tier: one fetched test file -> browse entries / loaded samples
// ---------------------------------------------------------------------------

/** A fetched Elastic test file within one package + data stream. */
export interface ElasticFile {
  /** Elastic package (e.g. "cisco_asa"). */
  packageName: string;
  /** Data stream (e.g. "log"). */
  stream: string;
  /** Test file name (e.g. "test-cisco-asa.log"). */
  fileName: string;
  /** Full file text. */
  content: string;
}

/** The provenance source id for an Elastic file (matches legacy). */
export function elasticSourceId(file: ElasticFile): string {
  return `elastic:${file.packageName}/${file.stream}/${file.fileName}`;
}

/** Parse + unwrap + cap one Elastic file into its raw event lines and format. */
function elasticEvents(file: ElasticFile): { events: string[]; format: SampleFormat } {
  const parsed = unwrapElasticEvents(parseElasticFileContent(file.content, file.fileName));
  const events = parsed.slice(0, ELASTIC_EVENT_CAP);
  const format =
    events.length > 0
      ? detectSampleFormat(events[0], { mode: "strict" })
      : detectSampleFormat(file.content, { mode: "strict" });
  return { events, format };
}

/**
 * Browse-list entries for one Elastic file: split by log type, drop splits
 * without self-describing field names, and build the STABLE id
 * `${elasticSourceId}:${logType}`. Verbatim from legacy `listAvailableSamples`.
 */
export function browseElasticFile(file: ElasticFile): AvailableSample[] {
  const { events, format } = elasticEvents(file);
  if (events.length === 0) return [];
  const source = elasticSourceId(file);
  const fileLogType = logTypeFromFilename(file.fileName, file.packageName);
  const splits = splitSamplesByLogType(events, fileLogType, format);

  const out: AvailableSample[] = [];
  for (const split of splits) {
    if (!hasNamedFields(split.rawEvents, split.format)) continue;
    out.push({
      id: browseSampleId(source, split.logType),
      tier: "elastic",
      source: `Elastic: ${file.packageName}`,
      logType: split.logType,
      format: split.format,
      eventCount: split.eventCount,
      fileName: file.fileName,
      preview: split.rawEvents.slice(0, PREVIEW_EVENT_COUNT),
    });
  }
  return out;
}

/**
 * Loaded samples for the splits of one Elastic file whose id is selected. Uses
 * the SAME split + id construction as {@link browseElasticFile} (the footgun),
 * applies PAN-OS load-time conversion, and tags the sample with the solution's
 * destination table. Verbatim from legacy `loadSelectedSamples`.
 */
export function loadElasticFile(
  file: ElasticFile,
  selectedIds: ReadonlySet<string>,
  sentinelTable: string,
): ResolvedSample[] {
  const { events, format } = elasticEvents(file);
  if (events.length === 0) return [];
  const source = elasticSourceId(file);
  const fileLogType = logTypeFromFilename(file.fileName, file.packageName);
  const splits = splitSamplesByLogType(events, fileLogType, format);

  const out: ResolvedSample[] = [];
  for (const split of splits) {
    const splitId = browseSampleId(source, split.logType);
    if (!selectedIds.has(splitId)) continue;
    const converted = convertPanosSplitAtLoad(split.rawEvents, split.format);
    out.push({
      tableName: sentinelTable,
      format: converted.format,
      rawEvents: converted.rawEvents,
      source: splitId,
      tier: "elastic",
      logType: split.logType,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cribl pack tier: fetched data/samples files -> loaded samples
// ---------------------------------------------------------------------------

/** A fetched Cribl pack sample file (`<repo>/data/samples/<file>.json`). */
export interface CriblPackFile {
  /** Sample file name (e.g. "cisco-asa.json"). */
  fileName: string;
  /** Full file text (a JSON array or a single enveloped object). */
  content: string;
}

/**
 * Read a Cribl pack's sample files into resolved samples. Verbatim from legacy
 * `readCachedCriblSamples`: parse each file (array or single object), unwrap the
 * Cribl envelope's `_raw` when present, cap at {@link CRIBL_EVENT_CAP}, detect
 * the inner format, and tag tier "cribl" with source `cribl:<repo>/<file>`.
 * Unparseable files are skipped.
 */
export function readCriblPackSamples(
  repoName: string,
  sentinelTable: string,
  files: readonly CriblPackFile[],
): ResolvedSample[] {
  const results: ResolvedSample[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch {
      continue;
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const rawEvents: string[] = [];
    for (const evt of events.slice(0, CRIBL_EVENT_CAP)) {
      if (typeof evt === "object" && evt !== null && "_raw" in evt) {
        const raw = (evt as { _raw: unknown })._raw;
        rawEvents.push(typeof raw === "string" ? raw : JSON.stringify(raw));
      } else {
        rawEvents.push(typeof evt === "string" ? evt : JSON.stringify(evt));
      }
    }
    if (rawEvents.length === 0) continue;
    results.push({
      tableName: sentinelTable,
      format: detectSampleFormat(rawEvents[0], { mode: "strict" }),
      rawEvents,
      source: `cribl:${repoName}/${file.fileName}`,
      tier: "cribl",
      logType: file.fileName.replace(/\.json$/, ""),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Sentinel-repo tier: RepoSample -> browse entries / loaded samples
// ---------------------------------------------------------------------------

/** The STABLE browse id for a repo sample (legacy `sentinel-repo:logType:source`). */
export function repoBrowseId(sample: RepoSample): string {
  return `sentinel-repo:${sample.logType}:${sample.source}`;
}

/**
 * Browse-list entries for a resolved sentinel-repo result: skip pre-ingested
 * samples, DEDUPE by logType (keep the first), and build the stable id.
 * Verbatim from legacy `listAvailableSamples` Tier 0.
 */
export function browseRepoResult(result: RepoSampleResult): AvailableSample[] {
  const out: AvailableSample[] = [];
  const seen = new Set<string>();
  for (const s of result.samples) {
    if (s.preIngested) continue;
    if (seen.has(s.logType)) continue;
    seen.add(s.logType);
    out.push({
      id: repoBrowseId(s),
      tier: "sentinel-repo",
      source: `Sentinel Repo: ${s.source}`,
      logType: s.logType,
      format: s.format,
      eventCount: s.eventCount,
      fileName: s.source,
      preview: (s.rawEvents || []).slice(0, PREVIEW_EVENT_COUNT),
    });
  }
  return out;
}

/**
 * Loaded samples for the selected sentinel-repo ids. Matches EVERY sample whose
 * id is selected (no dedupe at load - the legacy quirk), tagging each with the
 * `sentinel-repo:` source prefix. Verbatim from legacy `loadSelectedSamples`.
 */
export function loadRepoResult(
  result: RepoSampleResult,
  selectedIds: ReadonlySet<string>,
): ResolvedSample[] {
  const out: ResolvedSample[] = [];
  for (const s of result.samples) {
    if (!selectedIds.has(repoBrowseId(s))) continue;
    out.push({
      tableName: s.logType,
      format: s.format,
      rawEvents: s.rawEvents || [],
      source: `sentinel-repo:${s.source}`,
      tier: "sentinel-repo",
      logType: s.logType,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// User tier (Tier 4 override)
// ---------------------------------------------------------------------------

/** One user-uploaded/pasted sample. */
export interface UserSampleInput {
  /** The log type the user tagged. */
  logType: string;
  /** Raw file/paste content. */
  content: string;
  /** File name (or a paste label). */
  fileName: string;
}

/**
 * Resolve user-uploaded samples (the highest-precedence tier). Verbatim from
 * legacy `resolveSamples` user branch: detect the format, split JSON arrays into
 * events (else line-split), cap at {@link USER_EVENT_CAP}, and tag tier "user".
 */
export function resolveUserSamples(
  userSamples: readonly UserSampleInput[],
  solutionName: string,
): ResolvedSample[] {
  const results: ResolvedSample[] = [];
  for (const sample of userSamples) {
    const format = detectSampleFormat(sample.content, { mode: "strict" });
    let events: string[];
    if (format === "json") {
      try {
        const parsed = JSON.parse(sample.content);
        events = Array.isArray(parsed)
          ? parsed.map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
          : [sample.content.trim()];
      } catch {
        events = sample.content.trim().split("\n").filter(Boolean);
      }
    } else {
      events = sample.content.trim().split("\n").filter(Boolean);
    }
    results.push({
      tableName: sample.logType || solutionName,
      format,
      rawEvents: events.slice(0, USER_EVENT_CAP),
      source: `user:${sample.fileName}`,
      tier: "user",
      logType: sample.logType,
    });
  }
  return results;
}
