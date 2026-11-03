// The two shell paths that write or verify the shared Azure secret OUTSIDE a
// tenant session: Setup's Save and connect, and the once-per-connection secret
// probe (ADR 0009; review findings on AZR-65). App.tsx wires them; they live
// here so their order of slot writes can be pinned without mounting the shell.
//
// Both respect the same two guards a tenant session does:
//   - the KV credential LEASE: while another tab holds it, that tab is reading
//     a tenant through the shared slot, and writing the slot now would swap
//     the credential under its batch. Connect refuses; the probe reports
//     unproven. An unreadable lease is never treated as free.
//   - this tab's exclusive section on the slot, so no ordinary request of this
//     tab goes out between the secret write and the token write.
//
// Connect checks, INSIDE that exclusive section, that the connection it
// started for is still the active one. If the operator switched meanwhile,
// the now-active connection's secret is put back (when this tab holds it) or
// the slot is cleared - before any request for the new connection can run
// under the old one's app registration.
//
// The probe reads the credential-owner record. A record naming another
// connection is NOT a verified failure: the record is a best-effort plain
// document, and nothing was tried. That is `unproven`; `failed` is reserved for
// a token acquisition that was actually refused.

import {
  CREDENTIAL_LEASE_KEY,
  CREDENTIAL_OWNER_KEY,
  clearedCredentialOwner,
  credentialOwnerMatches,
  decodeCredentialOwner,
  encodeCredentialOwner,
  leaseHeldByOther,
} from '@soc/core';
import type { KvDocumentStore, Logger, TenantProfile } from '@soc/core';
import type { SecretIdentity } from './credential-slot';

/** The parts of AzureCredentialSlot these paths use. */
export interface SecretSlot {
  exclusive<R>(fn: () => Promise<R>): Promise<R>;
  remember(profileId: string, basic: string, identity: SecretIdentity): void;
  hasCredential(profile: TenantProfile): boolean;
  installCredential(profile: TenantProfile): Promise<void>;
  noteSecretWritten(): void;
  noteArmToken(tenantId: string): void;
}

export interface SecretPathDeps {
  readonly slot: SecretSlot;
  /** Where the lease and the credential-owner record live. */
  readonly documents: KvDocumentStore;
  /** This tab's lease holder id. */
  readonly holderId: string;
  /** Epoch ms. */
  readonly now: () => number;
  readonly mintArmToken: (tenantId: string) => Promise<{ access_token: string; expires_in?: number }>;
  readonly writeArmToken: (token: string) => Promise<void>;
  readonly logger?: Logger;
}

export interface ConnectDeps extends SecretPathDeps {
  readonly writeSecret: (basic: string) => Promise<void>;
  /** Fire-and-forget deletes of azureBasic and azureArmToken. */
  readonly clearSlot: () => void;
  /** The connection active NOW (read through a ref, not a render closure). */
  readonly activeProfile: () => TenantProfile | null;
}

export type ConnectOutcome =
  | { readonly kind: 'connected'; readonly expiresIn: number | undefined }
  /** The secret is stored and remembered; the verifying token step failed. */
  | { readonly kind: 'token-failed'; readonly message: string }
  /** Nothing was written. */
  | { readonly kind: 'write-failed'; readonly message: string }
  /** Nothing was written: another tab holds the lease, or it could not be read. */
  | { readonly kind: 'leased'; readonly message: string }
  /** The active connection changed during connect; the slot was put back or cleared. */
  | { readonly kind: 'changed'; readonly message: string };

export type ProbeOutcome =
  | { readonly state: 'missing' }
  | { readonly state: 'live' }
  /** Nothing proves or disproves the stored secret is this connection's. */
  | { readonly state: 'unproven'; readonly detail: string }
  /** A token acquisition with the stored secret was refused. */
  | { readonly state: 'failed'; readonly detail: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Null when this tab may write the slot; otherwise why not. */
async function leaseBlocks(deps: SecretPathDeps): Promise<string | null> {
  const verdict = leaseHeldByOther(await deps.documents.load(CREDENTIAL_LEASE_KEY), deps.holderId, deps.now());
  if (verdict.held === 'unknown') {
    return `the credential lease could not be read (${verdict.reason}), so whether another tab is reading a tenant through the shared credential is unknown`;
  }
  if (verdict.held) {
    return 'another tab of this app is reading a tenant through the shared credential right now';
  }
  return null;
}

async function saveOwner(deps: SecretPathDeps, value: unknown): Promise<void> {
  try {
    await deps.documents.save(CREDENTIAL_OWNER_KEY, value);
  } catch (err) {
    deps.logger?.warn('credential owner record not written', { error: errText(err) });
  }
}

/**
 * Save and connect for `profile`: write its secret and mint its ARM token as
 * one exclusive section of the slot. Never rejects.
 */
export async function connectThroughSlot(
  deps: ConnectDeps,
  profile: TenantProfile,
  input: { readonly tenantId: string; readonly clientId: string; readonly basic: string },
): Promise<ConnectOutcome> {
  const blocked = await leaseBlocks(deps);
  if (blocked !== null) {
    return { kind: 'leased', message: `Nothing was saved: ${blocked}. Try again when it finishes.` };
  }
  const { slot } = deps;
  type Inner =
    | { kind: 'write-failed'; message: string }
    | { kind: 'changed'; message: string }
    | { kind: 'written'; token: { expires_in?: number } | Error };
  const inner = await slot.exclusive(async (): Promise<Inner> => {
    try {
      await deps.writeSecret(input.basic);
    } catch (err) {
      return { kind: 'write-failed', message: errText(err) };
    }
    slot.noteSecretWritten();
    let token: { expires_in?: number } | Error;
    try {
      const minted = await deps.mintArmToken(input.tenantId);
      await deps.writeArmToken(minted.access_token);
      slot.noteArmToken(input.tenantId);
      token = minted;
    } catch (err) {
      token = err instanceof Error ? err : new Error(String(err));
    }
    // Still the connection this connect was for? Checked before the exclusive
    // section ends, so no request for another connection runs in between.
    const active = deps.activeProfile();
    if (active === null || active.id !== profile.id) {
      if (active !== null && slot.hasCredential(active)) {
        try {
          await slot.installCredential(active);
          await saveOwner(
            deps,
            encodeCredentialOwner({ profileId: active.id, tenantId: active.config.tenantId, clientId: active.config.clientId }),
          );
        } catch (err) {
          deps.logger?.error('connect: the active connection\'s secret was not put back', { error: errText(err) });
          deps.clearSlot();
          await saveOwner(deps, clearedCredentialOwner());
        }
      } else {
        deps.clearSlot();
        await saveOwner(deps, clearedCredentialOwner());
      }
      slot.noteSecretWritten();
      return {
        kind: 'changed',
        message:
          'The active connection changed while this secret was being saved, so it was not kept for the new one. ' +
          'Select the connection again and Save and connect.',
      };
    }
    await saveOwner(deps, encodeCredentialOwner({ profileId: profile.id, tenantId: input.tenantId, clientId: input.clientId }));
    return { kind: 'written', token };
  });
  if (inner.kind !== 'written') return inner;
  slot.remember(profile.id, input.basic, { tenantId: input.tenantId, clientId: input.clientId });
  if (inner.token instanceof Error) return { kind: 'token-failed', message: inner.token.message };
  return { kind: 'connected', expiresIn: inner.token.expires_in };
}

/**
 * Verify the stored secret for `profile` once: mint an ARM token with it when
 * nothing says it is another connection's. Never rejects.
 */
export async function probeStoredSecret(
  deps: SecretPathDeps & { readonly listKeys: () => Promise<string[]> },
  profile: TenantProfile,
  profileName: (profileId: string) => string | undefined,
): Promise<ProbeOutcome> {
  let keys: string[];
  try {
    keys = await deps.listKeys();
  } catch (err) {
    return { state: 'unproven', detail: `the stored keys could not be listed (${errText(err)}), so the secret was not checked` };
  }
  if (!keys.includes('azureBasic')) return { state: 'missing' };
  try {
    const blocked = await leaseBlocks(deps);
    if (blocked !== null) {
      return { state: 'unproven', detail: `the stored secret was not checked: ${blocked}` };
    }
    // Whose secret IS it? The slot is shared by every connection, so a token
    // minted for this tenant can still have come from another connection's
    // secret - two app registrations in one tenant. Probe only when the record
    // names this connection, or names nobody (a secret saved before the record
    // existed, or cleared).
    const ownerRead = await deps.documents.load(CREDENTIAL_OWNER_KEY);
    if (ownerRead.kind === 'unknown') {
      return {
        state: 'unproven',
        detail: `the record of whose secret is stored could not be read (${ownerRead.reason}), so it was not checked`,
      };
    }
    const owner = ownerRead.kind === 'value' ? decodeCredentialOwner(ownerRead.value) : null;
    if (owner !== null && !credentialOwnerMatches(owner, profile.config)) {
      const name = profileName(owner.profileId) ?? 'another connection';
      return {
        state: 'unproven',
        detail:
          `the record of whose secret is stored names ${name}, not this connection, so it was not checked. ` +
          'Save and connect this connection\'s secret to use it',
      };
    }
  } catch (err) {
    return { state: 'unproven', detail: `the secret was not checked (${errText(err)})` };
  }
  // The one verified answer: try the stored secret.
  try {
    await deps.slot.exclusive(async () => {
      const token = await deps.mintArmToken(profile.config.tenantId);
      await deps.writeArmToken(token.access_token);
      deps.slot.noteArmToken(profile.config.tenantId);
    });
    return { state: 'live' };
  } catch (err) {
    return { state: 'failed', detail: errText(err) };
  }
}
