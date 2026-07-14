/**
 * Golden-file + round-trip tests for the pure ustar/.crbl builder - Unit 19
 * task item 7, section 3 contract 5. Zero legacy coverage existed for the tar
 * builder; these tests learn the expected .crbl structure from the
 * Cribl-ACCEPTED reference archive and pin header layout, checksum, ordering,
 * gzip validity, and full round-trip.
 */

import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { PackTree } from "./pack-tree";
import {
  buildCrbl,
  buildUstarTar,
  crc32,
  gzipStored,
  parseUstarTar,
  ungzipStored,
} from "./tar";

const BLOCK = 512;

function referenceCrbl(): Uint8Array {
  const url = new URL("./__fixtures__/reference-pack.crbl", import.meta.url);
  return new Uint8Array(readFileSync(url));
}

/** Recompute a ustar header checksum (checksum field read as 8 spaces). */
function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

function parseOctal(bytes: Uint8Array): number {
  let s = "";
  for (const b of bytes) {
    if (b === 0 || b === 0x20) {
      if (s) break;
      continue;
    }
    s += String.fromCharCode(b);
  }
  return s ? parseInt(s, 8) : 0;
}

/** Split a raw tar into its 512-byte header blocks (skipping content/trailer). */
function headerBlocks(tar: Uint8Array): Uint8Array[] {
  const headers: Uint8Array[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    headers.push(h);
    const size = parseOctal(h.subarray(124, 136));
    const typ = String.fromCharCode(h[156]);
    off += BLOCK;
    if (typ !== "5") off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return headers;
}

function sampleTree(): PackTree {
  return new PackTree()
    .set("package.json", '{"name":"x"}\n')
    .set("default/pack.yml", "allowGlobalAccess: true\n")
    .set("default/pipelines/route.yml", "routes: []\n")
    .set("default/pipelines/Zeta/conf.yml", "id: Zeta\n")
    .set("default/pipelines/alpha/conf.yml", "id: alpha\n")
    .set("data/samples/x.json", "[]");
}

describe("pure ustar builder - header layout + checksum", () => {
  it("emits valid ustar magic, version, and checksums", () => {
    const tar = buildUstarTar(sampleTree().toTarEntries(), 1_700_000_000);
    for (const h of headerBlocks(tar)) {
      // magic "ustar\0" + version "00"
      expect([...h.subarray(257, 263)]).toEqual([...Buffer.from("ustar\0", "binary")]);
      expect(String.fromCharCode(h[263], h[264])).toBe("00");
      // typeflag is a file or directory marker
      expect(["0", "5"]).toContain(String.fromCharCode(h[156]));
      // stored checksum matches the recomputed one
      expect(parseOctal(h.subarray(148, 156))).toBe(computeChecksum(h));
    }
  });

  it("encodes the caller-supplied mtime (deterministic, Date-free)", () => {
    const a = buildUstarTar(sampleTree().toTarEntries(), 1_700_000_000);
    const b = buildUstarTar(sampleTree().toTarEntries(), 1_700_000_000);
    const c = buildUstarTar(sampleTree().toTarEntries(), 1_700_000_001);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
    // The first header's mtime field decodes to the supplied seconds.
    expect(parseOctal(a.subarray(136, 148))).toBe(1_700_000_000);
  });
});

describe("ordering - dirs before files, alphabetical, package.json LAST", () => {
  it("orders entries by the contract", () => {
    const tar = buildUstarTar(sampleTree().toTarEntries(), 1);
    const entries = parseUstarTar(tar);
    const order = entries.map((e) => `${e.isDir ? "d" : "f"}:${e.path}`);
    expect(order).toEqual([
      "d:data",
      "d:data/samples",
      "d:default",
      "d:default/pipelines",
      "d:default/pipelines/Zeta",
      "d:default/pipelines/alpha",
      "f:data/samples/x.json",
      "f:default/pack.yml",
      "f:default/pipelines/Zeta/conf.yml",
      "f:default/pipelines/alpha/conf.yml",
      "f:default/pipelines/route.yml",
      "f:package.json",
    ]);
  });

  it("puts package.json last even when other files sort after it", () => {
    const tar = buildUstarTar(
      new PackTree()
        .set("package.json", "{}")
        .set("zzz.txt", "z")
        .toTarEntries(),
      1,
    );
    const files = parseUstarTar(tar).filter((e) => !e.isDir).map((e) => e.path);
    expect(files).toEqual(["zzz.txt", "package.json"]);
  });
});

describe("round-trip - extract back to the same tree", () => {
  it("round-trips a raw tar through the pure parser", () => {
    const tree = sampleTree();
    const tar = buildUstarTar(tree.toTarEntries(), 42);
    const files = new Map(
      parseUstarTar(tar)
        .filter((e) => !e.isDir)
        .map((e) => [e.path, Buffer.from(e.content).toString("utf8")]),
    );
    for (const [path, content] of tree.entries()) {
      expect(files.get(path)).toBe(content);
    }
    expect(files.size).toBe(tree.size);
  });

  it("round-trips the full gzip+ustar .crbl purely (ungzipStored)", () => {
    const tree = sampleTree();
    const crbl = buildCrbl(tree.toTarEntries(), 42);
    const tar = ungzipStored(crbl);
    const files = new Map(
      parseUstarTar(tar).filter((e) => !e.isDir).map((e) => [e.path, Buffer.from(e.content).toString("utf8")]),
    );
    expect(files.get("package.json")).toBe('{"name":"x"}\n');
    expect(files.get("data/samples/x.json")).toBe("[]");
  });

  it("preserves binary (Uint8Array) content exactly", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 0, 0, 7]);
    const tar = buildUstarTar([{ path: "data/blob.bin", content: bytes }], 1);
    const out = parseUstarTar(tar).find((e) => e.path === "data/blob.bin");
    expect(out).toBeDefined();
    expect([...out!.content]).toEqual([...bytes]);
  });
});

describe("gzip validity - standard gunzip accepts the stored-block output", () => {
  it("node zlib gunzips buildCrbl to the exact tar bytes", () => {
    const entries = sampleTree().toTarEntries();
    const tar = buildUstarTar(entries, 7);
    const crbl = buildCrbl(entries, 7);
    const nodeInflated = new Uint8Array(gunzipSync(Buffer.from(crbl)));
    expect(Buffer.from(nodeInflated).equals(Buffer.from(tar))).toBe(true);
    // The pure decompressor agrees with node.
    expect(Buffer.from(ungzipStored(crbl)).equals(Buffer.from(tar))).toBe(true);
  });

  it("crc32 matches node's gzip CRC for the same payload", () => {
    const data = Buffer.from("the quick brown fox\n".repeat(1000), "utf8");
    const mine = gzipStored(new Uint8Array(data));
    // Both decompress to the same bytes under node.
    expect(Buffer.from(gunzipSync(Buffer.from(mine))).equals(data)).toBe(true);
    // And node's own gzip of the same data round-trips through our pure ungzip
    // only if it were stored; here we just confirm crc32 is a real IEEE CRC by
    // cross-checking the trailer node wrote.
    const nodeGz = gzipSync(data);
    const nodeCrc = nodeGz.readUInt32LE(nodeGz.length - 8);
    expect(crc32(new Uint8Array(data))).toBe(nodeCrc);
  });

  it("handles empty payloads", () => {
    const gz = gzipStored(new Uint8Array(0));
    expect(Buffer.from(gunzipSync(Buffer.from(gz))).length).toBe(0);
    expect(ungzipStored(gz).length).toBe(0);
  });
});

describe("golden file - the Cribl-accepted reference archive", () => {
  it("this builder's parser reads the real reference .crbl", () => {
    const tar = new Uint8Array(gunzipSync(Buffer.from(referenceCrbl())));
    const entries = parseUstarTar(tar);
    const paths = new Set(entries.map((e) => e.path));
    // Known members of the reference pack.
    expect(paths.has("package.json")).toBe(true);
    expect(paths.has("default/outputs.yml")).toBe(true);
    expect(paths.has("default/pipelines/route.yml")).toBe(true);
    expect(paths.has("data/lookups/BrandLookup.yml")).toBe(true);
    expect(paths.has("data/samples/e6GVKx.json")).toBe(true);
    // Directory members are present and typed as directories.
    const dataDir = entries.find((e) => e.path === "data");
    expect(dataDir?.isDir).toBe(true);
  });

  it("the reference package.json is the LAST member and parses", () => {
    const tar = new Uint8Array(gunzipSync(Buffer.from(referenceCrbl())));
    const files = parseUstarTar(tar).filter((e) => !e.isDir);
    expect(files[files.length - 1].path).toBe("package.json");
    const pkg = JSON.parse(Buffer.from(files[files.length - 1].content).toString("utf8"));
    expect(pkg.version).toBeTruthy();
  });

  it("every reference header has a valid checksum (our algorithm agrees)", () => {
    const tar = new Uint8Array(gunzipSync(Buffer.from(referenceCrbl())));
    for (const h of headerBlocks(tar)) {
      expect(parseOctal(h.subarray(148, 156))).toBe(computeChecksum(h));
    }
  });
});

describe("report-file exclusion set (pinned)", () => {
  it("drops legacy report/side files from the archive", () => {
    const tar = buildUstarTar(
      new PackTree()
        .set("package.json", "{}")
        .set("default/pack.yml", "x")
        .set("FIELD_MAPPING_CommonSecurityLog.txt", "report")
        .set("VENDOR_RESEARCH.txt", "report")
        .set("DCR_GAP_ANALYSIS_CommonSecurityLog.txt", "report")
        .set("GAP_ANALYSIS_ERROR.txt", "err")
        .toTarEntries(),
      1,
    );
    const paths = parseUstarTar(tar).filter((e) => !e.isDir).map((e) => e.path);
    expect(paths).toEqual(["default/pack.yml", "package.json"]);
  });
});
