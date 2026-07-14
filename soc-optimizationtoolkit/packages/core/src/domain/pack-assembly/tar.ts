/**
 * Pure ustar/.crbl builder - porting-plan Unit 19 (ENG-08), task item 7 and
 * porting-plan section 3 contract 5.
 *
 * THE PACKAGING-CORRECTNESS HEART. The legacy pack-builder had TWO code paths
 * (pack-builder.ts 1565-1590): the primary Windows path shelled out to
 * `C:\Windows\System32\tar.exe`, and a Node-only fallback `buildNodeTar`
 * (1501-1518) emitted a gzip-wrapped ustar by hand. The tar.exe path DOES NOT
 * port - the browser cloud shell has no child process, and even the local Node
 * host must produce identical bytes deterministically. So the pure builder
 * becomes the ONLY implementation, hardened into a correct POSIX ustar emitter.
 *
 * Everything here is PURE: it emits BYTES in memory (Uint8Array) and never
 * touches the filesystem. There is NO Date/crypto/Math.random - the archive
 * mtime is a caller-supplied deterministic value (`mtimeSec`), so the same pack
 * tree always produces byte-identical output. gzip is emitted with STORED
 * (uncompressed) DEFLATE blocks so the whole compressor is deterministic,
 * dependency-free, and browser-safe (no Node zlib); a standard gunzip - Cribl's
 * included - decompresses it identically to any other gzip.
 *
 * Header layout mined byte-for-byte from the Cribl-ACCEPTED reference archive
 * (Cribl-Microsoft_IntegrationSolution/build/reference-pack.crbl, vendored under
 * __fixtures__/): name(100), mode(8), uid(8), gid(8), size(12), mtime(12),
 * chksum(8), typeflag(1), linkname(100), magic "ustar\0"(6), version "00"(2),
 * uname(32), gname(32), devmajor(8), devminor(8), prefix(155). Numeric fields
 * use the reference's exact padding (mode/uid/gid/dev: 6 octal digits + space +
 * NUL; size/mtime: 11 octal digits + space; checksum: 6 octal digits + space +
 * NUL). Checksum = the unsigned sum of all 512 header bytes with the checksum
 * field itself read as 8 ASCII spaces (verified against the reference).
 *
 * ORDERING (section 3 item 5, and pinned by tar.test.ts): all DIRECTORY entries
 * first, sorted; then all FILE entries, sorted; `package.json` forced LAST. The
 * legacy sort used `localeCompare`, which is locale-dependent and therefore
 * non-deterministic; this port sorts by UTF-16 code unit (ASCII byte order,
 * capital letters before lowercase) so the ordering is stable everywhere - a
 * conscious determinism fix over the legacy comparator.
 */

/**
 * A relative-path -> content map is the pack domain object (see pack-tree.ts).
 * The tar builder consumes an already-ordered list of file entries.
 */
export interface TarFileEntry {
  /** POSIX relative path, forward slashes, no leading slash. */
  path: string;
  /** File bytes. Strings are UTF-8 encoded before sizing/writing. */
  content: Uint8Array;
}

const BLOCK = 512;

/** Report/side files the legacy scaffold wrote into the pack dir but which must
 * NEVER ship inside a .crbl (section 3 / task item 8 decision). The legacy
 * tar.exe path excluded FIELD_MAPPING_* / VENDOR_RESEARCH* / inputs.yml, but the
 * Node fallback did NOT exclude the DCR_GAP_ANALYSIS_*.txt or GAP_ANALYSIS_ERROR
 * reports, so every pack shipped gap-analysis text. Unit 19 pins ONE exclusion
 * set applied by the builder itself as a defensive guard - the PackTree the
 * scaffold produces already omits reports, but any caller-injected report file
 * matching these patterns is dropped from the archive. */
export const REPORT_FILE_EXCLUSIONS: readonly RegExp[] = [
  /^FIELD_MAPPING_/,
  /^VENDOR_RESEARCH/,
  /^DCR_GAP_ANALYSIS_/,
  /^GAP_ANALYSIS_ERROR/,
];

/** True when `relPath` (basename or full path) is an excluded report file. */
export function isExcludedFromCrbl(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return REPORT_FILE_EXCLUSIONS.some((re) => re.test(base));
}

const ENCODER = new TextEncoder();

/** UTF-8 encode a string, or pass a Uint8Array through unchanged. */
export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? ENCODER.encode(content) : content;
}

function writeAscii(buf: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i) & 0xff;
  }
}

/** Left-zero-pad an octal representation of `value` to `digits` characters. */
function octal(value: number, digits: number): string {
  const s = Math.floor(value).toString(8);
  if (s.length > digits) {
    throw new Error(`ustar numeric field overflow: ${value} exceeds ${digits} octal digits`);
  }
  return s.padStart(digits, "0");
}

/**
 * Build one 512-byte ustar header. `name` already carries a trailing slash for
 * directories. Field encodings replicate the vendored reference archive.
 */
function ustarHeader(
  name: string,
  size: number,
  isDir: boolean,
  mtimeSec: number,
): Uint8Array {
  if (ENCODER.encode(name).length > 100) {
    throw new Error(`ustar name too long (>100 bytes): ${name}`);
  }
  const h = new Uint8Array(BLOCK);

  writeAscii(h, 0, name);
  // mode: 6 octal digits + space + NUL
  writeAscii(h, 100, octal(isDir ? 0o755 : 0o644, 6) + " \0");
  // uid / gid: 6 octal digits + space + NUL
  writeAscii(h, 108, "000000 \0");
  writeAscii(h, 116, "000000 \0");
  // size: 11 octal digits + space
  writeAscii(h, 124, octal(size, 11) + " ");
  // mtime: 11 octal digits + space
  writeAscii(h, 136, octal(mtimeSec, 11) + " ");
  // typeflag
  writeAscii(h, 156, isDir ? "5" : "0");
  // magic "ustar\0" + version "00"
  writeAscii(h, 257, "ustar\0" + "00");
  // devmajor / devminor: 6 octal digits + space + NUL (reference fills these)
  writeAscii(h, 329, "000000 \0");
  writeAscii(h, 337, "000000 \0");

  // Checksum: fill field with 8 spaces, sum all bytes unsigned, then store as
  // 6 octal digits + space + NUL (reference layout).
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  writeAscii(h, 148, octal(sum, 6) + " \0");

  return h;
}

/** Every ancestor directory path implied by a set of file paths (no slash). */
function ancestorDirs(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    parts.pop(); // drop the file name
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      dirs.add(acc);
    }
  }
  return dirs;
}

/** Deterministic ASCII/code-unit comparison (replaces legacy localeCompare). */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the raw (uncompressed) ustar tar bytes for a set of pack files.
 *
 * Directory entries are synthesized for every ancestor of every file so the
 * archive mirrors the reference (which carries explicit `data`, `default`, ...
 * directory members). Ordering: directories (sorted) first, then files
 * (sorted), with `package.json` forced last. Report/side files are dropped via
 * {@link isExcludedFromCrbl}.
 */
export function buildUstarTar(
  entries: TarFileEntry[],
  mtimeSec: number,
): Uint8Array {
  const files = entries.filter((e) => !isExcludedFromCrbl(e.path));
  const dirPaths = [...ancestorDirs(files.map((e) => e.path))].sort(byPath);

  const filePaths = files.map((e) => e.path).sort((a, b) => {
    if (a === "package.json") return 1; // package.json forced last
    if (b === "package.json") return -1;
    return byPath(a, b);
  });
  const byPathContent = new Map(files.map((e) => [e.path, e.content]));

  const chunks: Uint8Array[] = [];

  for (const dir of dirPaths) {
    chunks.push(ustarHeader(`${dir}/`, 0, true, mtimeSec));
  }
  for (const fp of filePaths) {
    const content = byPathContent.get(fp)!;
    chunks.push(ustarHeader(fp, content.length, false, mtimeSec));
    chunks.push(content);
    const rem = content.length % BLOCK;
    if (rem > 0) chunks.push(new Uint8Array(BLOCK - rem));
  }
  // Two zero blocks terminate the archive (matches the reference trailer).
  chunks.push(new Uint8Array(BLOCK * 2));

  return concat(chunks);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** One parsed tar member. */
export interface ParsedTarEntry {
  path: string;
  isDir: boolean;
  content: Uint8Array;
}

/** Parse the raw octal digits of a ustar numeric field (space/NUL tolerant). */
function parseOctal(bytes: Uint8Array): number {
  let s = "";
  for (const b of bytes) {
    if (b === 0 || b === 0x20) {
      if (s.length > 0) break;
      continue;
    }
    s += String.fromCharCode(b);
  }
  return s === "" ? 0 : parseInt(s, 8);
}

function readCString(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Parse a raw ustar tar (already gunzipped) back into its members. Tolerant of
 * both the reference encoding (directory members with no trailing slash, marked
 * only by typeflag 5) and this builder's encoding (trailing slash + typeflag 5),
 * so it round-trips this builder AND reads real Cribl-accepted archives.
 */
export function parseUstarTar(tar: Uint8Array): ParsedTarEntry[] {
  const out: ParsedTarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    // A zero block signals end-of-archive.
    if (header.every((b) => b === 0)) break;

    const rawName = readCString(header.subarray(0, 100));
    const size = parseOctal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156]);
    off += BLOCK;

    const isDir = typeflag === "5" || rawName.endsWith("/");
    const path = rawName.replace(/\/+$/, "");
    if (isDir) {
      out.push({ path, isDir: true, content: new Uint8Array(0) });
    } else {
      const content = tar.slice(off, off + size);
      out.push({ path, isDir: false, content });
      off += Math.ceil(size / BLOCK) * BLOCK;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// gzip (stored DEFLATE blocks) - pure, deterministic, no Node zlib
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of a byte array. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const STORED_MAX = 0xffff;

/**
 * gzip-wrap `data` using STORED (uncompressed) DEFLATE blocks. The output is a
 * fully standard gzip stream (any gunzip decompresses it); it is merely not
 * compressed, which keeps the encoder pure and deterministic. mtime in the gzip
 * header is fixed to 0 for reproducibility.
 */
export function gzipStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];

  // gzip header: magic, CM=deflate(8), FLG=0, MTIME=0, XFL=0, OS=255(unknown).
  parts.push(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]));

  if (data.length === 0) {
    // A single final empty stored block.
    parts.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
  } else {
    for (let pos = 0; pos < data.length; pos += STORED_MAX) {
      const len = Math.min(STORED_MAX, data.length - pos);
      const isFinal = pos + len >= data.length;
      const block = new Uint8Array(5 + len);
      block[0] = isFinal ? 0x01 : 0x00; // BFINAL bit, BTYPE=00 (stored)
      block[1] = len & 0xff;
      block[2] = (len >>> 8) & 0xff;
      block[3] = ~len & 0xff;
      block[4] = (~len >>> 8) & 0xff;
      block.set(data.subarray(pos, pos + len), 5);
      parts.push(block);
    }
  }

  const crc = crc32(data);
  const isize = data.length >>> 0;
  parts.push(
    new Uint8Array([
      crc & 0xff,
      (crc >>> 8) & 0xff,
      (crc >>> 16) & 0xff,
      (crc >>> 24) & 0xff,
      isize & 0xff,
      (isize >>> 8) & 0xff,
      (isize >>> 16) & 0xff,
      (isize >>> 24) & 0xff,
    ]),
  );

  return concat(parts);
}

/**
 * Inverse of {@link gzipStored}: parse a gzip stream whose payload is STORED
 * DEFLATE blocks and return the original bytes. Supports exactly the subset this
 * builder emits (compressed blocks throw) - enough for a fully pure round-trip
 * of this module's own output. Real (compressed) archives are gunzipped by the
 * shell/runtime before {@link parseUstarTar}.
 */
export function ungzipStored(gz: Uint8Array): Uint8Array {
  if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 0x08) {
    throw new Error("not a gzip/deflate stream");
  }
  const flg = gz[3];
  let pos = 10;
  if (flg & 0x04) {
    // FEXTRA
    const xlen = gz[pos] | (gz[pos + 1] << 8);
    pos += 2 + xlen;
  }
  if (flg & 0x08) while (gz[pos++] !== 0); // FNAME
  if (flg & 0x10) while (gz[pos++] !== 0); // FCOMMENT
  if (flg & 0x02) pos += 2; // FHCRC

  const out: Uint8Array[] = [];
  let final = false;
  while (!final) {
    const b = gz[pos++];
    final = (b & 0x01) === 1;
    const btype = (b >>> 1) & 0x03;
    if (btype !== 0) {
      throw new Error("ungzipStored supports only STORED DEFLATE blocks");
    }
    const len = gz[pos] | (gz[pos + 1] << 8);
    pos += 4; // LEN + NLEN
    out.push(gz.slice(pos, pos + len));
    pos += len;
  }
  return concat(out);
}

/**
 * Build the final .crbl bytes: order + tar the pack files, then gzip. The one
 * call shells use to produce a downloadable/uploadable archive.
 */
export function buildCrbl(
  entries: TarFileEntry[],
  mtimeSec: number,
): Uint8Array {
  return gzipStored(buildUstarTar(entries, mtimeSec));
}
