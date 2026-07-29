/**
 * arch-layout - the renderer-agnostic geometry of the architecture diagram:
 * the dagre left-to-right layout (the EXACT parameters the interactive
 * canvas uses) and the per-node badge derivation, extracted from
 * architecture-flow.tsx so the SVG exporter produces identical coordinates
 * to the on-screen canvas (2026-07-29). Dagre is pure JS - no DOM here.
 */

import Dagre from "@dagrejs/dagre";
import type { DiagramEdge, DiagramTier, PatternDiagram } from "@soc/core";

export const NODE_W = 190;
export const NODE_H = 62;

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
  if (lower.includes("azure") || lower.includes("data explorer")) {
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

/** dagre LR layout with the canvas's exact parameters. */
export function layoutDiagram(diagram: PatternDiagram): LaidOutDiagram {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 96, marginx: 12, marginy: 12 });
  for (const node of diagram.nodes) {
    g.setNode(node.id, { width: NODE_W, height: NODE_H });
  }
  for (const edge of diagram.edges) {
    g.setEdge(edge.from, edge.to);
  }
  Dagre.layout(g);

  const nodes: LaidOutNode[] = diagram.nodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      label: n.label,
      tier: n.tier,
      x: p.x - NODE_W / 2,
      y: p.y - NODE_H / 2,
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
