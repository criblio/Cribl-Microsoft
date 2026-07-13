/**
 * PACK INSTALL CONFLICT LADDER - the shared decision logic both shells run
 * after uploading a .crbl.
 *
 * Two live failures shaped this (2026-07-13):
 *  - "Pack install still conflicts after delete-and-retry" with no
 *    explanation: the silent DELETE was refused (a pack whose pipelines are
 *    referenced by routes cannot be deleted) and the retry walked into the
 *    same conflict.
 *  - POST {source, force: true} did NOT overwrite - Cribl "install anyway"
 *    semantics RENAMED the pack (a suffixed id), so the group ended up with
 *    a stray pack that matched nothing the app showed. The documented
 *    reinstall path is PATCH /packs/{id} {source} ("Upgrade a Pack" in the
 *    vendored cribl-openapi.json): in place, id preserved, route references
 *    intact.
 *
 * The ladder, in order:
 *   1. POST {source}                  - the plain install.
 *   2. PATCH /packs/{id} {source}    - on conflict: the documented upgrade.
 *   3. DELETE /packs/{id} + POST     - last resort; the DELETE's status and
 *      body are CAPTURED and reported, never swallowed.
 * Whatever rung succeeds, the returned pack id must MATCH the requested one
 * (sanitize-tolerant compare) - a server-side rename is deleted and reported
 * instead of silently accepted.
 *
 * Transport is injected (the cloud shell calls the workspace proxy, the
 * local shell the host relay), so this stays unit-testable with plain fakes.
 */

import {
  interpretInstallResponse,
  packIdFromCrblFileName,
  parsePackListResponse,
} from "../../domain/pack-assembly";
import type { InstalledPack } from "../../domain/pack-assembly";

/** The transport the ladder drives; each returns [status, bodyText]. */
export interface PackInstallTransport {
  /** POST /packs {source} in the group context. */
  post(body: { source: string }): Promise<[number, string]>;
  /** PATCH /packs/{id} {source} in the group context (documented upgrade). */
  upgradePack(packId: string, body: { source: string }): Promise<[number, string]>;
  /** DELETE /packs/{id} in the group context. */
  deletePack(packId: string): Promise<[number, string]>;
}

/**
 * Compare pack ids tolerant of the .crbl namer's sanitization (disallowed
 * characters become "-") and of server-side case normalization. A rename
 * (suffix, random token) still reads as different.
 */
function samePackId(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return norm(a) === norm(b);
}

/**
 * Install an uploaded pack source, escalating through the conflict ladder.
 * Returns the installed pack summary; throws with the FULL trail (upgrade
 * failure, refused delete, unexpected rename) on failure.
 */
export async function installViaConflictLadder(
  fileName: string,
  source: string,
  transport: PackInstallTransport,
): Promise<InstalledPack> {
  const expectedId = packIdFromCrblFileName(fileName);
  let outcome = interpretInstallResponse(...(await transport.post({ source })));

  let upgradeDetail = "";
  let deleteDetail = "";
  if (outcome.kind === "conflict") {
    const upgraded = interpretInstallResponse(
      ...(await transport.upgradePack(expectedId, { source })),
    );
    if (upgraded.kind === "installed") {
      outcome = upgraded;
    } else {
      upgradeDetail =
        upgraded.kind === "error"
          ? ` (upgrade attempt: ${upgraded.error})`
          : " (upgrade attempt also conflicted)";
      const [delStatus, delBody] = await transport.deletePack(expectedId);
      if (delStatus < 200 || delStatus >= 300) {
        deleteDetail =
          ` (existing pack '${expectedId}' could not be deleted: HTTP ${delStatus}` +
          ` ${delBody.slice(0, 200)} - if its pipelines are referenced by` +
          " routes outside the pack, detach those routes in Cribl and retry)";
      }
      outcome = interpretInstallResponse(...(await transport.post({ source })));
    }
  }

  if (outcome.kind !== "installed") {
    throw new Error(
      outcome.kind === "conflict"
        ? `Pack install still conflicts after upgrade and delete-and-retry${upgradeDetail}${deleteDetail}`
        : outcome.error,
    );
  }

  // NEVER accept a server-side rename (live 2026-07-13: force-install left a
  // suffixed stray pack the app never asked for). Remove it and say so.
  if (outcome.pack.id !== "" && !samePackId(outcome.pack.id, expectedId)) {
    await transport.deletePack(outcome.pack.id);
    throw new Error(
      `Pack was installed under the unexpected id '${outcome.pack.id}'` +
        ` (expected '${expectedId}'); the stray copy was removed.` +
        ` An existing pack named '${expectedId}' is likely blocking the` +
        " install - delete it in Cribl (detach any routes first) and retry.",
    );
  }
  return outcome.pack;
}

/**
 * List installed packs per group over an injected GET. A failed or
 * unparseable listing THROWS instead of reading as "no packs" (live failure
 * 2026-07-13: the overwrite pre-check reported "the name is free" while the
 * pack was installed, and the install then conflicted "unexpectedly").
 */
export async function listDeployedPacks(
  groups: readonly string[],
  get: (group: string) => Promise<[number, string]>,
): Promise<Array<{ group: string; packs: InstalledPack[] }>> {
  const out: Array<{ group: string; packs: InstalledPack[] }> = [];
  for (const group of groups) {
    const [status, body] = await get(group);
    const parsed = parsePackListResponse(status, body);
    if (!parsed.ok) {
      throw new Error(`list packs in '${group}': ${parsed.error}`);
    }
    out.push({ group, packs: parsed.packs });
  }
  return out;
}
