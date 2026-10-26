/**
 * LoggingMapCanvas - the Azure Logging Map diagram (AZR-19, phase 1,
 * READ-ONLY): hand-written SVG over the top-to-bottom dagre layout in
 * logging-map-layout.ts. Props only; no fetching, no app context.
 *
 * Follows the house diagram standard (claude-kit
 * standards/cribl-dataflow-diagram.md, ported from its reference
 * FlowDiagram.tsx) with these deliberate differences:
 * - NO DRAG and NO "Reset layout". The approved mockup's interaction model is
 *   zoom, fit, collapse, outline and trace, and has no drag; the standard
 *   asks for movable cards. That conflict is a recorded decision card, not
 *   settled here. A pointer press on a card therefore never moves it and
 *   never pans the view; `applyPositions` (layout) stays the one seam a drag
 *   would later feed. Panning the empty canvas is allowed.
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
 * Every state is drawn with more than colour (the mockup's visual encoding):
 * ours is a solid chip with an "ours" pill, other owners a grey chip,
 * inherited a dotted italic chip saying where it is from, excluded or exempt
 * a hatch plus a pill, unreadable a dashed card with a lock note, and the
 * remaining gap states each have their own pill.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";

import {
  CARD,
  CARD_LINE_CHARS,
  MAX_CHIPS,
  NODE_W,
  applyPositions,
  clampZoom,
  edgeAnchors,
  edgePath,
  fit as fitLayout,
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

const ZOOM_STEP = 1.2;
const WHEEL_STEP = 1.12;
const PAN_THRESHOLD_PX = 4;

interface View {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

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
  // applyPositions is the ONE seam a future drag would feed; phase 1 passes none.
  const laid = useMemo(() => applyPositions(layoutLoggingMap(graph), undefined), [graph]);
  const marks = useMemo(() => traceView(map, { tracedAssignment: state.tracedAssignment }), [map, state.tracedAssignment]);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const hatchId = `${uid}-hatch`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [infoId, setInfoId] = useState<string | null>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const closeInfo = useCallback(() => setInfoId(null), []);
  const cardsById = useMemo(() => new Map(laid.cards.map((c) => [c.id, c])), [laid.cards]);

  const sizeRef = useRef(laid);
  sizeRef.current = laid;
  const fit = useCallback(() => {
    const el = containerRef.current;
    const t = fitLayout(sizeRef.current, { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 });
    setView({ x: t.panX, y: t.panY, k: t.zoom });
  }, []);

  // Re-fit only when the layout itself changes (collapse, fold, filters).
  useEffect(() => {
    fit();
    closeInfo();
  }, [laid, fit, closeInfo]);

  useEffect(() => {
    if (infoId === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeInfo();
    };
    const onDown = (e: globalThis.PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-lm-popover], [data-lm-info]")) return;
      closeInfo();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [infoId, closeInfo]);

  const zoomBy = useCallback((factor: number, origin?: { x: number; y: number }) => {
    setView((prev) => {
      const k = clampZoom(prev.k * factor);
      if (origin === undefined) return { ...prev, k };
      const r = k / prev.k;
      return { k, x: origin.x - (origin.x - prev.x) * r, y: origin.y - (origin.y - prev.y) * r };
    });
  }, []);

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    closeInfo();
    const rect = containerRef.current?.getBoundingClientRect();
    const origin = rect === undefined ? undefined : { x: e.clientX - rect.left, y: e.clientY - rect.top };
    zoomBy(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, origin);
  };

  // Panning the EMPTY canvas only. A press that lands on a card, its (i) or
  // its caret starts nothing, so pressing and moving on a card neither moves
  // the card nor pans the view. (Not stopPropagation: the popover's outside-
  // pointerdown close must still hear a press on another card.)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (target?.closest?.("[data-lm-card], [data-lm-info], [data-lm-caret], [data-lm-popover]")) return;
    panRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan === null) return;
    if ((e.buttons & 1) === 0) {
      panRef.current = null;
      return;
    }
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
      pan.moved = true;
      closeInfo();
    }
    setView((prev) => ({ ...prev, x: pan.vx + dx, y: pan.vy + dy }));
  };
  const endPan = () => {
    panRef.current = null;
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

  if (laid.cards.length === 0) {
    return <div className="lm-canvas-empty">No scope could be listed, so there is nothing to draw.</div>;
  }

  const infoCard = infoId === null ? undefined : cardsById.get(infoId);

  return (
    <div className="lm-canvas-root">
      <div className="lm-zoom" role="group" aria-label="Zoom">
        <button type="button" className="lm-btn" aria-label="Zoom out" onClick={() => { closeInfo(); zoomBy(1 / ZOOM_STEP); }}>
          -
        </button>
        <button type="button" className="lm-btn" onClick={() => { closeInfo(); fit(); }}>
          Fit
        </button>
        <button type="button" className="lm-btn" aria-label="Zoom in" onClick={() => { closeInfo(); zoomBy(ZOOM_STEP); }}>
          +
        </button>
      </div>
      <div
        ref={containerRef}
        className="lm-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <svg width="100%" height="100%" role="group" aria-label="Management group tree with policy assignments">
          <defs>
            <pattern id={hatchId} width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={8} height={8} className="lm-hatch-bg" />
              <line x1={0} y1={0} x2={0} y2={8} className="lm-hatch-line" />
            </pattern>
          </defs>
          <g data-lm-viewport="" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {laid.edges.map((edge) => {
              const from = cardsById.get(edge.from);
              const to = cardsById.get(edge.to);
              if (from === undefined || to === undefined) return null;
              const { start, end } = edgeAnchors(from, to);
              return <path key={`${edge.from}>${edge.to}`} className="lm-edge" d={edgePath(edge.points, start, end)} />;
            })}
            {laid.cards.map((card) => (
              <CardGroup
                key={card.id}
                map={map}
                state={state}
                card={card}
                mark={marks?.get(card.scopeId)}
                hatchId={hatchId}
                infoOpen={infoId === card.id}
                onActivate={() => activate(card)}
                onKey={(e) => onCardKey(e, card)}
                onToggleInfo={() => toggleInfo(card.id)}
                onToggleCollapsed={() => onToggleCollapsed(card.scopeId)}
              />
            ))}
          </g>
        </svg>
        {infoCard !== undefined && (
          <div
            className="lm-popover"
            data-lm-popover=""
            role="dialog"
            aria-label={`About ${infoCard.title}`}
            style={{
              left: view.x + (infoCard.x + infoCard.width) * view.k + 8,
              top: view.y + infoCard.y * view.k,
            }}
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
          </div>
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
  readonly onKey: (e: KeyboardEvent<SVGGElement>) => void;
  readonly onToggleInfo: () => void;
  readonly onToggleCollapsed: () => void;
}

function CardGroup({ map, state, card, mark, hatchId, infoOpen, onActivate, onKey, onToggleInfo, onToggleCollapsed }: CardGroupProps) {
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
      <g
        className="lm-info"
        data-lm-info=""
        role="button"
        tabIndex={0}
        aria-label={`About ${card.title}`}
        aria-expanded={infoOpen}
        onClick={(e) => {
          e.stopPropagation();
          onToggleInfo();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          onToggleInfo();
        }}
      >
        {/* ~1.5x hit area around the visible glyph. */}
        <circle className="lm-info-hit" cx={infoX} cy={infoY} r={10} />
        <circle className="lm-info-glyph" cx={infoX} cy={infoY} r={6.5} />
        <text className="lm-info-i" x={infoX} y={infoY + 3.5} textAnchor="middle">
          i
        </text>
      </g>
    </g>
  );
}
