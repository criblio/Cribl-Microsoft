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
  MarkerType,
  Position,
  ReactFlow,
  ViewportPortal,
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
  type LaidOutDiagram,
  type LaidOutEdge,
} from "./arch-layout";
import { emptyEdits, loadEdits, saveEdits } from "./arch-edits";
import type { DiagramEditState } from "./arch-edits";
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
  /** The stable edit key (from>to) - bends/label offsets live UPSTREAM in
   * the canvas's edit state so undo, persistence, and export all see them. */
  editKey?: string;
  bends?: FlowPoint[];
  labelOffset?: { dx: number; dy: number };
  onBendsChange?: (editKey: string, bends: FlowPoint[]) => void;
  onLabelOffsetChange?: (
    editKey: string,
    offset: { dx: number; dy: number } | undefined,
  ) => void;
  onGestureStart?: () => void;
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
 * BENDABLE with MULTIPLE waypoints (2026-07-30, was single-bend since
 * 2026-07-29): solid dots are bends - drag to move one, double-click to
 * remove it; hollow dots sit between neighbors - drag one to ADD a bend
 * there, adjusting a smaller section of the line. The route runs
 * orthogonally through every bend in order (right-angle segments, rounded
 * corners) while both ENDPOINTS stay attached to their nodes; dragged
 * points snap onto neighboring axes so near-straight runs become exactly
 * straight.
 */
function FlowingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<FlowEdge>) {
  const { screenToFlowPosition } = useReactFlow();
  // Bends and label offsets are CONTROLLED (2026-07-30): they live in the
  // canvas's shared edit state so undo/redo, persistence, and the exporter
  // all see the same arrangement.
  const bends = data?.bends ?? [];
  const editKey = data?.editKey ?? "";
  const commitBends = (next: FlowPoint[]): void =>
    data?.onBendsChange?.(editKey, next);
  const labelDragRef = useRef<{ start: FlowPoint; base: { dx: number; dy: number } } | null>(
    null,
  );

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
  // SEGMENT-BASED editing (2026-07-30 user report: via-point bends forced
  // a new right angle on every edit): bends store the INTERIOR CORNERS of
  // an orthogonal polyline. Each grab dot sits mid-SEGMENT and drags that
  // segment perpendicular to its axis - the neighboring segments stretch,
  // no corners are added. Releasing merges collinear corners, so dropping
  // a section back in line STRAIGHTENS it, and a fully straightened line
  // returns to the automatic route.
  const sourcePt: FlowPoint = { x: sourceX, y: sourceY };
  const targetPt: FlowPoint = { x: targetX, y: targetY };
  const corners = bends;
  const polyOf = (c: readonly FlowPoint[]): FlowPoint[] => [
    sourcePt,
    ...c,
    targetPt,
  ];
  if (corners.length > 0) {
    const route = polyOf(corners);
    edgePath = roundedOrthogonalPath(route);
    const anchor = polylineMidpoint(route);
    anchorX = anchor.x;
    anchorY = anchor.y;
  }

  const hasLabel = data?.label !== undefined && data.label !== "";
  const cost = data?.cost;

  const cleanupCorners = (c: readonly FlowPoint[]): FlowPoint[] => {
    const poly = polyOf(c);
    const kept: FlowPoint[] = [];
    for (let i = 1; i < poly.length - 1; i++) {
      const point = poly[i];
      const prev = kept.length > 0 ? kept[kept.length - 1] : poly[0];
      const next = poly[i + 1];
      const straightV =
        Math.abs(prev.x - point.x) < 3 && Math.abs(point.x - next.x) < 3;
      const straightH =
        Math.abs(prev.y - point.y) < 3 && Math.abs(point.y - next.y) < 3;
      const tiny = Math.hypot(point.x - prev.x, point.y - prev.y) < 3;
      if (!straightV && !straightH && !tiny) {
        kept.push(point);
      }
    }
    return kept;
  };

  const dragRef = useRef<{ cornerIndex: number; horizontal: boolean } | null>(null);
  const beginSegmentDrag = (segIndex: number, event: React.PointerEvent): void => {
    event.stopPropagation();
    data?.onGestureStart?.();
    // Seed a clean step route the first time an automatic line is grabbed.
    let c: FlowPoint[];
    let seg: number;
    if (corners.length === 0) {
      const midX = (sourceX + targetX) / 2;
      c = [
        { x: midX, y: sourceY },
        { x: midX, y: targetY },
      ];
      seg = 1;
    } else {
      c = [...corners];
      seg = segIndex;
    }
    // Normalize: the dragged segment needs interior corners on BOTH sides,
    // so endpoint-adjacent segments grow a short stub corner first.
    let poly = polyOf(c);
    if (seg === 0) {
      const dirX = Math.sign(poly[1].x - poly[0].x);
      const dirY = Math.sign(poly[1].y - poly[0].y);
      c = [
        { x: sourceX + dirX * 24, y: sourceY + dirY * 24 },
        ...c,
      ];
      seg += 1;
      poly = polyOf(c);
    }
    if (seg === poly.length - 2) {
      const n = poly.length;
      const dirX = Math.sign(poly[n - 1].x - poly[n - 2].x);
      const dirY = Math.sign(poly[n - 1].y - poly[n - 2].y);
      c = [...c, { x: targetX - dirX * 24, y: targetY - dirY * 24 }];
      poly = polyOf(c);
    }
    const horizontal = Math.abs(poly[seg].y - poly[seg + 1].y) < 0.5;
    commitBends(c);
    dragRef.current = { cornerIndex: seg - 1, horizontal };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };
  const segmentDragMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const c = [...corners];
    const j = drag.cornerIndex;
    if (c[j] === undefined || c[j + 1] === undefined) {
      return;
    }
    if (drag.horizontal) {
      const y = snapTo(point.y, [sourceY, targetY]);
      c[j] = { ...c[j], y };
      c[j + 1] = { ...c[j + 1], y };
    } else {
      const x = snapTo(point.x, [sourceX, targetX]);
      c[j] = { ...c[j], x };
      c[j + 1] = { ...c[j + 1], x };
    }
    commitBends(c);
  };
  const segmentDragEnd = (event: React.PointerEvent): void => {
    if (dragRef.current !== null) {
      commitBends(cleanupCorners(corners));
    }
    dragRef.current = null;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
  };

  // One grab dot per SEGMENT of the edited polyline; unbent lines show a
  // single dot at the label anchor (grabbing it seeds the step route).
  const editPoly = polyOf(corners);
  const segmentDots: FlowPoint[] =
    corners.length > 0
      ? editPoly.slice(0, -1).map((a, i) => ({
          x: (a.x + editPoly[i + 1].x) / 2,
          y: (a.y + editPoly[i + 1].y) / 2,
        }))
      : [{ x: anchorX, y: anchorY + (hasLabel || cost !== undefined ? 24 : 0) }];
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
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
          title="Drag to nudge this label; double-click to snap it back"
          style={{
            transform: `translate(-50%, -50%) translate(${anchorX + (data?.labelOffset?.dx ?? 0)}px, ${anchorY + (data?.labelOffset?.dy ?? 0)}px)`,
            pointerEvents: "all",
            cursor: "grab",
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            data?.onGestureStart?.();
            labelDragRef.current = {
              start: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              base: data?.labelOffset ?? { dx: 0, dy: 0 },
            };
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = labelDragRef.current;
            if (drag === null) {
              return;
            }
            const point = screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            data?.onLabelOffsetChange?.(editKey, {
              dx: drag.base.dx + point.x - drag.start.x,
              dy: drag.base.dy + point.y - drag.start.y,
            });
          }}
          onPointerUp={(event) => {
            labelDragRef.current = null;
            (event.target as HTMLElement).releasePointerCapture(event.pointerId);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            data?.onGestureStart?.();
            data?.onLabelOffsetChange?.(editKey, undefined);
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
        {segmentDots.map((point, index) => (
          <div
            key={`seg-${index}`}
            className="arch-flow-bend-dot nodrag nopan"
            title="Drag to move this section (neighbors stretch); drop it in line to straighten; double-click to remove its corners"
            style={{
              transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`,
            }}
            onPointerDown={(event) => beginSegmentDrag(index, event)}
            onPointerMove={segmentDragMove}
            onPointerUp={segmentDragEnd}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (corners.length === 0) {
                return;
              }
              data?.onGestureStart?.();
              commitBends(
                cleanupCorners(
                  corners.filter((_, i) => i !== index - 1 && i !== index),
                ),
              );
            }}
          />
        ))}
      </EdgeLabelRenderer>
    </>
  );
}

type NoteData = {
  text: string;
  onChangeText: (noteId: string, text: string) => void;
  onRemove: (noteId: string) => void;
};
type NoteNode = Node<NoteData, "note">;
type CanvasNode = ArchNode | NoteNode;

/** A free-text annotation sticky (2026-07-30 ergonomics slice): drag to
 * place, double-click to edit, x to remove. Exports with the diagram. */
function NoteCard({ id, data }: NodeProps<NoteNode>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.text);
  const noteId = id.startsWith("note:") ? id.slice("note:".length) : id;
  return (
    <div className="arch-flow-note" onDoubleClick={() => setEditing(true)}>
      {editing ? (
        <textarea
          className="arch-flow-note-editor nodrag nopan"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            data.onChangeText(noteId, draft);
          }}
        />
      ) : (
        <span className="arch-flow-note-text">
          {data.text === "" ? "Double-click to edit this note" : data.text}
        </span>
      )}
      <button
        type="button"
        className="arch-flow-remove-btn nodrag nopan"
        aria-label="Remove this note"
        onClick={(event) => {
          event.stopPropagation();
          data.onRemove(noteId);
        }}
      >
        x
      </button>
    </div>
  );
}

// Defined at module scope: React Flow warns if these objects are recreated per
// render (it treats them as new type maps).
const NODE_TYPES = { arch: ArchNodeCard, note: NoteCard };
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

/** The arrowhead color follows the pipe: cost/tone tinted, muted faint. */
function edgeMarkerColor(e: LaidOutEdge): string {
  if (e.muted === true) {
    return "var(--border)";
  }
  if (e.tone === "search") {
    return "#9254de";
  }
  if (e.cost === "premium") {
    return "var(--warn)";
  }
  if (e.cost === "economical") {
    return "var(--ok)";
  }
  return "var(--accent)";
}

/** Adapt the shared dagre layout (arch-layout) to React Flow's shapes. */
function layoutGraph(
  diagram: PatternDiagram,
  targetAspect: number,
): { nodes: ArchNode[]; edges: FlowEdge[]; laidOut: LaidOutDiagram } {
  const laidOut = layoutDiagram(diagram, targetAspect);
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
      // Arrowheads (2026-07-30 best-practices pass): direction must read at
      // a glance and in static captures - the packet animation alone fails
      // a paused look and every screenshot.
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 13,
        height: 13,
        color: edgeMarkerColor(e),
      },
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
  return { nodes, edges, laidOut };
}

export interface ArchitectureFlowProps {
  diagram: PatternDiagram;
  /** Toggle a node's exploded rendering (nodes with expandable=true). */
  onToggleNodeExpand?: (nodeId: string) => void;
  /**
   * Persist canvas edits under this key (localStorage): arrangements
   * survive tab switches and reloads per diagram. Absent = session-only.
   */
  storageKey?: string;
  /** Latest edit state, for the exporter (what you arranged is exported). */
  onCanvasStateChange?: (state: DiagramEditState) => void;
}

/** The interactive canvas. Empty diagrams render nothing (caller shows a hint). */
export function ArchitectureFlow({
  diagram,
  onToggleNodeExpand,
  storageKey,
  onCanvasStateChange,
}: ArchitectureFlowProps) {
  // ONE edit state (2026-07-30 ergonomics slice): positions, bends, label
  // offsets, removals, notes - snapshotted for undo/redo, persisted per
  // storageKey, and handed to the exporter.
  const [edits, setEdits] = useState<DiagramEditState>(emptyEdits());
  const historyRef = useRef<DiagramEditState[]>([]);
  const redoRef = useRef<DiagramEditState[]>([]);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  // Snapshot BEFORE a gesture/operation begins; redo clears on new work.
  const beginGesture = useCallback(() => {
    historyRef.current.push(editsRef.current);
    if (historyRef.current.length > 50) {
      historyRef.current.shift();
    }
    redoRef.current = [];
  }, []);

  // Load persisted edits per diagram key; no key = reset on diagram change.
  useEffect(() => {
    historyRef.current = [];
    redoRef.current = [];
    setEdits(
      (storageKey !== undefined ? loadEdits(storageKey) : null) ?? emptyEdits(),
    );
  }, [storageKey, diagram]);
  // Persist (debounced) and surface the latest state for exports.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    onCanvasStateChange?.(edits);
    if (storageKey === undefined) {
      return;
    }
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveEdits(storageKey, edits), 400);
    return () => clearTimeout(saveTimerRef.current);
  }, [edits, storageKey, onCanvasStateChange]);

  const removeNode = useCallback(
    (nodeId: string) => {
      beginGesture();
      setEdits((prev) => ({
        ...prev,
        removedNodes: [...new Set([...prev.removedNodes, nodeId])],
      }));
    },
    [beginGesture],
  );

  const effective = useMemo(
    () =>
      applyDiagramRemovals(
        diagram,
        new Set(edits.removedNodes),
        new Set(edits.removedEdges),
      ),
    [diagram, edits.removedNodes, edits.removedEdges],
  );

  // The REAL canvas aspect steers the serpentine wrap (measured by the
  // same ResizeObserver that triggers re-fits; rounded so tiny resizes do
  // not thrash the layout).
  const [canvasAspect, setCanvasAspect] = useState(2.4);
  const layouted = useMemo(() => {
    const graph = layoutGraph(effective, canvasAspect);
    return {
      nodes: graph.nodes.map((n) => ({
        ...n,
        data: { ...n.data, onRemove: removeNode, onToggleExpand: onToggleNodeExpand },
      })),
      edges: graph.edges,
      laidOut: graph.laidOut,
    };
  }, [effective, removeNode, onToggleNodeExpand, canvasAspect]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(
    layouted.nodes as CanvasNode[],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(layouted.edges);

  // Per-edge edit callbacks (stable): bends and label offsets commit into
  // the shared edit state.
  const handleBendsChange = useCallback((key: string, bends: FlowPoint[]) => {
    setEdits((prev) => ({
      ...prev,
      edges: {
        ...prev.edges,
        [key]: { ...(prev.edges[key] ?? { bends: [] }), bends },
      },
    }));
  }, []);
  const handleLabelOffsetChange = useCallback(
    (key: string, offset: { dx: number; dy: number } | undefined) => {
      setEdits((prev) => {
        const existing = prev.edges[key] ?? { bends: [] };
        return {
          ...prev,
          edges: {
            ...prev.edges,
            [key]:
              offset === undefined
                ? { bends: existing.bends }
                : { ...existing, labelOffset: offset },
          },
        };
      });
    },
    [],
  );
  const changeNoteText = useCallback(
    (noteId: string, text: string) => {
      beginGesture();
      setEdits((prev) => ({
        ...prev,
        notes: prev.notes.map((n) => (n.id === noteId ? { ...n, text } : n)),
      }));
    },
    [beginGesture],
  );
  const removeNote = useCallback(
    (noteId: string) => {
      beginGesture();
      setEdits((prev) => ({
        ...prev,
        notes: prev.notes.filter((n) => n.id !== noteId),
      }));
    },
    [beginGesture],
  );

  // Re-seed when the layout OR the edits change: layouted cards pick up the
  // dragged positions, edges pick up their bends/label offsets, and notes
  // join as free-floating nodes.
  useEffect(() => {
    const arch: CanvasNode[] = layouted.nodes.map((n) => {
      const p = edits.positions[n.id];
      return p !== undefined ? { ...n, position: { x: p.x, y: p.y } } : n;
    });
    const noteNodes: CanvasNode[] = edits.notes.map((note) => ({
      id: `note:${note.id}`,
      type: "note",
      position: { x: note.x, y: note.y },
      data: { text: note.text, onChangeText: changeNoteText, onRemove: removeNote },
    }));
    setNodes([...arch, ...noteNodes]);
    setEdges(
      layouted.edges.map((e) => {
        const key = edgeKey({ from: e.source, to: e.target });
        const edit = edits.edges[key];
        return {
          ...e,
          data: {
            ...e.data,
            editKey: key,
            bends: edit?.bends,
            labelOffset: edit?.labelOffset,
            onBendsChange: handleBendsChange,
            onLabelOffsetChange: handleLabelOffsetChange,
            onGestureStart: beginGesture,
          },
        };
      }),
    );
  }, [
    layouted,
    edits,
    setNodes,
    setEdges,
    handleBendsChange,
    handleLabelOffsetChange,
    changeNoteText,
    removeNote,
    beginGesture,
  ]);

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
      resizeTimerRef.current = setTimeout(() => {
        setResizeTick((t) => t + 1);
        if (el.clientHeight > 0) {
          setCanvasAspect(
            Math.round((el.clientWidth / el.clientHeight) * 10) / 10,
          );
        }
      }, 150);
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

  const removedCount = edits.removedNodes.length + edits.removedEdges.length;

  // Start fresh (user request 2026-07-30): one button clears EVERY canvas
  // edit and re-fits the pristine layout. Undo can bring the edits back.
  const [resetCount, setResetCount] = useState(0);
  const resetCanvas = useCallback(() => {
    beginGesture();
    setEdits(emptyEdits());
    setResetCount((count) => count + 1);
  }, [beginGesture]);

  // Undo/redo (Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z) over the whole edit state.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        const previous = historyRef.current.pop();
        if (previous !== undefined) {
          redoRef.current.push(editsRef.current);
          setEdits(previous);
          event.preventDefault();
        }
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        const next = redoRef.current.pop();
        if (next !== undefined) {
          historyRef.current.push(editsRef.current);
          setEdits(next);
          event.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const addNote = useCallback(() => {
    beginGesture();
    setEdits((prev) => ({
      ...prev,
      notes: [
        ...prev.notes,
        {
          id: `${prev.notes.length + 1}-${resetCount}-${prev.notes.map((n) => n.id).join("").length}`,
          text: "",
          x: 24 + prev.notes.length * 28,
          y: 24 + prev.notes.length * 22,
        },
      ],
    }));
  }, [beginGesture, resetCount]);

  if (diagram.nodes.length === 0) return null;

  if (effective.nodes.length === 0) {
    return (
      <div className="arch-flow-restore-row">
        <span className="field-hint">Everything was removed from the diagram.</span>
        <button
          type="button"
          className="arch-export-btn"
          onClick={() => {
            beginGesture();
            setEdits((prev) => ({ ...prev, removedNodes: [], removedEdges: [] }));
          }}
        >
          Restore the diagram
        </button>
      </div>
    );
  }

  return (
    <div className="arch-flow-canvas" ref={canvasRef} key={resetCount}>
      <div className="arch-flow-restore-row arch-flow-restore-overlay">
        <button
          type="button"
          className="arch-export-btn"
          title="Start fresh: undo drags, bent lines, labels, notes, and removals (Ctrl+Z undoes the reset)"
          onClick={resetCanvas}
        >
          Reset diagram
        </button>
        <button
          type="button"
          className="arch-export-btn"
          title="Add a free-text annotation to the canvas"
          onClick={addNote}
        >
          Add note
        </button>
        {removedCount > 0 && (
          <button
            type="button"
            className="arch-export-btn"
            onClick={() => {
              beginGesture();
              setEdits((prev) => ({
                ...prev,
                removedNodes: [],
                removedEdges: [],
              }));
            }}
          >
            Restore {removedCount} removed item{removedCount === 1 ? "" : "s"}
          </button>
        )}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={() => beginGesture()}
        onNodeDragStop={(_event, _node, draggedNodes) => {
          setEdits((prev) => {
            const positions = { ...prev.positions };
            let notes = prev.notes;
            for (const dragged of draggedNodes) {
              if (dragged.id.startsWith("note:")) {
                const noteId = dragged.id.slice("note:".length);
                notes = notes.map((n) =>
                  n.id === noteId
                    ? { ...n, x: dragged.position.x, y: dragged.position.y }
                    : n,
                );
              } else {
                positions[dragged.id] = {
                  x: dragged.position.x,
                  y: dragged.position.y,
                };
              }
            }
            return { ...prev, positions, notes };
          });
        }}
        onNodesDelete={(deleted) => {
          beginGesture();
          setEdits((prev) => ({
            ...prev,
            removedNodes: [
              ...new Set([
                ...prev.removedNodes,
                ...deleted
                  .filter((n) => !n.id.startsWith("note:"))
                  .map((n) => n.id),
              ]),
            ],
            notes: prev.notes.filter(
              (note) => !deleted.some((n) => n.id === `note:${note.id}`),
            ),
          }));
        }}
        onEdgesDelete={(deleted) => {
          beginGesture();
          setEdits((prev) => ({
            ...prev,
            removedEdges: [
              ...new Set([
                ...prev.removedEdges,
                ...deleted.map((e) => edgeKey({ from: e.source, to: e.target })),
              ]),
            ],
          }));
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
        snapToGrid
        snapGrid={[12, 12]}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control"]}
        proOptions={{ hideAttribution: true }}
      >
        <FitViewController signature={fitSignature} />
        {/* Stage bands + serpentine row dividers: descriptive underlays in
            flow coordinates, behind the cards (Gestalt grouping and wrap
            continuation cues - 2026-07-30 best-practices pass). */}
        <ViewportPortal>
          {layouted.laidOut.bands?.map((band) => (
            <div
              key={`${band.label}-${Math.round(band.left)}`}
              className="arch-flow-band"
              style={{
                left: band.left,
                top: -34,
                width: band.right - band.left,
                height: layouted.laidOut.height + 34,
              }}
            >
              <span className="arch-flow-band-label">{band.label}</span>
            </div>
          ))}
          {layouted.laidOut.rowDividers?.map((y) => (
            <div
              key={Math.round(y)}
              className="arch-flow-row-divider"
              style={{ left: -10, top: y, width: layouted.laidOut.width + 20 }}
            />
          ))}
        </ViewportPortal>
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
