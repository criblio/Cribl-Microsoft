/**
 * PackTree - the in-memory pack DOMAIN OBJECT - porting-plan Unit 19, task
 * item 1.
 *
 * The legacy scaffold (pack-builder.ts scaffoldPack) wrote directly to the
 * filesystem: `fs.mkdirSync`/`fs.writeFileSync` under an OS pack directory, then
 * `collectFiles` walked that directory back to tar it. Unit 19 replaces the
 * filesystem with an in-memory tree: a map of POSIX relative path -> content
 * (string or bytes). The scaffold builds this tree purely; the tar builder
 * serializes it; the ArtifactSink delivers the .crbl. Nothing here touches disk.
 *
 * Paths are POSIX-relative (forward slashes, no leading slash, no `..`, no
 * backslashes) - the archive is portable and the shells own placement. Invalid
 * paths are rejected at set time so a bad path can never reach the tar builder.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import type { TarFileEntry } from "./tar";
import { toBytes } from "./tar";

/** A pack file's content: UTF-8 text or raw bytes. */
export type PackFileContent = string | Uint8Array;

/** Error thrown when a pack relative path is invalid. */
export class PackTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackTreeError";
  }
}

function assertValidPath(relPath: string): void {
  if (relPath === "") throw new PackTreeError("pack path must not be empty");
  if (relPath.includes("\\")) {
    throw new PackTreeError(`pack path must use forward slashes: ${relPath}`);
  }
  if (relPath.startsWith("/")) {
    throw new PackTreeError(`pack path must be relative: ${relPath}`);
  }
  const parts = relPath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new PackTreeError(`pack path has an empty or traversal segment: ${relPath}`);
  }
}

/**
 * The pack file tree: an ordered map of relative path -> content. Insertion
 * order is preserved for readability, but the tar builder re-sorts to the
 * canonical dirs-before-files / package.json-last ordering, so callers need not
 * insert in any particular order.
 */
export class PackTree {
  private readonly files = new Map<string, PackFileContent>();

  /** Add or replace a file at `relPath`. Rejects invalid paths. */
  set(relPath: string, content: PackFileContent): this {
    assertValidPath(relPath);
    this.files.set(relPath, content);
    return this;
  }

  /** Content at `relPath`, or undefined. */
  get(relPath: string): PackFileContent | undefined {
    return this.files.get(relPath);
  }

  has(relPath: string): boolean {
    return this.files.has(relPath);
  }

  /** All relative paths, in insertion order. */
  paths(): string[] {
    return [...this.files.keys()];
  }

  get size(): number {
    return this.files.size;
  }

  /** All [path, content] pairs, in insertion order. */
  entries(): Array<[string, PackFileContent]> {
    return [...this.files.entries()];
  }

  /** The file entries as tar input (content encoded to bytes). */
  toTarEntries(): TarFileEntry[] {
    return this.entries().map(([path, content]) => ({
      path,
      content: toBytes(content),
    }));
  }
}
