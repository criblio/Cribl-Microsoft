/**
 * Persisting a CapabilitySet - the codec for the cached audit
 * (capability-model-plan step 2).
 *
 * The audit survives a launch because the plan says not to re-run it every
 * launch, which means it has to be stored somewhere. It goes through the
 * existing ContentCache port (a plain keyed get/set both shells already bind),
 * so this pair is OBJECT-shaped rather than string-shaped like parseAzureConfig
 * and parseProfileStore - the cache stores JSON values, not serialized text.
 * The tolerance discipline is the same as those codecs: parse is TOTAL, and any
 * untrusted blob yields a well-formed CapabilitySet rather than a throw.
 *
 * The tolerance matters more here than usual. A persisted set outlives the code
 * that wrote it, so it can name capabilities this build no longer has, or carry
 * a verdict value that is no longer in the union. Both are DROPPED rather than
 * passed through, because a bogus verdict would not merely be noise - it would
 * be the model asserting a permission fact that nothing measured.
 *
 * Pure: no IO, no clock.
 */

import { AZURE_CAPABILITIES, CRIBL_CAPABILITIES, emptyCapabilitySet } from "./capabilities";
import type { Capability, CapabilitySet, CapabilityVerdict } from "./capabilities";

/**
 * The ContentCache key the audit is stored under. ONE entry: the set carries the
 * connection it was measured against, and isSetForConnection is what decides
 * whether it applies - so a per-connection key here would duplicate that rule in
 * a second place, and the two could disagree.
 */
export const CAPABILITY_AUDIT_CACHE_KEY = "capability-audit~v1";

/** The stored shape. Plain JSON; no methods, no undefined. */
export interface CachedCapabilitySet {
  verdicts: Record<string, string>;
  auditedAt: string | null;
  connectionId: string | null;
}

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  ...AZURE_CAPABILITIES,
  ...CRIBL_CAPABILITIES,
]);

const KNOWN_VERDICTS: ReadonlySet<string> = new Set<string>([
  "granted",
  "denied",
  "unknown",
  "unreachable",
]);

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field, or null when absent/not a string. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Project a set into its stored form, emitting only known keys and verdicts. */
export function serializeCapabilitySet(set: CapabilitySet): CachedCapabilitySet {
  const verdicts: Record<string, string> = {};
  for (const [capability, verdict] of Object.entries(set.verdicts)) {
    if (verdict !== undefined && KNOWN_CAPABILITIES.has(capability)) {
      verdicts[capability] = verdict;
    }
  }
  return {
    verdicts,
    auditedAt: set.auditedAt,
    connectionId: set.connectionId,
  };
}

/**
 * Parse a cached value into a CapabilitySet. TOTAL: null, junk, a partially
 * corrupt blob, or a set written by an older build all yield a well-formed
 * result. Unrecognised capabilities and verdict values are dropped, so an
 * unreadable entry degrades to "not measured" rather than to a wrong answer.
 */
export function parseCapabilitySet(value: unknown): CapabilitySet {
  if (!isPlainObject(value)) {
    return emptyCapabilitySet();
  }
  const verdicts: Partial<Record<Capability, CapabilityVerdict>> = {};
  const rawVerdicts = value["verdicts"];
  if (isPlainObject(rawVerdicts)) {
    for (const [capability, verdict] of Object.entries(rawVerdicts)) {
      if (
        typeof verdict === "string" &&
        KNOWN_CAPABILITIES.has(capability) &&
        KNOWN_VERDICTS.has(verdict)
      ) {
        verdicts[capability as Capability] = verdict as CapabilityVerdict;
      }
    }
  }
  return {
    verdicts,
    auditedAt: stringOrNull(value["auditedAt"]),
    connectionId: stringOrNull(value["connectionId"]),
  };
}
