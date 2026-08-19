/**
 * Sample-source discovery - ONE fetch behind the picker (plan Phase 3, ADR 0003).
 *
 * Same shape as useWorkspaceTables: the fetch lives in a hook with no surface of
 * its own, and the CHOICE over it lives in the component. The inventory is one
 * fact about the workspace - the Search datasets, Lake datasets and live sources
 * that exist do not depend on which solution is selected - so it is read once
 * rather than per anything.
 *
 * NOT AUTO-RETRIED. The load clears nothing on error and the effect is keyed on
 * a ref, so a failure stays failed until the operator asks again. One 403 must
 * not become a request storm against a proxy budget shared with the whole page.
 *
 * DISCOVERY NEVER GATES ANYTHING. Every failure mode here still leaves manual
 * upload working, which is the point of it being the fallback path - so this
 * hook reports and never blocks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { discoverSampleSources } from "@soc/core";
import type { SampleSourceInventory } from "@soc/core";
import { usePorts } from "../../ports-context";

export interface SampleSourcesState {
  /** Null until the first load completes; the picker renders a loading line. */
  inventory: SampleSourceInventory | null;
  /** Notes about DISCOVERY itself (capped group reads, a dead leader). */
  notes: readonly string[];
  loading: boolean;
  /** Re-run discovery. The picker offers this on every degraded section. */
  reload: () => void;
}

export interface UseSampleSourcesInput {
  /**
   * Whether a Cribl connection exists to discover against. False keeps the
   * hook idle - there is no address to call, which is different from a call
   * that failed and must not be reported as one.
   */
  enabled: boolean;
}

export function useSampleSources({
  enabled,
}: UseSampleSourcesInput): SampleSourcesState {
  const { ports } = usePorts();
  const [inventory, setInventory] = useState<SampleSourceInventory | null>(null);
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await discoverSampleSources(ports.cribl, {}, ports.logger);
      setInventory(result.inventory);
      setNotes(result.notes);
    } catch (err) {
      // The usecase folds per-surface failures into sections and only rejects
      // on something truly unexpected. Surface it rather than swallow it: an
      // empty picker with no reason is the failure this whole phase is against.
      setNotes([
        `Sample-source discovery failed unexpectedly: ${String(err)}. Uploading samples still works.`,
      ]);
      setInventory(null);
    } finally {
      setLoading(false);
    }
  }, [ports.cribl, ports.logger]);

  // Once per enablement, not once per render.
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void load();
  }, [enabled, load]);

  const reload = useCallback(() => {
    started.current = true;
    void load();
  }, [load]);

  return { inventory, notes, loading, reload };
}
