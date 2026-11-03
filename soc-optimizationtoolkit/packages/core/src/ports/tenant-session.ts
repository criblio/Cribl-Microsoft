/**
 * TenantSession port - read ONE Azure tenant at a time through the proxy's
 * single credential slot (ADR 0009 decision 2).
 *
 * The Cribl app proxy injects every Azure credential from one fixed KV key per
 * host (`azureBasic`, `azureArmToken`, `azureGraphToken`) and cannot choose a
 * key per request (measured; claude-kit standards/cribl-app-platform.md). So
 * reading tenant N means: take the lease, put N's credential in the slot, mint
 * N's tokens, PROVE the slot now answers as N, run N's work with ordinary
 * ports, put the active connection's credential back, release the lease.
 * {@link TenantSession.runForTenant} owns that sequence; the work it runs gets
 * plain {@link AzureManagement} and {@link GraphDirectory} ports and never
 * knows a swap happened.
 *
 * The proof is read before the work AND after it, and the run is `done` only
 * when both answered as N and this holder still has an unexpired lease when
 * the work ends - so a swap by another tab during the batch is caught too.
 *
 * Every outcome but a proven, completed run is `unknown` - never a red cell.
 * A tenant whose credential was not entered this session, a lease held by
 * another tab, a refused or mismatched proof: none of those says anything
 * about what is configured in that tenant.
 *
 * {@link CredentialSlot} is the shell's half: the primitives over the KV slot
 * and the tab's in-memory secrets. @soc/core's runTenantSession sequences them.
 */

import type { AzureManagement } from "./azure-management";
import type { GraphDirectory } from "./graph-directory";

/** The parts of a connection profile a tenant session needs (ConnectionProfile satisfies it). */
export interface TenantProfile {
  readonly id: string;
  readonly name?: string;
  readonly config: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly subscriptionId: string;
  };
}

/** The ordinary ports a tenant's work runs with. */
export interface TenantPorts {
  readonly azure: AzureManagement;
  readonly graph: GraphDirectory;
}

/** Where a run stopped short. */
export type TenantRunStage =
  /** The profile has no tenant or no subscription to prove against. */
  | "identity"
  /** This session does not hold the client secret it needs (target or active). */
  | "credential"
  /**
   * The lease is held by another tab, or could not be read or taken - or, when
   * the work ended, it was no longer this holder's or had expired.
   */
  | "lease"
  /** Writing the credential or minting a token failed. */
  | "swap"
  /** A proof read (before or after the work) was refused, failed, or another tenant answered. */
  | "proof"
  /** The work itself threw. */
  | "work";

/** Whether the ACTIVE connection's credential is back in the slot afterwards. */
export type TenantRestore =
  | { readonly kind: "not-needed" }
  | { readonly kind: "restored" }
  | { readonly kind: "failed"; readonly reason: string };

/** The outcome of one tenant's run. */
export type TenantRun<T> =
  | {
      readonly kind: "done";
      readonly tenantId: string;
      readonly value: T;
      readonly restore: TenantRestore;
    }
  | {
      readonly kind: "unknown";
      readonly tenantId: string;
      readonly stage: TenantRunStage;
      readonly reason: string;
      readonly restore: TenantRestore;
    };

/** Read one tenant through the shared credential slot. */
export interface TenantSession {
  /**
   * Run `work` against `profile`'s tenant. Never rejects: every failure is an
   * `unknown` result naming the stage, and the active connection's credential
   * is put back whatever happened (the result says whether that worked).
   */
  runForTenant<T>(profile: TenantProfile, work: (ports: TenantPorts) => Promise<T>): Promise<TenantRun<T>>;
}

/**
 * The shell's primitives over the shared credential slot. Implemented in the
 * cribl-app shell (platform/credential-slot.ts); faked in tests.
 */
export interface CredentialSlot {
  /**
   * Whether this tab holds `profile`'s client secret, entered for the tenant
   * and client id the profile has NOW. Encrypted KV entries are write-only, so
   * the only copy the app can put back in the slot is one the operator entered
   * in THIS session - and a copy entered before the identity was edited is
   * another identity's secret.
   */
  hasCredential(profile: TenantProfile): boolean;
  /**
   * Run `fn` with every other Azure request from this tab held back until it
   * settles, so no request goes out under a credential it was not meant for.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Write `profile`'s credential into `azureBasic`; rejects when the held copy
   * was entered for another identity. Call only inside {@link exclusive}.
   */
  installCredential(profile: TenantProfile): Promise<void>;
  /** Mint ARM and Graph tokens for `tenantId` into their slots. Call only inside {@link exclusive}. */
  mintTokens(tenantId: string): Promise<void>;
  /**
   * Ports that send through the slot as it now stands, for use inside
   * {@link exclusive} only: they never wait for the slot and never mint for a
   * tenant of their own.
   */
  portsFor(tenantId: string): TenantPorts;
}
