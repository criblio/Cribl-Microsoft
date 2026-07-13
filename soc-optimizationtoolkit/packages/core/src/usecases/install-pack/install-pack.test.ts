/**
 * Pins for the pack install conflict ladder (live failures 2026-07-13: a
 * rebuild's install "still conflicts after delete-and-retry" with no
 * explanation while the pre-check claimed the name free; then the force-POST
 * "fix" made Cribl RENAME the pack instead of overwriting it - the correct
 * reinstall is the documented PATCH /packs/{id} upgrade).
 */

import { describe, expect, it } from "vitest";
import { installViaConflictLadder, listDeployedPacks } from "./install-pack";
import type { PackInstallTransport } from "./install-pack";

function installedBody(id = "MS-Sentinel"): string {
  return JSON.stringify({
    items: [{ id, displayName: "MS Sentinel", version: "1.0.0" }],
  });
}
const CONFLICT: [number, string] = [
  500,
  '{"message":"MS-Sentinel conflicts with existing Pack MS-Sentinel"}',
];
// A conflict naming a DIFFERENT pack - the live 2026-07-13 shape: a stray
// from the id-guessing era blocks the reinstall while the expected id is
// not installed at all.
const STRAY_CONFLICT: [number, string] = [
  500,
  '{"message":"MS-Sentinel conflicts with existing Pack fi8Xk-Zscaler_Internet_Sentinel_1"}',
];

function transport(init: {
  posts: Array<[number, string]>;
  upgrade?: [number, string];
  del?: [number, string];
}): PackInstallTransport & {
  postBodies: Array<{ source: string; id: string }>;
  upgradedIds: string[];
  deletedIds: string[];
} {
  const t = {
    postBodies: [] as Array<{ source: string; id: string }>,
    upgradedIds: [] as string[],
    deletedIds: [] as string[],
    async post(body: { source: string; id: string }): Promise<[number, string]> {
      t.postBodies.push(body);
      return init.posts[t.postBodies.length - 1] ?? [500, "no scripted response"];
    },
    async upgradePack(packId: string): Promise<[number, string]> {
      t.upgradedIds.push(packId);
      return init.upgrade ?? [500, "no scripted upgrade"];
    },
    async deletePack(packId: string): Promise<[number, string]> {
      t.deletedIds.push(packId);
      return init.del ?? [200, "{}"];
    },
  };
  return t;
}

describe("installViaConflictLadder", () => {
  it("installs on the first POST with the id PINNED, no upgrade or delete", async () => {
    // The id rides every install POST (live 2026-07-13: without it the
    // server derived the id from the randomized upload filename).
    const t = transport({ posts: [[200, installedBody()]] });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.postBodies).toEqual([{ source: "src.crbl", id: "MS-Sentinel" }]);
    expect(t.upgradedIds).toEqual([]);
    expect(t.deletedIds).toEqual([]);
  });

  it("escalates a conflict to the PATCH upgrade and stops there on success", async () => {
    // The id-preserving reinstall: never a rename, never a delete.
    const t = transport({ posts: [CONFLICT], upgrade: [200, installedBody()] });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.upgradedIds).toEqual(["MS-Sentinel"]);
    expect(t.deletedIds).toEqual([]);
    expect(t.postBodies.length).toBe(1);
  });

  it("falls back to delete-and-retry when the upgrade fails", async () => {
    const t = transport({
      posts: [CONFLICT, [200, installedBody()]],
      upgrade: [500, "upgrade exploded"],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual(["MS-Sentinel"]);
    // Both POSTs pin the id.
    expect(t.postBodies).toEqual([
      { source: "src.crbl", id: "MS-Sentinel" },
      { source: "src.crbl", id: "MS-Sentinel" },
    ]);
  });

  it("targets the NAMED case-variant id in the upgrade rung", async () => {
    // The exact live 2026-07-13 failure: an installed "ms-sentinel" blocks
    // "MS-Sentinel" (ids are case-insensitive) but PATCH/DELETE on our
    // spelling report not-installed. The rungs must use the server's.
    const caseConflict: [number, string] = [
      500,
      '{"status":"error","message":"failed to install: Pack Id conflicts with existing Pack \\"ms-sentinel\\". Pack Ids are case-insensitive and must be unique."}',
    ];
    const t = transport({
      posts: [caseConflict],
      upgrade: [200, installedBody("ms-sentinel")],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    // The installed spelling is accepted (same id per Cribl), never a stray.
    expect(pack.id).toBe("ms-sentinel");
    expect(t.upgradedIds).toEqual(["ms-sentinel"]);
    expect(t.deletedIds).toEqual([]);
  });

  it("deletes the NAMED case-variant id when the upgrade fails", async () => {
    const caseConflict: [number, string] = [
      500,
      '{"message":"Pack Id conflicts with existing Pack \\"ms-sentinel\\"."}',
    ];
    const t = transport({
      posts: [caseConflict, [200, installedBody()]],
      upgrade: [500, "failed to upgrade: exploded"],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual(["ms-sentinel"]);
  });

  it("deletes the NAMED conflicting stray and retries when the conflict names a different id", async () => {
    // The expected id is not installed (PATCH/DELETE on it would fail); the
    // blocker is the stray the server names. Delete THAT and retry.
    const t = transport({
      posts: [STRAY_CONFLICT, [200, installedBody()]],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual(["fi8Xk-Zscaler_Internet_Sentinel_1"]);
    expect(t.upgradedIds).toEqual([]);
  });

  it("clears SEVERAL accumulated strays, bounded", async () => {
    const stray2: [number, string] = [
      500,
      '{"message":"MS-Sentinel conflicts with existing Pack qZ2p-Zscaler_Internet_Sentinel_1"}',
    ];
    const t = transport({
      posts: [STRAY_CONFLICT, stray2, [200, installedBody()]],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual([
      "fi8Xk-Zscaler_Internet_Sentinel_1",
      "qZ2p-Zscaler_Internet_Sentinel_1",
    ]);
  });

  it("reports the conflict message AND the failed stray delete in the final error", async () => {
    // Stray delete refused -> the remaining rungs run and every failure is
    // in the final error: the raw conflict, the stray refusal, the upgrade
    // failure, the expected-id delete refusal.
    const t = transport({
      posts: [STRAY_CONFLICT, STRAY_CONFLICT],
      del: [500, '{"message":"failed to uninstall: in use"}'],
      upgrade: [500, "failed to upgrade: Pack is not currently installed"],
    });
    await expect(
      installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t),
    ).rejects.toThrow(
      /conflict: .*fi8Xk-Zscaler_Internet_Sentinel_1.*conflicting pack 'fi8Xk-Zscaler_Internet_Sentinel_1' could not be deleted: HTTP 500.*upgrade attempt.*not currently installed/,
    );
  });

  it("backfills the PINNED id when the install response omits the pack summary", async () => {
    // Some responses carry no items[] - the caller still reports the id we
    // requested, never a blank.
    const t = transport({ posts: [[200, "{}"]] });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual([]);
  });

  it("reports the upgrade failure AND a REFUSED delete in the final error", async () => {
    const t = transport({
      posts: [CONFLICT, CONFLICT],
      upgrade: [500, "upgrade exploded"],
      del: [400, '{"message":"Pack MS-Sentinel is referenced by routes"}'],
    });
    await expect(
      installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t),
    ).rejects.toThrow(
      /upgrade attempt: .*upgrade exploded.*could not be deleted: HTTP 400.*referenced by routes/,
    );
  });

  it("REJECTS a server-side rename and removes the stray pack", async () => {
    // Live 2026-07-13: force-install created a suffixed pack the app never
    // asked for. Any rung returning a different id must fail loudly.
    const t = transport({ posts: [[200, installedBody("ms-sentinel-fi8P1M_1")]] });
    await expect(
      installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t),
    ).rejects.toThrow(/unexpected id 'ms-sentinel-fi8P1M_1'.*expected 'MS-Sentinel'/);
    expect(t.deletedIds).toEqual(["ms-sentinel-fi8P1M_1"]);
  });

  it("tolerates case and sanitizer differences in the returned id", async () => {
    // crblFileName replaces disallowed characters with "-" and servers may
    // normalize case; neither is a rename.
    const t = transport({ posts: [[200, installedBody("ms-sentinel")]] });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("ms-sentinel");
    expect(t.deletedIds).toEqual([]);
  });

  it("surfaces a non-conflict error verbatim", async () => {
    const t = transport({ posts: [[503, "leader busy"]] });
    await expect(
      installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t),
    ).rejects.toThrow(/Install failed \(503\)/);
  });
});

describe("listDeployedPacks", () => {
  it("returns per-group pack lists on success", async () => {
    const out = await listDeployedPacks(["default"], async () => [200, installedBody()]);
    expect(out).toEqual([
      {
        group: "default",
        packs: [{ id: "MS-Sentinel", displayName: "MS Sentinel", version: "1.0.0" }],
      },
    ]);
  });

  it("THROWS on a failed listing instead of reading as no packs", async () => {
    // The silent [] made the overwrite pre-check claim "the name is free"
    // while the pack was installed (live 2026-07-13).
    await expect(
      listDeployedPacks(["default"], async () => [403, "forbidden"]),
    ).rejects.toThrow(/list packs in 'default': API returned 403/);
  });
});
