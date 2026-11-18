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
  private readonly listeners = new Set<() => void>();

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
      if (this.running === settled) {
        this.running = null;
        this.notify();
      }
    });
    this.running = settled;
    this.notify();
  }

  /**
   * Be told when a read starts or ends (AZR-90 review): the shell shows that
   * a Read all holds the Azure slot while the operator is on another screen,
   * whose Azure reads wait until it ends. Returns the unsubscribe.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
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

/** A position in the grid of indicator tips: tenant row, and indicator column (two per source). */
export interface GridPos {
  readonly row: number;
  readonly col: number;
}

/**
 * Where a key moves the grid's single tab stop (AZR-91, a roving tabindex):
 * arrows one step, clamped at the edges; Home / End to the row's first / last
 * indicator; with Ctrl, Home / End to the grid's first / last. Null for a key
 * the grid does not handle, so it keeps its ordinary meaning.
 */
export function moveGridFocus(
  pos: GridPos,
  key: string,
  ctrl: boolean,
  rows: number,
  cols: number,
): GridPos | null {
  if (rows <= 0 || cols <= 0) return null;
  const clamp = (row: number, col: number): GridPos => ({
    row: Math.max(0, Math.min(rows - 1, row)),
    col: Math.max(0, Math.min(cols - 1, col)),
  });
  switch (key) {
    case "ArrowRight":
      return clamp(pos.row, pos.col + 1);
    case "ArrowLeft":
      return clamp(pos.row, pos.col - 1);
    case "ArrowDown":
      return clamp(pos.row + 1, pos.col);
    case "ArrowUp":
      return clamp(pos.row - 1, pos.col);
    case "Home":
      return ctrl ? clamp(0, 0) : clamp(pos.row, 0);
    case "End":
      return ctrl ? clamp(rows - 1, cols - 1) : clamp(pos.row, cols - 1);
    default:
      return null;
  }
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
