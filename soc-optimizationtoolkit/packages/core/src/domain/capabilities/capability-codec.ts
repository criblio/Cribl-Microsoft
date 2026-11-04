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
 * The LEGACY single-slot ContentCache key: until ADR 0009 every connection's
 * audit was stored here, so measuring tenant B overwrote tenant A. Now read only
 * to move its one audit to the tenant it was measured for.
 */
export const CAPABILITY_AUDIT_CACHE_KEY = "capability-audit~v1";

/**
 * The ContentCache key one TENANT's audit is stored under (ADR 0009 decision 3;
 * audit tenancy MEDIUM, capability-codec.ts:31). Per tenant and not per full
 * audit key: within a tenant the set still carries the connection it was
 * measured against, and isSetForConnection still decides whether it applies -
 * the per-tenant key only stops one tenant's audit evicting another's.
 */
export function capabilityAuditCacheKey(tenantId: string): string {
  const tenant = tenantId.trim().toLowerCase();
  return `${CAPABILITY_AUDIT_CACHE_KEY}~${tenant === "" ? "none" : tenant}`;
}

/** Whether a stored audit key (capabilityAuditKey) was measured for `tenantId`. */
export function auditKeyNamesTenant(connectionId: string | null, tenantId: string): boolean {
  if (connectionId === null) return false;
  const want = `tenant=${tenantId.trim().toLowerCase()}`;
  return connectionId.split("|").some((part) => part.toLowerCase() === want);
}

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
