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
 * that route's primary purpose actually exercises. `preflight` deliberately
 * departs from the old value, as noted below.
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
    // Event Hub discovery's primary read is the Resource Graph query. This was
    // `[]` while the taxonomy had nothing covering Resource Graph (mapping it
    // onto a workspace or DCR read would have MISREPORTED what was checked);
    // CAP-1 added resourcegraph.read, measured by a one-row query probe on every
    // audited path. The per-namespace hub GETs that follow are still not a
    // capability, so the screen keeps reporting its own errors for those.
    "eventhub-discovery": ["resourcegraph.read"],
    // EXPLICITLY EMPTY, not forgotten. Azure Native Source Onboarding needs
    // Defender pricings read, the security automation read and write, and the
    // Event Hub rule's listKeys. CAP-7a added the three Defender capabilities
    // (defender-plans.read, defender-automation.read/.write), measured only by
    // an existing-subscription audit; listKeys is still unmeasured (CAP-7b).
    // The entry stays [] because the screen still renders both lists itself as
    // "needed, not yet measured" and reads no verdict, and because the route
    // is several sources: gating all of it on the Defender export would flag
    // the Event Hub and Entra paths for an operator who never touches Defender.
    // It changes together with that screen copy, under CAP-7.
    "azure-onboarding": [],
    "mapping-catalog": [],
    // Same kind of gap eventhub-discovery had before CAP-1. The logging map
    // reads management groups, policy assignments, exemptions, definitions and
    // role assignments; Management Group Reader and policy / role read are not
    // in the capability taxonomy (core capabilities.ts), and borrowing a
    // workspace or DCR capability would misreport what is checked. So the
    // route is unconstrained and the screen reports every refused read itself
    // as UNKNOWN, counted. A dedicated capability is filed as its own card.
    "azure-logging-map": [],
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
