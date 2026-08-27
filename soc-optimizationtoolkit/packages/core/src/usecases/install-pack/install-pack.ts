/**
 * PACK INSTALL CONFLICT LADDER - the shared decision logic both shells run
 * after uploading a .crbl.
 *
 * Three live failures shaped this (2026-07-13):
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
 *  - A POST without an `id` lets the server DERIVE the pack id from the
 *    RANDOMIZED upload filename (the "fi...entinel_1" stray) - so every
 *    install POST now pins {id} explicitly (PackRequestBody.id in the
 *    vendored spec). The name is never server-guessed.
 *
 * A FOURTH failure moved the last two rungs (live 2026-08-27). PATCH is
 * Cribl's "Upgrade a Pack", and an upgrade MERGES the archive over what is
 * already installed. Pipeline directory ids come from the operator's log type
 * (`pipelineSuffix`, domain/pack-assembly/naming.ts), so as soon as a log type
 * is renamed between builds the previous build's pipeline ids are no longer in
 * the archive - and the merge leaves them behind with no conf.yml, which the
 * Cribl UI lists as a nameless pipeline at 0 functions, "Missing pipeline
 * configuration". The trigger is the RENAME, not the rebuild: measured across
 * five app-built packs in one workspace, the two whose log types changed
 * between builds carried 4 and 12+ orphans, while a never-rebuilt pack and TWO
 * rebuilt ones whose log types stayed put (v1.0.1, v1.0.3) carried none. So it
 * is not every rebuild - it is every rebuild that renames a log type, which is
 * exactly what re-deriving log types from a new sample set does. The UI had
 * been promising "Building will overwrite it there" the whole time.
 * So an overwrite now REPLACES (delete, then install) and only merges when the
 * delete is refused - which is the one case the 2026-07-13 lesson covers.
 *
 * The ladder, in order:
 *   1. POST {source, id}              - the plain install, id pinned.
 *   2. Delete the NAMED conflicting pack + retry (bounded) - the conflict
 *      message names the blocking pack, which can be a stray under a
 *      DIFFERENT id (live 2026-07-13: strays from the id-guessing era
 *      blocked every reinstall while the expected id "did not exist").
 *   3. DELETE /packs/{id} + POST     - the overwrite, and a REPLACE: the old
 *      pack's tree goes with it, so no earlier build's pipelines survive.
 *      The DELETE's status and body are CAPTURED and reported, never
 *      swallowed.
 *   4. PATCH /packs/{id} {source}    - only when that DELETE is REFUSED (a
 *      pack whose pipelines are referenced by routes outside it cannot be
 *      deleted). This merges, so it is reported through `onNote` rather than
 *      passing as a clean overwrite.
 * Whatever rung succeeds, a returned pack id must MATCH the requested one
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
  /** POST /packs {source, id} in the group context (id always pinned). */
  post(body: { source: string; id: string }): Promise<[number, string]>;
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
 *
 * `onNote` carries a SUCCESSFUL-but-degraded outcome, which a return value
 * cannot: rung 4 installs the pack and still leaves earlier builds' pipelines
 * in it. Defaulting it to a no-op keeps every existing caller compiling, but a
 * shell that drops it is choosing not to show the operator why their pack has
 * pipelines they did not ask for.
 */
export async function installViaConflictLadder(
  fileName: string,
  source: string,
  transport: PackInstallTransport,
  onNote: (note: string) => void = () => {},
): Promise<InstalledPack> {
  const expectedId = packIdFromCrblFileName(fileName);
  // The id is PINNED on every POST (live 2026-07-13: without it the server
  // derived the id from the randomized upload filename).
  const installBody = { source, id: expectedId };
  let outcome = interpretInstallResponse(...(await transport.post(installBody)));

  // Rung 2: the conflict message NAMES the blocking pack. When that is a
  // DIFFERENT id than ours, it is a stray copy of this very pack (Cribl
  // matches on content, not id - live 2026-07-13: id-guessed strays blocked
  // every reinstall while the expected id "did not exist"). Delete the named
  // stray and retry; bounded, because several strays can accumulate.
  let strayDetail = "";
  for (
    let attempt = 0;
    attempt < 3 &&
    outcome.kind === "conflict" &&
    outcome.conflictingPackId !== undefined &&
    !samePackId(outcome.conflictingPackId, expectedId);
    attempt++
  ) {
    const strayId = outcome.conflictingPackId;
    const [delStatus, delBody] = await transport.deletePack(strayId);
    if (delStatus < 200 || delStatus >= 300) {
      strayDetail += ` (conflicting pack '${strayId}' could not be deleted: HTTP ${delStatus} ${delBody.slice(0, 120)})`;
      break;
    }
    strayDetail += ` (deleted conflicting stray pack '${strayId}')`;
    outcome = interpretInstallResponse(...(await transport.post(installBody)));
  }

  let upgradeDetail = "";
  let deleteDetail = "";
  if (outcome.kind === "conflict") {
    // Target the id the server NAMED when it is a case variant of ours -
    // "Pack Ids are case-insensitive and must be unique", but the per-pack
    // API routes want the INSTALLED spelling (live 2026-07-13: PATCH/DELETE
    // on "MS-Sentinel" reported not-installed while "ms-sentinel" was the
    // blocking pack).
    const named = outcome.conflictingPackId;
    const targetId =
      named !== undefined && samePackId(named, expectedId) ? named : expectedId;

    // REPLACE FIRST (live 2026-08-27). Deleting takes the old pack's whole
    // tree with it, which is the only way a rebuild stops inheriting pipeline
    // ids from log types it no longer has.
    const [delStatus, delBody] = await transport.deletePack(targetId);
    if (delStatus >= 200 && delStatus < 300) {
      outcome = interpretInstallResponse(...(await transport.post(installBody)));
    } else {
      // The 2026-07-13 case: a pack whose pipelines are referenced by routes
      // OUTSIDE it cannot be deleted. Merging is then better than failing -
      // but it is not the clean overwrite the UI promised, so say so.
      deleteDetail =
        ` (existing pack '${targetId}' could not be deleted: HTTP ${delStatus}` +
        ` ${delBody.slice(0, 200)} - if its pipelines are referenced by` +
        " routes outside the pack, detach those routes in Cribl and retry)";
      const upgraded = interpretInstallResponse(
        ...(await transport.upgradePack(targetId, { source })),
      );
      if (upgraded.kind === "installed") {
        outcome = upgraded;
        onNote(
          `Pack '${targetId}' could not be deleted, so it was upgraded in` +
            " place instead of replaced. Pipelines from earlier builds may" +
            " remain in the pack; remove any that show 'Missing pipeline" +
            " configuration'.",
        );
      } else {
        upgradeDetail =
          upgraded.kind === "error"
            ? ` (upgrade attempt: ${upgraded.error})`
            : " (upgrade attempt also conflicted)";
      }
    }
  }

  if (outcome.kind !== "installed") {
    throw new Error(
      outcome.kind === "conflict"
        ? `Pack install still conflicts after delete-and-retry and upgrade` +
          ` (conflict: ${outcome.detail})${strayDetail}${upgradeDetail}${deleteDetail}`
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
  // Some install responses omit the pack summary entirely (the rename guard
  // above cannot verify those); the id the caller reports is then the one we
  // PINNED in the request, never a blank.
  if (outcome.pack.id === "") {
    return { ...outcome.pack, id: expectedId };
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
