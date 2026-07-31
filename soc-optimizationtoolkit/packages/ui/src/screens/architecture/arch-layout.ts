/**
 * arch-layout - the renderer-agnostic geometry of the architecture diagram:
 * the dagre left-to-right layout (the EXACT parameters the interactive
 * canvas uses) and the per-node badge derivation, extracted from
 * architecture-flow.tsx so the SVG exporter produces identical coordinates
 * to the on-screen canvas (2026-07-29). Dagre is pure JS - no DOM here.
 */

import Dagre from "@dagrejs/dagre";
import { criblSourceTypeFromLabel } from "@soc/core";
import type {
  DiagramEdge,
  DiagramNodeInfo,
  DiagramTier,
  PatternDiagram,
} from "@soc/core";

export const NODE_W = 190;
export const NODE_H = 62;
/** Extra card height when a node carries source-type tags (2026-07-29). */
export const CHIP_ROW_H = 20;

/**
 * The footprint an edge label occupies in the LAYOUT (declared to dagre so
 * ranks widen only where labels need room). ONE rule shared by the layout,
 * the renderers, and the overlap regression pin: capped at ~two wrapped
 * lines so long labels deepen instead of widening the diagram.
 */
export function edgeLabelFootprint(
  label: string,
  hasCost = false,
): { width: number; height: number } {
  const estimated = label.length * 5.5 + 12;
  return {
    width: Math.min(estimated, 132),
    // The cost badge stacks UNDER the label pill - reserve its row too.
    height: (estimated > 132 ? 30 : 18) + (hasCost ? 14 : 0),
  };
}

/** The tag row a renderer draws: up to three types plus an overflow count. */
export function sourceTypeChips(types: readonly string[]): string[] {
  if (types.length <= 3) {
    return [...types];
  }
  return [...types.slice(0, 3), `+${types.length - 3}`];
}

/** The short tier badge shown above a node's label (non-destination tiers). */
const TIER_BADGE: Record<DiagramTier, string> = {
  source: "Source",
  route: "Route",
  pipeline: "Pipeline",
  cribl: "Cribl",
  azure: "Azure",
  destination: "Destination",
};

/**
 * The badge for one node. The destination COLUMN hosts more than Sentinel -
 * Cribl Lake, ADX, downstream consumers (user report 2026-07-29: a card read
 * "SENTINEL / Cribl Lake") - so destination badges derive from the label;
 * the other tiers keep their fixed badge.
 */
export function nodeBadge(label: string, tier: DiagramTier): string {
  if (tier !== "destination") {
    return TIER_BADGE[tier];
  }
  const lower = label.toLowerCase();
  if (lower.includes("sentinel")) {
    return "Sentinel";
  }
  if (lower.includes("cribl")) {
    return "Cribl";
  }
  if (
    lower.includes("azure") ||
    lower.includes("data explorer") ||
    lower.includes("log analytics")
  ) {
    return "Azure";
  }
  return TIER_BADGE.destination;
}

/** One laid-out node: top-left position plus the drawing facts. */
export interface LaidOutNode {
  id: string;
  label: string;
  tier: DiagramTier;
  x: number;
  y: number;
  /** Card height: NODE_H, plus the tag row when sourceTypes is non-empty. */
  height: number;
  /** The Cribl source types feeding this node (from its ingress edges). */
  sourceTypes: string[];
  /** Per-node info override (live diagrams); catalog nodes resolve by label. */
  info?: DiagramNodeInfo;
  /** Card badge override (live stage/type captions). */
  badge?: string;
  /** Service tags overlapping the bottom-right corner (e.g. Sentinel). */
  overlays?: readonly string[];
  /** The card offers an explode/collapse toggle (pack internals). */
  expandable?: boolean;
  expanded?: boolean;
  /** Render subdued (disabled routes in the exploded routing table). */
  muted?: boolean;
}

/** A routed point on an edge's polyline (dagre's node-avoiding waypoints). */
export interface EdgePoint {
  x: number;
  y: number;
}

/**
 * One laid-out edge: the diagram edge plus dagre's ROUTED waypoints. Long
 * edges spanning ranks get virtual-node waypoints that dodge the node
 * columns - renderers that ignore them (the React Flow canvas draws its own
 * smoothstep) simply use from/to.
 */
export interface LaidOutEdge extends DiagramEdge {
  points: EdgePoint[];
  /**
   * Where dagre placed the edge LABEL (labels participate in the layout as
   * virtual nodes, so this spot is clear of cards and other labels). Absent
   * on unlabeled edges.
   */
  labelPoint?: EdgePoint;
  /**
   * The edge crosses serpentine rows (2026-07-30): its points already snake
   * through the row gap, so renderers must NOT treat the right-to-left
   * direction as a wrap-back (no bottom handles, no reverse offsets).
   */
  wrap?: boolean;
}

/**
 * A stage band: a contiguous run of rank columns sharing a dominant tier
 * (Gestalt proximity, 2026-07-30 best-practices pass) - renderers draw a
 * faint captioned background strip so "everything Cribl" reads at a glance.
 * DESCRIPTIVE, derived from the actual layout, never a constraint.
 */
export interface TierBand {
  label: string;
  left: number;
  right: number;
}

/** The laid-out diagram: nodes with positions, routed edges, canvas size. */
export interface LaidOutDiagram {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  /** Stage bands (single-row layouts only - serpentine rows drop them). */
  bands?: TierBand[];
  /** Faint dividers between serpentine rows (y midlines of the gaps). */
  rowDividers?: number[];
}

/** A stable identity for an edge across re-layouts (its endpoint pair). */
export function edgeKey(edge: Pick<DiagramEdge, "from" | "to">): string {
  return `${edge.from}>${edge.to}`;
}

/**
 * The point at half a polyline's total length - the label anchor fallback
 * for unlabeled/cost-only edges, shared by BOTH renderers so their labels
 * sit at identical spots on identical routed paths.
 */
export function polylineMidpoint(points: readonly EdgePoint[]): EdgePoint {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const segment = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
    if (segment >= remaining && segment > 0) {
      const t = remaining / segment;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    remaining -= segment;
  }
  return points[Math.floor(points.length / 2)] ?? points[0];
}

/**
 * The diagram minus the user's removals (2026-07-29: delete parts of a
 * diagram and let it re-layout around what is left). Removing a node also
 * removes every edge touching it; removing an edge leaves its nodes.
 * Unknown ids are ignored. Pure - the canvas re-runs dagre on the result.
 */
export function applyDiagramRemovals(
  diagram: PatternDiagram,
  removedNodeIds: ReadonlySet<string>,
  removedEdgeKeys: ReadonlySet<string>,
): PatternDiagram {
  const nodes = diagram.nodes.filter((n) => !removedNodeIds.has(n.id));
  const kept = new Set(nodes.map((n) => n.id));
  const edges = diagram.edges.filter(
    (e) => kept.has(e.from) && kept.has(e.to) && !removedEdgeKeys.has(edgeKey(e)),
  );
  return { nodes, edges };
}

/** dagre LR layout with the canvas's exact parameters. Long merged chains
 * (the long-term-retention preset spans ~8 ranks) re-lay-out COMPACT when
 * the first pass comes out as an extreme ribbon, and a STILL-extreme
 * ribbon wraps serpentine into rows (2026-07-30 user report: a thin strip
 * with dead bands above and below) so the fitted view uses the window. */
export function layoutDiagram(
  diagram: PatternDiagram,
  /**
   * The canvas's width/height ratio (2026-07-30 best-practices pass): the
   * serpentine wrap folds toward the REAL window shape instead of a
   * constant, so defaults land near "fills the viewport" on any monitor.
   */
  targetAspect = 2.4,
): LaidOutDiagram {
  const first = layoutDiagramWith(diagram, 56, 26);
  // Aspect-driven gates with an absolute floor: a short simple chain reads
  // straight left-to-right even when its ratio is extreme, but a preset
  // merge wider than a typical window compacts, then WRAPS.
  if (first.width <= 1200 || first.width <= 3.4 * first.height) {
    return first;
  }
  const compact = layoutDiagramWith(diagram, 40, 22);
  if (compact.width > 1200 && compact.width > 3.0 * compact.height) {
    return serpentineWrap(compact, targetAspect);
  }
  return compact;
}

/** Cluster laid-out nodes into rank columns by x center (same rank = same
 * center in LR dagre) - shared by the serpentine wrap and the tier bands. */
function clusterColumns(
  nodes: readonly LaidOutNode[],
): Array<{ center: number; left: number; right: number; ids: string[]; tiers: DiagramTier[] }> {
  const sorted = [...nodes].sort(
    (a, b) => a.x + NODE_W / 2 - (b.x + NODE_W / 2),
  );
  const columns: Array<{
    center: number;
    left: number;
    right: number;
    ids: string[];
    tiers: DiagramTier[];
  }> = [];
  for (const node of sorted) {
    const center = node.x + NODE_W / 2;
    const last = columns[columns.length - 1];
    if (last !== undefined && Math.abs(center - last.center) < 8) {
      last.ids.push(node.id);
      last.tiers.push(node.tier);
      last.left = Math.min(last.left, node.x);
      last.right = Math.max(last.right, node.x + NODE_W);
    } else {
      columns.push({
        center,
        left: node.x,
        right: node.x + NODE_W,
        ids: [node.id],
        tiers: [node.tier],
      });
    }
  }
  return columns;
}

const BAND_LABEL: Record<DiagramTier, string> = {
  source: "Sources",
  route: "Routes",
  pipeline: "Pipelines",
  cribl: "Cribl",
  azure: "Azure",
  destination: "Destinations",
};
const TIER_ORDER: DiagramTier[] = [
  "source",
  "route",
  "pipeline",
  "cribl",
  "azure",
  "destination",
];

/** Stage bands from the dominant tier of each rank column; adjacent runs
 * merge, boundaries split the gap between neighbors. Undefined when the
 * diagram does not yield at least two distinct bands. */
function computeTierBands(nodes: readonly LaidOutNode[]): TierBand[] | undefined {
  const columns = clusterColumns(nodes);
  if (columns.length < 2) {
    return undefined;
  }
  const dominant = columns.map((column) => {
    const counts = new Map<DiagramTier, number>();
    for (const tier of column.tiers) {
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }
    let best: DiagramTier = column.tiers[0];
    let bestCount = -1;
    for (const tier of TIER_ORDER) {
      const count = counts.get(tier) ?? 0;
      if (count > bestCount) {
        best = tier;
        bestCount = count;
      }
    }
    return best;
  });
  const bands: TierBand[] = [];
  for (let i = 0; i < columns.length; i++) {
    const label = BAND_LABEL[dominant[i]];
    const last = bands[bands.length - 1];
    if (last !== undefined && last.label === label) {
      last.right = columns[i].right + 8;
    } else {
      bands.push({ label, left: columns[i].left - 8, right: columns[i].right + 8 });
    }
  }
  if (bands.length < 2) {
    return undefined;
  }
  // Neighbors split the gap between them evenly.
  for (let i = 1; i < bands.length; i++) {
    const boundary = (bands[i - 1].right + bands[i].left) / 2;
    bands[i - 1].right = boundary - 3;
    bands[i].left = boundary + 3;
  }
  return bands;
}

/** Vertical clearance between serpentine rows - the cross-row connectors
 * and their labels run through this band. */
const ROW_GAP = 90;

/**
 * Fold an extreme one-row ribbon into 2-3 left-to-right rows. Rank columns
 * stay intact; each row translates RIGIDLY (so every intra-row routed path
 * and reserved label spot stays valid); edges that cross rows get synthetic
 * orthogonal routes through the row gap, staggered so their labels keep
 * clear of each other.
 */
function serpentineWrap(
  laidOut: LaidOutDiagram,
  targetAspect: number,
): LaidOutDiagram {
  // 1. Cluster nodes into rank columns by x center (same rank = same center).
  const columns = clusterColumns(laidOut.nodes);
  if (columns.length < 3) {
    return laidOut;
  }
  const colOfNode = new Map<string, number>();
  columns.forEach((column, i) => {
    for (const id of column.ids) {
      colOfNode.set(id, i);
    }
  });
  // 2. Choose the fold line(s) by MINIMUM EDGE CUT (2026-07-30 user report:
  //    the Splunk migration wrap put Stream a row below its three feeders
  //    and every feed became a crossing). Candidate boundaries must keep
  //    rows reasonably width-balanced; among those, fewest severed edges
  //    wins, aspect distance breaks ties - and if even the best cut severs
  //    too many edges, the graph is BRANCHY, not a chain: stay unwrapped
  //    (a wide clean ribbon beats spaghetti).
  const crossingsFor = (boundaries: number[]): number => {
    const rowOfCol = (ci: number): number =>
      boundaries.filter((b) => ci >= b).length;
    let severed = 0;
    for (const e of laidOut.edges) {
      const a = rowOfCol(colOfNode.get(e.from) ?? 0);
      const b = rowOfCol(colOfNode.get(e.to) ?? 0);
      if (a !== b) {
        severed += 1;
      }
    }
    return severed;
  };
  const spanOf = (fromCol: number, toCol: number): number =>
    columns[toCol].right - columns[fromCol].left;
  interface FoldPlan {
    boundaries: number[];
    crossings: number;
    aspectScore: number;
  }
  // A fold must EARN its row (2026-07-30 user screenshot: a minimum cut
  // that isolated "Log sources" won on crossings while saving no width and
  // wasting a whole band): rows must be genuinely balanced AND the fold
  // must actually shrink the diagram.
  const plans: FoldPlan[] = [];
  for (let b = 1; b < columns.length; b++) {
    const w1 = spanOf(0, b - 1);
    const w2 = spanOf(b, columns.length - 1);
    const maxW = Math.max(w1, w2);
    if (Math.min(w1, w2) < 0.45 * maxW || maxW > 0.75 * laidOut.width) {
      continue;
    }
    plans.push({
      boundaries: [b],
      crossings: crossingsFor([b]),
      aspectScore: Math.abs(maxW / (2 * laidOut.height + ROW_GAP) - targetAspect),
    });
  }
  if (columns.length >= 5) {
    for (let b1 = 1; b1 < columns.length - 1; b1++) {
      for (let b2 = b1 + 1; b2 < columns.length; b2++) {
        const widths = [
          spanOf(0, b1 - 1),
          spanOf(b1, b2 - 1),
          spanOf(b2, columns.length - 1),
        ];
        const maxW = Math.max(...widths);
        if (Math.min(...widths) < 0.32 * maxW || maxW > 0.55 * laidOut.width) {
          continue;
        }
        plans.push({
          boundaries: [b1, b2],
          crossings: crossingsFor([b1, b2]),
          aspectScore: Math.abs(
            maxW / (3 * laidOut.height + 2 * ROW_GAP) - targetAspect,
          ),
        });
      }
    }
  }
  if (plans.length === 0) {
    return laidOut;
  }
  plans.sort(
    (a, b) => a.crossings - b.crossings || a.aspectScore - b.aspectScore,
  );
  const plan = plans[0];
  if (plan.crossings > 5) {
    return laidOut;
  }
  const rows = plan.boundaries.length + 1;
  const rowOfColumn = columns.map(
    (_, i) => plan.boundaries.filter((b) => i >= b).length,
  );
  const rowOfNode = new Map<string, number>();
  const rowDx: number[] = [];
  for (let r = 0; r < rows; r++) {
    const first = columns[rowOfColumn.indexOf(r)];
    rowDx[r] = first !== undefined ? 10 - first.left : 0;
  }
  columns.forEach((column, i) => {
    for (const id of column.ids) {
      rowOfNode.set(id, rowOfColumn[i]);
    }
  });
  // Size each gap band FROM the crossings it must carry (live 2026-07-30:
  // five connectors overflowed a fixed 90px band into the next row's cards).
  const crossBoxHeight = (e: LaidOutEdge): number =>
    e.label !== undefined
      ? edgeLabelFootprint(e.label, e.cost !== undefined).height
      : 12;
  const gapNeed = new Map<number, number>();
  for (const e of laidOut.edges) {
    const rowFrom = rowOfNode.get(e.from) ?? 0;
    const rowTo = rowOfNode.get(e.to) ?? 0;
    if (rowFrom !== rowTo) {
      const lowerRow = Math.max(rowFrom, rowTo);
      gapNeed.set(
        lowerRow,
        (gapNeed.get(lowerRow) ?? 24) + crossBoxHeight(e) + 8,
      );
    }
  }
  const gapHeight = (r: number): number =>
    Math.max(ROW_GAP, gapNeed.get(r) ?? 0);
  // Per-row vertical NORMALIZATION (2026-07-30 user screenshot: short rows
  // floated mid-band inside the full ribbon height, wasting huge vertical
  // space): each row is only as tall as its own content - rows shift up by
  // their content's min-y and stack with exactly the gap bands between.
  const rowMinY: number[] = Array.from({ length: rows }, () => Number.POSITIVE_INFINITY);
  const rowMaxY: number[] = Array.from({ length: rows }, () => Number.NEGATIVE_INFINITY);
  for (const n of laidOut.nodes) {
    const r = rowOfNode.get(n.id) ?? 0;
    rowMinY[r] = Math.min(rowMinY[r], n.y);
    rowMaxY[r] = Math.max(rowMaxY[r], n.y + n.height);
  }
  const rowHeight = (r: number): number =>
    rowMaxY[r] <= rowMinY[r] ? 0 : rowMaxY[r] - rowMinY[r];
  const rowTop: number[] = [10];
  for (let r = 1; r < rows; r++) {
    rowTop[r] = rowTop[r - 1] + rowHeight(r - 1) + gapHeight(r);
  }
  const translate = (r: number, p: EdgePoint): EdgePoint => ({
    x: p.x + rowDx[r],
    y: p.y - rowMinY[r] + rowTop[r],
  });
  const nodes = laidOut.nodes.map((n) => {
    const r = rowOfNode.get(n.id) ?? 0;
    const moved = translate(r, { x: n.x, y: n.y });
    return { ...n, x: moved.x, y: moved.y };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // 4. Rebuild edges. Intra-row edges translate rigidly. Cross-row edges
  //    ride a RIGHT-MARGIN BUS (2026-07-30: the old mid-diagram drops cut
  //    through row content): exit the content area to a per-edge lane in
  //    the right margin, descend outside everything, run leftward along
  //    the gap band, and enter the target from its left - the classic
  //    carriage-return shape. Gap bands still hand out label lanes by the
  //    ACTUAL box heights so cross-row labels never stack.
  const contentRight = Math.max(...nodes.map((n) => n.x + NODE_W));
  // Is a vertical corridor at x clear of every card between y1 and y2?
  // Clear corridors let a cross-row edge take the SHORT direct path
  // (2026-07-30 user report: lines swept the full width when a short hop
  // existed); blocked ones fall back to the margin bus.
  const corridorClear = (x: number, y1: number, y2: number): boolean => {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    return !nodes.some(
      (n) =>
        x > n.x - 6 &&
        x < n.x + NODE_W + 6 &&
        hi > n.y &&
        lo < n.y + n.height,
    );
  };
  const gapCursor = new Map<number, number>();
  let marginLane = 0;
  const edges: LaidOutEdge[] = laidOut.edges.map((e) => {
    const rowFrom = rowOfNode.get(e.from) ?? 0;
    const rowTo = rowOfNode.get(e.to) ?? 0;
    if (rowFrom === rowTo) {
      return {
        ...e,
        points: e.points.map((p) => translate(rowFrom, p)),
        ...(e.labelPoint !== undefined
          ? { labelPoint: translate(rowFrom, e.labelPoint) }
          : {}),
      };
    }
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (from === undefined || to === undefined) {
      return { ...e, points: [] };
    }
    const source = { x: from.x + NODE_W, y: from.y + from.height / 2 };
    const target = { x: to.x, y: to.y + to.height / 2 };
    const lowerRow = Math.max(rowFrom, rowTo);
    const gapTop = rowTop[lowerRow] - gapHeight(lowerRow);
    const boxHeight = crossBoxHeight(e);
    const laneStart = gapCursor.get(lowerRow) ?? 12;
    const gapY = gapTop + laneStart + boxHeight / 2;
    gapCursor.set(lowerRow, laneStart + boxHeight + 8);
    const dropX = source.x + 24;
    const riseX = target.x - 24;
    let points: EdgePoint[];
    let labelX: number;
    if (
      corridorClear(dropX, source.y, gapY) &&
      corridorClear(riseX, gapY, target.y)
    ) {
      // Short direct hop: down beside the source, along the gap, up into
      // the target - the gap run spans only source-to-target columns.
      points = [
        source,
        { x: dropX, y: source.y },
        { x: dropX, y: gapY },
        { x: riseX, y: gapY },
        { x: riseX, y: target.y },
        target,
      ];
      labelX = (dropX + riseX) / 2;
    } else {
      const laneX = contentRight + 28 + marginLane * 16;
      marginLane += 1;
      points = [
        source,
        { x: laneX, y: source.y },
        { x: laneX, y: gapY },
        { x: riseX, y: gapY },
        { x: riseX, y: target.y },
        target,
      ];
      labelX = (laneX + riseX) / 2;
    }
    return {
      ...e,
      points,
      wrap: true,
      ...(e.label !== undefined
        ? { labelPoint: { x: labelX, y: gapY } }
        : {}),
    };
  });
  const width =
    Math.max(contentRight, contentRight + 28 + Math.max(0, marginLane - 1) * 16) +
    12;
  const height = Math.max(...nodes.map((n) => n.y + n.height)) + 10;
  // Continuation cues: a faint divider at each gap's midline. Bands are
  // dropped - rank columns no longer share one axis.
  const rowDividers: number[] = [];
  for (let r = 1; r < rows; r++) {
    rowDividers.push(rowTop[r] - gapHeight(r) / 2);
  }
  return { nodes, edges, width, height, rowDividers };
}

function layoutDiagramWith(
  diagram: PatternDiagram,
  ranksep: number,
  nodesep: number,
): LaidOutDiagram {
  // The Cribl source types feeding each node, from its ingress edge labels
  // (the "<Type> source (...)" convention) - drawn as tags on the card.
  const typesByNode = new Map<string, string[]>();
  for (const edge of diagram.edges) {
    const type = criblSourceTypeFromLabel(edge.label ?? "");
    if (type === null) {
      continue;
    }
    const existing = typesByNode.get(edge.to) ?? [];
    if (!existing.includes(type)) {
      typesByNode.set(edge.to, [...existing, type]);
    }
  }
  const heightOf = (nodeId: string): number =>
    NODE_H + ((typesByNode.get(nodeId)?.length ?? 0) > 0 ? CHIP_ROW_H : 0);

  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  // Tightened 2026-07-29 (user report: a lot of whitespace between objects) -
  // was nodesep 34 / ranksep 96. Edge labels are DECLARED to dagre below
  // (2026-07-30 user report: labels struck through cards): the layout
  // reserves room for each label as a virtual node, so ranks widen exactly
  // where a label needs space instead of everywhere.
  // ranksep 56 (was 72): dagre halves it around the label ranks it inserts,
  // and the label footprints supply the rest of the separation - the merged
  // presets were growing too WIDE to use the window well (user report
  // 2026-07-30).
  g.setGraph({ rankdir: "LR", nodesep, ranksep, marginx: 10, marginy: 10 });
  for (const node of diagram.nodes) {
    g.setNode(node.id, { width: NODE_W, height: heightOf(node.id) });
  }
  for (const edge of diagram.edges) {
    const label = edge.label ?? "";
    g.setEdge(
      edge.from,
      edge.to,
      label !== ""
        ? { ...edgeLabelFootprint(label, edge.cost !== undefined), labelpos: "c" }
        : {},
    );
  }
  Dagre.layout(g);

  const nodes: LaidOutNode[] = diagram.nodes.map((n) => {
    const p = g.node(n.id);
    const height = heightOf(n.id);
    return {
      id: n.id,
      label: n.label,
      tier: n.tier,
      x: p.x - NODE_W / 2,
      y: p.y - height / 2,
      height,
      sourceTypes: typesByNode.get(n.id) ?? [],
      ...(n.info !== undefined ? { info: n.info } : {}),
      ...(n.badge !== undefined ? { badge: n.badge } : {}),
      ...(n.overlays !== undefined && n.overlays.length > 0
        ? { overlays: n.overlays }
        : {}),
      ...(n.expandable !== undefined ? { expandable: n.expandable } : {}),
      ...(n.expanded !== undefined ? { expanded: n.expanded } : {}),
      ...(n.muted !== undefined ? { muted: n.muted } : {}),
    };
  });
  const edges: LaidOutEdge[] = diagram.edges.map((e) => {
    const routed = g.edge({ v: e.from, w: e.to }) as
      | { points?: EdgePoint[]; x?: number; y?: number }
      | undefined;
    return {
      ...e,
      points: (routed?.points ?? []).map((p) => ({ x: p.x, y: p.y })),
      ...(e.label !== undefined &&
      e.label !== "" &&
      routed?.x !== undefined &&
      routed?.y !== undefined
        ? { labelPoint: { x: routed.x, y: routed.y } }
        : {}),
    };
  });
  const size = g.graph();
  const bands = computeTierBands(nodes);
  return {
    nodes,
    edges,
    width: size.width ?? 0,
    height: size.height ?? 0,
    ...(bands !== undefined ? { bands } : {}),
  };
}
