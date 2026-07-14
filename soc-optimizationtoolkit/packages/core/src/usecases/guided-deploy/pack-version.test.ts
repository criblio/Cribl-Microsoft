import { describe, expect, it } from "vitest";
import { bumpPackVersion, DEFAULT_PACK_VERSION } from "./pack-version";

describe("bumpPackVersion", () => {
  it("starts a brand-new pack at 1.0.0", () => {
    expect(bumpPackVersion()).toBe(DEFAULT_PACK_VERSION);
    expect(bumpPackVersion(null)).toBe("1.0.0");
    expect(bumpPackVersion("")).toBe("1.0.0");
    expect(bumpPackVersion("   ")).toBe("1.0.0");
  });

  it("increments the patch component, preserving major.minor (legacy semantics)", () => {
    expect(bumpPackVersion("1.0.0")).toBe("1.0.1");
    expect(bumpPackVersion("1.2.3")).toBe("1.2.4");
    expect(bumpPackVersion("10.4.99")).toBe("10.4.100");
  });

  it("treats a missing patch/minor as 0 before the bump", () => {
    expect(bumpPackVersion("2.5")).toBe("2.5.1");
    expect(bumpPackVersion("3")).toBe("3.0.1");
  });

  it("FIXES the legacy NaN-join defect: non-numeric components coerce to 0", () => {
    // Legacy `map(Number).join('.')` produced "NaN.NaN.1"; this port never does.
    expect(bumpPackVersion("x.y.z")).toBe("0.0.1");
    expect(bumpPackVersion("1.0.0-beta")).toBe("1.0.1");
  });
});
