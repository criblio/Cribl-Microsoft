/**
 * useFoldScopeFolding - the folding instance a page hands to its
 * {@link SectionFoldScope} (DBT-248): useSectionFolding plus the busy set the
 * scope's sections feed through useSectionRunState. A section running a long
 * operation (Save and connect, discovery, a Refresh check) is held open when
 * the operator moves elsewhere.
 *
 * Shared by the Setup page and the first-run wizard's steps so the scope is
 * built one way.
 */

import { useCallback, useState } from "react";
import { useSectionFolding } from "./use-section-folding";
import type { SectionFolding, SectionFoldingOptions } from "./use-section-folding";

export function useFoldScopeFolding(
  options: Omit<SectionFoldingOptions, "keepOpen">,
): { folding: SectionFolding; setBusy: (id: string, busy: boolean) => void } {
  const [busy, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const setBusy = useCallback((id: string, isBusy: boolean) => {
    setBusyIds((prev) => {
      if (prev.has(id) === isBusy) return prev;
      const next = new Set(prev);
      if (isBusy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const folding = useSectionFolding({ ...options, keepOpen: busy });
  return { folding, setBusy };
}
