/**
 * The diagram (i) affordance (AZR-30): an in-SVG info button drawn as a
 * SIBLING of its card, and the role=dialog popover it opens.
 *
 * Ported from the claude-kit cribl-dataflow-diagram reference
 * `FlowDiagram.tsx` (the `df-info` group and `df-popover`) and from
 * screens/azure-logging-map/logging-map-canvas.tsx, where this code lived
 * first (its `lm-info` group and `lm-popover`, :243-259 and :544-568).
 *
 * - The (i) is a sibling, never a child, of the card: nested interactive
 *   roles are invalid. It is keyboard reachable (role=button, tabIndex 0,
 *   Enter/Space) and stops propagation so it never selects the card.
 * - Its hit circle is ~1.5x the visible glyph (the standard's touch target).
 * - The popover closes on Escape and on a pointerdown outside it (and
 *   outside `keepOpenSelector`, which should match the (i) buttons so a
 *   second click on an (i) toggles rather than closes-then-reopens). Closing
 *   on wheel, zoom, fit and pan is the viewport's `onViewChange`.
 *
 * This file adds no class names: consumers pass their own.
 */

import { useEffect, type CSSProperties, type ReactNode } from "react";

/** The visible (i) glyph radius. */
export const INFO_GLYPH_R = 6.5;
/** The (i) hit radius: ~1.5x the glyph. */
export const INFO_HIT_R = 10;

export interface InfoHitCircleClasses {
  readonly group: string;
  readonly hit: string;
  readonly glyph: string;
  readonly letter: string;
}

/** Extra attributes for an element, e.g. `{ "data-lm-info": "" }`. */
export type ElementAttrs = Readonly<Record<string, string>>;

export interface InfoHitCircleProps {
  readonly cx: number;
  readonly cy: number;
  /** Accessible name, e.g. "About Sub A". */
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly classes: InfoHitCircleClasses;
  readonly attrs?: ElementAttrs;
}

export function InfoHitCircle({ cx, cy, label, expanded, onToggle, classes, attrs }: InfoHitCircleProps) {
  return (
    <g
      {...attrs}
      className={classes.group}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-expanded={expanded}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
    >
      {/* ~1.5x hit area around the visible glyph. */}
      <circle className={classes.hit} cx={cx} cy={cy} r={INFO_HIT_R} />
      <circle className={classes.glyph} cx={cx} cy={cy} r={INFO_GLYPH_R} />
      <text className={classes.letter} x={cx} y={cy + 3.5} textAnchor="middle">
        i
      </text>
    </g>
  );
}

export interface DiagramInfoPopoverProps {
  readonly label: string;
  readonly left: number;
  readonly top: number;
  readonly onClose: () => void;
  /**
   * A pointerdown inside an element matching this selector does not close
   * the popover. The popover itself always counts as inside.
   */
  readonly keepOpenSelector?: string;
  readonly className: string;
  readonly attrs?: ElementAttrs;
  readonly style?: CSSProperties;
  readonly children: ReactNode;
}

const POPOVER_MARK = "data-diagram-popover";

/** Mounted only while open; closes on Escape and an outside pointerdown. */
export function DiagramInfoPopover({
  label,
  left,
  top,
  onClose,
  keepOpenSelector,
  className,
  attrs,
  style,
  children,
}: DiagramInfoPopoverProps) {
  useEffect(() => {
    const inside = keepOpenSelector === undefined ? `[${POPOVER_MARK}]` : `[${POPOVER_MARK}], ${keepOpenSelector}`;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: globalThis.PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(inside)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, keepOpenSelector]);

  return (
    <div
      {...attrs}
      {...{ [POPOVER_MARK]: "" }}
      className={className}
      role="dialog"
      aria-label={label}
      style={{ ...style, left, top }}
    >
      {children}
    </div>
  );
}
