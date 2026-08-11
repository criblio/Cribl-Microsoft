/**
 * Capability fallbacks - "download the thing you'd need someone else to run"
 * (capability-model-plan, rule 2).
 *
 * The plan states this as a general pattern rather than a DCR special case:
 * every blocked ACTION has a defined output, and nothing may be merely disabled.
 * This module is the catalog. Step 3 uses it to NAME the fallback in the nav
 * annotation; step 4 routes each `kind` to the generator that already exists.
 *
 * THE READ CAPABILITIES HAVE NO FALLBACK, and that is a deliberate answer rather
 * than a gap. Without `dcr.read` / `workspace.read` / `table.read` discovery
 * genuinely cannot run - there is no artifact a colleague could hand back that
 * substitutes for being able to list the resources. The plan is explicit that
 * the honest UI says so instead of inventing an offline substitute, so
 * {@link fallbackFor} returns null for them and callers must render the absence
 * rather than paper over it.
 *
 * Pure: no IO, no clock.
 */

import type { Capability } from "./capabilities";

/**
 * Which generator produces the artifact. A typed union rather than free text so
 * step 4's routing is a switch the compiler checks, not a second derivation that
 * could drift from this catalog.
 */
export type CapabilityFallbackKind =
  | "dcr-arm-bodies"
  | "table-arm-bodies"
  | "arm-template"
  | "role-assignment-request"
  | "app-registration-request"
  | "cribl-pack";

/** What the operator gets when an action is blocked. */
export interface CapabilityFallback {
  /** Routes to the generator in step 4. */
  kind: CapabilityFallbackKind;
  /** What the artifact IS, in the operator's words. */
  label: string;
  /** What to do with it. Phrased as the handoff, since that is the point. */
  action: string;
}

/**
 * The fallback per capability, straight from the plan's table.
 *
 * The three Cribl management capabilities beyond `pack.manage` share the pack
 * artifact because the pack is genuinely what carries destinations, sources and
 * routes - there is one thing to hand over, not four. The plan named only
 * `pack.manage`; the other three are the same artifact by construction.
 */
export const CAPABILITY_FALLBACKS: Readonly<
  Partial<Record<Capability, CapabilityFallback>>
> = Object.freeze({
  "dcr.write": {
    kind: "dcr-arm-bodies",
    label: "DCR ARM request bodies",
    action: "Download them for someone with DCR write access to apply.",
  },
  "table.write": {
    kind: "table-arm-bodies",
    label: "Custom-table ARM PUT bodies",
    action: "Download them for someone who can create workspace tables.",
  },
  "arm.deploy": {
    kind: "arm-template",
    label: "Assembled ARM template",
    action: "Download it for someone who can deploy templates.",
  },
  "role.assign": {
    kind: "role-assignment-request",
    label: "Role-assignment change request",
    action: "Send it to whoever administers RBAC, with the az CLI command.",
  },
  "pack.manage": {
    kind: "cribl-pack",
    label: "Built Cribl pack (.crbl)",
    action: "Download it and upload it to the leader by hand.",
  },
  "destination.manage": {
    kind: "cribl-pack",
    label: "Built Cribl pack (.crbl)",
    action: "The pack carries the destination config - upload it by hand.",
  },
  "source.manage": {
    kind: "cribl-pack",
    label: "Built Cribl pack (.crbl)",
    action: "The pack carries the source config - upload it by hand.",
  },
  "route.manage": {
    kind: "cribl-pack",
    label: "Built Cribl pack (.crbl)",
    action: "The pack carries the routes - upload it by hand.",
  },
});

/**
 * The fallback for a blocked capability, or null when there honestly is none.
 *
 * Null is a real answer for the read capabilities - see the module note. Callers
 * must not treat it as "no fallback configured yet".
 */
export function fallbackFor(capability: Capability): CapabilityFallback | null {
  return CAPABILITY_FALLBACKS[capability] ?? null;
}

/**
 * The offer when there is no Azure identity AT ALL - a different situation from
 * a denied permission, and the plan gives it its own row: nobody can grant you
 * anything until the App registration exists. Already generated inline by the
 * wizard's Azure step.
 */
export const IDENTITY_FALLBACK: CapabilityFallback = Object.freeze({
  kind: "app-registration-request",
  label: "App-registration change request",
  action: "Send it to whoever administers Entra ID to get an identity created.",
});
