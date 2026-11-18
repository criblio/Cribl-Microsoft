/**
 * Name-based GUIDs (RFC 4122 version 5: SHA-1 over a namespace GUID and a
 * name). The same namespace and name always give the same GUID, so a resource
 * whose name must be a GUID - an Azure role assignment - can be addressed
 * deterministically: a second PUT of the same grant lands on the same name
 * (idempotent) instead of minting a fresh random id each time (AZR-103).
 *
 * WHY HERE AND NOT crypto.randomUUID. Core never reaches for crypto, Date or
 * Math.random (the shell mints random ids). A name-based GUID is not random:
 * it is a pure function of its inputs, so it belongs in the domain, and the
 * SHA-1 below is a plain implementation over bytes with no IO.
 *
 * SHA-1 is used because RFC 4122 version 5 names it, not for security: the
 * GUID only has to be stable and spread out, and nothing here is a secret.
 *
 * Pure: no IO, no clock, no randomness.
 */

/** UTF-8 bytes of a string (surrogate pairs combined into one code point). */
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** SHA-1 of a byte array, as 20 bytes (FIPS 180-4). */
export function sha1(bytes: readonly number[]): number[] {
  const bitLength = bytes.length * 8;
  const msg = [...bytes, 0x80];
  while (msg.length % 64 !== 56) msg.push(0);
  // 64-bit big-endian length; the high word is 0 for anything under 512 MB.
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  msg.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  msg.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80).fill(0);
  for (let block = 0; block < msg.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      const j = block + i * 4;
      w[i] = (((msg[j] ?? 0) << 24) | ((msg[j + 1] ?? 0) << 16) | ((msg[j + 2] ?? 0) << 8) | (msg[j + 3] ?? 0)) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + (f >>> 0) + e + k + (w[i] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].flatMap((h) => [(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]);
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a GUID in its 8-4-4-4-12 hex form (braces not accepted). */
export function isGuid(value: string): boolean {
  return GUID_PATTERN.test(value.trim());
}

function guidBytes(guid: string): number[] {
  if (!isGuid(guid)) throw new Error(`not a GUID: '${guid}'`);
  const hex = guid.trim().replace(/-/g, "");
  const out: number[] = [];
  for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * The RFC 4122 version 5 GUID of `name` (UTF-8) in `namespace`, lower case.
 * Throws only when `namespace` is not a GUID - a programming error, since
 * every caller passes a constant.
 */
export function nameBasedGuid(namespace: string, name: string): string {
  const hash = sha1([...guidBytes(namespace), ...utf8Bytes(name)]);
  const b = hash.slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // version 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.map(hex2).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
