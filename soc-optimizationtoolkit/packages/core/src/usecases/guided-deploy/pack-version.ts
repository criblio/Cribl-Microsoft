/**
 * Pack-name auto version bump - porting-plan Unit 20 task item 3.
 *
 * The legacy deploy (SentinelIntegration.tsx 1185-1196) looked up any existing
 * pack with the same name and, when found, incremented its PATCH component
 * (`parts[2] = (parts[2] || 0) + 1`) so re-deploying a pack ships a new
 * version; with no prior pack it started at "1.0.0".
 *
 * This port keeps the patch-bump semantics but FIXES the legacy's NaN-join
 * defect: `"1.2.3".split('.').map(Number)` is fine, but a non-numeric component
 * (e.g. "x.y.z" or a "-beta" prerelease tag) produced `NaN` and joined into a
 * garbage version like "NaN.NaN.1". Here any non-integer component coerces to 0
 * for the bump, so the result is always a clean three-part version. No deployed
 * artifact depends on the old NaN behavior (it was never a valid version), so
 * this is fix-and-pin, not preserve.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

/** The version a brand-new pack (no prior build) starts at. */
export const DEFAULT_PACK_VERSION = "1.0.0";

/** Parse one version component to a non-negative integer (junk -> 0). */
function toComponent(part: string | undefined): number {
  const n = Number.parseInt(part ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * The next version for a pack given its current version (if any).
 *
 * @param existingVersion The current pack version, or null/undefined/"" when no
 *   prior pack exists.
 * @returns {@link DEFAULT_PACK_VERSION} when there is no prior version, else the
 *   same major.minor with the patch incremented by one. Missing minor/patch
 *   components are treated as 0 before the bump (so "2.5" -> "2.5.1").
 */
export function bumpPackVersion(existingVersion?: string | null): string {
  if (existingVersion == null || existingVersion.trim() === "") {
    return DEFAULT_PACK_VERSION;
  }
  const parts = existingVersion.trim().split(".");
  const major = toComponent(parts[0]);
  const minor = toComponent(parts[1]);
  const patch = toComponent(parts[2]);
  return `${major}.${minor}.${patch + 1}`;
}
