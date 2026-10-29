/**
 * The DCR values a pack build bakes in - split out of integrate-screen.tsx so
 * the existing-destination path's one promise can be pinned without a mount
 * ([[GEN-21]]): the build callback that calls this needs an approved gap
 * analysis, which no mount-level test reaches.
 *
 * No IO of its own: the Azure read is the caller's `readInventory`, handed in,
 * which is exactly what lets a pin prove it is never called.
 */

import { resolveDestinations } from "@soc/core";
import type { DcrInventoryEntry, SessionDestination } from "@soc/core";

/**
 * Resolve each plan table's destination values from this session's deploys
 * and - for tables the session did not deploy - the Azure DCR inventory; or
 * null on the existing-destination path.
 *
 * THE EXISTING PATH NEVER CALLS `readInventory`. Its pack is routable and ships
 * no destination, so there is nothing to resolve, and an offline operator has
 * no Azure to read: the read would fail, or succeed empty under RBAC and be
 * reported as placeholders. It says so in one line instead. The path is chosen
 * by `existing` being non-null, not by a destination being picked, so an
 * unfinished pick can never fall through to the Azure read.
 */
export async function resolveBuildDestinations(input: {
  /** Non-null on the existing-destination path: the destination it builds for. */
  existing: { destination: string } | null;
  planTables: readonly string[];
  sessionDestinations: readonly SessionDestination[];
  /** Reads the Azure DCR inventory and reports what it read; may throw. */
  readInventory: () => Promise<DcrInventoryEntry[]>;
  push: (line: string) => void;
}): Promise<ReturnType<typeof resolveDestinations> | null> {
  const { existing, planTables, sessionDestinations, push } = input;
  if (existing !== null) {
    push(
      `Using the existing Cribl Sentinel destination ${existing.destination}: the ` +
        "pack is routable and ships no destination, so the Azure DCR inventory is " +
        "not read and no DCR, tenant or client id is written into the pack.",
    );
    return null;
  }
  const needsLookup = planTables.some(
    (t) => !sessionDestinations.some((s) => s.table === t),
  );
  let inventory: DcrInventoryEntry[] = [];
  if (needsLookup) {
    // A failed listing must never read as "no DCRs" - that would silently
    // downgrade every table to placeholders and blame the environment.
    // listDcrInventory throws; the reason is surfaced and the build goes on
    // with placeholders that the build then reports by table.
    try {
      inventory = await input.readInventory();
    } catch (err) {
      push(
        `Could not read deployed DCRs (${String(err)}) - tables not deployed ` +
          "in this session will ship placeholder destination values.",
      );
    }
  }
  return resolveDestinations(planTables, sessionDestinations, inventory);
}
