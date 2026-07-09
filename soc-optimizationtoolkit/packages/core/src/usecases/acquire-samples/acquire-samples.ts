/**
 * Tiered sample ACQUISITION usecase (porting-plan Unit 16, ENG-19 / ENG-20
 * redesigned) - the lazy, per-selected-solution fetch orchestration behind the
 * GUI-06 browse-samples modal. Pure orchestration over the ports; every fetch
 * lives behind an injected adapter, and all transformation is the pure
 * domain/sample-acquisition code.
 *
 * ENG-20 redesign: the legacy EAGER prefetch of all ~22 mapped vendors at
 * startup is NOT ported. Content is fetched only when a solution is browsed, and
 * only for that solution's mapped sources. The 12h staleness idea survives as
 * the shell adapter's KV cache TTL (the adapter caches per solution + commit);
 * this usecase does not cache - it re-derives deterministically from what the
 * adapters return.
 *
 * Three lazy tiers are wired here:
 * - SENTINEL-REPO (browse + load) via the Unit 14 SentinelContent port: list the
 *   solution's Sample Data directory, read the files, run the ENG-42 scorer.
 * - ELASTIC (browse + load) via {@link RemoteSampleSource}: list a package's
 *   test-pipeline files per data stream, split by log type.
 * - CRIBL (load) via {@link RemoteSampleSource}: read a pack's data/samples.
 *
 * The elastic/cribl seam is bound by each shell over the SAME GitHub hosts the
 * Unit 14 port already uses (api.github.com + raw.githubusercontent.com) - no
 * new external surface. The SentinelContent port cannot address the sibling
 * repos (elastic/integrations, criblpacks/*), so those two tiers take this
 * minimal function seam instead.
 *
 * Pure orchestration: no IO of its own, no fetch, no React, no Date/crypto.
 */

import type { SentinelContent } from "../../ports/sentinel-content";
import type { Logger } from "../../ports/logger";
import { SAMPLE_DATA_DIR_NAMES } from "../../domain/sentinel-content/discovery";
import {
  MAX_REPO_ROOT_SAMPLE_READS,
  MAX_REPO_SAMPLE_FILE_BYTES,
  REPO_SAMPLE_DATA_DIRS,
  buildSampleKeywords,
  isEligibleRepoFile,
  lookupSolution,
  resolveRepoSamples,
  scoreFileName,
  browseRepoResult,
  loadRepoResult,
  browseElasticFile,
  loadElasticFile,
  readCriblPackSamples,
  type AvailableSample,
  type ResolvedSample,
  type RepoSampleCandidate,
  type RepoSampleResult,
} from "../../domain/sample-acquisition/index";

/** A fetched remote file (elastic test file or cribl pack sample). */
export interface FetchedSampleFile {
  /** Bare file name. */
  fileName: string;
  /** Full file text. */
  content: string;
}

/**
 * The seam for the two sibling GitHub repos the SentinelContent port cannot
 * address. Bound by each shell over api.github.com + raw.githubusercontent.com
 * (the Unit 14 hosts); the cloud adapter caches per solution + commit in KV.
 */
export interface RemoteSampleSource {
  /** List an Elastic package's test-pipeline files for one data stream ([] when absent). */
  listElasticTestFiles(
    packageName: string,
    stream: string,
  ): Promise<FetchedSampleFile[]>;
  /** List a Cribl pack repo's data/samples files ([] when absent). */
  listCriblPackSamples(repoName: string): Promise<FetchedSampleFile[]>;
}

/** Injected dependencies for the acquisition usecase. */
export interface AcquireSamplesDeps {
  /** The Unit 14 content port (Azure-Sentinel repo) for the sentinel-repo tier. */
  content: SentinelContent;
  /** The elastic/cribl fetch seam. */
  source: RemoteSampleSource;
  /** Optional diagnostics. */
  logger?: Logger;
}

const DEFAULT_STREAMS = ["log"] as const;

/** Candidate gathering outcome: the files plus non-fatal fetch notes. */
interface RepoCandidateGathering {
  candidates: RepoSampleCandidate[];
  /**
   * Human-readable notes for every listing/read that failed (deduplicated).
   * The browse modal shows them as a partial-results warning - a single
   * failing directory or file must degrade the sentinel tier, never kill the
   * whole browse (live report 2026-07-08: one bridged "Failed to fetch"
   * blanked the modal).
   */
  notes: string[];
}

/**
 * Gather candidate Sample-Data files for a solution from the SentinelContent
 * port (one level per SAMPLE_DATA_DIR_NAMES variant). EVERY listing and read
 * is individually guarded: unreadable or failing files are skipped with a
 * note, and files the directory listing reports as larger than
 * MAX_REPO_SAMPLE_FILE_BYTES are never read at all (a tagged sample keeps at
 * most 200 events - and oversized responses are what the cloud shell's fetch
 * bridge refuses). The pure ENG-42 scorer decides which candidates match.
 */
async function gatherRepoCandidates(
  content: SentinelContent,
  solutionName: string,
  logger?: Logger,
): Promise<RepoCandidateGathering> {
  const candidates: RepoSampleCandidate[] = [];
  const notes = new Set<string>();
  const errText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const readCandidate = async (
    path: string,
    name: string,
    size: number,
    dirName: string,
  ): Promise<void> => {
    if (size > MAX_REPO_SAMPLE_FILE_BYTES) {
      logger?.debug("acquire-samples: sample file too large, skipped", {
        file: name,
        size,
      });
      return;
    }
    try {
      const text = await content.readFile(path);
      if (text === null) {
        logger?.debug("acquire-samples: repo sample unreadable", {
          solution: solutionName,
          file: name,
        });
        return;
      }
      candidates.push({ fileName: name, content: text, dirName });
    } catch (err) {
      notes.add(`Reading ${name} failed: ${errText(err)}`);
    }
  };

  for (const dir of SAMPLE_DATA_DIR_NAMES) {
    try {
      const files = await content.listSolutionFiles(solutionName, dir);
      for (const file of files) {
        await readCandidate(file.path, file.name, file.size, dir);
      }
    } catch (err) {
      notes.add(`Listing ${solutionName}/${dir} failed: ${errText(err)}`);
    }
  }

  // REPO-ROOT Sample Data (the legacy's PRIMARY location): most solutions ship
  // no per-solution Sample Data folder - their raw vendor files live under the
  // repo-root "Sample Data" tree. List each search dir (one call each), score
  // FILE NAMES with the same ENG-42 keyword scorer resolveRepoSamples uses,
  // and READ only the top matches (bounded raw fetches). A failing directory
  // listing is non-fatal.
  const keywords = buildSampleKeywords(solutionName);
  const rootMatches: Array<{
    name: string;
    path: string;
    size: number;
    dirName: string;
    score: number;
  }> = [];
  for (const dir of REPO_SAMPLE_DATA_DIRS) {
    try {
      const files = await content.listRepoFiles(dir);
      const dirName = dir.split("/").pop() ?? dir;
      for (const file of files) {
        if (!isEligibleRepoFile(file.name, dirName)) continue;
        const score = scoreFileName(file.name, keywords);
        if (score > 0) {
          rootMatches.push({
            name: file.name,
            path: file.path,
            size: file.size,
            dirName,
            score,
          });
        }
      }
    } catch (err) {
      notes.add(`Listing ${dir} failed: ${errText(err)}`);
    }
  }
  rootMatches.sort((a, b) => b.score - a.score);
  const seenNames = new Set(candidates.map((c) => c.fileName));
  for (const match of rootMatches.slice(0, MAX_REPO_ROOT_SAMPLE_READS)) {
    if (seenNames.has(match.name)) continue;
    seenNames.add(match.name);
    await readCandidate(match.path, match.name, match.size, match.dirName);
  }
  logger?.info("acquire-samples: repo candidates", {
    solution: solutionName,
    candidates: candidates.length,
    rootMatched: rootMatches.length,
    notes: notes.size,
  });
  return { candidates, notes: [...notes] };
}

/**
 * The DETAILED browse result: the flat browse-list entries {@link browseSamples}
 * returns, PLUS the sentinel-repo resolution result the UI needs to surface the
 * ENG-42 preIngested messaging honestly (its `skippedPreIngested` count and the
 * one-of-three user-facing `message`). `repo` is null when the solution has no
 * Sample-Data candidates at all (nothing was fetched to resolve).
 */
export interface BrowseSamplesResult {
  /** Browse-list entries across every browsable tier (stable ids). */
  available: AvailableSample[];
  /** The sentinel-repo resolution (null when no candidates existed). */
  repo: RepoSampleResult | null;
  /**
   * Non-fatal per-tier fetch failures (a directory listing, a file read, or a
   * whole tier). The modal renders these as a partial-results warning: browse
   * degrades to whatever loaded instead of dying on the first failure.
   */
  warnings: string[];
}

/**
 * Browse the samples available for a solution (metadata only, no full load),
 * returning both the flat entry list AND the sentinel-repo resolution result so
 * the browse modal can surface the ENG-42 preIngested messaging honestly. The
 * returned ids are STABLE - the same ids {@link loadSamples} consumes.
 */
export async function browseSamplesDetailed(
  deps: AcquireSamplesDeps,
  input: { solutionName: string },
): Promise<BrowseSamplesResult> {
  const { content, source, logger } = deps;
  const { solutionName } = input;
  const entry = lookupSolution(solutionName);
  const results: AvailableSample[] = [];
  const warnings: string[] = [];
  let repo: RepoSampleResult | null = null;

  // Tier 0: sentinel-repo. gatherRepoCandidates guards every listing/read
  // itself and reports failures as notes.
  const gathered = await gatherRepoCandidates(content, solutionName, logger);
  warnings.push(...gathered.notes);
  if (gathered.candidates.length > 0) {
    repo = resolveRepoSamples(solutionName, gathered.candidates);
    results.push(...browseRepoResult(repo));
  }

  // Tier 1: elastic. A failing stream degrades to a warning - the sentinel
  // entries above must still render (and vice versa).
  if (entry?.elasticPackage) {
    const streams =
      entry.elasticDataStreams && entry.elasticDataStreams.length > 0
        ? entry.elasticDataStreams
        : [...DEFAULT_STREAMS];
    for (const stream of streams) {
      try {
        const files = await source.listElasticTestFiles(entry.elasticPackage, stream);
        for (const file of files) {
          results.push(
            ...browseElasticFile({
              packageName: entry.elasticPackage,
              stream,
              fileName: file.fileName,
              content: file.content,
            }),
          );
        }
      } catch (err) {
        warnings.push(
          `Elastic samples (${entry.elasticPackage}/${stream}) unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  logger?.info("acquire-samples: browsed", {
    solution: solutionName,
    count: results.length,
    warnings: warnings.length,
  });
  return { available: results, repo, warnings };
}

/**
 * Browse the samples available for a solution (metadata only, no full load):
 * sentinel-repo entries (deduped, pre-ingested dropped) plus elastic entries
 * (split by log type, self-describing only). The returned ids are STABLE - the
 * same ids {@link loadSamples} consumes. A thin projection over
 * {@link browseSamplesDetailed} that drops the repo detail.
 */
export async function browseSamples(
  deps: AcquireSamplesDeps,
  input: { solutionName: string },
): Promise<AvailableSample[]> {
  return (await browseSamplesDetailed(deps, input)).available;
}

/**
 * Load the full content for the selected sample ids across every tier that can
 * own them: sentinel-repo (ids `sentinel-repo:...`), elastic (ids
 * `${source}:${logType}`, PAN-OS converted at load), and cribl (ids
 * `cribl:<repo>/<file>`). Ids that match nothing are silently ignored.
 */
export async function loadSamples(
  deps: AcquireSamplesDeps,
  input: { solutionName: string; selectedIds: readonly string[] },
): Promise<ResolvedSample[]> {
  const { content, source, logger } = deps;
  const { solutionName, selectedIds } = input;
  const entry = lookupSolution(solutionName);
  const idSet = new Set(selectedIds);
  const results: ResolvedSample[] = [];

  // Sentinel-repo. Listing/read failures are skipped inside the gathering
  // (logged as warn here): a selected id whose file failed simply does not
  // resolve, and the load summary reports the honest count.
  if (selectedIds.some((id) => id.startsWith("sentinel-repo:"))) {
    const gathered = await gatherRepoCandidates(content, solutionName, logger);
    for (const note of gathered.notes) {
      logger?.warn("acquire-samples: load-time repo fetch issue", { note });
    }
    if (gathered.candidates.length > 0) {
      const repoResult = resolveRepoSamples(solutionName, gathered.candidates);
      results.push(...loadRepoResult(repoResult, idSet));
    }
  }

  // Elastic.
  if (entry?.elasticPackage) {
    const streams =
      entry.elasticDataStreams && entry.elasticDataStreams.length > 0
        ? entry.elasticDataStreams
        : [...DEFAULT_STREAMS];
    for (const stream of streams) {
      const files = await source.listElasticTestFiles(entry.elasticPackage, stream);
      for (const file of files) {
        results.push(
          ...loadElasticFile(
            {
              packageName: entry.elasticPackage,
              stream,
              fileName: file.fileName,
              content: file.content,
            },
            idSet,
            entry.sentinelTable,
          ),
        );
      }
    }
  }

  // Cribl.
  if (entry?.criblPackRepo) {
    const files = await source.listCriblPackSamples(entry.criblPackRepo);
    const cribl = readCriblPackSamples(
      entry.criblPackRepo,
      entry.sentinelTable,
      files,
    );
    for (const s of cribl) {
      if (idSet.has(s.source)) results.push(s);
    }
  }

  logger?.info("acquire-samples: loaded", {
    solution: solutionName,
    selected: selectedIds.length,
    loaded: results.length,
  });
  return results;
}
