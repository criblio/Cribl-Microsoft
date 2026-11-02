/**
 * The context behind {@link SectionFoldScope} and the hook sections read it
 * through (DBT-248). Kept apart from the component so each file exports only
 * components or only values.
 */

import { createContext, useContext, useEffect, useRef } from "react";
import type { SectionFolding } from "./use-section-folding";

export interface FoldScopeValue {
  folding: SectionFolding;
  /** The badge number of a section on this page; undefined keeps the section's own. */
  numberFor?: (id: string) => number | undefined;
  /** The section that needs the operator now (wears the "current" badge). */
  currentId?: string | undefined;
  /** A section reports that a long operation is in flight; it stays open on a move. */
  setBusy?: (id: string, busy: boolean) => void;
}

export const FoldScopeContext = createContext<FoldScopeValue | null>(null);

/** The NumberedSection props a scope drives for one section. */
export interface SectionFoldProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onActivate: () => void;
  /** This section is the one that needs the operator now. */
  current: boolean;
  anchorId: string;
  /** Set when the scope numbers this section; spread only if defined. */
  number: number | undefined;
}

/** The fold props for one section of a page's folding (for the page that owns it). */
export function sectionFoldProps(
  folding: SectionFolding,
  id: string,
  numberFor?: (id: string) => number | undefined,
  currentId?: string,
): SectionFoldProps {
  return {
    current: currentId === id,
    collapsed: folding.collapsed.has(id),
    onCollapsedChange: (c) => folding.setCollapsed(id, c),
    pinned: folding.pinned.has(id),
    onPinnedChange: (p) => folding.setPinned(id, p),
    onActivate: () => folding.moveTo(id),
    anchorId: folding.anchorFor(id),
    number: numberFor?.(id),
  };
}

/** Fold props for section `id`, or undefined outside any scope. */
export function useSectionFold(id: string): SectionFoldProps | undefined {
  const scope = useContext(FoldScopeContext);
  if (scope === null) return undefined;
  return sectionFoldProps(scope.folding, id, scope.numberFor, scope.currentId);
}

/**
 * A section reports its long operation and its failures to the page's fold
 * scope (DBT-248): while `busy` the section stays open when the operator moves
 * elsewhere, and when `failed` turns true the section reopens so the failure is
 * not hidden behind a folded header. Outside a scope this does nothing.
 */
export function useSectionRunState(id: string, state: { busy: boolean; failed: boolean }): void {
  const scope = useContext(FoldScopeContext);
  const setBusy = scope?.setBusy;
  const setCollapsed = scope?.folding.setCollapsed;
  useEffect(() => {
    setBusy?.(id, state.busy);
    return () => setBusy?.(id, false);
  }, [id, setBusy, state.busy]);
  const wasFailed = useRef(false);
  useEffect(() => {
    if (state.failed && !wasFailed.current) setCollapsed?.(id, false);
    wasFailed.current = state.failed;
  }, [id, setCollapsed, state.failed]);
}
