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
}

/** The laid-out diagram: nodes with positions, routed edges, canvas size. */
export interface LaidOutDiagram {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

/** A stable identity for an edge across re-layouts (its endpoint pair). */
export function edgeKey(edge: Pick<DiagramEdge, "from" | "to">): string {
  return `${edge.from}>${edge.to}`;
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

/** dagre LR layout with the canvas's exact parameters. */
export function layoutDiagram(diagram: PatternDiagram): LaidOutDiagram {
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
  // was nodesep 34 / ranksep 96; labels ride the edges with backing pills so
  // the narrower column gap stays legible.
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 72, marginx: 10, marginy: 10 });
  for (const node of diagram.nodes) {
    g.setNode(node.id, { width: NODE_W, height: heightOf(node.id) });
  }
  for (const edge of diagram.edges) {
    g.setEdge(edge.from, edge.to);
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
    };
  });
  const edges: LaidOutEdge[] = diagram.edges.map((e) => {
    const routed = g.edge({ v: e.from, w: e.to }) as
      | { points?: EdgePoint[] }
      | undefined;
    return {
      ...e,
      points: (routed?.points ?? []).map((p) => ({ x: p.x, y: p.y })),
    };
  });
  const size = g.graph();
  return {
    nodes,
    edges,
    width: size.width ?? 0,
    height: size.height ?? 0,
  };
}
