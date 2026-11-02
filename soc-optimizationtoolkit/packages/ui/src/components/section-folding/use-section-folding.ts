/**
 * useSectionFolding - the page-owned fold state shared by Sentinel Integration
 * (DBT-127, DBT-232, DBT-237), Setup and the first-run wizard (DBT-248).
 *
 * The rules, in the order an operator meets them:
 *   - The page OPENS collapsed: only `currentId` is open.
 *   - Until the operator's first move, the load fold re-derives when
 *     `currentId` changes or the stored pins arrive (restored state lands
 *     after the first render).
 *   - A move ({@link SectionFolding.moveTo}: pointer-down or focus inside a
 *     section, Done - next, a next-action link) folds every other open,
 *     unpinned section, except those in `keepOpen` (a running operation). The
 *     FIRST move ends the load fold. The section moved to stays where it was
 *     on screen (scroll is compensated a frame later).
 *   - Collapsed bodies are the caller's to keep MOUNTED; this hook only says
 *     which ids are folded.
 *   - Pins are written per user to ports.contentCache under
 *     `pinnedKey(pinPrefix, user.id)`. No identity or a refused read means
 *     session-only pins: nothing is ever written under a shared key.
 *
 * Nothing folds because a status changed - a section can turn complete while
 * the operator is still working in it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePorts } from "../../ports-context";
import {
  initialCollapsed,
  parsePinned,
  pinnedKey,
  sectionsToCollapseOnMove,
} from "./section-folding-rules";

export interface SectionFoldingOptions {
  /** Every section id on the page, in page order. */
  ids: readonly string[];
  /** The section that needs the operator now; undefined folds them all. */
  currentId: string | undefined;
  /** Content-cache key prefix for this page's pins (one per page). */
  pinPrefix: string;
  /** Sections that must stay open on a move (e.g. a running deploy). */
  keepOpen?: ReadonlySet<string> | readonly string[];
  /** The DOM id a section scrolls to; defaults to the section id itself. */
  anchorFor?: (id: string) => string;
}

export interface SectionFolding {
  collapsed: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  setCollapsed(id: string, collapsed: boolean): void;
  setPinned(id: string, pinned: boolean): void;
  /** An explicit move: fold the other open, unpinned sections. */
  moveTo(id: string): void;
  /** Move, open the section and scroll it into view. */
  goTo(id: string): void;
  /** The DOM id of a section's anchor. */
  anchorFor(id: string): string;
}

export function useSectionFolding(options: SectionFoldingOptions): SectionFolding {
  const { ids, currentId, pinPrefix, keepOpen } = options;
  const { ports } = usePorts();

  // moveTo reads these through refs so its identity does not churn per render.
  const idsRef = useRef<readonly string[]>(ids);
  idsRef.current = ids;
  const keepOpenRef = useRef<ReadonlySet<string> | readonly string[] | undefined>(keepOpen);
  keepOpenRef.current = keepOpen;
  const anchorOption = options.anchorFor;
  const anchorFor = useCallback(
    (id: string): string => (anchorOption !== undefined ? anchorOption(id) : id),
    [anchorOption],
  );

  const [collapsed, setCollapsedSet] = useState<ReadonlySet<string>>(() =>
    initialCollapsed(ids, currentId),
  );
  const setCollapsed = useCallback((id: string, fold: boolean) => {
    setCollapsedSet((prev) => {
      if (prev.has(id) === fold) return prev;
      const next = new Set(prev);
      if (fold) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Pins are remembered per user; with no identity (or a refused read) they
  // live for this session only.
  const [pinned, setPinnedSet] = useState<ReadonlySet<string>>(() => new Set());
  const pinKeyRef = useRef<string | null>(null);
  const pinCache = ports.contentCache;
  const pinUser = ports.user;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await pinUser.current();
        const key = pinnedKey(pinPrefix, me.id);
        pinKeyRef.current = key;
        const raw = await pinCache?.get(key);
        if (!cancelled) {
          const pins = parsePinned(raw, idsRef.current);
          setPinnedSet(new Set(pins));
          // A pinned section is open, including on load.
          setCollapsedSet((prev) => {
            if (!pins.some((id) => prev.has(id))) return prev;
            const next = new Set(prev);
            for (const id of pins) next.delete(id);
            return next;
          });
        }
      } catch {
        // No identity, or the store refused the read: pins stay session-only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pinCache, pinUser, pinPrefix]);
  const setPinned = useCallback(
    (id: string, pin: boolean) => {
      const next = new Set(pinned);
      if (pin) next.add(id);
      else next.delete(id);
      setPinnedSet(next);
      const key = pinKeyRef.current;
      if (key !== null) {
        void pinCache?.set(key, JSON.stringify([...next])).catch(() => {
          // Best effort: the pin still holds for this session.
        });
      }
    },
    [pinned, pinCache],
  );

  const activeRef = useRef<string | null>(null);
  const moveTo = useCallback(
    (id: string) => {
      if (activeRef.current === id) return;
      activeRef.current = id;
      const toFold = sectionsToCollapseOnMove(
        id,
        idsRef.current,
        collapsed,
        pinned,
        new Set(keepOpenRef.current ?? []),
      );
      if (toFold.length === 0) return;
      const anchor = document.getElementById(anchorFor(id));
      const before = anchor?.getBoundingClientRect().top;
      setCollapsedSet((prev) => {
        const next = new Set(prev);
        for (const f of toFold) next.add(f);
        return next;
      });
      requestAnimationFrame(() => {
        if (anchor === null || before === undefined) return;
        const shift = anchor.getBoundingClientRect().top - before;
        if (shift !== 0) window.scrollBy(0, shift);
      });
    },
    [collapsed, pinned, anchorFor],
  );

  // Until the operator's first move, the load fold follows `currentId`: the
  // first render can run before restored state arrives, so "current" may
  // advance during load. Once the operator has acted, nothing folds on a
  // status change again.
  useEffect(() => {
    if (activeRef.current !== null) return;
    const next = initialCollapsed(idsRef.current, currentId);
    for (const id of pinned) next.delete(id);
    setCollapsedSet((prev) =>
      prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next,
    );
  }, [currentId, pinned]);

  const goTo = useCallback(
    (id: string) => {
      moveTo(id);
      setCollapsed(id, false);
      requestAnimationFrame(() => {
        document
          .getElementById(anchorFor(id))
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [setCollapsed, moveTo, anchorFor],
  );

  return { collapsed, pinned, setCollapsed, setPinned, moveTo, goTo, anchorFor };
}
