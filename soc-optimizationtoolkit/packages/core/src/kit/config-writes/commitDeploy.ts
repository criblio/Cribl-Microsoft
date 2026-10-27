// Commit and deploy a worker group's config — scoped, checked after the write, and compared by
// prefix.
//
// Standard: standards/config-plane-writes.md rule 7 (and its "Measured: what a Cribl commit
// carries" section).
//
// Provenance:
//  - `POST /version/commit` takes `{message, files}` — FILE PATHS, committed whole — Documented
//    (OpenAPI 4.19.0, GitCommitBody.files). One YAML file holds every source / every route in a
//    group, so a commit carries other people's uncommitted edits in those files.
//  - `/version/status` lists pending paths; a 403/500 is "could not tell", not "clean" — Measured.
//  - A group's `configVersion` is Git's ABBREVIATED hash while `/version` names HEAD in full:
//    `default` ran `a1b2c3d` while HEAD was the 40-char form — Measured 2026-09-26. Compare by
//    prefix (≥7 hex), never with `===`.
//  - `PATCH /products/stream/groups/{id}/deploy` is current; `/master/groups/{id}/deploy` is
//    deprecated in 4.19.0 but is all an older Leader answers — Documented. Fall back ONLY on 404:
//    a 403 cannot be fixed by a second path, and a 5xx deploy may already have started.
//  - `commitAndDeploy` used to report "nothing to commit" when the commit call succeeded but its
//    answer carried no hash (a commit may exist), and fed a failed `/version/status` read in as an
//    empty list — both "unknown" reported as "nothing to do". Found by an app audit 2026-10-06,
//    where the app's copy had already fixed the first. Hence `committed-unknown-hash`,
//    `status-unknown` and `unverified`: unknown is never "clean", and nothing unknown is deployed.
//  - Pending paths are matched as FULL paths under `groups/<group>/` (standard rule 7, "Match full
//    paths under the group, not substrings"). Substring matching swept a pack's own `outputs.yml`
//    and a Leader-level `local/cribl/outputs.yml` into a group's commit. Whether `/version/status`
//    reports `groups/<g>/…` or group-relative paths is Undefined on a distributed Leader (standard
//    rule 7, "Undefined" note): a path without a `groups/` prefix that a marker would match is UNPLACED, and an
//    unplaced path makes the scope unknown (nothing committed, nothing deployed) until measured, so
//    an app should refuse the edit before writing while one is pending (CommitScope.unplaced).
//  - `GET /version` lists the commit history newest first (`git log`; OpenAPI 4.19.0 getVersion,
//    PaginatedGitLogResult, example item `refs: "HEAD -> main"`) — Documented, not measured. It is
//    read just before the deploy: if HEAD is not this commit, a newer commit exists, and deploying
//    this one could roll the group back past it. An unreadable HEAD is "could not tell": no deploy.
//  - Added 2026-10-07 from an app's config-write hardening (unplaced paths, the HEAD check,
//    `commitScopeGrew`, `observeCommitDeploy`). An app had refused an edit only AFTER writing it
//    when a pending path could not be placed, leaving the change uncommitted in a shared file; and a
//    401/403 on the status or HEAD read after a write did not latch, so the next edit did the same.

import { isOk, type ApiResponse, type Request } from './transport';

/** Whether two hashes name the same commit: equal, or one a ≥7-char prefix of the other. */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.startsWith(short);
}

/** Every path Cribl reports uncommitted, or null when the read failed ("could not tell"). */
export async function pendingFiles(request: Request): Promise<string[] | null> {
  return (await readPending(request)).files;
}

/** `pendingFiles` plus the response, so a caller can show why the status could not be read. */
async function readPending(request: Request): Promise<{ files: string[] | null; response: ApiResponse }> {
  const response = await request('GET', '/version/status');
  return { files: parsePending(response), response };
}

function parsePending(r: ApiResponse): string[] | null {
  if (!isOk(r.status)) return null;
  const items = (r.body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const out = new Set<string>();
  for (const it of items as Array<Record<string, unknown>>) {
    for (const f of (it.files as Array<{ path?: unknown }> | undefined) ?? []) if (typeof f.path === 'string') out.add(f.path);
    for (const key of ['created', 'deleted', 'modified', 'not_added', 'staged']) {
      for (const p of (it[key] as unknown[] | undefined) ?? []) if (typeof p === 'string') out.add(p);
    }
  }
  return [...out];
}

/** A status path without a leading `./` or `/`. */
function normalPath(p: string): string {
  return p.replace(/^\.?\/+/, '');
}

/** `rel` (a path under a group's config directory) is `marker`, or inside it when the marker ends in `/`. */
function underMarker(rel: string, marker: string): boolean {
  return marker.endsWith('/') ? rel.startsWith(marker) : rel === marker;
}

/**
 * Where a pending path sits relative to `group` and the files a commit for it carries (`markers`,
 * paths under the group's config directory such as `local/cribl/inputs.yml`):
 *  - `mine`: `groups/<group>/<marker>` exactly (or inside a directory marker);
 *  - `unplaced`: no `groups/` prefix, but a marker as written. It is the Leader's own file, or this
 *    group's under a group-scoped status read; which one is not measured (standard rule 7,
 *    "Undefined"), so it cannot be classified;
 *  - `elsewhere`: anything else (another group, a pack's file, this group's other files).
 */
export function placePath(path: string, group: string, markers: readonly string[]): 'mine' | 'unplaced' | 'elsewhere' {
  const p = normalPath(path);
  const prefix = `groups/${group}/`;
  if (p.startsWith(prefix)) return markers.some((m) => underMarker(p.slice(prefix.length), m)) ? 'mine' : 'elsewhere';
  if (p.startsWith('groups/')) return 'elsewhere';
  return markers.some((m) => underMarker(p, m)) ? 'unplaced' : 'elsewhere';
}

/** Pending paths split by `placePath`, each list in status order. */
export function placePending(pending: readonly string[], group: string, markers: readonly string[]): { mine: string[]; unplaced: string[]; elsewhere: string[] } {
  const out = { mine: [] as string[], unplaced: [] as string[], elsewhere: [] as string[] };
  for (const p of pending) out[placePath(p, group, markers)].push(p);
  return out;
}

/** Pending paths that are certainly `group`'s files named by `markers` (full-path match). */
export function matchingFiles(pending: readonly string[], group: string, markers: readonly string[]): string[] {
  return placePending(pending, group, markers).mine;
}

/** What a confirmation must say a commit carries — read, not asserted. */
export interface CommitScope {
  /** Somebody else's uncommitted work in the files this commit will carry. Name it in the dialog. */
  alreadyDirty: string[];
  /** Uncommitted elsewhere — left alone, but the deploy moves the group to a commit, not a change. */
  elsewhere: string[];
  /**
   * Pending paths a marker would match that have no `groups/` prefix (see `placePath`). While any is
   * listed, `commitAndDeploy` commits nothing (`scope-unknown`), so a write would never be deployed.
   */
  unplaced: string[];
  /**
   * What the commit carries cannot be told: the status read failed (`unplaced` empty), or a pending
   * path could not be placed (`unplaced` lists it). Say "could not tell", never "nothing else is pending".
   */
  unknown: boolean;
}

export function commitScope(pending: readonly string[] | null, group: string, markers: readonly string[]): CommitScope {
  if (pending === null) return { alreadyDirty: [], elsewhere: [], unplaced: [], unknown: true };
  const placed = placePending(pending, group, markers);
  // An unplaced path may be one of the files this commit carries: "could not tell", never "clean".
  return { alreadyDirty: placed.mine, elsewhere: placed.elsewhere, unplaced: placed.unplaced, unknown: placed.unplaced.length > 0 };
}

/** Which deploy endpoint answered: the current products path, or the deprecated master path. */
export type DeployRoute = 'products' | 'master';

/**
 * Deploy, falling back to the deprecated path only when the current one 404s. Says which path
 * answered, so a 401/403 is latched and worded for the path that refused (a 403 on the master
 * fallback is a different policy grant from one on the products path).
 */
export async function deployGroup(request: Request, group: string, version: string): Promise<{ response: ApiResponse; route: DeployRoute }> {
  const body = { version };
  const r = await request('PATCH', `/products/stream/groups/${encodeURIComponent(group)}/deploy`, { body });
  if (r.status !== 404) return { response: r, route: 'products' };
  return { response: await request('PATCH', `/master/groups/${encodeURIComponent(group)}/deploy`, { body }), route: 'master' };
}

/** The commit a group's workers run, or null when unreadable — never reported as "none". */
export async function deployedVersion(request: Request, group: string): Promise<string | null> {
  let r = await request('GET', `/products/stream/groups/${encodeURIComponent(group)}`);
  if (r.status === 404) r = await request('GET', `/master/groups/${encodeURIComponent(group)}`);
  if (!isOk(r.status)) return null;
  const items = ((r.body as { items?: unknown } | null)?.items ?? []) as Array<{ id?: unknown; configVersion?: unknown }>;
  const rec = items.find((it) => it.id === group) ?? items[0];
  return typeof rec?.configVersion === 'string' && rec.configVersion ? rec.configVersion : null;
}

/** `GET /version?offset=0&limit=1`: the newest commit's hash (HEAD), or null when it could not be read. */
async function readHead(request: Request): Promise<{ hash: string | null; response: ApiResponse }> {
  const response = await request('GET', '/version?offset=0&limit=1');
  if (!isOk(response.status)) return { hash: null, response };
  const items = (response.body as { items?: unknown } | null)?.items;
  const hash = Array.isArray(items) ? (items[0] as { hash?: unknown } | undefined)?.hash : undefined;
  return { hash: typeof hash === 'string' && hash ? hash : null, response };
}

export type CommitDeployOutcome =
  | { kind: 'deployed'; hash: string; files: string[] }
  /** The status read succeeded and none of this change's files are pending. */
  | { kind: 'nothing-to-commit' }
  /** The status read before committing failed: could not tell what to commit. Nothing was committed. */
  | { kind: 'status-unknown'; response: ApiResponse }
  /** A pending path a marker would match has no `groups/<g>/` prefix, so what to commit is unknown. Nothing was committed. */
  | { kind: 'scope-unknown'; unplaced: string[] }
  /** Committed, but HEAD is now another commit: deploying this one could roll the group back. Not deployed. */
  | { kind: 'newer-commit'; hash: string; head: string }
  /** Committed, but HEAD could not be read just before the deploy, so a newer commit cannot be ruled out. Not deployed. */
  | { kind: 'head-unknown'; hash: string; response: ApiResponse }
  /** The commit call succeeded but its answer carried no hash: a commit may exist and is not deployed. */
  | { kind: 'committed-unknown-hash'; response: ApiResponse }
  | { kind: 'commit-failed'; response: ApiResponse }
  | { kind: 'incomplete'; hash: string; leftBehind: string[] }
  /** Committed, but the status re-read failed, so completeness could not be checked. Not deployed. */
  | { kind: 'unverified'; hash: string; response: ApiResponse }
  | { kind: 'deploy-failed'; hash: string; response: ApiResponse; route: DeployRoute };

/**
 * Commit this change's files and deploy that commit. CALL IT AFTER THE WRITE: the file list comes
 * from a status read taken now, because a list read before the write cannot contain the file the
 * write dirtied. After committing, status is read again — anything of ours still pending means the
 * commit is incomplete and it is NOT deployed.
 */
export async function commitAndDeploy(
  request: Request,
  input: { group: string; markers: readonly string[]; message: string },
): Promise<CommitDeployOutcome> {
  const before = await readPending(request);
  if (before.files === null) return { kind: 'status-unknown', response: before.response };
  const placed = placePending(before.files, input.group, input.markers);
  if (placed.unplaced.length > 0) return { kind: 'scope-unknown', unplaced: placed.unplaced };
  const files = placed.mine;
  if (files.length === 0) return { kind: 'nothing-to-commit' };

  const commit = await request('POST', '/version/commit', { body: { message: input.message, files } });
  if (!isOk(commit.status)) return { kind: 'commit-failed', response: commit };
  const b = commit.body as { items?: Array<{ commit?: unknown }>; commit?: unknown } | null;
  const hash = b?.items?.[0]?.commit ?? b?.commit;
  if (typeof hash !== 'string' || !hash) return { kind: 'committed-unknown-hash', response: commit };

  const after = await readPending(request);
  if (after.files === null) return { kind: 'unverified', hash, response: after.response };
  const left = placePending(after.files, input.group, input.markers);
  const leftBehind = [...left.mine, ...left.unplaced];
  if (leftBehind.length) return { kind: 'incomplete', hash, leftBehind };

  // The deploy names this commit. If another admin committed after it (and perhaps deployed), that
  // deploy would move the group back to this commit. Deploy only while this commit is still HEAD.
  const head = await readHead(request);
  if (head.hash === null) return { kind: 'head-unknown', hash, response: head.response };
  if (!sameCommit(head.hash, hash)) return { kind: 'newer-commit', hash, head: head.hash };

  const deploy = await deployGroup(request, input.group, hash);
  if (!isOk(deploy.response.status)) return { kind: 'deploy-failed', hash, response: deploy.response, route: deploy.route };
  return { kind: 'deployed', hash, files };
}

/**
 * The commit a confirmation described would now carry uncommitted work it did not name. Run it
 * BEFORE the post-answer re-read (it needs a status read of its own), with `planned` = the scope the
 * dialog showed and `now` = `commitScope` of a fresh status read. True means: write nothing and show
 * the new scope for a fresh approval. A scope that became unknown grew; an unplaced path should be
 * refused with its own reason before this is asked (`now.unplaced`).
 */
export function commitScopeGrew(planned: CommitScope, now: CommitScope): boolean {
  if (now.unknown) return !planned.unknown;
  const named = new Set(planned.alreadyDirty);
  return now.alreadyDirty.some((f) => !named.has(f));
}

/** Which step of `commitAndDeploy` a call is, so its status can be fed to a permission gate. */
export type CommitDeployStep = 'status' | 'head' | 'commit' | 'deploy' | 'deploy-master';

export function commitDeployStep(method: string, path: string): CommitDeployStep | null {
  const bare = path.split('?')[0];
  if (method === 'GET' && bare === '/version/status') return 'status';
  if (method === 'GET' && bare === '/version') return 'head';
  if (method === 'POST' && bare === '/version/commit') return 'commit';
  if (method === 'PATCH' && /^\/products\/stream\/groups\/[^/]+\/deploy$/.test(bare!)) return 'deploy';
  if (method === 'PATCH' && /^\/master\/groups\/[^/]+\/deploy$/.test(bare!)) return 'deploy-master';
  return null;
}

/**
 * Wrap the `request` handed to `commitAndDeploy` so EVERY status on the commit path reaches the
 * caller — the GET reads of `/version/status` and `/version` (HEAD) as well as the commit and the
 * deploy. Feed a 401/403 on any of them to the write gate (cribl-app-kit `writeGate.ts`) under that
 * step's own policy path: a refused read after the write otherwise leaves the gate open, and the next
 * edit writes, fails to commit, and stops in the same place again.
 */
export function observeCommitDeploy(
  request: Request,
  onStatus: (step: CommitDeployStep, method: string, path: string, status: number) => void,
): Request {
  return async (method, path, options) => {
    const r = await request(method, path, options);
    const step = commitDeployStep(method, path);
    if (step) {
      try {
        onStatus(step, method, path, r.status);
      } catch {
        /* an observer never changes the outcome of the call it observed */
      }
    }
    return r;
  };
}
