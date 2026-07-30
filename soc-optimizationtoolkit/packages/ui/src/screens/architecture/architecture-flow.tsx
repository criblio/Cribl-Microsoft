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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type {
  DiagramNodeInfo,
  DiagramTier,
  EdgeCostTier,
  EdgeFlowTone,
  PatternDiagram,
} from "@soc/core";
import {
  applyDiagramRemovals,
  edgeKey,
  layoutDiagram,
  nodeBadge,
  polylineMidpoint,
  sourceTypeChips,
} from "./arch-layout";
// React Flow's stylesheet is imported by the SHELL entry points (cribl-app
// main.tsx / local-app), matching how @soc/ui/styles.css is loaded - a library
// component must not side-effect-import CSS (no *.css module in the lib tsc).

type ArchNodeData = {
  label: string;
  tier: DiagramTier;
  /** The Cribl source types feeding this node (tag row on the card). */
  sourceTypes?: string[];
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
  /** Remove this node from the diagram (the hover x button). */
  onRemove?: (nodeId: string) => void;
  /** Toggle the node's exploded rendering (the +/- button). */
  onToggleExpand?: (nodeId: string) => void;
};
type ArchNode = Node<ArchNodeData, "arch">;
type FlowEdgeData = {
  label?: string;
  cost?: EdgeCostTier;
  tone?: EdgeFlowTone;
  muted?: boolean;
  reverse?: boolean;
  /** Dagre's routed waypoints (dodge cards); endpoints re-pinned live. */
  points?: FlowPoint[];
  /** Dagre's reserved collision-free label anchor. */
  labelPoint?: FlowPoint;
};
type FlowEdge = Edge<FlowEdgeData, "flowing">;

/**
 * A tier-colored, draggable node card (React Flow custom node). Nodes with a
 * catalog info entry carry an "i" button opening a popover with the
 * component's purpose and vendor documentation links (user feature
 * 2026-07-28). The popover is plain positioned markup - CSP-safe, no portal,
 * no external assets - and is marked nodrag/nopan so the canvas does not
 * intercept clicks inside it.
 */
function ArchNodeCard({ id, data }: NodeProps<ArchNode>) {
  const [infoOpen, setInfoOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Live nodes carry their info inline (composed from real config); catalog
  // nodes resolve through the label-keyed lookup.
  const info = data.info ?? diagramNodeInfo(data.label);

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
    <div
      ref={cardRef}
      className={
        `arch-flow-node arch-flow-node-${data.tier}` +
        (data.muted === true ? " arch-flow-node-muted" : "")
      }
    >
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        className="arch-flow-handle"
      />
      <span className="arch-flow-node-tier">
        {data.badge ?? nodeBadge(data.label, data.tier)}
      </span>
      <span className="arch-flow-node-label">{data.label}</span>
      {data.sourceTypes !== undefined && data.sourceTypes.length > 0 && (
        <span className="arch-flow-node-chips">
          {sourceTypeChips(data.sourceTypes).map((chip) => (
            <span className="arch-flow-source-chip" key={chip}>
              {chip}
            </span>
          ))}
        </span>
      )}
      {data.overlays !== undefined &&
        data.overlays.map((overlay, index) => (
          <span
            className="arch-flow-overlay-tag"
            key={overlay}
            style={{ bottom: -10 - index * 18 }}
            title={diagramNodeInfo(overlay)?.purpose ?? overlay}
          >
            {overlay}
          </span>
        ))}
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
      {data.onRemove !== undefined && (
        <button
          type="button"
          className="arch-flow-remove-btn nodrag nopan"
          aria-label={`Remove ${data.label} from the diagram`}
          title="Remove from the diagram (the layout adjusts)"
          onClick={(event) => {
            event.stopPropagation();
            data.onRemove?.(id);
          }}
        >
          x
        </button>
      )}
      {data.expandable === true && data.onToggleExpand !== undefined && (
        <button
          type="button"
          className="arch-flow-expand-btn nodrag nopan"
          aria-label={
            data.expanded === true
              ? `Collapse ${data.label}`
              : `Explode ${data.label} into its internals`
          }
          aria-expanded={data.expanded === true}
          title={
            data.expanded === true
              ? "Collapse the pack"
              : "Explode the pack: show its sources, routes, pipelines, and destinations"
          }
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleExpand?.(id);
          }}
        >
          {data.expanded === true ? "-" : "+"}
        </button>
      )}
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
          {info.facts !== undefined && info.facts.length > 0 && (
            <div className="arch-flow-info-facts">
              {info.facts.map((fact) => (
                <div className="arch-flow-info-fact" key={fact.label}>
                  <span className="arch-flow-info-fact-label">{fact.label}</span>
                  <span className="arch-flow-info-fact-value">{fact.value}</span>
                </div>
              ))}
            </div>
          )}
          {info.steps !== undefined && info.steps.length > 0 && (
            <div className="arch-flow-step-rows">
              {info.steps.map((step, index) => (
                <div
                  key={`${step.name}-${index}`}
                  className={
                    "arch-flow-step-row" +
                    (step.disabled === true ? " arch-flow-route-row-disabled" : "")
                  }
                >
                  <span className="arch-flow-step-num">{index + 1}</span>
                  <span className="arch-flow-step-name">
                    {step.name}
                    {step.disabled === true ? " (disabled)" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          {info.routes !== undefined && info.routes.length > 0 && (
            <div className="arch-flow-route-rows">
              {info.routes.map((row, index) => (
                <div
                  key={`${row.name}-${index}`}
                  className={
                    "arch-flow-route-row" +
                    (row.disabled === true ? " arch-flow-route-row-disabled" : "")
                  }
                  title={row.filter ?? "true (all events)"}
                >
                  <span className="arch-flow-route-row-name">
                    {index + 1}. {row.name}
                    {row.copy === true ? " (copy)" : ""}
                    {row.disabled === true ? " (disabled)" : ""}
                  </span>
                  <span className="arch-flow-route-row-chips">
                    <span className="arch-flow-route-chip arch-flow-route-chip-pipe">
                      {row.pipeline}
                    </span>
                    <span className="arch-flow-route-arrow">-&gt;</span>
                    <span className="arch-flow-route-chip arch-flow-route-chip-dest">
                      {row.destination}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <span className="arch-flow-info-links-label">Links</span>
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

/** A point in flow coordinates. */
type FlowPoint = { x: number; y: number };

/** Rounded-corner path through orthogonal waypoints (mirrors the exporter). */
function roundedOrthogonalPath(points: FlowPoint[], r = 12): string {
  const first = points[0];
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    if (inLen < 1 || outLen < 1) {
      continue;
    }
    const inT = Math.max(0, 1 - r / inLen);
    const outT = Math.min(1, r / outLen);
    d +=
      ` L ${prev.x + (corner.x - prev.x) * inT} ${prev.y + (corner.y - prev.y) * inT}` +
      ` Q ${corner.x} ${corner.y} ${corner.x + (next.x - corner.x) * outT} ${corner.y + (next.y - corner.y) * outT}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/**
 * Orthogonal waypoints from S to T passing THROUGH the dragged point P,
 * honoring the exit axis at the source handle and the entry axis at the
 * target handle. Near-collinear jogs (under 4px) collapse so the route
 * stays clean when P lines up with an endpoint.
 */
function orthogonalThrough(
  s: FlowPoint,
  t: FlowPoint,
  p: FlowPoint,
  exitAxis: "h" | "v",
  enterAxis: "h" | "v",
): FlowPoint[] {
  const pts: FlowPoint[] = [s];
  pts.push(exitAxis === "h" ? { x: p.x, y: s.y } : { x: s.x, y: p.y });
  pts.push(p);
  if (enterAxis === "h") {
    if (Math.abs(p.y - t.y) > 4) {
      const xj = (p.x + t.x) / 2;
      pts.push({ x: xj, y: p.y }, { x: xj, y: t.y });
    }
  } else if (Math.abs(p.x - t.x) > 4) {
    pts.push({ x: t.x, y: p.y });
  }
  pts.push(t);
  return pts.filter(
    (point, i) =>
      i === 0 || Math.hypot(point.x - pts[i - 1].x, point.y - pts[i - 1].y) > 1,
  );
}

/** Snap a coordinate onto a nearby guide (an endpoint axis) within 10px. */
function snapTo(value: number, guides: readonly number[]): number {
  for (const guide of guides) {
    if (Math.abs(value - guide) < 10) {
      return guide;
    }
  }
  return value;
}

/**
 * A custom edge that looks like data flowing through a pipe: a dashed pipe
 * animated in CSS (Firefox-safe - not SMIL) plus <animateMotion> packets that
 * ride the exact edge path, so they track the geometry on drag/relayout.
 *
 * BENDABLE (user 2026-07-29): every edge carries a small grab dot at its
 * label anchor. Dragging the dot re-routes the line ORTHOGONALLY through
 * the dragged point - right-angle segments with rounded corners, matching
 * the diagram's step aesthetic - while both ENDPOINTS stay attached to
 * their nodes; the drag point snaps onto an endpoint's axis when close so
 * near-straight routes become exactly straight. Double-click resets.
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

  // DEFAULT geometry is dagre's ROUTED path - the same one the SVG export
  // draws (user report 2026-07-30: the canvas's own smoothstep midpoints
  // put labels and cost badges on cards). The routed interior dodges the
  // node columns; endpoints re-pin to the LIVE handle coords so dragged
  // nodes stay connected; labels sit at dagre's reserved anchor. Smoothstep
  // remains the fallback for edges without routing.
  let edgePath = stepPath;
  let anchorX = stepLabelX;
  let anchorY = stepLabelY + (reverse ? 26 : 0);
  const routed = data?.points;
  if (routed !== undefined && routed.length >= 2) {
    const pts: FlowPoint[] = [
      { x: sourceX, y: sourceY },
      ...routed.slice(1, -1),
      { x: targetX, y: targetY },
    ];
    edgePath = roundedOrthogonalPath(pts);
    const anchor = data?.labelPoint ?? polylineMidpoint(pts);
    anchorX = anchor.x;
    anchorY = anchor.y;
  }
  // Bent edges re-route orthogonally THROUGH the dragged point, honoring
  // the axes the handles impose (right/left handles exit and enter
  // horizontally; the bottom wrap-back handles vertically).
  if (bend !== null) {
    const exitAxis = sourcePosition === Position.Bottom ? "v" : "h";
    const enterAxis = targetPosition === Position.Bottom ? "v" : "h";
    edgePath = roundedOrthogonalPath(
      orthogonalThrough(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        bend,
        exitAxis,
        enterAxis,
      ),
    );
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
        className={
          `arch-flow-pipe${cost !== undefined ? ` arch-flow-pipe-${cost}` : ""}` +
          (data?.tone !== undefined ? ` arch-flow-pipe-tone-${data.tone}` : "") +
          (data?.muted === true ? " arch-flow-pipe-muted" : "")
        }
      />
      {/* No packet animation on muted edges - a disabled route moves nothing. */}
      {data?.muted !== true &&
        [0, 0.9, 1.8].map((delay, i) => (
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
                  ? "Per-GB ingest billing - Sentinel analytics tier or SIEM license"
                  : "Low-cost retention or egress - avoids per-GB ingest billing"
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
            transform: `translate(-50%, -50%) translate(${anchorX}px, ${anchorY + (hasLabel || cost !== undefined ? 24 : 0)}px)`,
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
            const point = screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            // Snap onto an endpoint's axis when close - near-straight
            // routes become exactly straight (right angles by default).
            setBend({
              x: snapTo(point.x, [sourceX, targetX]),
              y: snapTo(point.y, [sourceY, targetY]),
            });
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

/**
 * The one fit-to-view configuration (initial fit and every re-fit): a slim
 * padding so the diagram FILLS the canvas (user report 2026-07-29: too much
 * whitespace - was 0.15), and a fit-zoom ceiling so tiny diagrams do not
 * blow up to poster-sized cards. The user can still zoom to maxZoom by hand.
 */
const FIT_VIEW_OPTIONS = { padding: 0.06, maxZoom: 1.15, duration: 200 } as const;

/**
 * Re-fits the viewport whenever the diagram identity or the canvas size
 * changes (user 2026-07-29: everything should fit the window by default and
 * keep fitting across monitors/resolutions). Rendered INSIDE <ReactFlow> to
 * reach its store; the rAF defers the fit until the re-seeded nodes painted.
 */
function FitViewController({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    // TWO frames plus a settle-time backup: a single rAF could fire before
    // React Flow measured the newly seeded nodes, fitting the STALE bounds
    // and leaving the new diagram running off screen (user report
    // 2026-07-30: the long-term-retention preset rendered cut off).
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        void fitView(FIT_VIEW_OPTIONS);
      });
    });
    const backup = setTimeout(() => {
      void fitView(FIT_VIEW_OPTIONS);
    }, 200);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(backup);
    };
  }, [signature, fitView]);
  return null;
}

/** Adapt the shared dagre layout (arch-layout) to React Flow's shapes. */
function layoutGraph(diagram: PatternDiagram): { nodes: ArchNode[]; edges: FlowEdge[] } {
  const laidOut = layoutDiagram(diagram);
  const nodes: ArchNode[] = laidOut.nodes.map((n) => ({
    id: n.id,
    type: "arch",
    position: { x: n.x, y: n.y },
    data: {
      label: n.label,
      tier: n.tier,
      sourceTypes: n.sourceTypes,
      info: n.info,
      badge: n.badge,
      overlays: n.overlays,
      expandable: n.expandable,
      expanded: n.expanded,
      muted: n.muted,
    },
  }));
  // A wrap-back edge runs right-to-left in the laid-out flow (its source
  // column sits right of its target column) - the replay/return edges.
  const xById = new Map(laidOut.nodes.map((n) => [n.id, n.x]));
  const edges: FlowEdge[] = laidOut.edges.map((e, i) => {
    // Serpentine cross-row edges already snake through the row gap - they
    // are NOT wrap-backs even though the target sits left of the source.
    const reverse =
      e.wrap !== true && (xById.get(e.from) ?? 0) > (xById.get(e.to) ?? 0);
    return {
      id: `edge-${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      // Wrap-back edges attach at the bottom handle pair so a node's IN and
      // OUT lines never share the same connection point.
      sourceHandle: reverse ? "out-b" : "out",
      targetHandle: reverse ? "in-b" : "in",
      type: "flowing",
      data: {
        label: e.label,
        cost: e.cost,
        tone: e.tone,
        muted: e.muted,
        reverse,
        points: e.points,
        labelPoint: e.labelPoint,
      },
    };
  });
  return { nodes, edges };
}

export interface ArchitectureFlowProps {
  diagram: PatternDiagram;
  /** Toggle a node's exploded rendering (nodes with expandable=true). */
  onToggleNodeExpand?: (nodeId: string) => void;
}

/** The interactive canvas. Empty diagrams render nothing (caller shows a hint). */
export function ArchitectureFlow({ diagram, onToggleNodeExpand }: ArchitectureFlowProps) {
  // User removals (2026-07-29): deleted nodes/edges are subtracted from the
  // diagram and dagre RE-LAYOUTS what is left, so the drawing tightens up
  // around the remaining flow. Removals reset when the selection changes.
  const [removedNodes, setRemovedNodes] = useState<ReadonlySet<string>>(new Set());
  const [removedEdges, setRemovedEdges] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setRemovedNodes(new Set());
    setRemovedEdges(new Set());
  }, [diagram]);

  const removeNode = useCallback((nodeId: string) => {
    setRemovedNodes((prev) => new Set([...prev, nodeId]));
  }, []);

  const effective = useMemo(
    () => applyDiagramRemovals(diagram, removedNodes, removedEdges),
    [diagram, removedNodes, removedEdges],
  );

  const layouted = useMemo(() => {
    const graph = layoutGraph(effective);
    return {
      nodes: graph.nodes.map((n) => ({
        ...n,
        data: { ...n.data, onRemove: removeNode, onToggleExpand: onToggleNodeExpand },
      })),
      edges: graph.edges,
    };
  }, [effective, removeNode, onToggleNodeExpand]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchNode>(layouted.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(layouted.edges);

  // Re-seed nodes/edges when the selection (and thus the diagram) changes.
  useEffect(() => {
    setNodes(layouted.nodes);
    setEdges(layouted.edges);
  }, [layouted, setNodes, setEdges]);

  // Canvas-size watcher (ref callback, not an effect: the canvas div mounts
  // conditionally). A monitor/window/panel resize bumps resizeTick after a
  // short settle, and the FitViewController re-fits the whole flow into the
  // new bounds - the dynamic zoom-out-to-fit the user asked for 2026-07-29.
  const [resizeTick, setResizeTick] = useState(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canvasRef = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    clearTimeout(resizeTimerRef.current);
    if (el === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => setResizeTick((t) => t + 1), 150);
    });
    observer.observe(el);
    resizeObserverRef.current = observer;
  }, []);

  // Re-fit on structural change (selection, removals) or canvas resize -
  // NOT on node drags, which leave the diagram identity untouched.
  const fitSignature = useMemo(
    () =>
      `${effective.nodes.map((n) => n.id).join(",")}|${effective.edges.length}|${resizeTick}`,
    [effective, resizeTick],
  );

  const removedCount = removedNodes.size + removedEdges.size;

  if (diagram.nodes.length === 0) return null;

  if (effective.nodes.length === 0) {
    return (
      <div className="arch-flow-restore-row">
        <span className="field-hint">Everything was removed from the diagram.</span>
        <button
          type="button"
          className="arch-export-btn"
          onClick={() => {
            setRemovedNodes(new Set());
            setRemovedEdges(new Set());
          }}
        >
          Restore the diagram
        </button>
      </div>
    );
  }

  return (
    <div className="arch-flow-canvas" ref={canvasRef}>
      {removedCount > 0 && (
        <div className="arch-flow-restore-row arch-flow-restore-overlay">
          <button
            type="button"
            className="arch-export-btn"
            onClick={() => {
              setRemovedNodes(new Set());
              setRemovedEdges(new Set());
            }}
          >
            Restore {removedCount} removed item{removedCount === 1 ? "" : "s"}
          </button>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodesDelete={(deleted) => {
          setRemovedNodes((prev) => new Set([...prev, ...deleted.map((n) => n.id)]));
        }}
        onEdgesDelete={(deleted) => {
          setRemovedEdges(
            (prev) =>
              new Set([
                ...prev,
                ...deleted.map((e) => edgeKey({ from: e.source, to: e.target })),
              ]),
          );
        }}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.2}
        maxZoom={1.6}
        nodesConnectable={false}
        edgesFocusable={true}
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
      >
        <FitViewController signature={fitSignature} />
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
