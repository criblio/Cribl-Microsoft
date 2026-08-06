/**
 * Capabilities - what the connected identity can actually DO, replacing the
 * four app modes as the thing the product gates on.
 *
 * See docs/capability-model-plan.md. The modes were always a PROXY for
 * capability; this is the measurement. Three rules from that plan are binding
 * here and are the reason this module is shaped the way it is:
 *
 *   1. The menu ANNOTATES what is unavailable; it never hides it.
 *   2. Every blocked action falls back to "download the thing you'd need
 *      someone else to run".
 *   3. THE AUDIT INFORMS AND OFFERS - IT NEVER FORBIDS. A `denied` verdict
 *      annotates and offers the fallback, but the action stays attemptable;
 *      Azure's own 403 is the real gate. Nothing in this module should ever be
 *      used to disable a control outright.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. The audit
 * timestamp is supplied by the caller - the shell owns the clock.
 */

/** Azure-side capabilities, named for the ACTION rather than the role. */
export type AzureCapability =
  | "dcr.write"
  | "dcr.read"
  | "table.write"
  | "table.read"
  | "workspace.read"
  | "arm.deploy"
  | "role.assign";

/** Cribl-side capabilities. */
export type CriblCapability =
  | "pack.manage"
  | "destination.manage"
  | "source.manage"
  | "route.manage";

export type Capability = AzureCapability | CriblCapability;

export const AZURE_CAPABILITIES: readonly AzureCapability[] = Object.freeze([
  "dcr.write",
  "dcr.read",
  "table.write",
  "table.read",
  "workspace.read",
  "arm.deploy",
  "role.assign",
]);

export const CRIBL_CAPABILITIES: readonly CriblCapability[] = Object.freeze([
  "pack.manage",
  "destination.manage",
  "source.manage",
  "route.manage",
]);

/** Whether a capability belongs to the Azure side. Drives the identity rule. */
export function isAzureCapability(c: Capability): c is AzureCapability {
  return (AZURE_CAPABILITIES as readonly string[]).includes(c);
}

/**
 * What we know about one capability.
 *
 *   granted     - measured, and the identity can do it.
 *   denied      - measured, and it cannot.
 *   unknown     - an identity exists but no audit has run yet.
 *   unreachable - there is no identity/connection at all, so the action cannot
 *                 work for a reason that has nothing to do with permissions.
 *
 * `unreachable` exists because collapsing it into `denied` or `unknown` was the
 * mistake the plan caught: with no identity configured we KNOW nothing Azure
 * can work, and saying "Connect Azure to enable" is a fact about the connection
 * rather than a claim about permissions. `unknown` must never render as
 * `denied` - "not yet measured" and "measured and refused" are different facts,
 * the same distinction JourneyFacts already draws with
 * secretLive: 'live' | 'unknown' | 'missing'.
 */
export type CapabilityVerdict = "granted" | "denied" | "unknown" | "unreachable";

/** The audit result for one connection. */
export interface CapabilitySet {
  /** Per-capability verdicts. A capability absent from the map is 'unknown'. */
  verdicts: Readonly<Partial<Record<Capability, CapabilityVerdict>>>;
  /**
   * When the audit ran, ISO-8601, or null when it never has. Supplied by the
   * shell - this module never reads a clock. Rendered as the audit's age so an
   * operator can judge staleness themselves.
   */
  auditedAt: string | null;
  /**
   * The connection the audit was measured against. A different App registration
   * is a different answer, so a set from another connection must never be
   * reused - the caller compares this before trusting `verdicts`.
   */
  connectionId: string | null;
}

/** The facts that decide a verdict before any audit has run. */
export interface CapabilityContext {
  /** Tenant and client id are present on the active connection. */
  azureIdentityPresent: boolean;
  /** A Cribl connection exists (implicit in the cloud shell, configured locally). */
  criblReachable: boolean;
}

/** An unaudited set - every verdict resolves from context alone. */
export function emptyCapabilitySet(): CapabilitySet {
  return { verdicts: {}, auditedAt: null, connectionId: null };
}

/**
 * The verdict for one capability.
 *
 * Precedence, and the order matters: a measured verdict always wins, because an
 * audit is evidence and context is only inference. Only when nothing was
 * measured does the connection state decide, and then the answer is
 * `unreachable` (no connection) or `unknown` (connected but unmeasured) - never
 * `denied`, which would assert a permission fact we have not established.
 */
export function verdictFor(
  capability: Capability,
  set: CapabilitySet,
  context: CapabilityContext,
): CapabilityVerdict {
  const measured = set.verdicts[capability];
  if (measured !== undefined) {
    return measured;
  }
  const connected = isAzureCapability(capability)
    ? context.azureIdentityPresent
    : context.criblReachable;
  return connected ? "unknown" : "unreachable";
}

/**
 * Whether a capability is known to be available.
 *
 * TRUE only for a measured `granted`. Deliberately strict, and deliberately NOT
 * the thing that gates a control: per rule 3 this answers "may we present this
 * as working?", never "may the operator attempt it?". Use
 * {@link isAttemptable} for the latter.
 */
export function can(
  capability: Capability,
  set: CapabilitySet,
  context: CapabilityContext,
): boolean {
  return verdictFor(capability, set, context) === "granted";
}

/**
 * Whether the operator may ATTEMPT the action.
 *
 * True for everything except `unreachable` - a denied verdict still permits the
 * attempt, because the audit informs rather than forbids and Azure's 403 is the
 * real gate (rule 3). `unreachable` is the sole exception, and not on
 * permission grounds: with no connection there is literally nowhere to send the
 * request.
 */
export function isAttemptable(
  capability: Capability,
  set: CapabilitySet,
  context: CapabilityContext,
): boolean {
  return verdictFor(capability, set, context) !== "unreachable";
}

/**
 * Whether a cached set may be trusted for this connection.
 *
 * A set measured against a different App registration answers a different
 * question, so it is discarded rather than shown stale. Staleness in TIME is
 * deliberately not judged here: the plan's decision is to surface the audit's
 * age and let the operator refresh, not to expire it on a timer this module
 * would have to read a clock to enforce.
 */
export function isSetForConnection(
  set: CapabilitySet,
  connectionId: string | null,
): boolean {
  return set.connectionId !== null && set.connectionId === connectionId;
}

/**
 * The reason an item is not presented as available, or null when it is.
 *
 * Copy lives here so every surface says the same thing, and so the
 * identity-derived wording stays distinct from the permission-derived wording -
 * conflating them is exactly what the plan set out to avoid.
 */
export function unavailableReason(
  capability: Capability,
  set: CapabilitySet,
  context: CapabilityContext,
): string | null {
  switch (verdictFor(capability, set, context)) {
    case "granted":
      return null;
    case "denied":
      return "The connected identity cannot do this. You can still try it, or take the downloadable version to someone who can.";
    case "unknown":
      return "Not checked yet - run the permission check to find out.";
    case "unreachable":
      return isAzureCapability(capability)
        ? "Connect Azure to enable this."
        : "Connect Cribl to enable this.";
  }
}
