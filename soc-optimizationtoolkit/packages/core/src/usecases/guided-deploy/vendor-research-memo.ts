/**
 * Vendor-research memoization - porting-plan Unit 20 characterization
 * ("vendor-research memoized (legacy called it three times per deploy)").
 *
 * The legacy handleDeploy called performVendorResearch for the SAME solution
 * three times in one deploy (SentinelIntegration.tsx 953, 1038, and again via
 * the e2e path), each a fresh network round trip. This wraps a research function
 * so repeated calls for the same vendor within one deploy resolve from cache -
 * ONE call per distinct vendor, per the normalized vendor key (porting-plan
 * contract 14: lowercase, non-alphanumeric to '_'). The in-flight PROMISE is
 * cached, so concurrent calls for the same vendor also dedupe to one underlying
 * call.
 *
 * The full vendor-research ENGINE is Unit 15 (deferred for the MVP); this module
 * only provides the memoization wrapper the orchestrator injects around whatever
 * research function a shell supplies.
 *
 * Pure higher-order function: no IO of its own, no Date/crypto/Math.random. The
 * wrapped function owns any IO.
 */

/** Normalized vendor key (porting-plan contract 14): lowercase, non-alnum -> '_'. */
export function normalizeVendorKey(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

/** A memoized research function plus its call counters (for tests/diagnostics). */
export interface MemoizedResearch<T> {
  /** Research a vendor, resolving from cache after the first call per key. */
  (vendor: string): Promise<T>;
  /** Number of times the UNDERLYING function was actually invoked. */
  readonly underlyingCalls: () => number;
  /** Number of distinct vendor keys cached. */
  readonly cachedKeys: () => number;
}

/**
 * Memoize a vendor-research function by normalized vendor key. Caches the
 * returned promise (so concurrent same-key calls share one invocation). If the
 * underlying call REJECTS, the cache entry is evicted so a later retry can run
 * again (a failed research must not be permanently cached).
 */
export function memoizeVendorResearch<T>(
  research: (vendor: string) => Promise<T>,
): MemoizedResearch<T> {
  const cache = new Map<string, Promise<T>>();
  let underlying = 0;

  const memoized = ((vendor: string): Promise<T> => {
    const key = normalizeVendorKey(vendor);
    const existing = cache.get(key);
    if (existing !== undefined) {
      return existing;
    }
    underlying += 1;
    const pending = research(vendor).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, pending);
    return pending;
  }) as MemoizedResearch<T>;

  Object.defineProperties(memoized, {
    underlyingCalls: { value: () => underlying },
    cachedKeys: { value: () => cache.size },
  });

  return memoized;
}
