/**
 * diagram geometry - the pure, shell-agnostic geometry every hand-SVG diagram
 * in this package shares (AZR-30). No DOM, no React, no clock.
 *
 * Lifted UNCHANGED from the Azure Logging Map (screens/azure-logging-map/
 * logging-map-layout.ts, which re-exports these names so its callers and pins
 * are untouched), itself ported from the claude-kit cribl-dataflow-diagram
 * reference `layout.ts`. One addition: {@link edgePathLR}, the left-to-right
 * edge a dataflow (emitter -> transport -> source -> route -> destination)
 * draws, where the logging map's tree draws top to bottom.
 *
 * {@link fit} is typed against the minimal {@link FitLayout} shape it reads,
 * so any layout with cards, a width and a height can use it.
 */

/** Small one-line text on a card: ~30 characters fit a 200px card. */
export const CARD_LINE_CHARS = 30;
export const LABEL_CHARS_PER_LINE = 24;
export const LABEL_MAX_LINES = 3;

/** Zoom limits: Fit never goes below the legible floor; manual zoom may. */
export const MIN_LEGIBLE_ZOOM = 0.55;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;

export interface Point {
  x: number;
  y: number;
}

export interface Wrapped {
  lines: string[];
  overflow: boolean;
}

/**
 * One card line, ellipsised past `max` characters. The full text belongs in
 * the popover - never let it run past the card edge.
 */
export function fitLine(text: string, max = CARD_LINE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Wrap a name on `_ - . /` and whitespace, hard-splitting a token longer than
 * a line. Past `maxLines`, the last line ends in an ellipsis and `overflow`
 * is set.
 */
export function wrapText(text: string, perLine = LABEL_CHARS_PER_LINE, maxLines = LABEL_MAX_LINES): Wrapped {
  const tokens = text.split(/(?<=[_\-./\s])/);
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (current.length + token.length <= perLine) {
      current += token;
      continue;
    }
    if (current) lines.push(current);
    let rest = token;
    while (rest.length > perLine) {
      lines.push(rest.slice(0, perLine));
      rest = rest.slice(perLine);
    }
    current = rest;
  }
  if (current) lines.push(current);
  if (lines.length === 0) lines.push("");
  if (lines.length <= maxLines) return { lines, overflow: false };
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, perLine - 1)).trimEnd()}…`;
  return { lines: kept, overflow: true };
}

/**
 * SVG path through routed waypoints, anchored to each card's own
 * bottom / top middle and smoothed at the corners. The first and last
 * points sit on the card boundary; they are replaced with the anchors.
 * With no inner waypoints it is a vertical S-curve (top to bottom).
 */
export function edgePath(points: readonly Point[], start: Point, end: Point): string {
  const inner = points.slice(1, -1);
  const pts = [start, ...inner, end];
  if (pts.length === 2) {
    const dy = Math.max(18, Math.abs(end.y - start.y) / 2);
    return `M ${start.x} ${start.y} C ${start.x} ${start.y + dy}, ${end.x} ${end.y - dy}, ${end.x} ${end.y}`;
  }
  let d = `M ${start.x} ${start.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i] as Point;
    const q = pts[i + 1] as Point;
    d += ` Q ${p.x} ${p.y}, ${(p.x + q.x) / 2} ${(p.y + q.y) / 2}`;
  }
  d += ` L ${end.x} ${end.y}`;
  return d;
}

/** A card's box: top-left corner plus size. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Left-to-right edge between two cards: from the right edge mid-height of
 * `from` to the left edge mid-height of `to`, as a horizontal S-curve. A
 * dataflow reads left to right, so its edges leave and enter cards sideways.
 */
export function edgePathLR(from: Box, to: Box): string {
  const sx = from.x + from.width;
  const sy = from.y + from.height / 2;
  const ex = to.x;
  const ey = to.y + to.height / 2;
  const dx = Math.max(18, Math.abs(ex - sx) / 2);
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
}

/** Clamp a manual zoom to [{@link MIN_ZOOM}, {@link MAX_ZOOM}]. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** A view transform: screen = content * zoom + pan. */
export interface ViewTransform {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

/** The minimal layout shape {@link fit} reads. */
export interface FitLayout {
  readonly cards: readonly { readonly x: number; readonly width: number }[];
  readonly width: number;
  readonly height: number;
}

/**
 * Fit the layout into the viewport, never below {@link MIN_LEGIBLE_ZOOM}
 * (an unreadable whole diagram is worse than a readable part of it) and never
 * above 1 (a small diagram is not blown up). When the layout does not fit at
 * that floor, the view pans so the first card is centred horizontally at the
 * top - the operator starts where the diagram starts. Otherwise it is centred.
 */
export function fit(laid: FitLayout, viewport: Viewport): ViewTransform {
  if (laid.cards.length === 0 || laid.width <= 0 || laid.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const raw = Math.min(viewport.width / laid.width, viewport.height / laid.height, 1);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_LEGIBLE_ZOOM, raw));
  const w = laid.width * zoom;
  const h = laid.height * zoom;
  let panX: number;
  if (w <= viewport.width) {
    panX = (viewport.width - w) / 2;
  } else {
    const first = laid.cards[0] as { x: number; width: number };
    const centre = (first.x + first.width / 2) * zoom;
    // Centre the first card, but never pan past either edge of the content.
    panX = Math.min(0, Math.max(viewport.width - w, viewport.width / 2 - centre));
  }
  const panY = h <= viewport.height ? (viewport.height - h) / 2 : 0;
  return { zoom, panX, panY };
}
