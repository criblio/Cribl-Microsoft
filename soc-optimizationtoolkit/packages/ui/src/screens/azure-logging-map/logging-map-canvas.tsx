/**
 * LoggingMapCanvas - the Azure Logging Map diagram (AZR-19, phase 1,
 * READ-ONLY): hand-written SVG over the top-to-bottom dagre layout in
 * logging-map-layout.ts. Props only; no fetching, no app context.
 *
 * Follows the house diagram standard (claude-kit
 * standards/cribl-dataflow-diagram.md, ported from its reference
 * FlowDiagram.tsx), including its "Movable cards" rule (AZR-20, the owner's
 * answer to the drag-vs-mockup decision):
 * - Every card can be dragged once the pointer travels the shared
 *   DRAG_THRESHOLD_PX; below it a press is a click and selects. The shared
 *   useCardDrag holds the positions and `applyPositions` (layout) is the one
 *   seam they feed: it re-draws a moved card's edges between the anchors.
 * - "Reset layout" returns every card to the computed layout. A new layout
 *   (collapse, fold, a filter) also drops them, because they were placed
 *   against the old tree; a drag itself never re-fits the view.
 * - Positions are SESSION-ONLY component state: the standard persists them
 *   only when the owner asks, and then in the KV store, never browser storage.
 * - A drag never remounts the card element, so it keeps its focus and its
 *   sibling (i); only the click that ends a drag is swallowed, so Enter and
 *   Space still select a dragged, focused card. Dragging changes no status,
 *   count or chip. Panning the empty canvas is unchanged.
 *
 * Deliberate differences from the standard:
 * - NO ANIMATION. Policy coverage is configuration, not measured flow, and
 *   the standard animates only measured flow.
 * - No arrowheads: a top-to-bottom tree reads parent above child.
 *
 * Kept from the standard: every card is keyboard-reachable (role=button,
 * tabIndex 0, Enter/Space selects, aria-pressed), every card carries a
 * visible (i) as a SIBLING (nested interactive roles are invalid) with a
 * ~1.5x hit circle, the (i) opens a role=dialog popover that closes on an
 * outside pointerdown, Escape, wheel, zoom and fit; SVG ids are scoped with
 * useId(); fit floors the zoom at a legible 0.55; every colour is a class
 * whose value is a var(--...) token in styles.css.
 *
 * The viewport (pan, zoom, wheel, fit), the (i) circle and the popover's
 * dismissal come from the shared diagram shell in components/diagram
 * (AZR-30), so this canvas and the onboarding dataflow share one engine. It
 * passes its own lm-* class names, uses the shell's card drag, and does not
 * use its animated edge.
 *
 * Every state is drawn with more than colour (the mockup's visual encoding):
 * ours is a solid chip with an "ours" pill, other owners a grey chip,
 * inherited a dotted italic chip saying where it is from, excluded or exempt
 * a hatch plus a pill, unreadable a dashed card with a lock note, and the
 * remaining gap states each have their own pill.
 */

import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import { DiagramInfoPopover, InfoHitCircle, useCardDrag, useDiagramViewport } from "../../components/diagram";
import {
  CARD,
  CARD_LINE_CHARS,
  MAX_CHIPS,
  NODE_W,
  applyPositions,
  edgeAnchors,
  edgePath,
  fitLine,
  layoutLoggingMap,
  type LaidOutCard,
} from "./logging-map-layout";
import {
  diagramGraph,
  formatCount,
  scopeChips,
  traceView,
  type LoggingMapUiState,
  type ScopeChip,
  type TraceMark,
  type UiLoggingMap,
} from "./logging-map-state";
import {
  ASSIGNMENTS_REFUSED,
  EXEMPTIONS_REFUSED,
  KIND_HEADER,
  KIND_WORD,
  LOCK_NOTE,
  MARK_LABEL,
  classPill,
  coveragePill,
  isUnreadable,
  readRoleFor,
  unreadSentence,
} from "./logging-map-copy";

export interface LoggingMapCanvasProps {
  readonly map: UiLoggingMap;
  readonly state: LoggingMapUiState;
  readonly onSelect: (scopeId: string) => void;
  /** A count card standing in for a collapsed group was activated. */
  readonly onToggleCollapsed: (scopeId: string) => void;
  /** A count card standing in for folded subscriptions was activated. */
  readonly onToggleFolded: (scopeId: string) => void;
}

/** A press on any of these starts no pan (a press on a card may start a card drag instead). */
const PAN_IGNORE = "[data-lm-card], [data-lm-info], [data-lm-caret], [data-lm-popover]";
/** A pointerdown on these leaves the popover open (the (i) toggles it itself). */
const POPOVER_KEEP = "[data-lm-popover], [data-lm-info]";
const INFO_CLASSES = { group: "lm-info", hit: "lm-info-hit", glyph: "lm-info-glyph", letter: "lm-info-i" } as const;
const INFO_ATTRS = { "data-lm-info": "" } as const;
const POPOVER_ATTRS = { "data-lm-popover": "" } as const;

function exemptionsUnknown(map: UiLoggingMap, scopeId: string): boolean {
  const n = map.nodesById.get(scopeId);
  return n !== undefined && n.node.kind !== "placeholder" && n.node.treeRole !== "unread-origin"
    && n.exemptions.kind === "empty";
}

/** A combined pill longer than this keeps only its gap state (chip room is short). */
const MAX_COMBINED_PILL = 22;

/**
 * The pill a chip carries, or null. The gap state at this scope comes first,
 * for set-here chips as well as inherited ones: an assignment set directly on
 * a subscription can be conditional, partial or exempt there too. A set-here
 * chip adds its ownership (or unclassified) pill after the gap when both fit;
 * when room is short the gap wins, and ownership is still told by the chip's
 * solid or grey fill and in the details panel.
 */
function chipPill(chip: ScopeChip): string | null {
  const gap = coveragePill(chip.coverage);
  const own = chip.inherited
    ? null
    : chip.entry.ownership?.owner === "ours"
      ? chip.entry.ownership.strength === "name-only" ? "name match" : "ours"
      : null;
  const second = own ?? classPill(chip.entry.classification);
  if (gap === null) return second;
  if (second === null) return gap;
  const both = `${gap} | ${second}`;
  return both.length <= MAX_COMBINED_PILL ? both : gap;
}

function chipClass(chip: ScopeChip): string {
  if (chip.inherited) return "lm-chip lm-chip-inherited";
  return chip.entry.ownership?.owner === "ours" ? "lm-chip lm-chip-ours" : "lm-chip lm-chip-other";
}

function chipText(map: UiLoggingMap, chip: ScopeChip, room: number): string {
  const a = chip.entry.assignment;
  const name = a.displayName !== "" ? a.displayName : a.name;
  if (!chip.inherited) return fitLine(name, room);
  const origin = map.tree.byId.get(chip.originId)?.displayName ?? chip.originId;
  return fitLine(`${name} from ${origin}`, room);
}

function markClass(mark: TraceMark | undefined): string {
  return mark === undefined ? "" : ` lm-mark-${mark}`;
}

/** The status line under a card's name. */
function statusLine(map: UiLoggingMap, card: LaidOutCard, mark: TraceMark | undefined): string {
  if (card.kind === "count") return "select to show";
  const n = map.nodesById.get(card.scopeId);
  if (n === undefined) return "";
  if (isUnreadable(map, card.scopeId)) return LOCK_NOTE;
  if (mark !== undefined) return MARK_LABEL[mark];
  if (n.node.kind === "placeholder") return "where these sit is unknown";
  if (exemptionsUnknown(map, card.scopeId)) return "exemptions unknown";
  return fitLine(n.node.name, CARD_LINE_CHARS);
}

function cardLabel(map: UiLoggingMap, card: LaidOutCard, mark: TraceMark | undefined): string {
  if (card.kind === "count") return `Show ${card.title}`;
  const n = map.nodesById.get(card.scopeId);
  if (n === undefined) return card.title;
  const parts = [card.title, KIND_WORD[n.node.kind]];
  if (isUnreadable(map, card.scopeId)) parts.push("can't be read");
  if (mark !== undefined) parts.push(MARK_LABEL[mark]);
  return parts.join(", ");
}

/** The facts the (i) popover lists for a scope card. */
function popoverFacts(map: UiLoggingMap, scopeId: string): string[] {
  const n = map.nodesById.get(scopeId);
  if (n === undefined) return [];
  const facts: string[] = [];
  const unread = unreadSentence(n.node, n.assignments.kind === "empty" && n.node.kind !== "placeholder");
  if (unread !== null) facts.push(unread);
  if (n.node.kind === "placeholder") return facts;
  if (n.node.treeRole !== "unread-origin") {
    facts.push(
      n.assignments.kind === "empty"
        ? `${ASSIGNMENTS_REFUSED} ${readRoleFor(n.node.kind)}`
        : `Assignments that apply here: ${n.assignments.kind === "none" ? "none" : formatCount(n.assignmentCount)}.`,
    );
    facts.push(
      n.exemptions.kind === "empty"
        ? `${EXEMPTIONS_REFUSED} ${readRoleFor(n.node.kind)}`
        : `Exemptions: ${n.exemptions.kind === "none" ? "none" : formatCount(n.exemptionCount)}.`,
    );
  }
  // A refused assignments read (or an origin seen only from below) has no
  // verified set-here figure: what is known came from scopes beneath.
  const setHereKnown = n.assignments.kind !== "empty" && n.node.treeRole !== "unread-origin";
  facts.push(
    setHereKnown
      ? `Set here: ${n.setHere.length}. Select the card for details.`
      : n.setHere.length > 0
        ? `Set here: at least ${n.setHere.length}, seen from scopes below. Select the card for details.`
        : "Set here: unknown. Select the card for details.",
  );
  return facts;
}

export function LoggingMapCanvas({ map, state, onSelect, onToggleCollapsed, onToggleFolded }: LoggingMapCanvasProps) {
  // Only what changes the drawing feeds the layout: selecting or tracing must
  // not re-run dagre (and so must not re-fit the view under the operator).
  const { collapsed, folded, showAll, showInherited } = state;
  const graph = useMemo(
    () => diagramGraph(map, { ...state, collapsed, folded, showAll, showInherited }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `state` is read only for the four fields listed
    [map, collapsed, folded, showAll, showInherited],
  );
  // The computed layout; hand-placed positions are applied over it below.
  const laid = useMemo(() => layoutLoggingMap(graph), [graph]);
  const marks = useMemo(() => traceView(map, { tracedAssignment: state.tracedAssignment }), [map, state.tracedAssignment]);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const hatchId = `${uid}-hatch`;
  const [infoId, setInfoId] = useState<string | null>(null);

  const closeInfo = useCallback(() => setInfoId(null), []);

  // Panning the EMPTY canvas only (PAN_IGNORE): a press that lands on a card,
  // its (i) or its caret starts no pan; on a card it may start a card drag.
  // Every zoom, wheel, fit, pan and drag start closes the popover.
  const viewport = useDiagramViewport({ layout: laid, onViewChange: closeInfo, panIgnoreSelector: PAN_IGNORE });
  const { containerRef, view, fit, fitTo } = viewport;
  const drag = useCardDrag({ zoom: view.k, onDragStart: closeInfo });
  const { reset: resetDrag } = drag;
  // THE seam: the computed layout with the hand-placed cards applied. Edges
  // are drawn from these cards, so they follow a dragged card.
  const drawn = useMemo(() => applyPositions(laid, drag.positions), [laid, drag.positions]);
  const cardsById = useMemo(() => new Map(drawn.cards.map((c) => [c.id, c])), [drawn.cards]);

  // Re-fit only when the computed layout changes (collapse, fold, filters),
  // never on a drag; positions placed against the old tree are dropped.
  useEffect(() => {
    resetDrag();
    fit();
    closeInfo();
  }, [laid, resetDrag, fit, closeInfo]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.onPointerMove(e)) viewport.panHandlers.onPointerMove(e);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    drag.endDrag(e);
    viewport.panHandlers.onPointerUp(e);
  };

  const activate = (card: LaidOutCard) => {
    if (card.kind === "count") {
      const row = graphCard(card.id);
      if (row?.countOf === "folded") onToggleFolded(card.scopeId);
      else onToggleCollapsed(card.scopeId);
      return;
    }
    onSelect(card.scopeId);
  };
  const graphCard = (id: string) => graph.cards.find((c) => c.id === id);
  const onCardKey = (e: KeyboardEvent<SVGGElement>, card: LaidOutCard) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate(card);
  };
  const toggleInfo = (id: string) => setInfoId((cur) => (cur === id ? null : id));

  if (drawn.cards.length === 0) {
    return <div className="lm-canvas-empty">No scope could be listed, so there is nothing to draw.</div>;
  }

  const infoCard = infoId === null ? undefined : cardsById.get(infoId);

  return (
    <div className="lm-canvas-root">
      <div className="lm-zoom" role="group" aria-label="Zoom">
        <button type="button" className="lm-btn" aria-label="Zoom out" onClick={viewport.zoomOut}>
          -
        </button>
        {/* Fit frames what is drawn, moved cards included. */}
        <button type="button" className="lm-btn" onClick={() => fitTo(drawn)}>
          Fit
        </button>
        <button type="button" className="lm-btn" aria-label="Zoom in" onClick={viewport.zoomIn}>
          +
        </button>
        <button type="button" className="lm-btn" onClick={resetDrag} disabled={!drag.hasMoved}>
          Reset layout
        </button>
      </div>
      <div
        ref={containerRef}
        className="lm-canvas"
        onWheel={viewport.onWheel}
        onPointerDown={viewport.panHandlers.onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <svg width="100%" height="100%" role="group" aria-label="Management group tree with policy assignments">
          <defs>
            <pattern id={hatchId} width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={8} height={8} className="lm-hatch-bg" />
              <line x1={0} y1={0} x2={0} y2={8} className="lm-hatch-line" />
            </pattern>
          </defs>
          <g data-lm-viewport="" transform={viewport.transform}>
            {drawn.edges.map((edge) => {
              const from = cardsById.get(edge.from);
              const to = cardsById.get(edge.to);
              if (from === undefined || to === undefined) return null;
              const { start, end } = edgeAnchors(from, to);
              return <path key={`${edge.from}>${edge.to}`} className="lm-edge" d={edgePath(edge.points, start, end)} />;
            })}
            {drawn.cards.map((card) => (
              <CardGroup
                key={card.id}
                map={map}
                state={state}
                card={card}
                mark={marks?.get(card.scopeId)}
                hatchId={hatchId}
                infoOpen={infoId === card.id}
                onActivate={() => {
                  // The click that ends a drag is swallowed; Enter/Space are not.
                  if (!drag.wasDragged()) activate(card);
                }}
                onPointerDown={(e) => drag.onCardPointerDown(e, card.id, { x: card.x, y: card.y })}
                onKey={(e) => onCardKey(e, card)}
                onToggleInfo={() => toggleInfo(card.id)}
                onToggleCollapsed={() => onToggleCollapsed(card.scopeId)}
              />
            ))}
          </g>
        </svg>
        {infoCard !== undefined && (
          <DiagramInfoPopover
            className="lm-popover"
            attrs={POPOVER_ATTRS}
            label={`About ${infoCard.title}`}
            left={view.x + (infoCard.x + infoCard.width) * view.k + 8}
            top={view.y + infoCard.y * view.k}
            onClose={closeInfo}
            keepOpenSelector={POPOVER_KEEP}
          >
            <div className="lm-popover-kind">
              {infoCard.kind === "count"
                ? "HIDDEN SCOPES"
                : KIND_HEADER[map.nodesById.get(infoCard.scopeId)?.node.kind ?? "placeholder"]}
            </div>
            <div className="lm-popover-title">{infoCard.title}</div>
            {infoCard.kind === "scope" && <div className="lm-popover-id">{infoCard.scopeId}</div>}
            <ul className="lm-popover-facts">
              {(infoCard.kind === "count"
                ? [`${infoCard.title} are hidden behind this count to keep the tree readable. Select the card, or use the outline, to show them.`]
                : popoverFacts(map, infoCard.scopeId)
              ).map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
            <button type="button" className="lm-btn lm-popover-close" aria-label="Close" onClick={closeInfo}>
              x
            </button>
          </DiagramInfoPopover>
        )}
      </div>
    </div>
  );
}

interface CardGroupProps {
  readonly map: UiLoggingMap;
  readonly state: LoggingMapUiState;
  readonly card: LaidOutCard;
  readonly mark: TraceMark | undefined;
  readonly hatchId: string;
  readonly infoOpen: boolean;
  readonly onActivate: () => void;
  readonly onPointerDown: (e: PointerEvent<SVGGElement>) => void;
  readonly onKey: (e: KeyboardEvent<SVGGElement>) => void;
  readonly onToggleInfo: () => void;
  readonly onToggleCollapsed: () => void;
}

function CardGroup({
  map,
  state,
  card,
  mark,
  hatchId,
  infoOpen,
  onActivate,
  onPointerDown,
  onKey,
  onToggleInfo,
  onToggleCollapsed,
}: CardGroupProps) {
  const node = map.nodesById.get(card.scopeId)?.node;
  const isCount = card.kind === "count";
  const selected = !isCount && state.selectedScope === card.scopeId;
  const unread = !isCount && isUnreadable(map, card.scopeId);
  const kindClass = isCount ? " lm-card-count" : ` lm-card-${node?.kind ?? "placeholder"}`;
  const gapped = mark === "gap-excluded" || mark === "gap-exempt";
  const cls = `lm-card${kindClass}${selected ? " is-selected" : ""}${unread ? " is-unread" : ""}${markClass(mark)}`;
  const chips = isCount ? [] : scopeChips(map, state, card.scopeId);
  const shownChips = chips.length > MAX_CHIPS ? chips.slice(0, MAX_CHIPS - 1) : chips;
  const more = chips.length - shownChips.length;
  const nameTop = card.y + CARD.headerH + CARD.padY + CARD.lineH - 3;
  const statusY = card.y + CARD.headerH + CARD.padY + card.labelLines.length * CARD.lineH + CARD.metaH - 3;
  const chipTop = card.y + CARD.headerH + CARD.padY + card.labelLines.length * CARD.lineH + CARD.metaH + 2;
  const infoX = card.x + card.width - 12;
  const infoY = card.y + CARD.headerH / 2;
  const hasChildren = !isCount && (map.tree.childrenOf.get(card.scopeId)?.length ?? 0) > 0;
  const collapsed = state.collapsed.has(card.scopeId);
  const header = isCount ? "HIDDEN" : KIND_HEADER[node?.kind ?? "placeholder"];

  return (
    <g data-lm-card-group={card.id}>
      <g
        className={cls}
        data-lm-card={card.id}
        role="button"
        tabIndex={0}
        aria-label={cardLabel(map, card, mark)}
        aria-pressed={isCount ? undefined : selected}
        onClick={onActivate}
        onPointerDown={onPointerDown}
        onKeyDown={onKey}
      >
        <rect className="lm-card-box" x={card.x} y={card.y} width={card.width} height={card.height} rx={8} />
        {gapped && (
          <rect
            className="lm-card-hatch"
            x={card.x}
            y={card.y}
            width={card.width}
            height={card.height}
            rx={8}
            fill={`url(#${hatchId})`}
          />
        )}
        <rect className="lm-card-header" x={card.x + 1} y={card.y + 1} width={card.width - 2} height={CARD.headerH} rx={7} />
        <text className="lm-card-kind" x={card.x + 10} y={card.y + 14}>
          {header}
        </text>
        <text className="lm-card-name">
          {card.labelLines.map((line, i) => (
            <tspan key={i} x={card.x + 10} y={nameTop + i * CARD.lineH}>
              {line}
            </tspan>
          ))}
        </text>
        <text className={unread ? "lm-card-status lm-card-lock" : "lm-card-status"} x={card.x + 10} y={statusY}>
          {statusLine(map, card, mark)}
        </text>
        {shownChips.map((chip, i) => {
          const pill = chipPill(chip);
          const room = pill === null ? CARD_LINE_CHARS - 2 : Math.max(8, CARD_LINE_CHARS - 4 - pill.length);
          const top = chipTop + i * (CARD.chipH + CARD.chipGap);
          return (
            <g key={`${chip.entry.assignmentKey}-${chip.inherited ? "i" : "s"}`} className={chipClass(chip)} data-lm-chip="">
              <rect x={card.x + 8} y={top} width={NODE_W - 16} height={CARD.chipH} rx={4} />
              <text className="lm-chip-text" x={card.x + 14} y={top + 12.5}>
                {chipText(map, chip, room)}
              </text>
              {pill !== null && (
                <text className="lm-chip-pill" x={card.x + card.width - 14} y={top + 12.5} textAnchor="end">
                  {pill}
                </text>
              )}
            </g>
          );
        })}
        {more > 0 && (
          <text
            className="lm-card-more"
            x={card.x + 14}
            y={chipTop + shownChips.length * (CARD.chipH + CARD.chipGap) + 12.5}
          >
            {`+${more} more in the details panel`}
          </text>
        )}
      </g>
      {hasChildren && !collapsed && (
        <g
          className="lm-caret"
          data-lm-caret=""
          role="button"
          tabIndex={0}
          aria-label={`Collapse ${card.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapsed();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            onToggleCollapsed();
          }}
        >
          <circle className="lm-caret-hit" cx={infoX - 22} cy={infoY} r={9} />
          <text className="lm-caret-glyph" x={infoX - 22} y={infoY + 4} textAnchor="middle">
            -
          </text>
        </g>
      )}
      {/* A sibling of the card, not inside it: nested interactive roles are invalid. */}
      <InfoHitCircle
        cx={infoX}
        cy={infoY}
        label={`About ${card.title}`}
        expanded={infoOpen}
        onToggle={onToggleInfo}
        classes={INFO_CLASSES}
        attrs={INFO_ATTRS}
      />
    </g>
  );
}
