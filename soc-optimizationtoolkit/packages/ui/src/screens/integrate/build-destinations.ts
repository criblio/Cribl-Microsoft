/**
 * The DCR values a pack build bakes in - split out of integrate-screen.tsx so
 * the existing-destination path's promises can be pinned without a mount
 * ([[GEN-21]], [[GEN-25]]): the build callback that calls this needs an
 * approved gap analysis, which no mount-level test reaches.
 *
 * No IO of its own: the Azure read is the caller's `readInventory`, handed in,
 * which is exactly what lets a pin prove it is never called.
 */

import { resolveDestinations } from "@soc/core";
import type { DcrInventoryEntry, PackScaffoldInput, SessionDestination } from "@soc/core";

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
 *
 * NOR DOES A NATIVE-PATH ROUTABLE PACK (GEN-25). It writes no outputs.yml
 * either, so inventory values would be thrown away, and an empty or failed read
 * would log that tables "will ship placeholder destination values" - a pack
 * that ships no destination ships no placeholders. This run's own deploys are
 * still matched (no IO), so every table still gets a resolution.
 */
export async function resolveBuildDestinations(input: {
  /** Non-null on the existing-destination path: the destination it builds for. */
  existing: { destination: string } | null;
  /** The plan's packShape is "routable": the pack writes no outputs.yml. */
  routable?: boolean;
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
  if (input.routable === true) {
    push(
      "The pack is routable and ships no destination, so the Azure DCR inventory " +
        "is not read and no DCR values are written into the pack.",
    );
    return resolveDestinations(planTables, sessionDestinations, []);
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

/**
 * The destination fields of the stored build definition, chosen by the path
 * {@link resolveBuildDestinations} took. The existing path (resolved null)
 * stamps no Azure identity - the picked destination carries its own - and
 * carries the picked id instead, so the README names it on this build and on
 * every Packs-screen rebuild of the stored definition (GEN-25). The native
 * path stamps the identity and never a pick.
 */
export function definitionDestinationFields(input: {
  resolved: ReturnType<typeof resolveDestinations> | null;
  existingDestination: string | undefined;
  tenantId: string;
  ingestionClientId: string;
}): Pick<PackScaffoldInput, "existingDestinationId" | "outputsDefaults"> {
  if (input.resolved === null) {
    return input.existingDestination !== undefined
      ? { existingDestinationId: input.existingDestination }
      : {};
  }
  return {
    outputsDefaults: {
      tenantId: input.tenantId,
      ingestionClientId: input.ingestionClientId,
    },
  };
}
