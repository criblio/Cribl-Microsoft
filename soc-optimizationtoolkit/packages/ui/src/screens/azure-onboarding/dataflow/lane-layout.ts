/**
 * lane-layout - the pure geometry of the onboarding dataflow diagram (AZR-30).
 * No DOM, no React, no clock. This is a LAYOUT, not a canvas: rendering, the
 * viewport, the (i) popover and drag come from components/diagram (G2).
 *
 * The house standard's "section per flow" alternative (claude-kit standards/
 * cribl-dataflow-diagram.md, "Alternative layout - section per flow"):
 *
 * - ONE SECTION PER LANE, stacked top to bottom; each lane (one chosen source,
 *   built by @soc/core buildOnboardingLanes) reads left to right.
 * - COLUMNS ARE PINNED BY CARD KIND and line up across sections, so a stage
 *   reads down the page as well as along each flow (the Cribl source card has
 *   the same x in every section). A kind no lane draws takes no column.
 * - SHARED OBJECTS ARE DRAWN ONCE PER SECTION: two lanes on one Event Hub
 *   namespace each draw their own transport card, carrying the one shared
 *   status the core computed (D14). No edge ever leaves its section.
 * - STEP CARDS (Azure side only) hang BELOW the main row, in a column just left
 *   of the card they configure. Each step's edge enters its target's left edge
 *   at its own anchor in the lower half, ordered like the stack, so step edges
 *   never cross, touch or run along one another or the main row's edge (which
 *   enters at mid-height).
 *
 * Every edge is a left-to-right S-curve drawn with {@link edgePathLR}. The
 * column gap is wider than twice edgePathLR's minimum control offset, so each
 * curve stays monotone in x between its two columns.
 *
 * {@link clampToSection} is the clamp G2's useCardDrag calls: a dragged card
 * stays inside its own section. {@link relayoutEdges} redraws the edges for
 * dragged positions; with no positions it returns the computed layout.
 */

import type { CardStatus, DataflowPerspective, EdgeFlow, LaneCard, LaneCardKind, OnboardingLane } from "@soc/core";

import { edgePathLR, fitLine, wrapText, type Box, type Point } from "../../../components/diagram";

export const LANE_CARD_WIDTH = 200;
/** Horizontal gap between columns. Must exceed 36 (2 x edgePathLR's 18px minimum offset). */
export const LANE_COLUMN_GAP = 72;
export const SECTION_PAD = 16;
export const SECTION_CAPTION_HEIGHT = 30;
export const SECTION_GAP = 16;
/** Vertical gap between the main row and the first step card, and between step cards. */
export const STEP_GAP = 14;
export const TITLE_MAX_LINES = 2;
export const FACT_MAX_LINES = 3;

const CARD_PAD_Y = 10;
const TITLE_LINE_H = 16;
const STATUS_LINE_H = 18;
const FACT_LINE_H = 14;

/**
 * The column a card is pinned to. Step cards take the column just left of
 * the card they configure.
 */
export type LaneColumn = "emitter-steps" | "transport-steps" | Exclude<LaneCardKind, "step">;

/** Every column, in left-to-right order. Only the columns some card uses are laid out. */
export const COLUMN_ORDER: readonly LaneColumn[] = [
  "emitter-steps",
  "emitter",
  "transport-steps",
  "transport",
  "azure-folded",
  "cribl-folded",
  "cribl-source",
  "route",
  "destination",
];

export interface LaidCard extends Box {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: LaneCardKind;
  readonly column: LaneColumn;
  readonly titleLines: readonly string[];
  readonly statusLine: string;
  readonly status: CardStatus;
  readonly factLines: readonly string[];
  /** The core card: full text, (i) text, tick, sharedId. */
  readonly card: LaneCard;
}

export interface LaidEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "data" | "configures";
  readonly flow: EdgeFlow;
  readonly animated: boolean;
  /** Where on the source card's right edge (fraction of its height) the edge leaves. */
  readonly fromFrac: number;
  /** Where on the target card's left edge (fraction of its height) the edge enters. */
  readonly toFrac: number;
  readonly start: Point;
  readonly end: Point;
  /** The SVG path, from {@link edgePathLR}. */
  readonly d: string;
}

export interface LaidSection extends Box {
  readonly sourceId: string;
  readonly title: string;
  /** Baseline of the caption text, inside the section's top band. */
  readonly captionY: number;
}

export interface LaneLayout {
  readonly perspective: DataflowPerspective;
  readonly columns: readonly LaneColumn[];
  readonly sections: readonly LaidSection[];
  readonly cards: readonly LaidCard[];
  readonly edges: readonly LaidEdge[];
  readonly width: number;
  readonly height: number;
}

interface CardText {
  readonly titleLines: readonly string[];
  readonly statusLine: string;
  readonly factLines: readonly string[];
}

function cardText(card: LaneCard): CardText {
  const titleLines = wrapText(card.title, 24, TITLE_MAX_LINES).lines;
  const facts = card.facts.map((f) => fitLine(f));
  const factLines =
    facts.length <= FACT_MAX_LINES
      ? facts
      : [...facts.slice(0, FACT_MAX_LINES - 1), `+${facts.length - (FACT_MAX_LINES - 1)} more (see the i)`];
  return { titleLines, statusLine: fitLine(card.status.label), factLines };
}

function textHeight(t: CardText): number {
  return CARD_PAD_Y * 2 + t.titleLines.length * TITLE_LINE_H + STATUS_LINE_H + t.factLines.length * FACT_LINE_H;
}

/** The column of a step card: left of the card its `configures` edge targets. */
function stepColumn(lane: OnboardingLane, card: LaneCard): LaneColumn {
  const edge = lane.edges.find((e) => e.kind === "configures" && e.from === card.id);
  const target = edge === undefined ? undefined : lane.cards.find((c) => c.id === edge.to);
  return target?.kind === "transport" ? "transport-steps" : "emitter-steps";
}

function columnOf(lane: OnboardingLane, card: LaneCard): LaneColumn {
  return card.kind === "step" ? stepColumn(lane, card) : card.kind;
}

function edgeGeometry(from: Box, to: Box, fromFrac: number, toFrac: number): { start: Point; end: Point; d: string } {
  // edgePathLR anchors at mid-height; a zero-height box at the anchor line
  // places the end exactly where the fraction says.
  const fromAnchor: Box = { x: from.x, y: from.y + from.height * fromFrac, width: from.width, height: 0 };
  const toAnchor: Box = { x: to.x, y: to.y + to.height * toFrac, width: to.width, height: 0 };
  return {
    start: { x: fromAnchor.x + fromAnchor.width, y: fromAnchor.y },
    end: { x: toAnchor.x, y: toAnchor.y },
    d: edgePathLR(fromAnchor, toAnchor),
  };
}

function drawEdges(cards: readonly LaidCard[], edges: readonly LaidEdge[]): LaidEdge[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: LaidEdge[] = [];
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from === undefined || to === undefined) continue;
    out.push({ ...e, ...edgeGeometry(from, to, e.fromFrac, e.toFrac) });
  }
  return out;
}

/**
 * Lay the lanes out: one section per lane, columns pinned by card kind and
 * aligned across sections, step cards stacked below the main row.
 */
export function layoutLanes(lanes: readonly OnboardingLane[], perspective: DataflowPerspective): LaneLayout {
  const used = new Set<LaneColumn>();
  for (const lane of lanes) for (const card of lane.cards) used.add(columnOf(lane, card));
  const columns = COLUMN_ORDER.filter((c) => used.has(c));
  const columnX = new Map<LaneColumn, number>();
  columns.forEach((c, i) => columnX.set(c, SECTION_PAD + i * (LANE_CARD_WIDTH + LANE_COLUMN_GAP)));
  if (lanes.length === 0) {
    return { perspective, columns, sections: [], cards: [], edges: [], width: 0, height: 0 };
  }
  const width = SECTION_PAD * 2 + columns.length * LANE_CARD_WIDTH + (columns.length - 1) * LANE_COLUMN_GAP;

  // One card height for the whole diagram, so every main-row edge is straight.
  let cardHeight = 0;
  const texts = new Map<string, CardText>();
  for (const lane of lanes) {
    for (const card of lane.cards) {
      const t = cardText(card);
      texts.set(card.id, t);
      cardHeight = Math.max(cardHeight, textHeight(t));
    }
  }

  const sections: LaidSection[] = [];
  const cards: LaidCard[] = [];
  const pending: LaidEdge[] = [];
  let top = 0;
  for (const lane of lanes) {
    const mainY = top + SECTION_CAPTION_HEIGHT;
    const stackDepth = new Map<LaneColumn, number>();
    let bottom = mainY + cardHeight;
    for (const card of lane.cards) {
      const column = columnOf(lane, card);
      let y = mainY;
      if (card.kind === "step") {
        const depth = stackDepth.get(column) ?? 0;
        stackDepth.set(column, depth + 1);
        y = mainY + cardHeight + STEP_GAP + depth * (cardHeight + STEP_GAP);
      }
      bottom = Math.max(bottom, y + cardHeight);
      const t = texts.get(card.id) as CardText;
      cards.push({
        id: card.id,
        sourceId: lane.sourceId,
        kind: card.kind,
        column,
        x: columnX.get(column) as number,
        y,
        width: LANE_CARD_WIDTH,
        height: cardHeight,
        titleLines: t.titleLines,
        statusLine: t.statusLine,
        status: card.status,
        factLines: t.factLines,
        card,
      });
    }
    const height = bottom + SECTION_PAD - top;
    sections.push({ sourceId: lane.sourceId, title: lane.title, x: 0, y: top, width, height, captionY: top + 20 });

    // Step edges enter their target at distinct anchors in its lower half,
    // ordered like the stack; data edges use mid-height on both ends.
    const stepsByTarget = new Map<string, string[]>();
    for (const e of lane.edges) {
      if (e.kind !== "configures") continue;
      stepsByTarget.set(e.to, [...(stepsByTarget.get(e.to) ?? []), e.from]);
    }
    for (const e of lane.edges) {
      let toFrac = 0.5;
      if (e.kind === "configures") {
        const list = stepsByTarget.get(e.to) ?? [];
        toFrac = 0.5 + (0.5 * (list.indexOf(e.from) + 1)) / (list.length + 1);
      }
      pending.push({
        id: e.id,
        sourceId: lane.sourceId,
        from: e.from,
        to: e.to,
        kind: e.kind,
        flow: e.flow,
        animated: e.animated,
        fromFrac: 0.5,
        toFrac,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        d: "",
      });
    }
    top += height + SECTION_GAP;
  }

  return {
    perspective,
    columns,
    sections,
    cards,
    edges: drawEdges(cards, pending),
    width,
    height: top - SECTION_GAP,
  };
}

/**
 * Keep a dragged card inside its own section (below the caption, inside the
 * padding). An unknown card id returns `pos` unchanged.
 */
export function clampToSection(layout: LaneLayout, cardId: string, pos: Point): Point {
  const card = layout.cards.find((c) => c.id === cardId);
  if (card === undefined) return pos;
  const section = layout.sections.find((s) => s.sourceId === card.sourceId);
  if (section === undefined) return pos;
  const minX = section.x + SECTION_PAD;
  const maxX = section.x + section.width - SECTION_PAD - card.width;
  const minY = section.y + SECTION_CAPTION_HEIGHT;
  const maxY = section.y + section.height - SECTION_PAD - card.height;
  return {
    x: Math.min(Math.max(pos.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(pos.y, minY), Math.max(minY, maxY)),
  };
}

/**
 * The layout with dragged cards moved to `positions` (top-left, layout
 * coordinates, keyed by card id) and every edge redrawn between the cards'
 * side anchors. Empty positions return a layout equal to the computed one.
 */
export function relayoutEdges(layout: LaneLayout, positions: Readonly<Record<string, Point>>): LaneLayout {
  const cards = layout.cards.map((c) => {
    const p = positions[c.id];
    return p === undefined ? c : { ...c, x: p.x, y: p.y };
  });
  return { ...layout, cards, edges: drawEdges(cards, layout.edges) };
}
