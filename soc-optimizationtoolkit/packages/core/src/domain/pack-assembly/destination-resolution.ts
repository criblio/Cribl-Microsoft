/**
 * Resolving a table's REAL Sentinel destination values from a DCR inventory.
 *
 * WHY THIS EXISTS (user report 2026-08-11: "the sentinel destination creation
 * process only puts placeholders instead of real values"). The pack's
 * outputs.yml took its DCR immutable id and logs-ingestion endpoint from the
 * Integrate screen's in-session deploy outcomes and NOWHERE ELSE. Those are
 * React state: cleared on every deploy run and gone on reload. So an operator
 * who deployed their DCRs, reloaded, and rebuilt the pack got
 * `dcr-00000000000000000000000000000000` and `UPDATE-DCE-ENDPOINT` baked into a
 * destination that installs cleanly and sends nowhere - while the real DCRs sat
 * in Azure the whole time.
 *
 * The fix is to ASK AZURE instead of remembering. The DCR inventory already
 * carries both values plus the tables each rule routes, so this module matches
 * on what a DCR ACTUALLY ROUTES rather than re-deriving its predicted name -
 * which also means an operator who renamed a DCR, or deployed it by hand, is
 * still resolved correctly.
 *
 * IT REFUSES TO GUESS. Two DCRs routing the same table is a real situation (an
 * old rule and its replacement), and silently choosing either would bake the
 * wrong endpoint into a pack that installs without complaint - the exact
 * invisible-wrong-value failure this whole module exists to end. Ambiguity
 * resolves to `unresolved` with both names in the reason, so the operator can
 * see it and decide. Same discipline as docs/inventory-standard.md: never
 * present an unverified value as if it were confirmed.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. The caller
 * fetches the inventory and passes it in.
 */

/**
 * The slice of a DCR listing this module reads.
 *
 * Declared here rather than imported from usecases/dcr-inventory because
 * `domain/` must not depend on `usecases/` - the dependency points one way, and
 * a domain module reaching up for a type is how that stops being true.
 * The dcr-inventory usecase's DcrInventoryEntry satisfies this structurally, so
 * its rows pass straight in - no adapter, and no second type to keep in step.
 */
export interface DcrDestinationSource {
  name: string;
  /** properties.immutableId; "" when ARM reports none. */
  immutableId: string;
  /** endpoints.logsIngestion; "" for DCE-based rules. */
  ingestionEndpoint: string;
  /** Destination tables this rule routes. */
  tables: string[];
}

/**
 * Where a table's destination values came from.
 *
 *   session    - this run's deploy outcome. Always preferred: it is the DCR
 *                just deployed, with no matching to get wrong.
 *   inventory  - resolved from Azure by what the DCR routes.
 *   unresolved - no confirmed values; the pack ships placeholders for this
 *                table and the caller MUST say so.
 */
export type DestinationSource = "session" | "inventory" | "unresolved";

/** One table's resolution outcome. */
export interface ResolvedDestination {
  table: string;
  source: DestinationSource;
  /** properties.immutableId of the serving DCR (resolved only). */
  dcrImmutableId?: string;
  /** endpoints.logsIngestion of the serving DCR (resolved only). */
  ingestionEndpoint?: string;
  /** The serving DCR's name, for the operator-facing message. */
  dcrName?: string;
  /**
   * The destination id the deploy ACTUALLY created, when it differs from the
   * predicted one. The deploy renames on conflict ("'x' exists and points
   * elsewhere - using 'y'"), so carrying only the prediction would put the
   * pack's destination under a name nothing else uses. Absent on the inventory
   * path, where the caller's planned name is the right answer.
   */
  destinationId?: string;
  /** Likewise the stream the deploy actually created. */
  streamName?: string;
  /**
   * Why this table could not be resolved, phrased for an operator and naming
   * what to do about it. Present exactly when `source` is "unresolved".
   */
  reason?: string;
}

/** Case-insensitive table-name comparison (ARM table names are not case-exact). */
function sameTable(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A DCR can serve a Sentinel destination only if it exposes BOTH a logs
 * ingestion endpoint and an immutable id - the two values the destination's URL
 * is composed from.
 *
 * MORE THAN ONE KIND OF RULE FAILS THIS, which is why the message names the
 * symptom rather than a cause. DCE-based rules carry a
 * dataCollectionEndpointId instead of `endpoints.logsIngestion`; agent rules
 * (Kind "Windows"/"Linux") have no ingestion endpoint at all - confirmed live
 * 2026-08-11 against a lab holding a Kind "Windows" rule for WindowsEvent
 * beside three Direct ones. Both route their table and neither can back this
 * destination, and blaming DCE for an agent rule would send the operator
 * looking for a DCE that does not exist.
 *
 * The distinction from "no rule routes this" is kept because the fixes differ:
 * one needs any DCR, the other needs a DIRECT one.
 */
function canServeDestination(entry: DcrDestinationSource): boolean {
  return entry.immutableId !== "" && entry.ingestionEndpoint !== "";
}

/**
 * Resolve one table's destination values from the inventory.
 *
 * Returns `unresolved` rather than a best guess whenever the answer is not
 * unambiguous - see the module note on refusing to guess.
 */
export function resolveDestinationForTable(
  table: string,
  inventory: readonly DcrDestinationSource[],
): ResolvedDestination {
  const routing = inventory.filter((entry) =>
    entry.tables.some((t) => sameTable(t, table)),
  );
  if (routing.length === 0) {
    return {
      table,
      source: "unresolved",
      reason:
        "no Data Collection Rule in this resource group routes it - deploy it " +
        "from the Deploy section, or point the app at the resource group that has it",
    };
  }

  const usable = routing.filter(canServeDestination);
  if (usable.length === 0) {
    const names = routing.map((e) => e.name).join(", ");
    return {
      table,
      source: "unresolved",
      reason:
        `the rule(s) routing it (${names}) expose no logs-ingestion endpoint - ` +
        "only a Direct DCR can back this destination, so deploy one for this table",
    };
  }
  if (usable.length > 1) {
    const names = usable.map((e) => e.name).join(", ");
    return {
      table,
      source: "unresolved",
      reason:
        `${usable.length} rules route it (${names}) and picking one would be a ` +
        "guess - deploy from the Deploy section to choose explicitly, or remove the rule you do not want",
    };
  }

  const entry = usable[0]!;
  return {
    table,
    source: "inventory",
    dcrImmutableId: entry.immutableId,
    ingestionEndpoint: entry.ingestionEndpoint,
    dcrName: entry.name,
  };
}

/** One table's already-known values from this run's deploy outcome. */
export interface SessionDestination {
  table: string;
  dcrImmutableId: string;
  ingestionEndpoint: string;
  dcrName?: string;
  /** The destination id the deploy actually created (may differ from planned). */
  destinationId?: string;
  /** The stream the deploy actually created. */
  streamName?: string;
}

/**
 * Resolve every table, preferring this run's deploy outcomes and falling back
 * to the inventory.
 *
 * Session outcomes win because they need no matching at all - they name the DCR
 * that was just deployed for that table. The inventory is the fallback that
 * makes a rebuilt pack correct after a reload, which is the case that was
 * broken. Results come back in input order, one per table, always.
 */
export function resolveDestinations(
  tables: readonly string[],
  session: readonly SessionDestination[],
  inventory: readonly DcrDestinationSource[],
): ResolvedDestination[] {
  return tables.map((table) => {
    const known = session.find((s) => sameTable(s.table, table));
    if (known !== undefined) {
      const resolved: ResolvedDestination = {
        table,
        source: "session",
        dcrImmutableId: known.dcrImmutableId,
        ingestionEndpoint: known.ingestionEndpoint,
      };
      if (known.dcrName !== undefined) {
        resolved.dcrName = known.dcrName;
      }
      if (known.destinationId !== undefined) {
        resolved.destinationId = known.destinationId;
      }
      if (known.streamName !== undefined) {
        resolved.streamName = known.streamName;
      }
      return resolved;
    }
    return resolveDestinationForTable(table, inventory);
  });
}

/** The tables that will ship placeholders - what the caller must report. */
export function unresolvedDestinations(
  resolved: readonly ResolvedDestination[],
): ResolvedDestination[] {
  return resolved.filter((r) => r.source === "unresolved");
}

/**
 * The operator-facing warning for a pack that shipped placeholders, or null
 * when every table resolved.
 *
 * Lives here so the two shells and the build log cannot describe the same
 * outcome differently - and so this is never left to a caller who might just
 * not bother, which is how the silent fallback survived as long as it did.
 */
export function placeholderWarning(
  resolved: readonly ResolvedDestination[],
): string | null {
  const missing = unresolvedDestinations(resolved);
  if (missing.length === 0) {
    return null;
  }
  const lines = [
    `${missing.length} table(s) shipped PLACEHOLDER destination values. The pack ` +
      "installs, but those destinations point nowhere until you edit them in Cribl:",
    ...missing.map((r) => `  - ${r.table}: ${r.reason ?? "not resolved"}`),
  ];
  return lines.join("\n");
}
