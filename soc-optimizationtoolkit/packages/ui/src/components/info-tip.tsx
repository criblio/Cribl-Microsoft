/**
 * InfoTip - a small "i" affordance that reveals an explanatory tip on hover,
 * keyboard focus, or click/tap. Mined from the legacy InfoTip with two
 * deliberate changes: focus/blur support (the legacy tip was mouse-only) and
 * class-based styling instead of inline styles.
 *
 * The KEPT contract: embedded newlines in `text` render as line breaks
 * (white-space: pre-wrap in .info-tip-pop), so multi-line domain
 * explanations lay out as authored.
 *
 * TOP LAYER (user report 2026-08-03: tips rendered behind other elements, and
 * long ones ran off the page unreadable). The tip is a native popover, so the
 * browser paints it in the TOP LAYER - above every stacking context and
 * outside every ancestor's overflow clipping. `position: absolute` with
 * `z-index: 10000` could not do this: a z-index only orders siblings within
 * its own stacking context, and any ancestor with a transform, filter,
 * opacity, or `overflow: hidden/auto` (numbered sections, the scrolling
 * solution list, the diagram canvas) trapped or clipped the tip regardless.
 *
 * Placement is computed from the icon's viewport rect rather than fixed to one
 * side: the tip prefers to sit above the icon, FLIPS below when there is not
 * enough room above (the old hardcoded `bottom: 100%` ran off the top of the
 * page near the header), and clamps horizontally so it never overhangs the
 * viewport edge. A tip taller than the room available scrolls internally
 * instead of overflowing, so the whole text is always reachable.
 *
 * Hovering the tip itself keeps it open, so a long tip can be read and
 * scrolled without it vanishing when the pointer leaves the icon.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface InfoTipProps {
  /** Tip content. Embedded "\n" characters render as line breaks. */
  text: string;
}

/** Gap between the icon and the tip, and the minimum margin to any edge. */
const GAP = 6;
const EDGE = 8;

export function InfoTip({ text }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const iconRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // Position the tip from the icon's CURRENT viewport rect. Runs on open and
  // again on scroll/resize, so a pinned tip tracks its icon instead of
  // stranding itself where the icon used to be.
  const place = useCallback(() => {
    const icon = iconRef.current;
    const pop = popRef.current;
    if (icon === null || pop === null) {
      return;
    }
    const anchor = icon.getBoundingClientRect();
    const tip = pop.getBoundingClientRect();
    // Prefer above (the established look); flip below only when above cannot
    // fit, which is what made tips near the top of the page unreadable.
    const fitsAbove = anchor.top >= tip.height + GAP + EDGE;
    const top = fitsAbove
      ? anchor.top - tip.height - GAP
      : anchor.bottom + GAP;
    const centered = anchor.left + anchor.width / 2 - tip.width / 2;
    const left = Math.max(
      EDGE,
      Math.min(centered, window.innerWidth - tip.width - EDGE),
    );
    pop.style.top = `${Math.max(EDGE, top)}px`;
    pop.style.left = `${left}px`;
  }, []);

  useLayoutEffect(() => {
    const pop = popRef.current;
    if (pop === null) {
      return;
    }
    // showPopover/hidePopover throw if the element is already in the requested
    // state (e.g. a double render); the state is what we asked for either way.
    if (open) {
      try {
        pop.showPopover();
      } catch {
        // already open
      }
      place();
    } else {
      try {
        pop.hidePopover();
      } catch {
        // already closed
      }
    }
  }, [open, place]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const reposition = () => place();
    // Capture phase: the scroll may happen on any ancestor, not just window.
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("resize", reposition, { passive: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, place]);

  return (
    <span className="info-tip">
      <span
        ref={iconRef}
        className="info-tip-icon"
        role="button"
        tabIndex={0}
        aria-label="More information"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        i
      </span>
      {/* Always mounted: showPopover() needs the element in the document, and
        * keeping it mounted avoids a mount-then-measure flash. `manual` so the
        * browser never light-dismisses it out from under a hover. */}
      <span
        ref={popRef}
        className="info-tip-pop"
        role="tooltip"
        popover="manual"
        // Keeping the pointer on the tip keeps it open, so a long tip can be
        // read and scrolled; leaving it closes, same as leaving the icon.
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {text}
      </span>
    </span>
  );
}
