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
 *             defensively; a failed read only disables reuse for this session,
 *             and SAYS so (storeRefused - DBT-175).
 *   resolve - a stored operator order BEATS the bundled one, and the override is
 *             re-derived live so the notice can never go stale (decision 3).
 *             With nothing stored, the bundled order answers, which is what
 *             PRE-FILLS the dialog for the operator to confirm (decision 2).
 *   remember- persist an operator-supplied order. A merely CONFIRMED pre-fill
 *             builds to null and writes NOTHING - see the trap argued at length
 *             in the core module header. A failed write never blocks the apply,
 *             and is exposed the same way.
 *   forget  - drop the stored order so the bundled one answers again; the way
 *             back from a mistaken paste that decision 3 makes visible.
 *
 * The scope may be unnameable - an un-curated solution yields no vendor, and a
 * sample may be tagged with a log type that folds to nothing. Then there is NO
 * key, nothing is read, and nothing is written: absent is absent, and two
 * un-named vendors never share a slot.
 *
 * A REFUSED STORE IS A SKIP, NOT SILENCE (DBT-175). Since DBT-145 the KV store
 * throws on a non-encrypted 403 (a 5xx always did). Every call here already
 * survived that, but by swallowing it: the operator named columns, was told
 * nothing, and found them gone next session. The hook now keeps the LAST
 * refusal - which call, and why - for the screen to say; the pre-fill and the
 * apply carry on exactly as before.
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

/** Which store call was refused, and why (DBT-175). */
export interface ColumnOrderRefusal {
  /** The call the store refused: the load, a remember, or a forget. */
  action: "read" | "remember" | "forget";
  /** The thrown error, stringified. */
  reason: string;
}

/**
 * The operator-facing sentence for a refusal. Each call has its own
 * consequence, so each gets its own sentence: a refused read means a saved
 * order may exist and is not being used; a refused remember means the order
 * applies now and is gone next session; a refused forget means the order the
 * operator just dropped may come back.
 */
export function describeColumnOrderRefusal(refusal: ColumnOrderRefusal): string {
  switch (refusal.action) {
    case "read":
      return (
        `A column order saved for this vendor and log type could not be read ` +
        `(${refusal.reason}), so none is being reused. Naming the columns ` +
        "still works; any saved order is simply not applied."
      );
    case "remember":
      return (
        `This column order could not be saved (${refusal.reason}). It applies ` +
        "to this sample now but will not be remembered for the next one."
      );
    case "forget":
      return (
        `The saved column order could not be removed (${refusal.reason}). It ` +
        "is ignored for now, but it may still pre-fill the next sample."
      );
  }
}

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
  /**
   * The last call the store REFUSED for this scope, or null while none has
   * (DBT-175). Reset when the scope changes, since the next read is a fresh
   * question. Describe it with {@link describeColumnOrderRefusal}.
   */
  storeRefused: ColumnOrderRefusal | null;
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
  const [storeRefused, setStoreRefused] = useState<ColumnOrderRefusal | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setStored(null);
    setStoreRefused(null);
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
      } catch (err) {
        // A failed load only disables reuse for this session; the bundled
        // order still pre-fills and the operator can still supply their own.
        // It is KEPT, not swallowed (DBT-175): a saved order may exist.
        if (!cancelled) {
          setStoreRefused({ action: "read", reason: String(err) });
        }
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
      // A refused write is a skip - the order is in hand and applies - but
      // it is said, since it will not be there next session (DBT-175).
      void cache.set(key, definition).catch((err: unknown) => {
        setStoreRefused({ action: "remember", reason: String(err) });
      });
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
    void cache.set(key, null).catch((err: unknown) => {
      setStoreRefused({ action: "forget", reason: String(err) });
    });
  }, [cache, key]);

  return { resolved, notice, loading, remember, forget, storeRefused };
}
