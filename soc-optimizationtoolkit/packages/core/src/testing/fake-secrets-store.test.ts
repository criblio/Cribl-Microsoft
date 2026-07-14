import { describe, expect, it } from 'vitest';
import { FakeSecretsStore, REDACTED_SECRET_PLACEHOLDER } from './fake-secrets-store';

describe('FakeSecretsStore', () => {
  it('round-trips plaintext values', async () => {
    const store = new FakeSecretsStore();
    await store.set('azure/tenantId', 'tenant-123');
    expect(await store.get('azure/tenantId')).toBe('tenant-123');
  });

  it('returns null for missing keys', async () => {
    const store = new FakeSecretsStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('redacts encrypted entries on get, mirroring the Cribl KV write-only semantic', async () => {
    const store = new FakeSecretsStore();
    await store.set('azure/clientSecret', 'super-secret', { encrypted: true });
    expect(await store.get('azure/clientSecret')).toBe(REDACTED_SECRET_PLACEHOLDER);
  });

  it('exposes the real encrypted value only through peek', async () => {
    const store = new FakeSecretsStore();
    await store.set('azure/clientSecret', 'super-secret', { encrypted: true });
    expect(store.peek('azure/clientSecret')).toBe('super-secret');
    expect(store.peek('missing')).toBeNull();
  });

  it('clears the encrypted flag when a key is overwritten as plaintext', async () => {
    const store = new FakeSecretsStore();
    await store.set('key', 'hidden', { encrypted: true });
    await store.set('key', 'visible');
    expect(await store.get('key')).toBe('visible');
  });

  it('deletes entries and treats deleting a missing key as a no-op', async () => {
    const store = new FakeSecretsStore();
    await store.set('key', 'value');
    await store.delete('key');
    expect(await store.get('key')).toBeNull();
    await expect(store.delete('key')).resolves.toBeUndefined();
  });

  it('lists keys by prefix without exposing values', async () => {
    const store = new FakeSecretsStore();
    await store.set('azure/tenantId', 'a');
    await store.set('azure/clientId', 'b');
    await store.set('cribl/token', 'c', { encrypted: true });
    expect(await store.list('azure/')).toEqual(['azure/tenantId', 'azure/clientId']);
    expect(await store.list('')).toHaveLength(3);
    expect(await store.list('graph/')).toEqual([]);
  });
});
