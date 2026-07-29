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

import { useEffect, useMemo, useRef, useState } from "react";
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
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { diagramNodeInfo } from "@soc/core";
import type { DiagramTier, EdgeCostTier, PatternDiagram } from "@soc/core";
import { layoutDiagram, nodeBadge } from "./arch-layout";
// React Flow's stylesheet is imported by the SHELL entry points (cribl-app
// main.tsx / local-app), matching how @soc/ui/styles.css is loaded - a library
// component must not side-effect-import CSS (no *.css module in the lib tsc).

type ArchNodeData = { label: string; tier: DiagramTier };
type ArchNode = Node<ArchNodeData, "arch">;
type FlowEdgeData = { label?: string; cost?: EdgeCostTier; reverse?: boolean };
type FlowEdge = Edge<FlowEdgeData, "flowing">;

/**
 * A tier-colored, draggable node card (React Flow custom node). Nodes with a
 * catalog info entry carry an "i" button opening a popover with the
 * component's purpose and vendor documentation links (user feature
 * 2026-07-28). The popover is plain positioned markup - CSP-safe, no portal,
 * no external assets - and is marked nodrag/nopan so the canvas does not
 * intercept clicks inside it.
 */
function ArchNodeCard({ data }: NodeProps<ArchNode>) {
  const [infoOpen, setInfoOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const info = diagramNodeInfo(data.label);

  // Light-dismiss (user report 2026-07-29: popovers only closed via their x
  // and stacked up): while open, any pointer-down OUTSIDE this card closes
  // the popover - which also means opening another node's popover closes
  // this one. CAPTURE phase so React Flow's pane/drag handlers cannot
  // swallow the event first; Escape closes too.
  useEffect(() => {
    if (!infoOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        cardRef.current !== null &&
        target instanceof Node &&
        !cardRef.current.contains(target)
      ) {
        setInfoOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInfoOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [infoOpen]);

  return (
    <div ref={cardRef} className={`arch-flow-node arch-flow-node-${data.tier}`}>
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        className="arch-flow-handle"
      />
      <span className="arch-flow-node-tier">{nodeBadge(data.label, data.tier)}</span>
      <span className="arch-flow-node-label">{data.label}</span>
      <Handle
        type="source"
        id="out"
        position={Position.Right}
        className="arch-flow-handle"
      />
      {/* Bottom handle pair: wrap-back edges (replay/return flows) attach
          here so a node's IN and OUT lines use visibly separate connection
          points instead of sharing the left/right pair (user 2026-07-29). */}
      <Handle
        type="target"
        id="in-b"
        position={Position.Bottom}
        className="arch-flow-handle"
        style={{ left: "35%" }}
      />
      <Handle
        type="source"
        id="out-b"
        position={Position.Bottom}
        className="arch-flow-handle"
        style={{ left: "65%" }}
      />
      {info !== undefined && (
        <button
          type="button"
          className="arch-flow-info-btn nodrag nopan"
          aria-label={`About ${data.label}`}
          aria-expanded={infoOpen}
          onClick={(event) => {
            event.stopPropagation();
            setInfoOpen((open) => !open);
          }}
        >
          i
        </button>
      )}
      {info !== undefined && infoOpen && (
        <div className="arch-flow-info-pop nodrag nopan">
          <div className="arch-flow-info-pop-head">
            <span className="arch-flow-info-pop-title">{data.label}</span>
            <button
              type="button"
              className="arch-flow-info-close"
              aria-label="Close"
              onClick={(event) => {
                event.stopPropagation();
                setInfoOpen(false);
              }}
            >
              x
            </button>
          </div>
          <p className="arch-flow-info-purpose">{info.purpose}</p>
          <span className="arch-flow-info-links-label">Documentation</span>
          <ul className="arch-flow-info-links">
            {info.docs.map((doc) => (
              <li key={doc.url}>
                <a href={doc.url} target="_blank" rel="noopener noreferrer">
                  {doc.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * A custom edge that looks like data flowing through a pipe: a dashed pipe
 * animated in CSS (Firefox-safe - not SMIL) plus <animateMotion> packets that
 * ride the exact edge path, so they track the geometry on drag/relayout.
 *
 * BENDABLE (user 2026-07-29): every edge carries a small grab dot at its
 * label anchor. Dragging the dot bends the line through the dragged point (a
 * quadratic whose control the user holds) while both ENDPOINTS stay attached
 * to their nodes - node drags keep updating sourceX/targetX, so the line
 * stays connected. Double-click the dot to reset the bend.
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
  const { screenToFlowPosition } = useReactFlow();
  const [bend, setBend] = useState<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);

  // Wrap-back edges (e.g. the blob "replay" return into Stream) get a wider
  // clearance so the wrap does not hug the node cards, and their label drops
  // below the line so it cannot stack on the forward edge's label (user
  // report 2026-07-29: overlapping visuals on the cost/archive preset).
  const reverse = data?.reverse === true;
  const [stepPath, stepLabelX, stepLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: reverse ? 48 : 20,
  });

  // Bent edges become a quadratic through the dragged control point. The
  // visible anchor sits ON the curve (t=0.5), not at the control point, so
  // the dot tracks the line the user sees.
  let edgePath = stepPath;
  let anchorX = stepLabelX;
  let anchorY = stepLabelY + (reverse ? 26 : 0);
  if (bend !== null) {
    // Control point chosen so the curve passes THROUGH the dragged point:
    // q = 2*p - (s + t)/2 for a quadratic bezier at t=0.5.
    const qx = 2 * bend.x - (sourceX + targetX) / 2;
    const qy = 2 * bend.y - (sourceY + targetY) / 2;
    edgePath = `M ${sourceX} ${sourceY} Q ${qx} ${qy} ${targetX} ${targetY}`;
    anchorX = bend.x;
    anchorY = bend.y;
  }

  const hasLabel = data?.label !== undefined && data.label !== "";
  const cost = data?.cost;
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className={`arch-flow-pipe${cost !== undefined ? ` arch-flow-pipe-${cost}` : ""}`}
      />
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
      <EdgeLabelRenderer>
        <div
          className="arch-flow-edge-tags nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${anchorX}px, ${anchorY}px)`,
          }}
        >
          {hasLabel && <span className="arch-flow-edge-label">{data?.label}</span>}
          {cost !== undefined && (
            <span
              className={`arch-flow-cost-badge arch-flow-cost-${cost}`}
              title={
                cost === "premium"
                  ? "Lands in the analytics tier - billed per GB ingested"
                  : "Low-cost retention or egress - avoids analytics-tier billing"
              }
            >
              {cost}
            </span>
          )}
        </div>
        <div
          className="arch-flow-bend-dot nodrag nopan"
          title="Drag to bend this line; double-click to reset"
          style={{
            transform: `translate(-50%, -50%) translate(${anchorX}px, ${anchorY + (hasLabel || cost !== undefined ? 16 : 0)}px)`,
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            draggingRef.current = true;
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) {
              return;
            }
            setBend(
              screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
          }}
          onPointerUp={(event) => {
            draggingRef.current = false;
            (event.target as HTMLElement).releasePointerCapture(event.pointerId);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            setBend(null);
          }}
        />
      </EdgeLabelRenderer>
    </>
  );
}

// Defined at module scope: React Flow warns if these objects are recreated per
// render (it treats them as new type maps).
const NODE_TYPES = { arch: ArchNodeCard };
const EDGE_TYPES = { flowing: FlowingEdge };

/** Adapt the shared dagre layout (arch-layout) to React Flow's shapes. */
function layoutGraph(diagram: PatternDiagram): { nodes: ArchNode[]; edges: FlowEdge[] } {
  const laidOut = layoutDiagram(diagram);
  const nodes: ArchNode[] = laidOut.nodes.map((n) => ({
    id: n.id,
    type: "arch",
    position: { x: n.x, y: n.y },
    data: { label: n.label, tier: n.tier },
  }));
  // A wrap-back edge runs right-to-left in the laid-out flow (its source
  // column sits right of its target column) - the replay/return edges.
  const xById = new Map(laidOut.nodes.map((n) => [n.id, n.x]));
  const edges: FlowEdge[] = laidOut.edges.map((e, i) => {
    const reverse = (xById.get(e.from) ?? 0) > (xById.get(e.to) ?? 0);
    return {
      id: `edge-${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      // Wrap-back edges attach at the bottom handle pair so a node's IN and
      // OUT lines never share the same connection point.
      sourceHandle: reverse ? "out-b" : "out",
      targetHandle: reverse ? "in-b" : "in",
      type: "flowing",
      data: { label: e.label, cost: e.cost, reverse },
    };
  });
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
