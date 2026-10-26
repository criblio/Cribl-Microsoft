/**
 * logging-map-layout - the geometry of the Azure Logging Map canvas (AZR-19).
 * Pure JS, no DOM: the canvas consumes coordinates only.
 *
 * Ported from the claude-kit cribl-dataflow-diagram reference `layout.ts`
 * (wrapText, fitLine, nodeHeight, edgeAnchors, edgePath, applyPositions),
 * MINUS what a hierarchy does not need: the pinned stage ranker, stage bands,
 * corridors, measured-flow lines and animation. Differences, on purpose:
 * - dagre rankdir is TB (top to bottom), because the management-group tree is
 *   a hierarchy, not a left-to-right flow; edges therefore anchor bottom-mid
 *   of the parent to top-mid of the child;
 * - a collapsed group is ONE count card (built by `diagramGraph` in
 *   logging-map-state.ts), not its hidden children;
 * - NO DRAG in phase 1: the approved mockup's interaction model has zoom, fit,
 *   collapse, outline and trace, and no drag. That deviates from the house
 *   standard (standards/cribl-dataflow-diagram.md, "Movable cards"), and the
 *   choice is a recorded decision card. {@link applyPositions} is kept as the
 *   ONE seam hand-placed positions would feed, so adding drag stays local.
 */

import Dagre from "@dagrejs/dagre";

import type { DiagramGraph } from "./logging-map-state";

export const NODE_W = 200;
const PAD_Y = 8;
/** The kind header strip ("MANAGEMENT GROUP"). */
const HEADER_H = 20;
export const LABEL_LINE_H = 15;
/** The id / note line under the name. */
const META_H = 14;
export const CHIP_H = 18;
export const CHIP_GAP = 4;
/** Chips drawn on one card; past it the last row reads "+N more". */
export const MAX_CHIPS = 4;
export const LABEL_CHARS_PER_LINE = 24;
/** Small one-line text on a card: ~30 characters fit the 200px card. */
export const CARD_LINE_CHARS = 30;
export const LABEL_MAX_LINES = 3;

/** Card geometry the renderer shares with the layout, so text lands where height was reserved. */
export const CARD = {
  padY: PAD_Y,
  headerH: HEADER_H,
  lineH: LABEL_LINE_H,
  metaH: META_H,
  chipH: CHIP_H,
  chipGap: CHIP_GAP,
} as const;

const NODE_SEP = 22;
const RANK_SEP = 48;
const MARGIN = 24;

/** Zoom limits: Fit never goes below the legible floor; manual zoom may. */
export const MIN_LEGIBLE_ZOOM = 0.55;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;

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

/** Card height for its wrapped name and the chips it draws (capped at {@link MAX_CHIPS} rows). */
export function nodeHeight(labelLines: number, chipCount: number): number {
  const chips = Math.min(chipCount, MAX_CHIPS);
  return PAD_Y * 2 + HEADER_H + labelLines * LABEL_LINE_H + META_H
    + (chips > 0 ? chips * (CHIP_H + CHIP_GAP) : 0);
}

export interface Point {
  x: number;
  y: number;
}

export interface LaidOutCard {
  readonly id: string;
  readonly kind: "scope" | "count";
  readonly scopeId: string;
  readonly title: string;
  readonly chipCount: number;
  /** Top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly labelLines: readonly string[];
  readonly labelOverflow: boolean;
}

export interface LaidOutEdge {
  readonly from: string;
  readonly to: string;
  /** Dagre's routed waypoints; empty after a card was moved (re-drawn between anchors). */
  readonly points: readonly Point[];
}

export interface LaidOutMap {
  readonly cards: readonly LaidOutCard[];
  readonly edges: readonly LaidOutEdge[];
  readonly width: number;
  readonly height: number;
}

/** Lay the diagram out top to bottom. Deterministic for the same input. */
export function layoutLoggingMap(graph: DiagramGraph): LaidOutMap {
  if (graph.cards.length === 0) return { cards: [], edges: [], width: 0, height: 0 };
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });

  const wrapped = new Map(graph.cards.map((c) => [c.id, wrapText(c.title)]));
  const heightOf = (id: string, chips: number): number => nodeHeight(wrapped.get(id)?.lines.length ?? 1, chips);
  const ids = new Set(graph.cards.map((c) => c.id));
  for (const c of graph.cards) g.setNode(c.id, { width: NODE_W, height: heightOf(c.id, c.chipCount) });
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  for (const e of edges) g.setEdge(e.from, e.to);

  Dagre.layout(g);

  const cards: LaidOutCard[] = graph.cards.map((c) => {
    const p = g.node(c.id) as { x?: number; y?: number } | undefined;
    const h = heightOf(c.id, c.chipCount);
    const wrap = wrapped.get(c.id) ?? { lines: [c.title], overflow: false };
    return {
      id: c.id,
      kind: c.kind,
      scopeId: c.scopeId,
      title: c.title,
      chipCount: c.chipCount,
      x: (p?.x ?? 0) - NODE_W / 2,
      y: (p?.y ?? 0) - h / 2,
      width: NODE_W,
      height: h,
      labelLines: wrap.lines,
      labelOverflow: wrap.overflow,
    };
  });
  const laidEdges: LaidOutEdge[] = edges.map((e) => {
    const routed = (g.edge({ v: e.from, w: e.to }) as { points?: Point[] } | undefined)?.points ?? [];
    return { from: e.from, to: e.to, points: routed.map((p) => ({ x: p.x, y: p.y })) };
  });
  const size = g.graph() as { width?: number; height?: number };
  return { cards, edges: laidEdges, width: size.width ?? 0, height: size.height ?? 0 };
}

/** Edge endpoints for a top-to-bottom tree: the parent's bottom mid to the child's top mid. */
export function edgeAnchors(from: LaidOutCard, to: LaidOutCard): { start: Point; end: Point } {
  return {
    start: { x: from.x + from.width / 2, y: from.y + from.height },
    end: { x: to.x + to.width / 2, y: to.y },
  };
}

/**
 * SVG path through dagre's routed waypoints, anchored to each card's own
 * bottom / top middle and smoothed at the corners. Dagre's first and last
 * points sit on the card boundary; they are replaced with the anchors.
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

/** Hand-placed card positions (top-left corner), keyed by card id. Session state, never config. */
export type NodePositions = Readonly<Record<string, Point>>;

/**
 * The computed layout with hand-placed cards applied. THE SEAM drag would
 * feed (phase 1 has no drag - see the header). A moved card's edges drop
 * dagre's waypoints and are re-drawn between the cards' anchors; positions
 * are clamped to the margin so nothing is drawn at negative coordinates;
 * ids not in the layout are ignored, so positions survive a re-read that
 * drops a card.
 */
export function applyPositions(laid: LaidOutMap, positions: NodePositions | undefined): LaidOutMap {
  if (!positions) return laid;
  const moved = new Set<string>();
  const cards = laid.cards.map((c) => {
    const p = positions[c.id];
    if (!p) return c;
    const x = Math.max(MARGIN / 2, p.x);
    const y = Math.max(MARGIN / 2, p.y);
    if (x === c.x && y === c.y) return c;
    moved.add(c.id);
    return { ...c, x, y };
  });
  if (moved.size === 0) return laid;
  const edges = laid.edges.map((e) =>
    moved.has(e.from) || moved.has(e.to) ? { ...e, points: [] } : e,
  );
  const right = Math.max(...cards.map((c) => c.x + c.width));
  const bottom = Math.max(...cards.map((c) => c.y + c.height));
  return {
    cards,
    edges,
    width: Math.max(laid.width, right + MARGIN),
    height: Math.max(laid.height, bottom + MARGIN),
  };
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

/**
 * Fit the layout into the viewport, never below {@link MIN_LEGIBLE_ZOOM}
 * (an unreadable whole tree is worse than a readable part of it) and never
 * above 1 (a small tree is not blown up). When the tree does not fit at that
 * floor, the view pans so the first root card is centred horizontally at the
 * top - the operator starts where the hierarchy starts. Otherwise the tree is
 * centred.
 */
export function fit(laid: LaidOutMap, viewport: Viewport): ViewTransform {
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
    const first = laid.cards[0] as LaidOutCard;
    const centre = (first.x + first.width / 2) * zoom;
    // Centre the first root, but never pan past either edge of the content.
    panX = Math.min(0, Math.max(viewport.width - w, viewport.width / 2 - centre));
  }
  const panY = h <= viewport.height ? (viewport.height - h) / 2 : 0;
  return { zoom, panX, panY };
}
