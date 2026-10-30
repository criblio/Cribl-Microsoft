/**
 * useDiagramViewport - the pan / zoom / fit viewport every hand-SVG diagram
 * in this package shares (AZR-30). One engine, so the Azure Logging Map and
 * the onboarding dataflow cannot drift apart on how a canvas moves.
 *
 * Ported from the claude-kit cribl-dataflow-diagram reference
 * `FlowDiagram.tsx` (transform state, zoomBy around an origin, wheel zoom,
 * thresholded pan with deferred pointer capture, a missed release ends the
 * gesture) and from screens/azure-logging-map/logging-map-canvas.tsx, where
 * this code lived first (its view state, zoomBy, onWheel and empty-canvas pan).
 *
 * - Pan starts only after the pointer travels {@link PAN_THRESHOLD_PX}; below
 *   that a press is a click. Pointer capture is deferred to that moment:
 *   capturing on pointer-down retargets the click and swallows selection.
 * - A press landing inside `panIgnoreSelector` (cards, their (i), the
 *   popover) starts no pan. The canvas does NOT stopPropagation, so a
 *   document-level outside-pointerdown close still hears every press.
 * - Fit uses geometry.fit, which floors the zoom at the legible 0.55.
 * - `onViewChange` fires on every zoom, wheel, fit and pan start, so a
 *   popover anchored to a card closes instead of floating off it.
 *
 * The consumer owns WHEN to re-fit (usually an effect on its own layout).
 */

import { useCallback, useRef, useState, type PointerEvent, type RefObject, type WheelEvent } from "react";

import { clampZoom, fit as fitLayout, type FitLayout } from "./geometry";

export const ZOOM_STEP = 1.2;
export const WHEEL_STEP = 1.12;
export const PAN_THRESHOLD_PX = 4;

export interface DiagramView {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export interface DiagramViewportOptions {
  /** The layout Fit measures; the latest value is always used. */
  readonly layout: FitLayout;
  /** Fired on zoom, wheel, fit and the start of a pan. */
  readonly onViewChange?: () => void;
  /** A press inside an element matching this selector starts no pan. */
  readonly panIgnoreSelector?: string;
}

export interface DiagramPanHandlers {
  readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
}

export interface DiagramViewport {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly view: DiagramView;
  /** The SVG transform attribute for the viewport group. */
  readonly transform: string;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  /** Fit the latest `layout` into the container. Stable across renders. */
  readonly fit: () => void;
  /** Fit a given layout into the container. Stable across renders. */
  readonly fitTo: (layout: FitLayout) => void;
  readonly onWheel: (e: WheelEvent<HTMLElement>) => void;
  readonly panHandlers: DiagramPanHandlers;
}

interface PanGesture {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  moved: boolean;
}

function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture?.(pointerId);
  } catch {
    // An unknown pointer id (synthetic events, a pointer already gone) is harmless.
  }
}

function release(el: Element, pointerId: number): void {
  try {
    if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
  } catch {
    // As above.
  }
}

export function useDiagramViewport({ layout, onViewChange, panIgnoreSelector }: DiagramViewportOptions): DiagramViewport {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<DiagramView>({ x: 0, y: 0, k: 1 });
  const panRef = useRef<PanGesture | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const changeRef = useRef(onViewChange);
  changeRef.current = onViewChange;
  const viewRef = useRef(view);
  viewRef.current = view;

  const notify = useCallback(() => changeRef.current?.(), []);

  const fitTo = useCallback(
    (target: FitLayout) => {
      const el = containerRef.current;
      const t = fitLayout(target, { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 });
      notify();
      setView({ x: t.panX, y: t.panY, k: t.zoom });
    },
    [notify],
  );
  const fit = useCallback(() => fitTo(layoutRef.current), [fitTo]);

  const zoomBy = useCallback((factor: number, origin?: { x: number; y: number }) => {
    setView((prev) => {
      const k = clampZoom(prev.k * factor);
      if (origin === undefined) return { ...prev, k };
      const r = k / prev.k;
      return { k, x: origin.x - (origin.x - prev.x) * r, y: origin.y - (origin.y - prev.y) * r };
    });
  }, []);

  const zoomIn = useCallback(() => {
    notify();
    zoomBy(ZOOM_STEP);
  }, [notify, zoomBy]);
  const zoomOut = useCallback(() => {
    notify();
    zoomBy(1 / ZOOM_STEP);
  }, [notify, zoomBy]);

  const onWheel = (e: WheelEvent<HTMLElement>) => {
    notify();
    const rect = containerRef.current?.getBoundingClientRect();
    const origin = rect === undefined ? undefined : { x: e.clientX - rect.left, y: e.clientY - rect.top };
    zoomBy(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, origin);
  };

  const endPan = (e: PointerEvent<HTMLElement>) => {
    const pan = panRef.current;
    panRef.current = null;
    if (pan?.moved === true) release(e.currentTarget, e.pointerId);
  };

  const panHandlers: DiagramPanHandlers = {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (panIgnoreSelector !== undefined && target?.closest?.(panIgnoreSelector)) return;
      const v = viewRef.current;
      panRef.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false };
    },
    onPointerMove: (e) => {
      const pan = panRef.current;
      if (pan === null) return;
      // The release was missed (outside the canvas or the iframe): end the
      // gesture rather than let the view follow a pointer with no button down.
      if ((e.buttons & 1) === 0) {
        endPan(e);
        return;
      }
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!pan.moved) {
        if (Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
        pan.moved = true;
        notify();
        capture(e.currentTarget, e.pointerId);
      }
      setView((prev) => ({ ...prev, x: pan.vx + dx, y: pan.vy + dy }));
    },
    onPointerUp: endPan,
    onPointerCancel: endPan,
  };

  return {
    containerRef,
    view,
    transform: `translate(${view.x} ${view.y}) scale(${view.k})`,
    zoomIn,
    zoomOut,
    fit,
    fitTo,
    onWheel,
    panHandlers,
  };
}
