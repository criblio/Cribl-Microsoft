import type { UserContext, UserIdentity } from '../ports/user-context';

/** Default identity resolved by {@link FakeUserContext} when none is given. */
export const DEFAULT_FAKE_USER: UserIdentity = {
  id: 'user-1',
  username: 'test.user',
  email: 'test.user@example.com',
  firstName: 'Test',
  lastName: 'User',
};

/**
 * In-memory {@link UserContext} for tests. Resolves a fixed identity;
 * override any field via the constructor.
 */
export class FakeUserContext implements UserContext {
  private readonly identity: UserIdentity;

  constructor(overrides?: Partial<UserIdentity>) {
    this.identity = { ...DEFAULT_FAKE_USER, ...overrides };
  }

  async current(): Promise<UserIdentity> {
    return { ...this.identity };
  }
}
