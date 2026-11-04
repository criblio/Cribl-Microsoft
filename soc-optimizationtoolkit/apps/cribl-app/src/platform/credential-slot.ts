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
// Other TABS are not covered by the lock. The KV lease and the tenant proof in
// @soc/core's runTenantSession protect a session's OWN batch; the owner check
// below (AZR-92) protects every other tab's ordinary requests from it.
//
// THE OWNER CHECK PER BATCH (AZR-92, ADR 0009 decision 2). The KV record
// `azure-credential-owner` names the tenant whose credential is in the slot;
// a tenant session marks it SWITCHING before it swaps and names the new owner
// only once the tokens are in, and Save and connect does the same. Every
// ordinary request this module admits (`shared`) is a member of a BATCH:
//   - before anything is sent - before even a token mint - the batch reads the
//     record once; a record naming another tenant, a swap in progress, or a
//     read that failed or does not decode REFUSES every member: it rejects
//     with SharedCredentialRefusal, the port's transport-failure path, so a
//     screen shows "could not read", never a status it could read as red or
//     an empty list. A write (any non-GET) is therefore never sent;
//   - after every member has settled, the batch reads the record again; unless
//     it is the very record read before (every write carries its own write id),
//     every member's answer is discarded as unknown - a write's outcome is
//     reported as unknown, since it was sent.
// A batch is this tab's ordinary READS for one connection (tenant AND client:
// a record naming the same tenant under another app registration refuses)
// admitted while it is open: from the first until the first of them settles,
// and for at most BATCH_JOIN_MS after its before-read resolved - a read asked
// later than that is not admitted on a verdict that old. N reads issued
// together share ONE read before and ONE after; the after-read waits for the
// LAST member. A write never joins a batch - it opens its own, so the record
// it is admitted on was read after it was asked.
// Cost: 2 KV reads of the record per batch, 1 when the before-read refuses or
// every member fails (nobody is left to take an answer from the after-read). A
// read batch opened within BATCH_JOIN_MS of the previous batch's after-read
// uses that after-read as its before-read (no staler than joining), so a
// sequential chain - nextLink paging - costs about 1 per request. Plus 1 per
// RE-CHECK: before each resend of a write after a 429, and before a 401
// re-mint (any access) - the record is read again and must be the very
// record the batch was admitted on. Nothing is read until a request is made,
// so building adapters (a screen mounting) reads nothing. Tenant-session
// ports ('session' mode in adapters.ts) never pass through `shared`, so the
// session is exempt. Whether these KV reads count against the platform's
// 100 req/min proxy budget is NOT measured (ADR 0009).
//
// TOKEN CACHES. This tab's record of whose ARM and Graph tokens are in the
// slot cannot see another tab's writes. So when a batch is admitted on a
// record other than the one this tab's last batch was admitted on, the caches
// are dropped and the next request mints its own token first: a record
// rewritten elsewhere (a connect whose mint failed, a session's restore, a
// Graph token another tab never replaced) never lets a stale cache skip the
// mint. Costs one mint per record change per tab; no KV read.
//
// What the check does NOT prove: that the slot holds what the record says.
// The record is plain KV with no compare-and-swap, written by this app only;
// a tab still running a bundle from before AZR-92 writes no switching marker
// and no write id. A read admitted, then interleaved with another tab's swap
// that writes its marker after the read was sent, is caught only by the
// after-read - its answer is discarded, but it WAS sent.

import { CREDENTIAL_OWNER_KEY, judgeSlotOwner, slotOwnerChanged } from '@soc/core';
import type {
  CredentialSlot,
  KvDocumentLoad,
  KvDocumentStore,
  SlotOwnerCheck,
  TenantPorts,
  TenantProfile,
} from '@soc/core';
import { acquireArmToken, acquireGraphToken, fetchWithTimeout, kvUrl } from './http';

const BASIC_KV_KEY = 'azureBasic';
const ARM_TOKEN_KV_KEY = 'azureArmToken';
const GRAPH_TOKEN_KV_KEY = 'azureGraphToken';

/** Whether an ordinary request only reads (GET) or may change something. */
export type SlotAccess = 'read' | 'write';

/** Whose ordinary request this is: the tenant, and when known the app registration. */
export interface SlotIdentity {
  readonly tenantId: string;
  readonly clientId?: string;
}

/**
 * Handed to an ordinary run: re-reads the owner record and rejects with
 * SharedCredentialRefusal unless it is the very record the batch was admitted
 * on. Call it before anything sent on the strength of an old verdict - a
 * write's resend, a re-mint. Costs one KV read.
 */
export type SlotRecheck = () => Promise<void>;

/**
 * How long after its before-read resolved a batch still admits new reads, and
 * how long a batch's after-read serves as the next read batch's before-read.
 */
export const BATCH_JOIN_MS = 2000;

/**
 * An ordinary Azure request refused by the owner check (AZR-92): before it was
 * sent (`stage: 'before'`) or, its answer discarded, after (`'after'`). It is a
 * rejection - the port's "could not reach Azure" path - so nothing renders it
 * as a status, a red cell or an empty list.
 */
export class SharedCredentialRefusal extends Error {
  readonly stage: 'before' | 'after';
  readonly access: SlotAccess;
  constructor(stage: 'before' | 'after', access: SlotAccess, tenantId: string, reason: string) {
    super(refusalText(stage, access, tenantId, reason));
    this.name = 'SharedCredentialRefusal';
    this.stage = stage;
    this.access = access;
  }
}

function refusalText(stage: 'before' | 'after', access: SlotAccess, tenantId: string, reason: string): string {
  if (stage === 'before') {
    return access === 'read'
      ? `Not read: ${reason}. Its answer would not be tenant ${tenantId}'s, so this read is unknown; try again when it finishes.`
      : `Not sent: ${reason}. Nothing was written; try again when it finishes.`;
  }
  return access === 'read'
    ? `Discarded: the shared Azure credential changed while this read was in flight (${reason}), so its answer may not be tenant ${tenantId}'s and is unknown.`
    : `The shared Azure credential changed while this write was in flight (${reason}), so it may have gone out under another tenant's credential: its outcome is unknown. Check the target before retrying.`;
}

/** One batch of the owner check: see the module header. */
interface OwnerBatch {
  /** The connection the batch is for: tenant and client. */
  readonly key: string;
  /** Still accepting reads: no member has settled yet. */
  open: boolean;
  /** When the before-read resolved (null while it is in flight). */
  beforeAt: number | null;
  /** Members admitted to the batch that have not settled (or been refused). */
  members: number;
  /** Members whose run succeeded and that wait on the after-read. */
  waiting: number;
  readonly before: Promise<SlotOwnerCheck>;
  readonly after: Promise<SlotOwnerCheck>;
  startAfter: () => void;
}

/** Builds the ports a session runs with; supplied by adapters.ts to avoid an import cycle. */
export type SessionPortsFactory = (tenantId: string, slot: AzureCredentialSlot) => TenantPorts;

function tenantKey(tenantId: string): string {
  return tenantId.trim().toLowerCase();
}

function identityOf(who: string | SlotIdentity): SlotIdentity {
  return typeof who === 'string' ? { tenantId: who } : who;
}

function connectionKey(who: SlotIdentity): string {
  return `${tenantKey(who.tenantId)}|${who.clientId === undefined ? '*' : tenantKey(who.clientId)}`;
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
  /** The batch new reads join (AZR-92), while it is open. */
  private batch: OwnerBatch | null = null;
  /** The last admitting after-read, which a read batch opened soon after uses as its before-read. */
  private lastAfter: { readonly key: string; readonly check: SlotOwnerCheck; readonly at: number } | null = null;
  /** The record this tab's last admitted batch was admitted on (null: none yet). */
  private cacheStamp: string | null = null;

  private readonly sessionPorts: SessionPortsFactory;
  /** Where the owner record lives: the app KV store, shared by every tab. */
  private readonly ownerDocuments: KvDocumentStore;
  private readonly now: () => number;

  constructor(sessionPorts: SessionPortsFactory, ownerDocuments: KvDocumentStore, now: () => number = () => Date.now()) {
    this.sessionPorts = sessionPorts;
    this.ownerDocuments = ownerDocuments;
    this.now = now;
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
   *
   * Once admitted it is a member of an owner-check batch (AZR-92, module
   * header): `fn` runs only when the owner record names `who` (its tenant,
   * and its client when given), and its answer is returned only when the
   * record is unchanged after the batch. `access` decides whether a refusal
   * says "not read" or "nothing written", and a write always opens a batch of
   * its own. `fn` is handed a {@link SlotRecheck} for anything it sends later
   * on the batch's verdict.
   */
  async shared<T>(
    who: string | SlotIdentity,
    access: SlotAccess,
    fn: (recheck: SlotRecheck) => Promise<T>,
  ): Promise<T> {
    const identity = identityOf(who);
    const key = tenantKey(identity.tenantId);
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
    // waiter can slip in between. The owner check runs inside the registered
    // run, so a session of this tab waits for its after-read too.
    const p = this.checked(identity, access, fn);
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

  // -- the owner check (AZR-92) ----------------------------------------------

  private async readOwner(identity: SlotIdentity): Promise<SlotOwnerCheck> {
    let read: KvDocumentLoad;
    try {
      read = await this.ownerDocuments.load(CREDENTIAL_OWNER_KEY);
    } catch (err) {
      read = { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
    }
    return judgeSlotOwner(read, identity);
  }

  private openBatch(identity: SlotIdentity, key: string, access: SlotAccess): OwnerBatch {
    let startAfter: () => void = () => undefined;
    const after = new Promise<SlotOwnerCheck>((resolve) => {
      startAfter = () => {
        void this.readOwner(identity).then((check) => {
          if (check.kind === 'admit') this.lastAfter = { key, check, at: this.now() };
          resolve(check);
        });
      };
    });
    // A read batch opened right after the last one's after-read uses it: that
    // record was read after every earlier member settled, so it is no older
    // than the verdict a joining read would get. Never for a write.
    const recent = this.lastAfter;
    const reuse =
      access === 'read' && recent !== null && recent.key === key && this.now() - recent.at <= BATCH_JOIN_MS
        ? recent
        : null;
    const batch: OwnerBatch = {
      key,
      open: true,
      beforeAt: reuse !== null ? reuse.at : null,
      members: 0,
      waiting: 0,
      before: reuse !== null ? Promise.resolve(reuse.check) : this.readOwner(identity),
      after,
      startAfter,
    };
    if (reuse === null) {
      void batch.before.then(() => {
        batch.beforeAt = this.now();
      });
    }
    this.batch = batch;
    return batch;
  }

  /** Whether a read asked now may join `batch`: open, same connection, verdict fresh enough. */
  private joinable(batch: OwnerBatch | null, key: string): batch is OwnerBatch {
    return (
      batch !== null &&
      batch.open &&
      batch.key === key &&
      (batch.beforeAt === null || this.now() - batch.beforeAt <= BATCH_JOIN_MS)
    );
  }

  /**
   * A member leaves - `answered` when its run succeeded and it now waits on
   * the after-read. The LAST one out starts the after-read, and only when a
   * member waits on it: a batch whose every member was refused or failed
   * reads nothing more.
   */
  private leave(batch: OwnerBatch, answered: boolean): void {
    batch.open = false;
    batch.members -= 1;
    if (answered) batch.waiting += 1;
    if (batch.members === 0 && batch.waiting > 0) batch.startAfter();
  }

  private async checked<T>(
    identity: SlotIdentity,
    access: SlotAccess,
    fn: (recheck: SlotRecheck) => Promise<T>,
  ): Promise<T> {
    const tenant = tenantKey(identity.tenantId);
    const key = connectionKey(identity);
    // Joining is synchronous with admission: a member is counted before any
    // await, so no after-read can start while it is still to run.
    const open = this.batch;
    const batch = access === 'read' && this.joinable(open, key) ? open : this.openBatch(identity, key, access);
    batch.members += 1;
    const before = await batch.before;
    if (before.kind === 'refuse') {
      this.leave(batch, false);
      throw new SharedCredentialRefusal('before', access, tenant, before.reason);
    }
    // Another tab rewrote the record since this tab's last batch: whatever
    // this tab believes about the tokens in the slot predates that write.
    if (this.cacheStamp !== null && this.cacheStamp !== before.stamp) this.noteSecretWritten();
    this.cacheStamp = before.stamp;
    const recheck: SlotRecheck = async () => {
      const changed = slotOwnerChanged(before, await this.readOwner(identity));
      if (changed !== null) throw new SharedCredentialRefusal('before', access, tenant, changed);
    };
    let value: T;
    try {
      value = await fn(recheck);
    } catch (err) {
      this.leave(batch, false);
      throw err;
    }
    this.leave(batch, true);
    const changed = slotOwnerChanged(before, await batch.after);
    if (changed !== null) throw new SharedCredentialRefusal('after', access, tenant, changed);
    return value;
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
