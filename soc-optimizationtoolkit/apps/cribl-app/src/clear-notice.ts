/**
 * The connection-bar notice after a clear action. The secret clear tells the
 * operator to re-authenticate; the identity clear (Disconnected, "Clear stored
 * identity") must NOT, because the connect section that notice points at is
 * hidden under Disconnected.
 */
export function clearNotice(kind: 'secret' | 'identity'): string {
  return kind === 'secret'
    ? 'Stored secret cleared - re-enter the client secret in the App registration and connect section on Setup and Save and connect to re-authenticate.'
    : 'Stored Azure identity cleared.';
}
