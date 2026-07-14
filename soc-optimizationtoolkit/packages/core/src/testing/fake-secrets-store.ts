import type { SecretsStore, SecretSetOptions } from '../ports/secrets-store';

/**
 * Placeholder returned by {@link FakeSecretsStore.get} for entries written
 * with `{ encrypted: true }`, mirroring the Cribl KV store's write-only
 * semantic for secrets.
 */
export const REDACTED_SECRET_PLACEHOLDER = '<redacted>';

/**
 * In-memory {@link SecretsStore} for tests.
 *
 * Honors the encrypted flag the way the strictest real platform does:
 * reading an encrypted entry yields {@link REDACTED_SECRET_PLACEHOLDER}
 * instead of the plaintext, so tests catch code that wrongly tries to
 * read-modify-write secrets. Use {@link FakeSecretsStore.peek} in assertions
 * that need the real stored value.
 */
export class FakeSecretsStore implements SecretsStore {
  private readonly entries = new Map<string, { value: string; encrypted: boolean }>();

  async set(key: string, value: string, opts?: SecretSetOptions): Promise<void> {
    this.entries.set(key, { value, encrypted: opts?.encrypted ?? false });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    return entry.encrypted ? REDACTED_SECRET_PLACEHOLDER : entry.value;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix));
  }

  /**
   * Test-only escape hatch: read the actual stored value, bypassing the
   * encrypted-entry redaction. Returns null for missing keys.
   */
  peek(key: string): string | null {
    return this.entries.get(key)?.value ?? null;
  }
}
