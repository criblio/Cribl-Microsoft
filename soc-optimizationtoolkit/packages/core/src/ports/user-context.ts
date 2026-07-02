/**
 * UserContext port: identity of the person driving the current session.
 *
 * Implementations:
 * - Cloud shell: adapter over the Cribl App Platform session (the logged-in
 *   Cribl.Cloud user).
 * - Local shell: the Node host returns the profile captured during first-run
 *   onboarding.
 */

/** Minimal identity of the current user. */
export interface UserIdentity {
  /** Stable unique identifier within the hosting platform. */
  id: string;
  /** Login/display handle. Always present. */
  username: string;
  /** Email address, when the platform exposes one. */
  email?: string;
  /** Given name, when known. */
  firstName?: string;
  /** Family name, when known. */
  lastName?: string;
}

/**
 * Read-only access to the current user's identity, used for audit fields
 * (who created a job, who exported a pack) and UI personalization.
 *
 * Error semantics: `current` rejects when there is no authenticated session;
 * it never resolves with a partial/anonymous identity.
 */
export interface UserContext {
  /** Resolve the identity of the user driving this session. */
  current(): Promise<UserIdentity>;
}
