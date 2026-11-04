/**
 * Tenant gap dashboard state - the per-tenant result cache and the words the
 * grid shows beside each colour.
 *
 * THE CACHE outlives the screen: the shell makes one per app and hands it in,
 * so leaving the dashboard and coming back shows the last answers (with their
 * time) instead of reading every tenant again (ADR 0009 decision 2). An entry
 * is the answer for the tenant the connection held WHEN it was read; a
 * connection whose tenant id has changed since gets no entry back.
 */

import { normalizeTenantId } from "@soc/core";
import type { GapState, TenantGapRow } from "@soc/core";

/** One tenant's last answer and when it was read (epoch ms, the shell's clock). */
export interface TenantGapEntry {
  readonly row: TenantGapRow;
  readonly readAt: number;
}

/** The app-lifetime cache of tenant answers, keyed by connection. */
export class TenantGapCache {
  private readonly entries = new Map<string, TenantGapEntry>();
  private running: Promise<void> | null = null;

  /**
   * The read still in flight, if any. It outlives the screen like the answers
   * do: leaving the screen aborts a read but cannot stop the tenant already in
   * the credential slot, and a second read started on return would take the
   * lease the first then releases - its tenant would read unknown for no
   * reason but its own earlier run.
   */
  inFlight(): Promise<void> | null {
    return this.running;
  }

  /** Record `run` as the read in flight until it settles. */
  track(run: Promise<void>): void {
    const settled = run.finally(() => {
      if (this.running === settled) this.running = null;
    });
    this.running = settled;
  }

  /** The entry for this connection, only while it still names the tenant that was read. */
  get(profile: { readonly id: string; readonly config: { readonly tenantId: string } }): TenantGapEntry | null {
    const entry = this.entries.get(profile.id);
    if (entry === undefined) return null;
    return entry.row.tenantId === normalizeTenantId(profile.config.tenantId) ? entry : null;
  }

  /**
   * Keep `entry` as the connection's answer - unless it came from a cancelled
   * read and an earlier answer exists: a partial row must not replace a
   * complete one, nor take its "read at" time.
   */
  set(entry: TenantGapEntry): void {
    if (entry.row.cancelled && this.entries.has(entry.row.profileId)) return;
    this.entries.set(entry.row.profileId, entry);
  }
}

/** The word beside each colour, so the grid never relies on colour alone. */
export const AZURE_WORD: Readonly<Record<GapState, string>> = {
  green: "Configured",
  red: "Not configured",
  unknown: "Unknown",
};

export const CRIBL_WORD: Readonly<Record<GapState, string>> = {
  green: "Onboarded",
  red: "Not onboarded",
  unknown: "Unknown",
};

/** Read progress, as one line. */
export interface ScanProgress {
  readonly index: number;
  readonly total: number;
  readonly name: string;
  readonly done: number;
  readonly reads: number;
}

export function progressLine(p: ScanProgress): string {
  const which = p.total > 1 ? `tenant ${p.index + 1} of ${p.total} (${p.name})` : p.name;
  const reads = p.reads > 0 ? `: ${p.done} of ${p.reads} Azure reads` : "";
  return `Reading ${which}${reads}...`;
}

/** Counts of each state across read rows, per side - never counting a row that was not read. */
export function stateCounts(
  rows: readonly TenantGapRow[],
  side: "azure" | "cribl",
): Readonly<Record<GapState, number>> {
  const counts: Record<GapState, number> = { green: 0, red: 0, unknown: 0 };
  for (const r of rows) for (const c of r.cells) counts[c[side].state] += 1;
  return counts;
}
