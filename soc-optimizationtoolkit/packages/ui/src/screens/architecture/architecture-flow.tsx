/**
 * ArchitectureFlow - the interactive data-flow canvas (user direction
 * 2026-07-20). Replaces the per-pattern static SVGs with ONE React Flow canvas
 * that lays out the unified diagram (unifyPatternDiagrams) into left->right
 * tiers with @dagrejs/dagre, renders draggable tier-colored node cards, and
 * animates "data flowing" through each edge (a CSS stroke-dashoffset pipe plus
 * SVG <animateMotion> packets). As the selected components change, the diagram
 * recomputes and re-lays-out.
 *
 * STRICT-CSP SAFE: React Flow ships a STATIC bundled stylesheet (no runtime
 * <style> injection) and uses no eval; dagre is pure JS (no WASM/eval); the
 * flow animation is declarative SMIL + a bundled CSS @keyframes. No external
 * assets, no unsafe-eval, no unsafe-inline. (See reference_interactive_diagram.)
 */

import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import Dagre from "@dagrejs/dagre";
import type { DiagramTier, PatternDiagram } from "@soc/core";
// React Flow's stylesheet is imported by the SHELL entry points (cribl-app
// main.tsx / local-app), matching how @soc/ui/styles.css is loaded - a library
// component must not side-effect-import CSS (no *.css module in the lib tsc).

type ArchNodeData = { label: string; tier: DiagramTier };
type ArchNode = Node<ArchNodeData, "arch">;
type FlowEdgeData = { label?: string };
type FlowEdge = Edge<FlowEdgeData, "flowing">;

const NODE_W = 190;
const NODE_H = 62;

/** The short tier badge shown above a node's label. */
const TIER_BADGE: Record<DiagramTier, string> = {
  source: "Source",
  cribl: "Cribl",
  azure: "Azure",
  destination: "Sentinel",
};

/** A tier-colored, draggable node card (React Flow custom node). */
function ArchNodeCard({ data }: NodeProps<ArchNode>) {
  return (
    <div className={`arch-flow-node arch-flow-node-${data.tier}`}>
      <Handle type="target" position={Position.Left} className="arch-flow-handle" />
      <span className="arch-flow-node-tier">{TIER_BADGE[data.tier]}</span>
      <span className="arch-flow-node-label">{data.label}</span>
      <Handle type="source" position={Position.Right} className="arch-flow-handle" />
    </div>
  );
}

/**
 * A custom edge that looks like data flowing through a pipe: a dashed pipe
 * animated in CSS (Firefox-safe - not SMIL) plus <animateMotion> packets that
 * ride the exact edge path, so they track the geometry on drag/relayout.
 */
function FlowingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });
  return (
    <>
      <BaseEdge id={id} path={edgePath} className="arch-flow-pipe" />
      {[0, 0.9, 1.8].map((delay, i) => (
        <circle key={i} r={3} className="arch-flow-dot">
          <animateMotion
            dur="2.7s"
            begin={`${delay}s`}
            repeatCount="indefinite"
            path={edgePath}
            calcMode="paced"
          />
        </circle>
      ))}
      {data?.label !== undefined && data.label !== "" && (
        <EdgeLabelRenderer>
          <div
            className="arch-flow-edge-label nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// Defined at module scope: React Flow warns if these objects are recreated per
// render (it treats them as new type maps).
const NODE_TYPES = { arch: ArchNodeCard };
const EDGE_TYPES = { flowing: FlowingEdge };

/** Lay the unified diagram out into left->right tiers with dagre. */
function layoutGraph(diagram: PatternDiagram): { nodes: ArchNode[]; edges: FlowEdge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 96, marginx: 12, marginy: 12 });
  for (const node of diagram.nodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const edge of diagram.edges) g.setEdge(edge.from, edge.to);
  Dagre.layout(g);

  const nodes: ArchNode[] = diagram.nodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      type: "arch",
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      data: { label: n.label, tier: n.tier },
    };
  });
  const edges: FlowEdge[] = diagram.edges.map((e, i) => ({
    id: `edge-${e.from}-${e.to}-${i}`,
    source: e.from,
    target: e.to,
    type: "flowing",
    data: { label: e.label },
  }));
  return { nodes, edges };
}

export interface ArchitectureFlowProps {
  diagram: PatternDiagram;
}

/** The interactive canvas. Empty diagrams render nothing (caller shows a hint). */
export function ArchitectureFlow({ diagram }: ArchitectureFlowProps) {
  const layouted = useMemo(() => layoutGraph(diagram), [diagram]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchNode>(layouted.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(layouted.edges);

  // Re-seed nodes/edges when the selection (and thus the diagram) changes.
  useEffect(() => {
    setNodes(layouted.nodes);
    setEdges(layouted.edges);
  }, [layouted, setNodes, setEdges]);

  if (diagram.nodes.length === 0) return null;

  return (
    <div className="arch-flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="var(--border)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
