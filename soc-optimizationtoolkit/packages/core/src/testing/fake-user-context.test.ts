import { describe, expect, it } from 'vitest';
import { DEFAULT_FAKE_USER, FakeUserContext } from './fake-user-context';

describe('FakeUserContext', () => {
  it('resolves the default identity when constructed without overrides', async () => {
    const context = new FakeUserContext();
    expect(await context.current()).toEqual(DEFAULT_FAKE_USER);
  });

  it('applies overrides on top of the default identity', async () => {
    const context = new FakeUserContext({ id: 'user-42', email: 'jp@example.com' });
    const identity = await context.current();
    expect(identity.id).toBe('user-42');
    expect(identity.email).toBe('jp@example.com');
    expect(identity.username).toBe(DEFAULT_FAKE_USER.username);
  });

  it('returns a copy so callers cannot mutate the stored identity', async () => {
    const context = new FakeUserContext();
    const first = await context.current();
    first.username = 'tampered';
    expect((await context.current()).username).toBe(DEFAULT_FAKE_USER.username);
  });
});
