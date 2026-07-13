/**
 * Pins for the pack install conflict ladder (live failure 2026-07-13: a
 * rebuild's install "still conflicts after delete-and-retry" with no
 * explanation, while the overwrite pre-check claimed the name was free).
 */

import { describe, expect, it } from "vitest";
import { installViaConflictLadder, listDeployedPacks } from "./install-pack";
import type { PackInstallTransport } from "./install-pack";

const INSTALLED_BODY = JSON.stringify({
  items: [{ id: "MS-Sentinel", displayName: "MS Sentinel", version: "1.0.0" }],
});
const CONFLICT: [number, string] = [
  500,
  '{"message":"MS-Sentinel conflicts with existing Pack MS-Sentinel"}',
];

function transport(
  posts: Array<[number, string]>,
  del: [number, string] = [200, "{}"],
): PackInstallTransport & {
  postBodies: Array<{ source: string; force?: boolean }>;
  deletedIds: string[];
} {
  const postBodies: Array<{ source: string; force?: boolean }> = [];
  const deletedIds: string[] = [];
  return {
    postBodies,
    deletedIds,
    async post(body) {
      postBodies.push(body);
      return posts[postBodies.length - 1] ?? [500, "no scripted response"];
    },
    async deletePack(packId) {
      deletedIds.push(packId);
      return del;
    },
  };
}

describe("installViaConflictLadder", () => {
  it("installs on the first POST without force or delete", async () => {
    const t = transport([[200, INSTALLED_BODY]]);
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.postBodies).toEqual([{ source: "src.crbl" }]);
    expect(t.deletedIds).toEqual([]);
  });

  it("escalates a conflict to force: true and stops there on success", async () => {
    const t = transport([CONFLICT, [200, INSTALLED_BODY]]);
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.postBodies).toEqual([
      { source: "src.crbl" },
      { source: "src.crbl", force: true },
    ]);
    expect(t.deletedIds).toEqual([]);
  });

  it("falls back to delete-and-retry when force also conflicts", async () => {
    const t = transport([CONFLICT, CONFLICT, [200, INSTALLED_BODY]]);
    const pack = await installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t);
    expect(pack.id).toBe("MS-Sentinel");
    expect(t.deletedIds).toEqual(["MS-Sentinel"]);
    expect(t.postBodies[2]).toEqual({ source: "src.crbl" });
  });

  it("reports a REFUSED delete in the final conflict error", async () => {
    const t = transport(
      [CONFLICT, CONFLICT, CONFLICT],
      [400, '{"message":"Pack MS-Sentinel is referenced by routes"}'],
    );
    await expect(
      installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t),
    ).rejects.toThrow(/could not be deleted: HTTP 400.*referenced by routes/);
  });

  it("surfaces a non-conflict error verbatim", async () => {
    const t = transport([[503, "leader busy"]]);
    await expect(
      installViaConflictLadder("MS-Sentinel_1.0.0.crbl", "src.crbl", t),
    ).rejects.toThrow(/Install failed \(503\)/);
  });
});

describe("listDeployedPacks", () => {
  it("returns per-group pack lists on success", async () => {
    const out = await listDeployedPacks(["default"], async () => [200, INSTALLED_BODY]);
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
