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
   * Cribl KV store) encrypted entries are WRITE-ONLY: reading them back yields
   * a redacted placeholder instead of the plaintext. Defaults to false.
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
   * exist. For entries written with `{ encrypted: true }`, some platforms
   * return a redacted placeholder rather than the plaintext (Cribl KV
   * write-only semantic) - callers must not assume an encrypted value can be
   * read back and should re-`set` rather than read-modify-write secrets.
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
