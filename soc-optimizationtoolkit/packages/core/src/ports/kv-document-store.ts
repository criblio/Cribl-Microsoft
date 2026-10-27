/**
 * KvDocumentStore port - one readable JSON document per key, with a THREE-way
 * read (AZR-18). The cloud shell binds it over the app-scoped KV store.
 *
 * WHY A NEW PORT AND NOT SecretsStore OR ContentCache. Both existing KV
 * adapters fold the encrypted-value 403 into "absent" (null); since DBT-145
 * any other 403 rejects. For a secret that is right - an encrypted entry is
 * write-only and answers 403 by design. For a document the operator edits
 * any null-or-reject read is a data-loss path - a forgotten catch, or a 403
 * that reads as null, and a read that FAILED decodes as "no
 * document", the screen shows the defaults, and the next Save replaces the
 * operator's real selection with them (claude-kit standards/cribl-kv-store.md,
 * "A failed read is not a first run"). This port makes the difference a type,
 * so a caller cannot forget it:
 *
 *   absent   404, an empty body, or a body that is not JSON. Nothing of ours is
 *            there to lose - start from defaults, and Save may overwrite it.
 *   value    the parsed JSON. Whether it is OURS and READABLE by this release
 *            (kind, then version === 1) is the CALLER's second check - see
 *            readCoverageDocument - and is deliberately not made here.
 *   unknown  403, 5xx, a timeout or a transport error. The document may exist;
 *            the caller must show the reason and BLOCK SAVE until a load
 *            succeeds.
 *
 * Error semantics: `load` NEVER rejects - every failure is the `unknown`
 * variant, so a missing catch cannot turn one into a first run. `save` REJECTS
 * on any non-ok response (the PUT's own status is the only evidence a write
 * landed; never confirm by re-reading). Values are always written unencrypted:
 * an encrypted entry could never be read back, which is the opposite of what a
 * document store is for.
 *
 * There is no `delete` and no listing: nothing in AZR-18 needs either, and the
 * platform loses DELETE responses (platform/http.ts kvDelete), so a delete here
 * would need its own contract.
 */

/** The answer to {@link KvDocumentStore.load}. Discriminated on `kind`. */
export type KvDocumentLoad =
  | {
      kind: "absent";
      /** Which absence: never written, written empty, or not JSON at all. */
      why: "not-found" | "empty" | "corrupt";
    }
  | { kind: "value"; value: unknown }
  | {
      kind: "unknown";
      /** Human-readable cause, shown to the operator verbatim. */
      reason: string;
      /** The HTTP status when there was one; absent for a timeout or transport error. */
      status?: number;
    };

/** Plain (unencrypted) JSON documents in the app-scoped KV store. */
export interface KvDocumentStore {
  /** Read and parse the document at `key`. Never rejects; see {@link KvDocumentLoad}. */
  load(key: string): Promise<KvDocumentLoad>;
  /**
   * Write `value` as JSON at `key`, unencrypted, replacing what is there.
   * Rejects on a non-ok response and on a key {@link isKvDocumentKey} refuses.
   */
  save(key: string, value: unknown): Promise<void>;
}

/**
 * Whether `key` is safe to send to the KV store as-is. Measured on Cribl.Cloud
 * (cribl-kv-store.md, "Key characters"): any percent-escape in a key 404s on
 * the PUT and the GET alike, which reads as "never written" rather than as an
 * error. `[A-Za-z0-9-]` is safe within a segment, `/` and `.` round-trip, and
 * `_` is the escape character of the house encoding (cribl-app-kit
 * reference/kv.ts safeKeySegment), so this accepts exactly that alphabet, with
 * no empty, leading, trailing or doubled `/`. A segment made only of dots
 * (`.`, `..`) is refused too: kvUrl does not escape the key, and the URL parser
 * resolves dot segments, so `../x` would leave the KV store for /api/v1/x.
 * Both the shell adapter and the fake enforce it, so a key that would fail in
 * the product also fails in a unit test.
 */
export function isKvDocumentKey(key: string): boolean {
  return key.split("/").every((segment) => /^(?!\.+$)[A-Za-z0-9._-]+$/.test(segment));
}
