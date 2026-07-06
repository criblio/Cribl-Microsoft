import { describe, expect, it } from "vitest";
import {
  memoizeVendorResearch,
  normalizeVendorKey,
} from "./vendor-research-memo";

describe("normalizeVendorKey (porting-plan contract 14)", () => {
  it("lowercases and maps non-alphanumerics to underscore", () => {
    expect(normalizeVendorKey("Palo Alto Networks")).toBe("palo_alto_networks");
    expect(normalizeVendorKey("CrowdStrike-FDR")).toBe("crowdstrike_fdr");
  });
});

describe("memoizeVendorResearch", () => {
  it("calls the underlying research ONCE per vendor even across 3 lookups (the legacy called it thrice)", async () => {
    let calls = 0;
    const research = memoizeVendorResearch(async (vendor: string) => {
      calls += 1;
      return { vendor };
    });
    const a = await research("Palo Alto");
    const b = await research("Palo Alto");
    const c = await research("PALO ALTO"); // same normalized key (case-insensitive)
    expect(calls).toBe(1);
    expect(research.underlyingCalls()).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("dedupes CONCURRENT calls for the same vendor to one underlying call", async () => {
    let calls = 0;
    const research = memoizeVendorResearch(async () => {
      calls += 1;
      await Promise.resolve();
      return calls;
    });
    const [x, y] = await Promise.all([research("acme"), research("acme")]);
    expect(calls).toBe(1);
    expect(x).toBe(y);
  });

  it("keeps distinct vendors separate", async () => {
    let calls = 0;
    const research = memoizeVendorResearch(async (v: string) => {
      calls += 1;
      return v;
    });
    await research("alpha");
    await research("beta");
    expect(calls).toBe(2);
    expect(research.cachedKeys()).toBe(2);
  });

  it("evicts a rejected result so a retry can run again", async () => {
    let calls = 0;
    const research = memoizeVendorResearch(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "ok";
    });
    await expect(research("v")).rejects.toThrow("transient");
    // The failed entry was evicted, so the retry actually re-invokes.
    await expect(research("v")).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
