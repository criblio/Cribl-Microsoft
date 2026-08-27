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

  it("REPLACES a same-id pack - deletes it, re-POSTs, and never merges", async () => {
    // THE 2026-08-27 DEFECT. This used to escalate to PATCH ("Upgrade a
    // Pack") and stop there, and an upgrade MERGES: pipeline ids from a
    // previous build - whose log types no longer exist - survived with no
    // conf.yml behind them, showing in Cribl as nameless 0-function
    // pipelines reading "Missing pipeline configuration". Measured live over
    // five packs: the two whose log types were renamed between builds carried
    // 4 and 12+ orphans; a never-rebuilt pack and two rebuilt ones with stable
    // log types carried none. An overwrite has to actually overwrite.
    const t = transport({ posts: [CONFLICT, [200, installedBody()]] });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual(["MS-Sentinel"]);
    expect(t.upgradedIds).toEqual([]);
    // Both POSTs pin the id.
    expect(t.postBodies).toEqual([
      { source: "src.crbl", id: "MS-Sentinel" },
      { source: "src.crbl", id: "MS-Sentinel" },
    ]);
  });

  it("falls back to the PATCH upgrade only when the DELETE is refused", async () => {
    // The 2026-07-13 case that keeps the merge rung alive: a pack whose
    // pipelines are referenced by routes outside it cannot be deleted.
    // Merging beats failing here - but it is still a merge.
    const t = transport({
      posts: [CONFLICT],
      del: [409, "referenced by routes"],
      upgrade: [200, installedBody()],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual(["MS-Sentinel"]);
    expect(t.upgradedIds).toEqual(["MS-Sentinel"]);
    expect(t.postBodies.length).toBe(1);
  });

  it("REPORTS the degraded merge, so leftovers are expected and not mysterious", async () => {
    // A successful install that is not a clean overwrite. The return value
    // cannot say so, which is exactly why onNote exists - without it this is
    // the silent-success shape this codebase keeps getting bitten by.
    const notes: string[] = [];
    const t = transport({
      posts: [CONFLICT],
      del: [409, "referenced by routes"],
      upgrade: [200, installedBody()],
    });
    await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t, (n) =>
      notes.push(n),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("upgraded in place instead of replaced");
    expect(notes[0]).toContain("Missing pipeline configuration");
  });

  it("says nothing when the overwrite was a clean replace", async () => {
    // The note must mark the DEGRADED path only - a note on every rebuild
    // would train the operator to ignore it.
    const notes: string[] = [];
    const t = transport({ posts: [CONFLICT, [200, installedBody()]] });
    await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t, (n) =>
      notes.push(n),
    );
    expect(notes).toEqual([]);
  });

  it("still throws with the delete AND upgrade trail when both rungs fail", async () => {
    const t = transport({
      posts: [CONFLICT],
      del: [409, "referenced by routes"],
      upgrade: [500, "upgrade exploded"],
    });
    // Both rungs' evidence survives into the message - the refused delete is
    // the actionable half (detach the routes) and the upgrade error says why
    // the fallback did not save it. Order is not pinned, presence is.
    let message = "";
    try {
      await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("could not be deleted: HTTP 409");
    expect(message).toContain("referenced by routes");
    expect(message).toContain("upgrade attempt");
  });

  it("targets the NAMED case-variant id in the REPLACE rung", async () => {
    // The exact live 2026-07-13 failure: an installed "ms-sentinel" blocks
    // "MS-Sentinel" (ids are case-insensitive) but PATCH/DELETE on our
    // spelling report not-installed. The rungs must use the server's.
    const caseConflict: [number, string] = [
      500,
      '{"status":"error","message":"failed to install: Pack Id conflicts with existing Pack \\"ms-sentinel\\". Pack Ids are case-insensitive and must be unique."}',
    ];
    const t = transport({ posts: [caseConflict, [200, installedBody()]] });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    // The server's spelling on the DELETE, our pinned id on the re-POST.
    expect(t.deletedIds).toEqual(["ms-sentinel"]);
    expect(t.upgradedIds).toEqual([]);
  });

  it("upgrades the NAMED case-variant id when its delete is refused", async () => {
    const caseConflict: [number, string] = [
      500,
      '{"message":"Pack Id conflicts with existing Pack \\"ms-sentinel\\"."}',
    ];
    const t = transport({
      posts: [caseConflict],
      del: [409, "referenced by routes"],
      upgrade: [200, installedBody("ms-sentinel")],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    // The installed spelling is accepted (same id per Cribl), never a stray.
    expect(pack.id).toBe("ms-sentinel");
    expect(t.deletedIds).toEqual(["ms-sentinel"]);
    expect(t.upgradedIds).toEqual(["ms-sentinel"]);
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
