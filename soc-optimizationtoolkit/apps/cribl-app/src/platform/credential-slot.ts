// The shared Azure credential slot (ADR 0009 decision 2; audit tenancy HIGH
// proxies.yml:40 and adapters.ts:256).
//
// proxies.yml injects every Azure credential from ONE fixed KV key per host:
// Basic ${kv.azureBasic} on login.microsoftonline.com, Bearer
// ${kv.azureArmToken} on management.azure.com, Bearer ${kv.azureGraphToken} on
// graph.microsoft.com. The inject template sees only `kv` - no request context,
// and a computed key resolves to undefined (measured in Live Preview; claude-kit
// standards/cribl-app-platform.md) - so there is no way to choose a credential
// per request. Do not try. Reading another tenant means swapping the slot.
//
// This module owns, for this tab:
//   - which tenant's ARM and Graph tokens sit in the slot (ONE owner per slot,
//     not a boolean per adapter instance: the old per-instance `tokenEnsured`
//     let tenant A's adapter send under tenant B's token after B replaced it);
//   - a reader/writer lock whose readers are ONE TENANT AT A TIME: ordinary
//     Azure requests for the tenant that owns the slot share it; a request for
//     another tenant waits until those drain, then takes the slot over (and
//     later requests of the old owner queue behind it, so neither starves). A
//     tenant session takes the slot exclusively and drains everything first.
//     Ensuring the token and sending the request both happen inside one
//     admitted run, so no other tenant can mint into the slot in between;
//   - the client secrets the operator entered THIS session, in memory only,
//     each with the tenant and client id it was entered for. Encrypted KV
//     entries are write-only, so a secret can only be put back in the slot
//     from a copy the tab already holds - and only while the connection still
//     has the identity it was entered for. Never persisted, never logged;
//     gone on reload.
//
// Other TABS are not covered by the lock - that is what the KV lease and the
// tenant proof in @soc/core's runTenantSession are for.

import type { CredentialSlot, TenantPorts, TenantProfile } from '@soc/core';
import { acquireArmToken, acquireGraphToken, fetchWithTimeout, kvUrl } from './http';

const BASIC_KV_KEY = 'azureBasic';
export const ARM_TOKEN_KV_KEY = 'azureArmToken';
export const GRAPH_TOKEN_KV_KEY = 'azureGraphToken';

/** Builds the ports a session runs with; supplied by adapters.ts to avoid an import cycle. */
export type SessionPortsFactory = (tenantId: string, slot: AzureCredentialSlot) => TenantPorts;

function tenantKey(tenantId: string): string {
  return tenantId.trim().toLowerCase();
}

/** The identity a secret was entered for. */
export interface SecretIdentity {
  readonly tenantId: string;
  readonly clientId: string;
}

interface RememberedSecret {
  readonly basic: string;
  readonly tenantId: string;
  readonly clientId: string;
}

function sameIdentity(a: SecretIdentity, b: SecretIdentity): boolean {
  return tenantKey(a.tenantId) === tenantKey(b.tenantId) && tenantKey(a.clientId) === tenantKey(b.clientId);
}

async function putEncrypted(key: string, value: string): Promise<void> {
  const res = await fetchWithTimeout(kvUrl(`${key}?encrypted=true`), { method: 'PUT', body: value });
  if (!res.ok) {
    throw new Error(`PUT ${key}?encrypted=true: HTTP ${res.status}\n${await res.text()}`);
  }
}

export class AzureCredentialSlot implements CredentialSlot {
  private readonly secrets = new Map<string, RememberedSecret>();
  private armTenant: string | null = null;
  private graphTenant: string | null = null;
  private readonly minting = new Map<string, Promise<void>>();
  private pendingExclusive = 0;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** The tenant whose ordinary requests the slot admits right now. */
  private owner: string | null = null;
  /** A tenant waiting for the owner's requests to drain; later owner requests queue behind it. */
  private switchWanted: string | null = null;
  private drainWaiters: Array<() => void> = [];

  private readonly sessionPorts: SessionPortsFactory;

  constructor(sessionPorts: SessionPortsFactory) {
    this.sessionPorts = sessionPorts;
  }

  // -- the session's secrets -------------------------------------------------

  /**
   * Keep `profileId`'s Basic value (base64 of clientId:secret) for this
   * session, with the identity it was entered for.
   */
  remember(profileId: string, basic: string, identity: SecretIdentity): void {
    this.secrets.set(profileId, { basic, tenantId: identity.tenantId, clientId: identity.clientId });
  }

  /** Drop it (the profile was deleted or its secret cleared). */
  forget(profileId: string): void {
    this.secrets.delete(profileId);
  }

  /**
   * Whether the tab holds a secret for `profile` that was entered for the
   * identity the profile has NOW. A copy entered before its tenant or client id
   * was edited is another identity's secret and does not count.
   */
  hasCredential(profile: TenantProfile): boolean {
    const held = this.secrets.get(profile.id);
    return held !== undefined && sameIdentity(held, profile.config);
  }

  // -- token ownership -------------------------------------------------------

  /**
   * Record that something outside this module wrote `tenantId`'s ARM token to
   * the slot (the Setup connect action and the session probe write it
   * directly), so the next ordinary request does not mint a second one - and,
   * more importantly, so an adapter for ANOTHER tenant knows it must.
   */
  noteArmToken(tenantId: string): void {
    this.armTenant = tenantKey(tenantId);
  }

  /**
   * A new client secret was written to `azureBasic`. Whatever tokens sit in the
   * slot were minted with the previous secret - possibly another app
   * registration in the SAME tenant - so neither is known to be current and the
   * next request mints again.
   */
  noteSecretWritten(): void {
    this.armTenant = null;
    this.graphTenant = null;
  }

  /** Mint and store an ARM token for `tenantId` (deduplicated while in flight). */
  mintArm(tenantId: string): Promise<void> {
    return this.mintOnce(`arm:${tenantKey(tenantId)}`, async () => {
      const token = await acquireArmToken(tenantId);
      await putEncrypted(ARM_TOKEN_KV_KEY, token.access_token);
      this.armTenant = tenantKey(tenantId);
    });
  }

  /** Mint and store a Graph token for `tenantId` (deduplicated while in flight). */
  mintGraph(tenantId: string): Promise<void> {
    return this.mintOnce(`graph:${tenantKey(tenantId)}`, async () => {
      const token = await acquireGraphToken(tenantId);
      await putEncrypted(GRAPH_TOKEN_KV_KEY, token.access_token);
      this.graphTenant = tenantKey(tenantId);
    });
  }

  /** Mint the ARM token unless the slot already holds `tenantId`'s. */
  async ensureArm(tenantId: string): Promise<void> {
    if (this.armTenant !== tenantKey(tenantId)) await this.mintArm(tenantId);
  }

  /** Mint the Graph token unless the slot already holds `tenantId`'s. */
  async ensureGraph(tenantId: string): Promise<void> {
    if (this.graphTenant !== tenantKey(tenantId)) await this.mintGraph(tenantId);
  }

  private mintOnce(key: string, mint: () => Promise<void>): Promise<void> {
    const running = this.minting.get(key);
    if (running !== undefined) return running;
    const p = mint().finally(() => this.minting.delete(key));
    this.minting.set(key, p);
    return p;
  }

  // -- the reader/writer lock -------------------------------------------------

  /**
   * Run an ordinary Azure request for `tenantId`: `fn` ensures the tenant's
   * token AND sends, as one admitted run. It is admitted only while the slot
   * belongs to `tenantId` - never while another tenant's requests are in
   * flight, whose mints and sends would interleave with its own - and never
   * while a tenant session is queued or running. It is counted so a session,
   * or a request for another tenant, can wait for it to finish.
   */
  async shared<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const key = tenantKey(tenantId);
    for (;;) {
      if (this.pendingExclusive > 0) {
        await this.exclusiveTail;
        continue;
      }
      if (this.inFlight.size === 0) {
        // Nobody is using the slot: take it.
        this.owner = key;
        if (this.switchWanted === key) this.switchWanted = null;
        break;
      }
      if (this.owner === key && (this.switchWanted === null || this.switchWanted === key)) break;
      // Another tenant's requests hold the slot (or another tenant is already
      // waiting for it): wait for them to drain, and ask for the slot next.
      if (this.switchWanted === null) this.switchWanted = key;
      await this.drained();
    }
    // Admission and registration happen in one synchronous step, so no other
    // waiter can slip in between.
    const p = fn();
    this.inFlight.add(p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(p);
      if (this.inFlight.size === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const wake of waiters) wake();
      }
    }
  }

  private drained(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingExclusive += 1;
    const previous = this.exclusiveTail;
    let release: () => void = () => undefined;
    this.exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      await Promise.allSettled([...this.inFlight]);
      return await fn();
    } finally {
      this.pendingExclusive -= 1;
      release();
    }
  }

  // -- the session primitives --------------------------------------------------

  async installCredential(profile: TenantProfile): Promise<void> {
    const held = this.secrets.get(profile.id);
    if (held === undefined) {
      throw new Error(
        `the client secret for connection ${profile.id} was not entered in this session, so it cannot be put in the shared slot`,
      );
    }
    if (!sameIdentity(held, profile.config)) {
      throw new Error(
        `the client secret held for connection ${profile.id} was entered for tenant ${held.tenantId} / client ${held.clientId}, ` +
          'not the identity the connection has now, so it is not put in the shared slot',
      );
    }
    this.noteSecretWritten();
    await putEncrypted(BASIC_KV_KEY, held.basic);
  }

  async mintTokens(tenantId: string): Promise<void> {
    await this.mintArm(tenantId);
    await this.mintGraph(tenantId);
  }

  portsFor(tenantId: string): TenantPorts {
    return this.sessionPorts(tenantId, this);
  }
}
