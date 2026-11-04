/**
 * useSectionFolding - the page-owned fold state shared by Sentinel Integration
 * (DBT-127, DBT-232, DBT-237), Setup and the first-run wizard (DBT-248).
 *
 * The rules, in the order an operator meets them:
 *   - The page OPENS collapsed: only `currentId` is open.
 *   - Until the operator's first move or explicit open/fold, the load fold re-derives when
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
  // Held in a ref so moveTo/goTo keep their identity however the caller
  // passes anchorFor (an inline arrow is a new function every render).
  const anchorOptionRef = useRef(options.anchorFor);
  anchorOptionRef.current = options.anchorFor;
  const anchorFor = useCallback(
    (id: string): string => anchorOptionRef.current?.(id) ?? id,
    [],
  );

  const [collapsed, setCollapsedSet] = useState<ReadonlySet<string>>(() =>
    initialCollapsed(ids, currentId),
  );
  // DBT-256: an explicit open or fold (a header, Expand, Collapse, Done) ends
  // the load fold just as a move does. Opening is not a move, so without this
  // a section opened during load was shut again when `currentId` advanced or
  // the stored pins arrived.
  const touchedRef = useRef(false);
  const setCollapsed = useCallback((id: string, fold: boolean) => {
    touchedRef.current = true;
    setCollapsedSet((prev) => {
      if (prev.has(id) === fold) return prev;
      const next = new Set(prev);
      if (fold) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Pins are remembered per user; with no identity (or a refused read) they
  // live for this session only. A pin changed BEFORE the stored list has been
  // read is held as a session change and merged over the stored list when it
  // arrives - writing first would replace the stored pins with just the new one.
  const [pinned, setPinnedSet] = useState<ReadonlySet<string>>(() => new Set());
  const pinnedRef = useRef<ReadonlySet<string>>(pinned);
  // Writable only once the stored list has been read for a known user.
  const pinKeyRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const sessionPinOps = useRef(new Map<string, boolean>());
  const pinCache = ports.contentCache;
  const pinUser = ports.user;
  const writePins = useCallback(
    (key: string, next: ReadonlySet<string>) => {
      void pinCache?.set(key, JSON.stringify([...next])).catch(() => {
        // Best effort: the pin still holds for this session.
      });
    },
    [pinCache],
  );
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    pinKeyRef.current = null;
    void (async () => {
      try {
        const me = await pinUser.current();
        const key = pinnedKey(pinPrefix, me.id);
        const raw = await pinCache?.get(key);
        if (!cancelled) {
          const merged = new Set(parsePinned(raw, idsRef.current));
          const ops = sessionPinOps.current;
          for (const [id, on] of ops) {
            if (on) merged.add(id);
            else merged.delete(id);
          }
          pinnedRef.current = merged;
          setPinnedSet(merged);
          pinKeyRef.current = key;
          loadedRef.current = true;
          // A pin set while loading is now safe to save, over the stored list.
          if (ops.size > 0) writePins(key, merged);
          ops.clear();
          // A pinned section is open, including on load.
          setCollapsedSet((prev) => {
            if (![...merged].some((id) => prev.has(id))) return prev;
            const next = new Set(prev);
            for (const id of merged) next.delete(id);
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
  }, [pinCache, pinUser, pinPrefix, writePins]);
  const setPinned = useCallback(
    (id: string, pin: boolean) => {
      const next = new Set(pinnedRef.current);
      if (pin) next.add(id);
      else next.delete(id);
      pinnedRef.current = next;
      setPinnedSet(next);
      const key = pinKeyRef.current;
      if (key !== null && loadedRef.current) writePins(key, next);
      else sessionPinOps.current.set(id, pin);
    },
    [writePins],
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
    if (activeRef.current !== null || touchedRef.current) return;
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
