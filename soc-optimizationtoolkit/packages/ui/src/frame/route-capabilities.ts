/**
 * What each route needs, as capabilities (capability-model-plan step 3).
 *
 * SHARED between both shells, like SHARED_JOURNEY_LINKS: the route ids and what
 * they need are one product decision, while the render functions are per-shell.
 * Duplicating this in two route tables would let the two disagree about what an
 * operator can do, which is exactly the drift the capability model replaces.
 *
 * This is a faithful TRANSLATION of the old coarse requirements, not a redesign:
 * `none` becomes `[]`, and `azure`/`cribl`/`both` become the specific capability
 * that route's primary purpose actually exercises. Two entries deliberately
 * depart from the old value, and both are noted below.
 *
 * Pure data: no IO, no React.
 */

import type { Capability } from "@soc/core";

/**
 * Route id -> required capabilities. An entry of `[]` means the route works with
 * no connection at all - the generation-only surfaces that were `requires:
 * 'none'`.
 *
 * A route id absent from this map is treated as `[]` by
 * {@link capabilitiesForRoute}, so a new screen is available-by-default and must
 * opt IN to a requirement. That direction is deliberate: forgetting an entry
 * makes a screen reachable, never invisible.
 */
export const ROUTE_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> =
  Object.freeze({
    // Reference patterns and diagrams. Advisory; the live views inside are opt-in.
    architecture: [],
    // The setup page itself must always be reachable - it is where connections
    // are made in the first place.
    home: [],
    // The flagship deploy page: writes DCRs and creates the Sentinel destination.
    // table.write is NOT listed - custom _CL tables are a subset of the flow, and
    // requiring it would flag the whole page for operators doing native tables.
    integrate: ["dcr.write", "destination.manage"],
    "dcr-automation": ["dcr.write"],
    packs: ["pack.manage"],
    repositories: [],
    // Lab provisioning goes through ARM template deployments.
    labs: ["arm.deploy"],
    logs: [],
    settings: [],
    // Analysis over an uploaded export; touches nothing live.
    "siem-migration": [],
    // DEPARTS FROM THE OLD 'azure'. This is the screen that RUNS the permission
    // audit, so gating it on permissions is circular - an operator whose audit
    // says "no access" would find the one screen that could correct that finding
    // flagged as unavailable. It must always read as available.
    preflight: [],
    // DEPARTS FROM THE OLD 'azure', for a different and less satisfying reason:
    // Event Hub discovery reads through Resource Graph, and the settled
    // 11-capability taxonomy has nothing covering that. Mapping it onto a
    // workspace or DCR read would MISREPORT what is being checked, so it is left
    // unconstrained and the screen keeps reporting its own errors. Recorded in
    // the backlog as a taxonomy gap rather than papered over here.
    "eventhub-discovery": [],
    "mapping-catalog": [],
    // Diagnostics must stay reachable in every state - it is where you look when
    // something is wrong.
    harness: [],
  });

/**
 * The capabilities a route id needs. Unknown ids resolve to `[]` - see the note
 * on {@link ROUTE_CAPABILITIES} about failing toward reachable.
 */
export function capabilitiesForRoute(id: string): readonly Capability[] {
  return ROUTE_CAPABILITIES[id] ?? [];
}
