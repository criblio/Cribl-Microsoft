/**
 * Pack install decision logic - porting-plan Unit 19 (ENG-28 delta), task item
 * "expose the install DECISION LOGIC as pure helpers the shells call".
 *
 * Ported from legacy auth.ts criblUploadPack (479-569), criblListPacks
 * (653-675), and criblDeployPackToGroups (678-689). The legacy interleaved the
 * decision rules with `fetch`/`fs`. Here the rules are extracted as PURE
 * request-SHAPING and response-INTERPRETING functions; the actual network call
 * lives in each shell's CriblClient adapter. That keeps the two-step upload
 * protocol, the returned-randomized-filename rule, the duplicate-conflict
 * delete-and-retry rule, and the deployed-status-from-the-API rule identical and
 * testable across both shells.
 *
 * The two-step protocol (verbatim):
 *   1. PUT  /api/v1/m/{group}/packs?filename={file}.crbl   (octet-stream body)
 *      -> the response JSON returns a RANDOMIZED `source` filename
 *         (e.g. "paloalto-sentinel.h1i8P1M.crbl"); the install MUST use it.
 *   2. POST /api/v1/m/{group}/packs   {"source": "<returned source>"}
 *      -> on 500 "conflicts with existing Pack": escalate through the
 *         conflict ladder in usecases/install-pack (PATCH /packs/{id}
 *         in-place upgrade, then DELETE the existing pack - id derived from
 *         the ORIGINAL filename - and retry the POST).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** A shaped HTTP request (the shell adds auth headers and performs the call). */
export interface ShapedRequest {
  method: "GET" | "PUT" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  /** JSON string body, when applicable. */
  body?: string;
}

/** The worker-group-scoped API base (auth.ts apiUrl, 699-704). */
export function packApiPath(baseUrl: string, workerGroup: string, endpoint: string): string {
  return `${baseUrl}/api/v1/m/${workerGroup}${endpoint}`;
}

/** Step 1 request: upload the .crbl bytes via PUT ?filename=. */
export function packUploadRequest(
  baseUrl: string,
  workerGroup: string,
  fileName: string,
): ShapedRequest {
  return {
    method: "PUT",
    url: packApiPath(baseUrl, workerGroup, `/packs?filename=${encodeURIComponent(fileName)}`),
    headers: { "Content-Type": "application/octet-stream" },
  };
}

/** Result of interpreting the upload (PUT) response. */
export type UploadResult =
  | { ok: true; source: string }
  | { ok: false; error: string };

/**
 * Interpret the PUT upload response. The RETURNED-RANDOMIZED-FILENAME RULE: the
 * install source is the `source` field of the JSON body, NOT the filename we
 * uploaded (the server appends a random token). Missing/unparseable source is an
 * error.
 */
export function parseUploadResponse(status: number, body: string): UploadResult {
  if (status < 200 || status >= 300) {
    return { ok: false, error: `Upload failed (${status}): ${body.slice(0, 200)}` };
  }
  let source = "";
  try {
    source = (JSON.parse(body) as { source?: string }).source ?? "";
  } catch {
    return { ok: false, error: `Upload succeeded but response not parseable: ${body.slice(0, 200)}` };
  }
  if (!source) {
    return { ok: false, error: "Upload succeeded but no source filename returned" };
  }
  return { ok: true, source };
}

/** Step 2 request: install the uploaded pack by its returned source name. */
export function packInstallRequest(
  baseUrl: string,
  workerGroup: string,
  source: string,
): ShapedRequest {
  return {
    method: "POST",
    url: packApiPath(baseUrl, workerGroup, "/packs"),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  };
}

/** Installed pack summary parsed from an install/list response item. */
export interface InstalledPack {
  id: string;
  displayName: string;
  version: string;
}

/** Outcome of interpreting the install (POST) response. */
export type InstallOutcome =
  | { kind: "installed"; pack: InstalledPack }
  | {
      kind: "conflict";
      /** The raw conflict message (trimmed) - never discarded (live
       * 2026-07-13: the blind conflict path hid which pack was blocking). */
      detail: string;
      /** The pack id the server NAMED as conflicting, when parseable. */
      conflictingPackId?: string;
    }
  | { kind: "error"; error: string };

function firstItem(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as { items?: Array<Record<string, unknown>> };
    return parsed.items?.[0] ?? {};
  } catch {
    return {};
  }
}

/**
 * Interpret the install (POST) response into an outcome. A 500 whose body
 * mentions "conflicts with existing Pack" is the DUPLICATE-CONFLICT signal: the
 * shell should delete the existing pack and retry.
 */
export function interpretInstallResponse(status: number, body: string): InstallOutcome {
  if (status >= 200 && status < 300) {
    const item = firstItem(body);
    return {
      kind: "installed",
      pack: {
        id: String(item.id ?? ""),
        displayName: String(item.displayName ?? item.id ?? ""),
        version: String(item.version ?? ""),
      },
    };
  }
  if (status === 500 && body.includes("conflicts with existing Pack")) {
    // The message usually NAMES the blocking pack ("... conflicts with
    // existing Pack <id>") - a stray from an earlier failed install can
    // carry a different id than ours (server-derived from the randomized
    // upload filename), so the named id is the only way to find it.
    const named = body.match(
      /conflicts with existing Pack:?\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*)/,
    );
    return {
      kind: "conflict",
      detail: body.slice(0, 300),
      ...(named !== null ? { conflictingPackId: named[1] } : {}),
    };
  }
  return { kind: "error", error: `Install failed (${status}): ${body.slice(0, 200)}` };
}

/**
 * Derive the existing pack id to delete from the ORIGINAL .crbl filename (the
 * duplicate-conflict rule, auth.ts 537): strip a trailing `_{version}.crbl`,
 * else a trailing `.{token}.crbl`.
 */
export function packIdFromCrblFileName(fileName: string): string {
  return fileName.replace(/_[\d.]+\.crbl$/, "").replace(/\.[^.]+\.crbl$/, "");
}

/** Request to delete an existing pack (before a conflict retry). */
export function packDeleteRequest(
  baseUrl: string,
  workerGroup: string,
  packId: string,
): ShapedRequest {
  return {
    method: "DELETE",
    url: packApiPath(baseUrl, workerGroup, `/packs/${encodeURIComponent(packId)}`),
    headers: {},
  };
}

/** Request to list installed packs on a worker group. */
export function packListRequest(baseUrl: string, workerGroup: string): ShapedRequest {
  return {
    method: "GET",
    url: packApiPath(baseUrl, workerGroup, "/packs"),
    headers: {},
  };
}

/** Result of interpreting the packs list response. */
export type PackListResult =
  | { ok: true; packs: InstalledPack[] }
  | { ok: false; error: string };

/** Parse the packs list response into normalized pack summaries. */
export function parsePackListResponse(status: number, body: string): PackListResult {
  if (status < 200 || status >= 300) {
    return { ok: false, error: `API returned ${status}` };
  }
  let items: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(body) as
      | { items?: unknown; data?: unknown }
      | Array<Record<string, unknown>>;
    const raw = Array.isArray(parsed)
      ? parsed
      : ((parsed.items ?? parsed.data ?? []) as unknown);
    items = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  } catch {
    return { ok: false, error: "packs list response not parseable" };
  }
  const packs = items.map((p) => ({
    id: String(p.id ?? p.name ?? ""),
    displayName: String(p.displayName ?? p.name ?? p.id ?? ""),
    version: String(p.version ?? ""),
  }));
  return { ok: true, packs };
}

/**
 * DEPLOYED-STATUS TRUTH FROM THE PACKS API (not local storage): a pack id is
 * deployed on a worker group iff the group's packs list contains it. Matches on
 * exact id or the packName-derived id prefix (Cribl ids can carry a suffix).
 */
export function isPackDeployed(packs: InstalledPack[], packId: string): boolean {
  return packs.some((p) => p.id === packId || p.id.startsWith(`${packId}@`) || p.id.startsWith(`${packId}.`));
}

/**
 * The deployed status of one pack across several worker groups, from each
 * group's live packs list (the shell fetched them). Truth is the API response,
 * never a persisted flag.
 */
export function deployedGroups(
  packId: string,
  groupPacks: Array<{ group: string; packs: InstalledPack[] }>,
): string[] {
  return groupPacks.filter((g) => isPackDeployed(g.packs, packId)).map((g) => g.group);
}
