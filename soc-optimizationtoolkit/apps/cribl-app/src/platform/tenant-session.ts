// The shell's TenantSession adapter (ADR 0009 decision 2): @soc/core's
// runTenantSession over this tab's AzureCredentialSlot, the app KV store for
// the lease and the credential-owner record, and the shell's clock.
//
// The sequence and every refusal live in core and are pinned there; this class
// only supplies what core may not touch - the clock, the tab's holder id, and
// which connection is active at the moment a run starts.

import { runTenantSession } from '@soc/core';
import type {
  KvDocumentStore,
  Logger,
  TenantPorts,
  TenantProfile,
  TenantRun,
  TenantSession,
} from '@soc/core';
import type { AzureCredentialSlot } from './credential-slot';

export interface PlatformTenantSessionOptions {
  readonly slot: AzureCredentialSlot;
  readonly documents: KvDocumentStore;
  /** This tab's lease holder id (mint once per tab, e.g. crypto.randomUUID()). */
  readonly holderId: string;
  /** Epoch ms; Date.now in the app, a fixed value in tests. */
  readonly now: () => number;
  /** The connection active when a run starts: its credential is the one put back. */
  readonly getActiveProfile: () => TenantProfile | null;
  readonly leaseTtlMs?: number;
  readonly logger?: Logger;
}

export class PlatformTenantSession implements TenantSession {
  private readonly options: PlatformTenantSessionOptions;

  constructor(options: PlatformTenantSessionOptions) {
    this.options = options;
  }

  runForTenant<T>(profile: TenantProfile, work: (ports: TenantPorts) => Promise<T>): Promise<TenantRun<T>> {
    const { slot, documents, holderId, now, leaseTtlMs, logger } = this.options;
    return runTenantSession(
      {
        slot,
        documents,
        holderId,
        now,
        activeProfile: this.options.getActiveProfile(),
        ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
        ...(logger !== undefined ? { logger } : {}),
      },
      profile,
      work,
    );
  }
}
