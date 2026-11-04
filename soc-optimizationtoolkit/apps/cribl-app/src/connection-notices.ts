/**
 * Connection notices that follow the saved Azure connectivity choice
 * (DBT-246, I4). Under Disconnected the App registration and connect section
 * and the Select resources and grant permissions section are hidden, so no
 * notice may send the operator there: it says Azure is not connected by
 * choice and points at the choice itself, or at the template exports.
 *
 * Extracted from App.tsx, which has no harness, so the text can be pinned
 * (the same reason clear-notice.ts exists). Pure: no IO, no React.
 */

import type { AzureConnectivity } from '@soc/core';

/** Where a Disconnected operator is sent: the choice, or the exports. */
export const DISCONNECTED_POINTER =
  'Azure is not connected: the saved Azure connectivity choice is Disconnected. ' +
  'To connect, change "How will this app work with Azure?" on Setup; otherwise ' +
  'export ARM templates to hand to someone who can deploy them.';

/** The secret-verification probe as the shell tracks it. */
export type SecretProbe =
  | { state: 'idle' | 'checking' | 'live' | 'missing' }
  | { state: 'failed' | 'unproven'; detail: string };

/**
 * The VERIFIED secret notice: null while the secret is live, the probe is still
 * running, or there is nothing to probe yet. Only a verified absence or failure
 * warns.
 */
export function secretNotice(
  connectivity: AzureConnectivity,
  secretLive: boolean,
  probe: SecretProbe,
): string | null {
  if (secretLive) return null;
  if (probe.state !== 'missing' && probe.state !== 'failed' && probe.state !== 'unproven') return null;
  if (connectivity === 'disconnected') return DISCONNECTED_POINTER;
  // AZR-92: not verified either way (another connection's record, or another
  // tab holds the credential lease) - said as unknown, never as a failure.
  if (probe.state === 'unproven') {
    return `Whether the stored client secret is this connection's is not known: ${probe.detail}.`;
  }
  if (probe.state === 'failed') {
    return (
      'The stored client secret FAILED verification just now - token acquisition ' +
      'was refused. Re-enter the secret in the App registration and connect ' +
      `section on Setup. Detail: ${probe.detail}`
    );
  }
  return (
    'No client secret is stored for this connection (verified just now). Enter it ' +
    'in the App registration and connect section on Setup and Save and connect.'
  );
}

/**
 * The Onboard / Batch "Connection incomplete" panel text. The missing-field
 * list (the gate reason) always stays on screen.
 */
export function connectionIncompleteText(
  connectivity: AzureConnectivity,
  missing: readonly string[],
  page: 'onboard' | 'batch',
): string {
  const head = `The active connection is missing required configuration: ${missing.join(', ')}.`;
  if (connectivity === 'disconnected') {
    return `${head} ${DISCONNECTED_POINTER} The Run action unlocks once all five fields are set.`;
  }
  if (page === 'onboard') {
    return (
      `${head} Setup shows the whole journey and names the ` +
      'single next step. Connect first in the App registration and connect section on ' +
      'Setup - that fills the tenant and client ids. Then choose WHERE to deploy in the ' +
      'Select resources and grant permissions section (or commit a scope from the ' +
      "Sentinel Integration page's Azure Resources section). The Run action unlocks once all " +
      'five fields are set.'
    );
  }
  return (
    `${head} Setup shows the whole journey and names the ` +
    'single next step: connect first in the App registration and connect section on ' +
    'Setup, then choose the target in the Select resources and grant permissions ' +
    'section. The Run action unlocks once all five fields are set.'
  );
}
