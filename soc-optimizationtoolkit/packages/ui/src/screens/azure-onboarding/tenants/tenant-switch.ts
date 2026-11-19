/**
 * Switching the active tenant from the All tenants grid (AZR-147, ADR 0009
 * decision 6 amendment 2026-11-19) - the words and the refusal rule.
 *
 * The switch itself is SETUP'S: the shell hands the page the same handler the
 * connection picker on Setup calls (App.tsx handleSelectProfile), so a switch
 * from here clears and rewrites exactly what a switch there does. This module
 * only decides whether to offer it and what the confirm says.
 *
 * REFUSED, WITH THE REASON, while anything holds the Azure credential slot or
 * its lease (claude-kit standards/cribl-config-writes.md: a confirm quotes what
 * it does; and a switch rewrites the slot under a running request):
 *
 *   - a tenant gap Read all in this tab (the cache's read in flight);
 *   - a tenant session, a Save and connect, or an Azure write in this tab
 *     (the shell's credential slot answers);
 *   - another tab's credential lease, or a lease read that failed (an
 *     unreadable lease is never free - the same rule as Save and connect);
 *   - a change this page is making (a deploy, grant, create or removal, Azure
 *     or Cribl - operation-busy.ts), for its WHOLE run: the slot only sees a
 *     request while it is in flight, and the switch remounts the screen the
 *     change is running in (review round 1).
 *
 * And the switch happens only for the confirm on screen: a Cancel, or a new
 * Open, while the lease is being read drops the earlier confirm's switch;
 * and a switch made elsewhere meanwhile (the connection bar), or the named
 * connection being deleted or re-pointed, drops it too.
 *
 * Pure: no IO, no React.
 */

import type { LeaseVerdict } from "@soc/core";

/** The confirm's question: names the tenant and the source, and nothing happens until it is answered. */
export function switchConfirmText(tenantName: string, sourceTitle: string): string {
  return `Switch the active tenant to ${tenantName} and open ${sourceTitle}?`;
}

/** What the switch does, under the question: Setup's own switch, said plainly. */
export const SWITCH_CONSEQUENCE =
  "This is the same switch as choosing the connection on Setup: every screen moves to that connection, the stored " +
  "client secret is cleared, and Azure reads need its client secret entered and connected on Setup before they work.";

/** Refused: a tenant gap Read all holds the slot. */
export const SWITCH_REFUSED_READ_ALL =
  "Not switched: a tenant gap read is running and holds the Azure credential slot. Wait for it to finish, or Cancel it, then try again.";

/** Refused: a change on this page is running, named by its own words (operation-busy.ts). */
export function switchRefusedOperation(label: string): string {
  return `Not switched: ${label} is running on this page, and switching now would cut it off part-way. Wait for it to finish, then try again.`;
}

/** Dropped: the active connection changed (elsewhere) while the switch was being checked. */
export const SWITCH_REFUSED_ACTIVE_CHANGED =
  "Not switched: the active connection changed while the switch was being checked. Open the source again to switch from the connection now active.";

/**
 * Dropped: the connection the confirm names was deleted, or now points at a
 * different tenant, since the confirm opened (review round 3). An A-to-B-to-A
 * round trip leaves the active connection unchanged, so this is checked on
 * its own, not inferred from the active id.
 */
export function switchRefusedTarget(tenantName: string, why: "gone" | "repointed"): string {
  return why === "gone"
    ? `Not switched: ${tenantName} is no longer a connection. Open a source again from the grid.`
    : `Not switched: ${tenantName} now points at a different tenant than when you were asked. Open the source again to switch to it.`;
}

/** Refused: the shell cannot switch from here (no handler wired). */
export const SWITCH_UNAVAILABLE =
  "This build cannot switch the active connection from here. Choose the connection on Setup, then open the source.";

/** Refused: the shell's credential slot is busy, with its reason. */
export function switchRefusedSlot(reason: string): string {
  return `Not switched: ${reason}. Try again when it finishes.`;
}

/** Refused from the lease read, or null when the lease is free. */
export function switchRefusedLease(verdict: LeaseVerdict): string | null {
  if (verdict.held === false) return null;
  if (verdict.held === "unknown") {
    return (
      `Not switched: the credential lease could not be read (${verdict.reason}), so whether another tab is reading ` +
      "a tenant through the shared credential is unknown. Try again."
    );
  }
  return "Not switched: another tab of this app is reading a tenant through the shared credential right now. Try again when it finishes.";
}
