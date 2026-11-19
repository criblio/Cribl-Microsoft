import { describe, expect, it } from "vitest";
import { isGuid, nameBasedGuid, sha1 } from "./name-based-guid";

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

describe("sha1", () => {
  // FIPS 180 test vectors.
  it("hashes the empty message", () => {
    expect(hex(sha1([]))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("hashes 'abc'", () => {
    expect(hex(sha1(ascii("abc")))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("hashes a message that spans two blocks", () => {
    expect(hex(sha1(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    );
  });
});

describe("nameBasedGuid", () => {
  // RFC 4122 DNS namespace; the widely published v5 vector for www.example.com.
  const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

  it("matches the published version 5 vector", () => {
    expect(nameBasedGuid(DNS, "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("is stable and differs by name", () => {
    expect(nameBasedGuid(DNS, "a")).toBe(nameBasedGuid(DNS, "a"));
    expect(nameBasedGuid(DNS, "a")).not.toBe(nameBasedGuid(DNS, "b"));
  });

  it("sets version 5 and the RFC 4122 variant", () => {
    const g = nameBasedGuid(DNS, "anything");
    expect(g[14]).toBe("5");
    expect(["8", "9", "a", "b"]).toContain(g[19]);
    expect(isGuid(g)).toBe(true);
  });

  it("refuses a namespace that is not a GUID", () => {
    expect(() => nameBasedGuid("not-a-guid", "x")).toThrow("not a GUID");
  });
});

describe("isGuid", () => {
  it("accepts the 8-4-4-4-12 form only", () => {
    expect(isGuid("a638d3c7-ab3a-418d-83e6-5f17a39d4fde")).toBe(true);
    expect(isGuid(" A638D3C7-AB3A-418D-83E6-5F17A39D4FDE ")).toBe(true);
    expect(isGuid("{a638d3c7-ab3a-418d-83e6-5f17a39d4fde}")).toBe(false);
    expect(isGuid("a638d3c7ab3a418d83e65f17a39d4fde")).toBe(false);
    expect(isGuid("")).toBe(false);
  });
});
