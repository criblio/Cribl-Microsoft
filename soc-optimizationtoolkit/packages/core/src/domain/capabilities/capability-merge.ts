/**
 * Merging one writer's measurements into a cached CapabilitySet (CAP-11).
 *
 * TWO WRITERS share one cached set per tenant: the app-level capability audit
 * (runCapabilityAudit) and the RBAC preflight panel. They do not measure the
 * same things. The panel projects only what the setup path's preflight
 * measures; the audit adds the subscription-scope verdicts (the Defender export
 * on existing-rg, AZR-86; the policy and managed-identity enablers, CAP-2/CAP-3)
 * and the Graph permission probes (CAP-5). When each writer REPLACED the cached
 * set, a panel run silently turned every audit-only verdict back into unknown,
 * and the next launch reused that thinner set because its key still matched.
 *
 * THE RULE: a writer merges only the verdicts it measured, and a verdict is
 * replaced only by a NEWER measurement of the same capability. So:
 *   - a capability the incoming set did not measure keeps its cached verdict,
 *     whoever measured it;
 *   - a capability both measured takes whichever measurement is newer, judged
 *     per capability (CapabilitySet.measuredAt, defaulting to auditedAt), not
 *     by which write landed last - two writers can finish out of order;
 *   - only `granted` and `denied` count as measurements. `unknown` and
 *     `unreachable` are the ABSENCE of one (verdictFor derives them from
 *     context), so an incoming one never displaces a measured verdict.
 *
 * THAT IS THE PANEL'S RULE. The audit attempts every capability the panel does
 * and more, so it uses supersedeCapabilitySet instead: it may retract its own
 * earlier verdicts, and only a measurement newer than its run survives it.
 *
 * A DIFFERENT CONNECTION IS NOT MERGED. A set measured for another key answers
 * another question (isSetForConnection), so carrying its verdicts across would
 * be the worst failure this model can have - confidently wrong about
 * permissions. The incoming set then replaces the cached one outright, exactly
 * as before CAP-11.
 *
 * Pure: no IO and no clock - every time compared here was stamped by a shell.
 */

import type { Capability, CapabilitySet, CapabilityVerdict } from "./capabilities";

/** The verdicts that are measurements; the others are derived from context. */
function isMeasurement(verdict: CapabilityVerdict | undefined): boolean {
  return verdict === "granted" || verdict === "denied";
}

/** When `set` measured `capability`: its own entry, else the set's audit time. */
function measuredTime(set: CapabilitySet, capability: Capability): string | null {
  return set.measuredAt?.[capability] ?? set.auditedAt;
}

/** Milliseconds for an ISO time, or null when absent or unparseable. */
function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whether a measurement taken at `incoming` may replace one taken at `stored`.
 *
 * A stored measurement with no readable time cannot be shown to be newer, so
 * anything replaces it. An incoming one with no readable time cannot be shown
 * to be newer either, so it replaces nothing that has a time. A tie goes to the
 * incoming write: same instant, and it is the later one to arrive.
 */
function isAtLeastAsNew(incoming: string | null, stored: string | null): boolean {
  const s = ms(stored);
  if (s === null) return true;
  const i = ms(incoming);
  return i !== null && i >= s;
}

/**
 * Merge `incoming` (one writer's fresh measurements) over `stored` (the cached
 * set), per the rule above. Returns `incoming` itself when the two sets belong
 * to different connections, or when nothing is stored for any connection.
 */
export function mergeCapabilitySets(stored: CapabilitySet, incoming: CapabilitySet): CapabilitySet {
  if (stored.connectionId === null || stored.connectionId !== incoming.connectionId) {
    return incoming;
  }

  const verdicts: Partial<Record<Capability, CapabilityVerdict>> = {};
  const times: Partial<Record<Capability, string | null>> = {};

  for (const [capability, verdict] of Object.entries(stored.verdicts) as [
    Capability,
    CapabilityVerdict | undefined,
  ][]) {
    if (verdict === undefined) continue;
    verdicts[capability] = verdict;
    times[capability] = measuredTime(stored, capability);
  }

  for (const [capability, verdict] of Object.entries(incoming.verdicts) as [
    Capability,
    CapabilityVerdict | undefined,
  ][]) {
    if (verdict === undefined) continue;
    const at = measuredTime(incoming, capability);
    const held = verdicts[capability];
    if (held === undefined) {
      // Nothing stored: the incoming verdict is the only answer, even a derived one.
      verdicts[capability] = verdict;
      times[capability] = at;
      continue;
    }
    if (!isMeasurement(verdict) && isMeasurement(held)) continue;
    if (isAtLeastAsNew(at, times[capability] ?? null)) {
      verdicts[capability] = verdict;
      times[capability] = at;
    }
  }

  // The set's own time is its NEWEST measurement - "last audited". Each older
  // verdict keeps its own time in measuredAt, so nothing is made to look fresher
  // to a later merge than it is.
  const auditedAt = isAtLeastAsNew(incoming.auditedAt, stored.auditedAt)
    ? incoming.auditedAt
    : stored.auditedAt;
  const measuredAt: Partial<Record<Capability, string>> = {};
  for (const [capability, at] of Object.entries(times) as [Capability, string | null][]) {
    if (at !== null && at !== auditedAt) measuredAt[capability] = at;
  }

  return {
    verdicts,
    auditedAt,
    connectionId: incoming.connectionId,
    ...(Object.keys(measuredAt).length > 0 ? { measuredAt } : {}),
  };
}

/**
 * Write `incoming` from a writer that ATTEMPTED every capability: the app-level
 * audit (CAP-11, review round 1). Such a writer may retract its own earlier
 * answers. A capability it tried and could not settle this time must read
 * unknown, rather than keep a grant measured before the role was removed.
 * Causes include an empty 200 or an unrecognised 403 from a Graph probe
 * (AZR-111), a probe that rejected, or a subscription read that failed.
 * Carrying the old verdict would claim a grant this run did not measure, while
 * the set's audit time says it was just checked.
 *
 * So the stored set contributes ONLY measurements strictly newer than this
 * write's own time, i.e. a panel run that saved after this audit started.
 * Those are not stale relative to the audit and keep their verdict (the
 * out-of-order case mergeCapabilitySets exists for). Everything older is
 * superseded, whether or not this run measured it again. A tie or an unreadable
 * stored time goes to this write. Different connections are replaced outright,
 * as in the merge.
 */
export function supersedeCapabilitySet(stored: CapabilitySet, incoming: CapabilitySet): CapabilitySet {
  if (stored.connectionId === null || stored.connectionId !== incoming.connectionId) {
    return incoming;
  }
  const newer: Partial<Record<Capability, CapabilityVerdict>> = {};
  const newerAt: Partial<Record<Capability, string>> = {};
  let newest: string | null = null;
  for (const [capability, verdict] of Object.entries(stored.verdicts) as [
    Capability,
    CapabilityVerdict | undefined,
  ][]) {
    if (!isMeasurement(verdict)) continue;
    const at = measuredTime(stored, capability);
    if (at === null || ms(at) === null || isAtLeastAsNew(incoming.auditedAt, at)) continue;
    newer[capability] = verdict;
    newerAt[capability] = at;
    if (isAtLeastAsNew(at, newest)) newest = at;
  }
  const kept: CapabilitySet = {
    verdicts: newer,
    auditedAt: newest,
    connectionId: stored.connectionId,
    measuredAt: newerAt,
  };
  return mergeCapabilitySets(kept, incoming);
}
