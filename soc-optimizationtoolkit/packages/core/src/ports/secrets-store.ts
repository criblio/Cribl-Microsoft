/**
 * SecretsStore port: key/value storage for configuration values and secrets.
 *
 * Implementations:
 * - Cloud shell: adapter over the Cribl App Platform /kvstore API.
 * - Local shell: adapter over the Node host's encrypted on-disk store.
 */

/** Options accepted by {@link SecretsStore.set}. */
export interface SecretSetOptions {
  /**
   * When true the value is stored as a secret. On some platforms (notably the
   * Cribl KV store) encrypted entries are WRITE-ONLY: reading them back never
   * yields the plaintext - `get` resolves a redacted placeholder or null
   * (the Cribl platform rejects the read with 403 "Cannot read encrypted
   * value", which adapters surface as null). Defaults to false.
   */
  encrypted?: boolean;
}

/**
 * Key/value store for settings and secrets shared by both app shells.
 *
 * Error semantics: all methods reject only on backend failure (storage
 * unavailable, permission denied). Missing keys are never an error: `get`
 * resolves null, `delete` is an idempotent no-op, `list` resolves [].
 */
export interface SecretsStore {
  /**
   * Store `value` under `key`, overwriting any existing entry (including its
   * encrypted flag). Pass `{ encrypted: true }` for secrets; see
   * {@link SecretSetOptions.encrypted} for the read-back caveat.
   */
  set(key: string, value: string, opts?: SecretSetOptions): Promise<void>;

  /**
   * Read the value stored under `key`. Resolves null when the key does not
   * exist. For entries written with `{ encrypted: true }`, the plaintext is
   * never returned: platforms resolve a redacted placeholder or null - the
   * present-but-unreadable case (the Cribl KV store refuses the read with
   * 403 "Cannot read encrypted value"; adapters map that to null, not a
   * rejection). Callers must not assume an encrypted value can be read back
   * and should re-`set` rather than read-modify-write secrets.
   */
  get(key: string): Promise<string | null>;

  /** Remove the entry under `key`. Resolves without error if the key does not exist. */
  delete(key: string): Promise<void>;

  /**
   * List all stored keys that start with `prefix` (pass '' for every key).
   * Returns keys only, never values.
   */
  list(prefix: string): Promise<string[]>;
}
