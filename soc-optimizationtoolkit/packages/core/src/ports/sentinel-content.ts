/**
 * SentinelContent port - the ONE seam for reading Microsoft Sentinel content
 * (the Azure/Azure-Sentinel GitHub repo and the sibling sample repos) from
 * shared code (porting-plan Unit 14; ENG-21 redesigned, ENG-30, ENG-52
 * superseded).
 *
 * REDESIGN (catalog line 103, legacy-flow-analysis "LAZY-FETCH NEW WORKFLOW"):
 * the legacy `sentinel-repo.ts` bulk-MIRRORED the whole repo to disk (~30-50MB,
 * 549 solutions / 332 samples) and then every module read from the local mirror.
 * That architecture does NOT port: the cloud shell has no disk and a 100 req/min
 * proxy budget that a 600-2500-call prefetch would blow instantly. This port is
 * designed for LAZY, on-demand, per-selected-solution tree queries plus targeted
 * raw fetches - NEVER a whole-repo recursive tree walk. Parsed results are cached
 * by the {@link ContentCache} keyed by solution + commit SHA (immutable content),
 * so a solution is fetched at most once per repo commit.
 *
 * Adapters (bound by each shell, NOT here):
 * - Cloud shell: api.github.com + raw.githubusercontent.com through proxies.yml
 *   with the PAT injected server-side (the token never reaches browser code);
 *   ContentCache -> KV.
 * - Local shell: the Node host does the fetch (may still keep an on-disk cache);
 *   ContentCache -> host store. If IOC-laden rule content is ever written to
 *   disk, the EDR content filter (domain/sentinel-content/edr-filter) is
 *   MANDATORY on that persistence path.
 *
 * The port is the INTERFACE only. All fetching lives in the shell adapters; this
 * package stays zero-IO/zero-fetch. The pure knowledge that used to be tangled
 * into the mirror (file selection, deprecation heuristics, the connector decoder,
 * normalizeDcrType, the EDR blocklist, cache-key derivation, the PAT policy)
 * lives in domain/sentinel-content and is exercised over this port's data.
 */

/** A solution directory under `Solutions/`, with optional deprecation status. */
export interface SolutionRef {
  /** Solution directory name, e.g. "CrowdStrike Falcon Endpoint Protection". */
  name: string;
  /** Repo-relative path, e.g. "Solutions/CrowdStrike Falcon Endpoint Protection". */
  path: string;
  /** True when the deprecation heuristics flagged the solution. */
  deprecated?: boolean;
  /** Human-readable reason when {@link deprecated}. */
  deprecationReason?: string;
}

/** A single file inside a solution subtree. */
export interface SolutionFileRef {
  /** Bare file name, e.g. "CrowdStrikeCustomDCR.json". */
  name: string;
  /** Repo-relative path, e.g. "Solutions/<sol>/Data Connectors/.../file.json". */
  path: string;
  /** Byte size when known (0 when the adapter cannot cheaply determine it). */
  size: number;
}

/**
 * Read-only accessor over Sentinel content. Every method is async and LAZY:
 * an implementation resolves exactly the queried solution/subtree, never the
 * whole repo. All methods are pure reads - none mutate remote state.
 *
 * Error semantics mirror the legacy accessors: list methods resolve `[]` when
 * the target does not exist; `readFile`/`rawFetch` resolve `null` for a missing
 * or unreadable file rather than rejecting. They reject only on a genuine
 * transport failure the caller should surface (network down, auth rejected).
 */
export interface SentinelContent {
  /**
   * List the solution directories under `Solutions/`, sorted by name, each
   * annotated with deprecation status. Resolves `[]` when none are reachable.
   */
  listSolutions(): Promise<SolutionRef[]>;

  /**
   * List the files directly inside `Solutions/<solutionName>/<subDir>` (one
   * level, non-recursive). Resolves `[]` when the directory is absent.
   */
  listSolutionFiles(
    solutionName: string,
    subDir: string,
  ): Promise<SolutionFileRef[]>;

  /**
   * List the connector JSON files for a solution, RECURSIVELY (DCR files nest
   * 2+ levels deep, e.g.
   * `Data Connectors/CrowdstrikeReplicatorCLv2/Data Collection Rules/CrowdStrikeCustomDCR.json`).
   * Handles the "Data Connectors" / "DataConnectors" / "data_connectors" dir
   * name variants. Resolves `[]` when the solution has no connector directory.
   */
  listConnectorFiles(solutionName: string): Promise<SolutionFileRef[]>;

  /**
   * Read a repo-relative file's text lazily (the adapter decides fetch/cache).
   * Resolves `null` for a missing or unreadable file.
   */
  readFile(relativePath: string): Promise<string | null>;

  /**
   * Fetch a repo-relative file's text pinned to `commitSha` - the immutable
   * raw-content path (the legacy `githubRaw`). Content at a commit never
   * changes, so results are safe to cache by solution + commit. Resolves `null`
   * for a missing file.
   */
  rawFetch(relativePath: string, commitSha: string): Promise<string | null>;

  /**
   * Resolve the current HEAD commit SHA of the tracked branch. This is the
   * cache-invalidation stamp: cache keys combine solution + this SHA, so a new
   * upstream commit transparently invalidates stale entries. Resolves `null`
   * when the ref cannot be resolved.
   */
  getCommitSha(): Promise<string | null>;
}

/**
 * The ONLY PAT-derived shape that crosses the port boundary back to shared
 * code (structurally identical to the domain `PatStatus` from
 * domain/sentinel-content/pat-policy). It NEVER carries the token: a
 * GithubPatManager validates and stores a submitted PAT server-side and hands
 * back only whether one is now present plus the resolved GitHub login. Declared
 * here (not imported from the domain) so the port stays free of any domain
 * dependency edge.
 */
export interface PatManagerStatus {
  /** True when a validated PAT is stored for this app/host. */
  hasPat: boolean;
  /** The GitHub login resolved at validation time (not a secret). */
  login?: string;
  /**
   * The reason a `validateAndStore` attempt did not result in a stored PAT
   * (bad format, GitHub rejected the token, etc.) - a user-facing message,
   * NEVER the token. Present only on a failed validation; absent on success and
   * on plain `status()` reads.
   */
  error?: string;
}

/**
 * GithubPatManager - the seam for the GitHub PAT lifecycle (porting-plan Unit
 * 14; ENG-30). VALIDATE-THEN-STORE, WRITE-ONLY: {@link validateAndStore} calls
 * GET /user through the proxied/host GitHub path (the token injected
 * server-side) and stores the token encrypted ONLY on a 200; the token is never
 * returned to the renderer - {@link status} exposes `hasPat` and the login,
 * never the secret. All fetching/storage lives in the shell adapters; core
 * never builds an auth header.
 */
export interface GithubPatManager {
  /** Resolve whether a validated PAT is stored (and the login), never the token. */
  status(): Promise<PatManagerStatus>;

  /**
   * Validate `pat` (GET /user) and, only on success, store it encrypted. The
   * token never crosses back - the result carries `hasPat` and the login. A
   * failed validation resolves `{ hasPat: false }` and stores nothing that can
   * be used (any provisional write is rolled back by the adapter).
   */
  validateAndStore(pat: string): Promise<PatManagerStatus>;

  /** Remove the stored PAT (and its status marker). Idempotent. */
  clear(): Promise<void>;
}

/**
 * ContentCache abstraction - parsed results cached keyed by solution + commit
 * SHA. The domain derives keys via `contentCacheKey`
 * (domain/sentinel-content/cache-key); the shell binds the backing store:
 * - Cloud shell: KV (respecting write volume; only parsed results, not raw
 *   bytes, are cached).
 * - Local shell: the host store.
 *
 * Values are JSON-serializable (the decoder projections, the parsed rule lists,
 * the solution index). `get` resolves `null` on a miss; because cached values
 * are always objects/arrays, `null` is an unambiguous miss signal. Both methods
 * reject only on a genuine backend failure.
 */
export interface ContentCache {
  /** Resolve the cached value for `key`, or `null` when absent. */
  get(key: string): Promise<unknown | null>;

  /** Store `value` under `key`, replacing any previous entry. */
  set(key: string, value: unknown): Promise<void>;
}
