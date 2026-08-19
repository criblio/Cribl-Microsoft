/**
 * RemoteSampleSource port: the seam for the two sibling GitHub repos the
 * SentinelContent port cannot address (elastic/integrations and criblpacks/*).
 * Bound by each shell over the SAME hosts SentinelContent already uses
 * (api.github.com + raw.githubusercontent.com) - no new external surface.
 *
 * REHOMED 2026-08-18 (ADR 0003, sample-browser removal). This interface was
 * declared inside the acquire-samples usecase, which the browser removal
 * deleted. It survives because the Repositories screen uses it INDEPENDENTLY of
 * sample acquisition: a connectivity check that lists an Elastic package's
 * test files to prove the proxied GitHub path works
 * (repositories-screen.tsx listElasticTestFiles). A port belongs in ports/,
 * not in a usecase, so the move also puts it where the other six live.
 *
 * Adapters own transport and authentication; neither surfaces here.
 */

/** A fetched remote file (elastic test file or cribl pack sample). */
export interface FetchedSampleFile {
  /** Bare file name. */
  fileName: string;
  /** Full file text. */
  content: string;
}

/**
 * Read-only access to the two sibling sample repos.
 *
 * Error semantics: a missing directory resolves to `[]` (never rejects for
 * absence); transport and non-404 HTTP failures reject.
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
