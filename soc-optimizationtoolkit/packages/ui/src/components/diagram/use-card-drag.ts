/**
 * useCardDrag - movable diagram cards (AZR-30), the standard's "Movable
 * cards" rule. Ported from the claude-kit cribl-dataflow-diagram reference
 * `FlowDiagram.tsx` (onCardPointerDown, the card branch of onPointerMove,
 * endDrag, the swallowed post-drag click, Reset layout).
 *
 * - A press becomes a drag only after {@link DRAG_THRESHOLD_PX}; below that
 *   it is a click and the card selects as usual.
 * - Pointer capture is deferred to that moment (capturing on pointer-down
 *   retargets the click to the container and swallows selection).
 * - A move that arrives with the primary button already up ends the drag:
 *   a release outside the iframe is never delivered, so a card cannot stick.
 * - Positions are session-only component state keyed by card id, in layout
 *   coordinates (the pointer delta divided by the current zoom). An optional
 *   `clamp(id, pos)` keeps a card inside its region. `reset()` restores the
 *   computed layout.
 * - The card press does NOT stopPropagation (a document-level popover close
 *   must still hear it); the viewport's `panIgnoreSelector` keeps the canvas
 *   from panning under a card instead.
 *
 * The consumer composes this with useDiagramViewport on the container:
 * `onPointerMove = e => drag.onPointerMove(e) || pan.onPointerMove(e)`.
 */

import { useCallback, useRef, useState, type PointerEvent } from "react";

import type { Point } from "./geometry";

export const DRAG_THRESHOLD_PX = 4;

export type CardPositions = Readonly<Record<string, Point>>;

export interface CardDragOptions {
  /** The current view zoom: a screen delta is divided by it. */
  readonly zoom: number;
  /** Keep a dragged card where it may go (e.g. inside its section). */
  readonly clamp?: (id: string, pos: Point) => Point;
  /** Fired once when a press crosses the threshold and becomes a drag. */
  readonly onDragStart?: () => void;
}

export interface CardDrag {
  readonly positions: CardPositions;
  readonly hasMoved: boolean;
  /** Call from a card's onPointerDown with the card's current top-left. */
  readonly onCardPointerDown: (e: PointerEvent<Element>, id: string, origin: Point) => void;
  /** Call from the container's onPointerMove; true when a card drag owns the gesture. */
  readonly onPointerMove: (e: PointerEvent<Element>) => boolean;
  /** Call from the container's onPointerUp / onPointerCancel. */
  readonly endDrag: (e: PointerEvent<Element>) => void;
  /** True after a press that became a drag, until the next press: swallow that click. */
  readonly wasDragged: () => boolean;
  readonly reset: () => void;
}

interface CardGesture {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly origin: Point;
  readonly base: CardPositions;
}

const NO_POSITIONS: CardPositions = {};

export function useCardDrag({ zoom, clamp, onDragStart }: CardDragOptions): CardDrag {
  const [positions, setPositions] = useState<CardPositions>(NO_POSITIONS);
  const gestureRef = useRef<CardGesture | null>(null);
  const movedRef = useRef(false);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  const endDrag = useCallback((e: PointerEvent<Element>) => {
    if (gestureRef.current === null) return;
    gestureRef.current = null;
    if (!movedRef.current) return;
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // An unknown pointer id is harmless.
    }
  }, []);

  const onCardPointerDown = (e: PointerEvent<Element>, id: string, origin: Point) => {
    if (e.button !== 0) return;
    movedRef.current = false;
    gestureRef.current = { id, x: e.clientX, y: e.clientY, origin, base: positionsRef.current };
  };

  const onPointerMove = (e: PointerEvent<Element>): boolean => {
    const g = gestureRef.current;
    if (g === null) return false;
    if ((e.buttons & 1) === 0) {
      endDrag(e);
      return true;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!movedRef.current) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return true;
      movedRef.current = true;
      onDragStart?.();
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // As above.
      }
    }
    const k = zoom > 0 ? zoom : 1;
    const raw = { x: g.origin.x + dx / k, y: g.origin.y + dy / k };
    const next = clamp === undefined ? raw : clamp(g.id, raw);
    setPositions({ ...g.base, [g.id]: next });
    return true;
  };

  const wasDragged = useCallback(() => movedRef.current, []);
  const reset = useCallback(() => setPositions(NO_POSITIONS), []);

  return {
    positions,
    hasMoved: Object.keys(positions).length > 0,
    onCardPointerDown,
    onPointerMove,
    endDrag,
    wasDragged,
    reset,
  };
}
