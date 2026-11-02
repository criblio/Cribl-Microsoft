/**
 * The connection-bar notice after a clear action. The secret clear tells the
 * operator to re-authenticate; the identity clear (Disconnected, "Clear stored
 * identity") must NOT, because the connect section that notice points at is
 * hidden under Disconnected. For the same reason a secret clear under
 * Disconnected says the secret is gone and nothing more.
 */
import type { AzureConnectivity } from '@soc/core';

export function clearNotice(
  kind: 'secret' | 'identity',
  connectivity: AzureConnectivity = 'full',
): string {
  if (kind === 'identity') return 'Stored Azure identity cleared.';
  return connectivity === 'disconnected'
    ? 'Stored secret cleared. Azure is not connected (the saved Azure connectivity choice is Disconnected).'
    : 'Stored secret cleared - re-enter the client secret in the App registration and connect section on Setup and Save and connect to re-authenticate.';
}
