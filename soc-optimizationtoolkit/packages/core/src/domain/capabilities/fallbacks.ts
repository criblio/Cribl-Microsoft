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
 * than a gap. Without `dcr.read` / `workspace.read` / `table.read` (or the
 * Defender `.read` pair) discovery
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
  | "cribl-pack"
  | "defender-howto-steps"
  | "activity-log-howto-steps";

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
  // AZR-85 review. The artifact is the request for the solution write; the
  // ticket's row also says enabling it in the portal does the same thing.
  "sentinel.enable": {
    kind: "role-assignment-request",
    label: "Role-assignment change request",
    action:
      "Send it to whoever administers RBAC for the solution write at the resource group, or ask them to enable Sentinel in the portal.",
  },
  // CAP-7a. Its own kind rather than `arm-template`: that kind's run is the
  // Sentinel Integration export, which builds no continuous export. The How-to
  // steps (onboarding-howto-steps/defender-steps) carry the body the Automated
  // mode would PUT, built by the same builder, with the connection string
  // stood in - the artifact someone with Security Admin can follow.
  "defender-automation.write": {
    kind: "defender-howto-steps",
    label: "How-to steps for the Defender continuous export",
    action: "Hand them to someone with Security Admin on the subscription to follow.",
  },
  // CAP-2 / CAP-3. Measured ahead of the Azure Policy feature (AZR-4), which
  // will build the artifact proper (the assignment and remediation bodies,
  // and a request row for the role). Rule 2 still wants a handoff for each
  // write, but the request generated today is the setup path's, which asks
  // for none of these roles until a feature calls them (least privilege,
  // pinned in app-permissions.test.ts). So the text names NO role (review
  // r1): an offer naming Resource Policy Contributor would hand over a
  // request that leaves it out. The pin there fails if one comes back.
  "policy.assign": {
    kind: "role-assignment-request",
    label: "Role-assignment change request",
    action:
      "Send it to whoever administers Azure Policy, and ask them to add the role that assigns policy where the initiative is assigned - the request does not include it yet.",
  },
  "policy.remediate": {
    kind: "role-assignment-request",
    label: "Role-assignment change request",
    action:
      "Send it to whoever administers Azure Policy, and ask them to add the role that runs remediations where they run - the request does not include it yet.",
  },
  "identity.create": {
    kind: "role-assignment-request",
    label: "Role-assignment change request",
    action:
      "Send it to whoever administers RBAC, and ask them to add the role that creates managed identities on the identity's resource group - the request does not include it yet.",
  },
  // CAP-10. The Activity Log's How-to steps create the same subscription
  // diagnostic setting the Automated mode PUTs, so they are the artifact for
  // the write - the Defender kind's reasoning. Naming the role is fine here:
  // this kind is not the role-assignment request.
  "subscription-diagnostics.write": {
    kind: "activity-log-howto-steps",
    label: "How-to steps for the Activity Log diagnostic setting",
    action: "Hand them to someone with Monitoring Contributor on the subscription to follow.",
  },
  // CAP-10. Remove has no How-to artifact; the handoff is the request or the
  // portal. No role is named: the request generated today is the setup
  // path's, which does not include the removal's role (the pin in
  // app-permissions.test.ts holds every role-assignment offer to that).
  "subscription-diagnostics.delete": {
    kind: "role-assignment-request",
    label: "Role-assignment change request",
    action:
      "Send it to whoever administers RBAC, and ask them to add the role that removes the subscription's diagnostic settings - the request does not include it yet - or to remove the setting in the Azure portal.",
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
