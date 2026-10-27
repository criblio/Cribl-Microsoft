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
 * - no stage bands or sections, so a dragged card needs no corridor clamp;
 *   {@link applyPositions} only keeps it off negative coordinates. It is the
 *   ONE seam the canvas's card drag (AZR-20, the standard's "Movable cards")
 *   feeds.
 */

import Dagre from "@dagrejs/dagre";

import {
  CARD_LINE_CHARS,
  LABEL_CHARS_PER_LINE,
  LABEL_MAX_LINES,
  MAX_ZOOM,
  MIN_LEGIBLE_ZOOM,
  MIN_ZOOM,
  clampZoom,
  edgePath,
  fit,
  fitLine,
  wrapText,
  type Point,
} from "../../components/diagram/geometry";
import type { DiagramGraph } from "./logging-map-state";

/*
 * The pure geometry (fitLine, wrapText, edgePath, clampZoom, fit and their
 * constants and types) moved to components/diagram/geometry.ts so every
 * hand-SVG diagram shares it (AZR-30). The functions and constants are
 * re-exported here unchanged, so the canvas imports from this module as
 * before; the types are not, since nothing imported them from here - take
 * them from components/diagram/geometry.
 */
export {
  CARD_LINE_CHARS,
  LABEL_CHARS_PER_LINE,
  LABEL_MAX_LINES,
  MAX_ZOOM,
  MIN_LEGIBLE_ZOOM,
  MIN_ZOOM,
  clampZoom,
  edgePath,
  fit,
  fitLine,
  wrapText,
};

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

/** Card height for its wrapped name and the chips it draws (capped at {@link MAX_CHIPS} rows). */
export function nodeHeight(labelLines: number, chipCount: number): number {
  const chips = Math.min(chipCount, MAX_CHIPS);
  return PAD_Y * 2 + HEADER_H + labelLines * LABEL_LINE_H + META_H
    + (chips > 0 ? chips * (CHIP_H + CHIP_GAP) : 0);
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

/** Hand-placed card positions (top-left corner), keyed by card id. Session state, never config. */
export type NodePositions = Readonly<Record<string, Point>>;

/**
 * The computed layout with hand-placed cards applied. THE SEAM the canvas's
 * card drag feeds (see the header). A moved card's edges drop
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
