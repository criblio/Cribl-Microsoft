/**
 * The context behind {@link SectionFoldScope} and the hook sections read it
 * through (DBT-248). Kept apart from the component so each file exports only
 * components or only values.
 */

import { createContext, useContext } from "react";
import type { SectionFolding } from "./use-section-folding";

export interface FoldScopeValue {
  folding: SectionFolding;
  /** The badge number of a section on this page; undefined keeps the section's own. */
  numberFor?: (id: string) => number | undefined;
}

export const FoldScopeContext = createContext<FoldScopeValue | null>(null);

/** The NumberedSection props a scope drives for one section. */
export interface SectionFoldProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onActivate: () => void;
  anchorId: string;
  /** Set when the scope numbers this section; spread only if defined. */
  number: number | undefined;
}

/** The fold props for one section of a page's folding (for the page that owns it). */
export function sectionFoldProps(
  folding: SectionFolding,
  id: string,
  numberFor?: (id: string) => number | undefined,
): SectionFoldProps {
  return {
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
  return sectionFoldProps(scope.folding, id, scope.numberFor);
}
