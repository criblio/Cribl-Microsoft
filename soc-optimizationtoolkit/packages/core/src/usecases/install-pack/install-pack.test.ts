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

function transport(init: {
  posts: Array<[number, string]>;
  upgrade?: [number, string];
  del?: [number, string];
}): PackInstallTransport & {
  postCount: number;
  upgradedIds: string[];
  deletedIds: string[];
} {
  const t = {
    postCount: 0,
    upgradedIds: [] as string[],
    deletedIds: [] as string[],
    async post(): Promise<[number, string]> {
      t.postCount++;
      return init.posts[t.postCount - 1] ?? [500, "no scripted response"];
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
  it("installs on the first POST without upgrade or delete", async () => {
    const t = transport({ posts: [[200, installedBody()]] });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.postCount).toBe(1);
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
    expect(t.postCount).toBe(1);
  });

  it("falls back to delete-and-retry when the upgrade fails", async () => {
    const t = transport({
      posts: [CONFLICT, [200, installedBody()]],
      upgrade: [500, "upgrade exploded"],
    });
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual(["MS-Sentinel"]);
    expect(t.postCount).toBe(2);
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
