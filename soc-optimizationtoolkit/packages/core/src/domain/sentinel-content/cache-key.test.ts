/**
 * ContentCache key derivation - porting-plan Unit 14 (ENG-52 superseded).
 * The commit SHA is embedded in the key, so a new upstream commit invalidates
 * stale entries by producing a fresh key that misses.
 */
import { describe, expect, it } from "vitest";
import {
  connectorsCacheKey,
  contentCacheKey,
  shortCommitSha,
  solutionIndexCacheKey,
} from "./cache-key";
import { FakeContentCache } from "../../testing/fake-sentinel-content";

const SHA_A = "abcdef0123456789";
const SHA_B = "0011223344556677";

describe("shortCommitSha", () => {
  it("truncates to 12 chars (legacy lastCommit convention)", () => {
    expect(shortCommitSha(SHA_A)).toBe("abcdef012345");
    expect(shortCommitSha("")).toBe("");
  });
});

describe("contentCacheKey", () => {
  it("is deterministic for identical params", () => {
    const a = contentCacheKey({ kind: "connectors", solution: "CrowdStrike Falcon", commitSha: SHA_A });
    const b = contentCacheKey({ kind: "connectors", solution: "CrowdStrike Falcon", commitSha: SHA_A });
    expect(a).toBe(b);
  });

  it("changes when the commit changes (invalidation stamp)", () => {
    const a = contentCacheKey({ kind: "connectors", solution: "X", commitSha: SHA_A });
    const b = contentCacheKey({ kind: "connectors", solution: "X", commitSha: SHA_B });
    expect(a).not.toBe(b);
  });

  it("changes when solution, kind, or extra changes", () => {
    const base = contentCacheKey({ kind: "connectors", solution: "X", commitSha: SHA_A });
    expect(base).not.toBe(contentCacheKey({ kind: "connectors", solution: "Y", commitSha: SHA_A }));
    expect(base).not.toBe(contentCacheKey({ kind: "rules", solution: "X", commitSha: SHA_A }));
    expect(base).not.toBe(
      contentCacheKey({ kind: "connectors", solution: "X", commitSha: SHA_A, extra: "f.json" }),
    );
  });

  it("produces KV-safe keys even for solutions with spaces/specials", () => {
    const key = contentCacheKey({
      kind: "connectors",
      solution: "CrowdStrike Falcon Endpoint Protection (v2)!",
      commitSha: SHA_A,
    });
    expect(key).toMatch(/^[A-Za-z0-9_.:-]+$/);
    expect(key.startsWith("sentinel-content:connectors:abcdef012345:")).toBe(true);
  });

  it("solutionIndexCacheKey omits the solution segment", () => {
    expect(solutionIndexCacheKey(SHA_A)).toBe("sentinel-content:solution-index:abcdef012345");
    expect(connectorsCacheKey("Foo", SHA_A)).toBe(
      "sentinel-content:connectors:abcdef012345:Foo",
    );
  });
});

describe("round-trips through FakeContentCache keyed by solution+commit", () => {
  it("stores and retrieves a parsed result; a different commit misses", async () => {
    const cache = new FakeContentCache();
    const parsed = [{ tableName: "T_CL", columns: [] }];
    const keyA = connectorsCacheKey("Foo", SHA_A);

    expect(await cache.get(keyA)).toBeNull(); // cold miss
    await cache.set(keyA, parsed);
    expect(await cache.get(keyA)).toEqual(parsed);

    // A new commit yields a new key -> the old value is not served (invalidation).
    expect(await cache.get(connectorsCacheKey("Foo", SHA_B))).toBeNull();
  });

  it("returned values are deep copies (mutating them does not corrupt the cache)", async () => {
    const cache = new FakeContentCache();
    const key = connectorsCacheKey("Foo", SHA_A);
    await cache.set(key, { columns: ["a"] });
    const got = (await cache.get(key)) as { columns: string[] };
    got.columns.push("mutated");
    expect((await cache.get(key)) as { columns: string[] }).toEqual({ columns: ["a"] });
  });
});
