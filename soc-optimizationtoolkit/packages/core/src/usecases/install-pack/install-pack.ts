/**
 * PACK INSTALL CONFLICT LADDER - the shared decision logic both shells run
 * after uploading a .crbl (live failure 2026-07-13: "Pack install still
 * conflicts after delete-and-retry" with no explanation, because the silent
 * DELETE was refused - a pack whose pipelines are referenced by routes
 * cannot be deleted - and the retry walked into the same conflict).
 *
 * The ladder, in order:
 *   1. POST {source}                 - the plain install.
 *   2. POST {source, force: true}   - on conflict: the DOCUMENTED overwrite
 *      path (PackRequestBody.force in the vendored cribl-openapi.json).
 *      Reinstalls in place, so it works even when the existing pack is
 *      referenced by routes.
 *   3. DELETE /packs/{id} + POST    - last resort; the DELETE's status/body
 *      are CAPTURED and reported, never swallowed.
 *
 * Transport is injected (the cloud shell POSTs via the workspace proxy, the
 * local shell via the host relay), so this stays unit-testable with plain
 * fakes.
 */

import {
  interpretInstallResponse,
  packIdFromCrblFileName,
  parsePackListResponse,
} from "../../domain/pack-assembly";
import type { InstalledPack } from "../../domain/pack-assembly";

/** The transport the ladder drives: one JSON POST, one DELETE by id. */
export interface PackInstallTransport {
  /** POST /packs with this body in the group context; [status, bodyText]. */
  post(body: { source: string; force?: boolean }): Promise<[number, string]>;
  /** DELETE /packs/{id} in the group context; [status, bodyText]. */
  deletePack(packId: string): Promise<[number, string]>;
}

/**
 * Install an uploaded pack source, escalating through the conflict ladder.
 * Returns the installed pack summary; throws with the FULL trail (including
 * the delete refusal, when one happened) on failure.
 */
export async function installViaConflictLadder(
  fileName: string,
  source: string,
  transport: PackInstallTransport,
): Promise<InstalledPack> {
  let outcome = interpretInstallResponse(...(await transport.post({ source })));

  if (outcome.kind === "conflict") {
    outcome = interpretInstallResponse(
      ...(await transport.post({ source, force: true })),
    );
  }

  let deleteDetail = "";
  if (outcome.kind === "conflict") {
    const packId = packIdFromCrblFileName(fileName);
    const [delStatus, delBody] = await transport.deletePack(packId);
    if (delStatus < 200 || delStatus >= 300) {
      deleteDetail =
        ` (existing pack '${packId}' could not be deleted: HTTP ${delStatus}` +
        ` ${delBody.slice(0, 200)} - if its pipelines are referenced by` +
        " routes outside the pack, detach those routes in Cribl and retry)";
    }
    outcome = interpretInstallResponse(...(await transport.post({ source })));
  }

  if (outcome.kind !== "installed") {
    throw new Error(
      outcome.kind === "conflict"
        ? `Pack install still conflicts after force overwrite and delete-and-retry${deleteDetail}`
        : outcome.error,
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
