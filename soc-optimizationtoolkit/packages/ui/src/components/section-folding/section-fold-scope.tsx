/**
 * SectionFoldScope - hands one page's {@link SectionFolding} to the sections
 * beneath it without threading six props through every shell-composed child
 * (DBT-248). The Setup page and the first-run wizard each mount ONE scope; a
 * section calls useSectionFold (section-fold-context) with its id and spreads
 * the result onto its NumberedSection.
 *
 * No scope above a section means it renders exactly as it did before folding
 * (the standalone route, tests that mount a section alone): useSectionFold
 * returns undefined and the section keeps its own state.
 */

import type { ReactNode } from "react";
import { FoldScopeContext } from "./section-fold-context";
import type { FoldScopeValue } from "./section-fold-context";

export interface SectionFoldScopeProps extends FoldScopeValue {
  children: ReactNode;
}

export function SectionFoldScope({ folding, numberFor, children }: SectionFoldScopeProps) {
  return (
    <FoldScopeContext.Provider value={{ folding, ...(numberFor !== undefined ? { numberFor } : {}) }}>
      {children}
    </FoldScopeContext.Provider>
  );
}
