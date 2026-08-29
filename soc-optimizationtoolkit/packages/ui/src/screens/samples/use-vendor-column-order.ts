/**
 * useVendorColumnOrder - the load/save half of remembered column orders
 * (docs/vendor-field-definition-plan.md, Gap 3 / step 4). Every DECISION lives
 * in the pure core module `vendor-field-definitions`; this hook owns only the
 * two ContentCache calls and the React lifecycle around them, exactly as
 * `useLearnedMappings` does for the mapping-review feedback loop.
 *
 * The loop, per VENDOR + LOG TYPE (never per solution - see decision 1 in the
 * core module):
 *
 *   load    - read the stored definition for the scope and decode it
 *             defensively; a failed read only disables reuse for this session.
 *   resolve - a stored operator order BEATS the bundled one, and the override is
 *             re-derived live so the notice can never go stale (decision 3).
 *             With nothing stored, the bundled order answers, which is what
 *             PRE-FILLS the dialog for the operator to confirm (decision 2).
 *   remember- persist an operator-supplied order. A merely CONFIRMED pre-fill
 *             builds to null and writes NOTHING - see the trap argued at length
 *             in the core module header. A failed write never blocks the apply.
 *   forget  - drop the stored order so the bundled one answers again; the way
 *             back from a mistaken paste that decision 3 makes visible.
 *
 * The scope may be unnameable - an un-curated solution yields no vendor, and a
 * sample may be tagged with a log type that folds to nothing. Then there is NO
 * key, nothing is read, and nothing is written: absent is absent, and two
 * un-named vendors never share a slot.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildVendorFieldDefinition,
  describeColumnOrder,
  parseVendorFieldDefinition,
  resolveColumnOrder,
  vendorFieldDefinitionKey,
} from "@soc/core";
import type {
  ContentCache,
  ResolvedColumnOrder,
  VendorFieldDefinition,
} from "@soc/core";

export interface VendorColumnOrderState {
  /** The order to pre-fill with, or null when nothing is known about the scope. */
  resolved: ResolvedColumnOrder | null;
  /**
   * The operator-facing sentence for {@link resolved} ("" when nothing is
   * known): whether the order is bundled or theirs, and - decision 3 - what a
   * stored order of theirs REPLACED and where the two first differ.
   */
  notice: string;
  /** True while the stored definition is being read (nothing to pre-fill yet). */
  loading: boolean;
  /** Persist an operator-supplied order. A confirmed pre-fill stores nothing. */
  remember: (columns: readonly string[]) => void;
  /** Drop the stored order for this scope; the bundled one answers again. */
  forget: () => void;
}

/**
 * Remembered column order for one vendor + log type over the ContentCache port.
 * Pass `undefined` for the cache when the shell binds none - the hook then
 * resolves the bundled order only and remembers nothing.
 */
export function useVendorColumnOrder(
  cache: ContentCache | undefined,
  vendor: string,
  logType: string,
  /**
   * How many fields the tagged event actually has (VND-3). Optional because
   * not every caller has a sample in hand - the CSV header dialog resolves an
   * order before anything is parsed - and `describeColumnOrder` keeps its
   * unmeasured wording when it is absent rather than inventing a comparison.
   */
  fieldCount?: number,
): VendorColumnOrderState {
  const key = vendorFieldDefinitionKey(vendor, logType);
  const [stored, setStored] = useState<VendorFieldDefinition | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStored(null);
    if (cache === undefined || key === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const raw = await cache.get(key);
        if (!cancelled) {
          setStored(parseVendorFieldDefinition(raw, vendor, logType));
        }
      } catch {
        // A failed load only disables reuse for this session; the bundled
        // order still pre-fills and the operator can still supply their own.
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cache, key, vendor, logType]);

  const resolved = useMemo(
    () => resolveColumnOrder(vendor, logType, stored),
    [vendor, logType, stored],
  );

  const notice = useMemo(
    () => (resolved === null ? "" : describeColumnOrder(resolved, fieldCount)),
    [resolved, fieldCount],
  );

  const remember = useCallback(
    (columns: readonly string[]) => {
      if (cache === undefined || key === null) {
        return;
      }
      const definition = buildVendorFieldDefinition(vendor, logType, columns);
      if (definition === null) {
        // Nothing worth storing: an unnameable scope, no columns, or a bundled
        // order the operator merely confirmed. Storing that last one would
        // freeze today's shipped order as an operator fact and make the
        // override notice lie about who decided it.
        return;
      }
      setStored(definition);
      void cache.set(key, definition).catch(() => undefined);
    },
    [cache, key, vendor, logType],
  );

  const forget = useCallback(() => {
    setStored(null);
    if (cache === undefined || key === null) {
      return;
    }
    // Written as null rather than deleted: the port has no delete, and a stored
    // null decodes as absent, so the bundled order answers again.
    void cache.set(key, null).catch(() => undefined);
  }, [cache, key]);

  return { resolved, notice, loading, remember, forget };
}
