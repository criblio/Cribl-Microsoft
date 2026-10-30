/**
 * OnboardingDataflow - the dataflow diagram of the Azure Native Source
 * Onboarding screen (AZR-30), with the measured live flow (AZR-33).
 *
 * WHAT IT DRAWS. One section per chosen source, left to right: Azure emitter
 * -> Event Hub namespace or storage account -> Cribl source -> route ->
 * destination, from @soc/core buildOnboardingLanes, laid out by the pure
 * lane-layout.ts. Three perspectives (ADR 0007 D14): the Azure side (emitter,
 * transport and the How-to step cards; Cribl folded into one card), the Cribl
 * side (Azure folded into one card; source, route and destination expanded)
 * and end to end.
 *
 * ONE CANVAS ENGINE. Everything that moves - the viewport (pan, zoom, wheel,
 * fit), the (i) and its popover, card drag and the animated edge - comes from
 * the shared shell in components/diagram (G2). This file writes none of it;
 * it composes the shell the way the shell's own pins do (card drag ahead of
 * the pan on the container, onViewChange and drag start closing the popover).
 *
 * MEASURED FLOW ONLY. The one edge that can animate is a lane's transport ->
 * Cribl source hop, and only when its state is "flowing" (core shouldAnimate)
 * from Cribl's intake metrics read by useLiveFlow. Idle, never seen and not
 * measured are static and captioned with their word. Every other edge is "not
 * measured: no counter" and drawn dashed.
 *
 * Every card, section caption, legend entry and measured-hop label carries a
 * visible (i) (claude-kit standards/info-affordances.md). The hop's label on
 * the canvas is only its state word; its (i) holds the full sentence and the
 * reason (AZR-45: the sentence ran under the next card). The toolbar (i) shows the
 * literal metrics request (method, path, body). Cards are keyboard reachable
 * (role=button, tabIndex 0); Enter or Space opens the card's popover.
 *
 * Product marks: the standard asks for vendor marks on product cards; this
 * slice draws none (no Azure mark is in @capra/icons/logos, and inventing one
 * is forbidden). Recorded in the unit output, not guessed at here.
 *
 * Class names (styles.css owns every rule): azo-flow, azo-flow-toolbar,
 * azo-flow-perspective, azo-flow-perspective-option, azo-flow-btn, azo-flow-watch, azo-flow-watch-reason,
 * azo-flow-asof, azo-flow-canvas, azo-flow-empty, azo-flow-section,
 * azo-flow-section-caption, azo-flow-card, azo-flow-card-box,
 * azo-flow-card-title, azo-flow-card-status, azo-flow-card-fact,
 * azo-flow-edge, azo-flow-edge-label, azo-flow-pipe, azo-flow-packet,
 * azo-flow-info, azo-flow-info-hit, azo-flow-info-glyph, azo-flow-info-i,
 * azo-flow-popover, azo-flow-popover-kind, azo-flow-popover-title,
 * azo-flow-popover-status, azo-flow-popover-facts, azo-flow-popover-close,
 * azo-flow-legend, azo-flow-legend-item.
 */

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  DATAFLOW_PERSPECTIVES,
  FLOW_STATE_LABEL,
  buildOnboardingLanes,
  type BuildOnboardingLanesInput,
  type DataflowPerspective,
  type LaneCardKind,
} from "@soc/core";

import {
  AnimatedEdge,
  DiagramInfoPopover,
  InfoHitCircle,
  useCardDrag,
  useDiagramViewport,
} from "../../../components/diagram";
import { InfoTip } from "../../../components/info-tip";
import { clampToSection, layoutLanes, relayoutEdges, type LaidCard, type LaidSection, type LaneLayout } from "./lane-layout";
import { formatAsOf, type LiveFlow, type LiveFlowRequest } from "./use-live-flow";

const PERSPECTIVE_LABEL: Readonly<Record<DataflowPerspective, string>> = {
  azure: "Azure side",
  cribl: "Cribl side",
  "end-to-end": "End to end",
};

const PERSPECTIVE_INFO: Readonly<Record<DataflowPerspective, string>> = {
  azure:
    "What has to exist in Azure: the log emitter, the Event Hub namespace or storage account, and each setup step. Cribl is folded into one card.",
  cribl:
    "What Cribl Stream does with the logs: the source the app creates, the route and the destination. Azure is folded into one card carrying the overall check result.",
  "end-to-end": "The whole path from the Azure emitter to the Cribl destination, without the setup steps.",
};

const CARD_KIND_LABEL: Readonly<Record<LaneCardKind, string>> = {
  emitter: "AZURE LOG SOURCE",
  transport: "AZURE TRANSPORT",
  step: "SETUP STEP",
  "cribl-source": "CRIBL SOURCE",
  route: "CRIBL ROUTE",
  destination: "CRIBL DESTINATION",
  "cribl-folded": "CRIBL STREAM",
  "azure-folded": "AZURE",
};

/** The legend: every edge word, with what it means. */
const LEGEND: readonly { readonly word: string; readonly info: string }[] = [
  {
    word: FLOW_STATE_LABEL.flowing,
    info: "Cribl measured events from this source in the window. The only state that animates.",
  },
  {
    word: FLOW_STATE_LABEL.idle,
    info: "Cribl measured the source, and no events arrived in the window.",
  },
  {
    word: FLOW_STATE_LABEL["never-seen"],
    info: "Cribl answered, and has no events from this source in the lookback.",
  },
  {
    word: FLOW_STATE_LABEL["not-measured"],
    info: "The flow could not be measured: no permission, the request failed, no source yet, or no answer yet. Never read as zero.",
  },
  {
    word: "no counter",
    info: "Cribl keeps no counter for this hop, so it is never measured and never animates.",
  },
];

/** A press on any of these starts no pan (a card press may start a drag instead). */
const PAN_IGNORE = "[data-azo-card], [data-azo-info], [data-azo-popover]";
/** A pointerdown on these leaves the popover open (the (i) toggles it itself). */
const POPOVER_KEEP = "[data-azo-popover], [data-azo-info], [data-azo-card]";
const INFO_CLASSES = {
  group: "azo-flow-info",
  hit: "azo-flow-info-hit",
  glyph: "azo-flow-info-glyph",
  letter: "azo-flow-info-i",
} as const;
const CARD_INFO_ATTRS = { "data-azo-info": "", "data-azo-card-info": "" } as const;
const SECTION_INFO_ATTRS = { "data-azo-info": "", "data-azo-section-info": "" } as const;
const EDGE_INFO_ATTRS = { "data-azo-info": "", "data-azo-edge-info": "" } as const;
const POPOVER_ATTRS = { "data-azo-popover": "" } as const;

// Text metrics: these match lane-layout's card height arithmetic.
const PAD_Y = 10;
const TITLE_LINE_H = 16;
const STATUS_LINE_H = 18;
const FACT_LINE_H = 14;

export interface OnboardingDataflowProps {
  /** Everything buildOnboardingLanes needs except the perspective and the flow. */
  readonly laneInput: Omit<BuildOnboardingLanesInput, "perspective" | "flow">;
  /** The live-flow reading (useLiveFlow). */
  readonly live: LiveFlow;
  readonly watching: boolean;
  readonly onWatchingChange: (next: boolean) => void;
  /** Why Watch for data cannot start (e.g. no worker group), or null. */
  readonly watchBlockedReason?: string | null;
  readonly initialPerspective?: DataflowPerspective;
}

type InfoTarget = { readonly kind: "card" | "section" | "edge"; readonly id: string };

function requestText(label: string, r: LiveFlowRequest | null): string {
  return r === null ? `${label}: nothing is sent without a worker group.` : `${label}:\n${r.method} ${r.path}\n${r.body}`;
}

function windowPhrase(seconds: number): string {
  return seconds % 60 === 0 ? `the last ${seconds / 60} minutes` : `the last ${seconds} seconds`;
}

function lookbackPhrase(lookback: string): string {
  const m = /^-(\d+)h$/.exec(lookback);
  return m === null ? lookback : `the last ${m[1]} hours`;
}

export function OnboardingDataflow({
  laneInput,
  live,
  watching,
  onWatchingChange,
  watchBlockedReason = null,
  initialPerspective = "end-to-end",
}: OnboardingDataflowProps) {
  const [perspective, setPerspective] = useState<DataflowPerspective>(initialPerspective);
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const closeInfo = useCallback(() => setInfo(null), []);

  const lanes = useMemo(
    () => buildOnboardingLanes({ ...laneInput, flow: watching ? live.states : null, perspective }),
    [laneInput, watching, live.states, perspective],
  );
  const layout: LaneLayout = useMemo(() => layoutLanes(lanes.lanes, perspective), [lanes, perspective]);

  const viewport = useDiagramViewport({ layout, onViewChange: closeInfo, panIgnoreSelector: PAN_IGNORE });
  const { containerRef, view, fit } = viewport;
  const clamp = useCallback((id: string, pos: { x: number; y: number }) => clampToSection(layout, id, pos), [layout]);
  const drag = useCardDrag({ zoom: view.k, clamp, onDragStart: closeInfo });
  const { reset: resetDrag } = drag;
  const drawn = useMemo(() => relayoutEdges(layout, drag.positions), [layout, drag.positions]);

  // A new layout (perspective, lanes) re-fits and drops session positions,
  // which were for the old arrangement. A drag never re-fits.
  const shape = useMemo(
    () => `${perspective}|${layout.cards.map((c) => `${c.id}@${c.x},${c.y}`).join(";")}`,
    [perspective, layout],
  );
  useEffect(() => {
    resetDrag();
    fit();
    closeInfo();
  }, [shape, resetDrag, fit, closeInfo]);

  const cardsById = useMemo(() => new Map(drawn.cards.map((c) => [c.id, c])), [drawn.cards]);
  const animatedCount = drawn.edges.filter((e) => e.animated).length;
  const laneById = useMemo(() => new Map<string, (typeof lanes.lanes)[number]>(lanes.lanes.map((l) => [l.sourceId, l])), [lanes]);

  const toggleInfo = (target: InfoTarget) =>
    setInfo((cur) => (cur !== null && cur.kind === target.kind && cur.id === target.id ? null : target));

  const onCardKey = (e: KeyboardEvent<SVGGElement>, id: string) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggleInfo({ kind: "card", id });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.onPointerMove(e)) viewport.panHandlers.onPointerMove(e);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    drag.endDrag(e);
    viewport.panHandlers.onPointerUp(e);
  };

  const requestInfo = [
    "Watch for data sends one request a minute while this tab is visible. The first request looks back 24 hours; the live five-minute reading, the only one that can show data flowing, arrives about a minute after you turn Watch on.",
    requestText("The lookback, sent first", live.requests.lookback),
    requestText("The window, sent after the lookback answers", live.requests.window),
    ...(live.unmatchedLabels.length > 0 ? [`Inputs in the answer that match no lane: ${live.unmatchedLabels.join(", ")}`] : []),
  ].join("\n\n");

  const asOfText = !watching
    ? "Not watching: nothing is read from Cribl."
    : live.asOf === null
      ? "Watching: waiting for the first answer."
      : `As of ${formatAsOf(live.asOf)}.`;

  const popover = (() => {
    if (info === null) return null;
    if (info.kind === "card") {
      const card = cardsById.get(info.id);
      if (card === undefined) return null;
      return (
        <DiagramInfoPopover
          className="azo-flow-popover"
          attrs={POPOVER_ATTRS}
          label={`About ${card.card.title}`}
          left={view.x + (card.x + card.width) * view.k + 8}
          top={view.y + card.y * view.k}
          onClose={closeInfo}
          keepOpenSelector={POPOVER_KEEP}
        >
          <div className="azo-flow-popover-kind">{CARD_KIND_LABEL[card.kind]}</div>
          <div className="azo-flow-popover-title">{card.card.title}</div>
          <div className="azo-flow-popover-status">{card.status.label}</div>
          <ul className="azo-flow-popover-facts">
            <li>{card.card.info}</li>
            {card.card.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <button type="button" className="azo-flow-btn azo-flow-popover-close" aria-label="Close" onClick={closeInfo}>
            x
          </button>
        </DiagramInfoPopover>
      );
    }
    if (info.kind === "edge") {
      const edge = drawn.edges.find((e) => e.id === info.id);
      if (edge === undefined || edge.label === null) return null;
      const from = cardsById.get(edge.from);
      const to = cardsById.get(edge.to);
      const detail = edge.flow.kind === "measured" && edge.flow.state.kind === "not-measured" ? edge.flow.state.detail : "";
      return (
        <DiagramInfoPopover
          className="azo-flow-popover"
          attrs={POPOVER_ATTRS}
          label={`About this hop: ${edge.label.text}`}
          left={view.x + (edge.label.info.x + 12) * view.k}
          top={view.y + edge.label.info.y * view.k}
          onClose={closeInfo}
          keepOpenSelector={POPOVER_KEEP}
        >
          <div className="azo-flow-popover-kind">MEASURED HOP</div>
          <div className="azo-flow-popover-title">{`${from?.card.title ?? edge.from} to ${to?.card.title ?? edge.to}`}</div>
          <div className="azo-flow-popover-status">{edge.label.full}</div>
          <ul className="azo-flow-popover-facts">
            <li>The one hop Cribl's intake metrics measure for this source. Only a flowing hop animates.</li>
            {detail !== "" && <li>{detail}</li>}
          </ul>
          <button type="button" className="azo-flow-btn azo-flow-popover-close" aria-label="Close" onClick={closeInfo}>
            x
          </button>
        </DiagramInfoPopover>
      );
    }
    const section = drawn.sections.find((s) => s.sourceId === info.id);
    const lane = laneById.get(info.id);
    if (section === undefined || lane === undefined) return null;
    const measured = lane.edges.find((e) => e.flow.kind === "measured");
    return (
      <DiagramInfoPopover
        className="azo-flow-popover"
        attrs={POPOVER_ATTRS}
        label={`About ${section.title}`}
        left={view.x + (section.x + 24) * view.k}
        top={view.y + (section.y + 28) * view.k}
        onClose={closeInfo}
        keepOpenSelector={POPOVER_KEEP}
      >
        <div className="azo-flow-popover-kind">FLOW</div>
        <div className="azo-flow-popover-title">{section.title}</div>
        <ul className="azo-flow-popover-facts">
          <li>{lane.mode === "automate" ? "The app sets up the Azure side." : "You set up the Azure side (How-to)."}</li>
          <li>{`Transport: ${lane.transport === "eventhub" ? "Event Hub" : "Blob storage"}. Cribl source type: ${lane.criblInputType}.`}</li>
          <li>{lane.inputId === null ? "Cribl input id: needs plan values." : `Cribl input id: ${lane.inputId}.`}</li>
          <li>{`Azure to Cribl: ${measured?.flow.label ?? "not measured"}.`}</li>
        </ul>
        <button type="button" className="azo-flow-btn azo-flow-popover-close" aria-label="Close" onClick={closeInfo}>
          x
        </button>
      </DiagramInfoPopover>
    );
  })();

  return (
    <div className="azo-flow">
      <div className="azo-flow-toolbar">
        <div className="azo-flow-perspective" role="radiogroup" aria-label="Perspective">
          {DATAFLOW_PERSPECTIVES.map((p) => (
            <span key={p} className="azo-flow-perspective-option">
              <label>
                <input
                  type="radio"
                  name="azo-flow-perspective"
                  value={p}
                  checked={perspective === p}
                  onChange={() => setPerspective(p)}
                />
                {PERSPECTIVE_LABEL[p]}
              </label>
              <InfoTip text={PERSPECTIVE_INFO[p]} />
            </span>
          ))}
        </div>
        <div role="group" aria-label="Zoom">
          <button type="button" className="azo-flow-btn" aria-label="Zoom out" onClick={viewport.zoomOut}>
            -
          </button>
          <button type="button" className="azo-flow-btn" onClick={fit}>
            Fit
          </button>
          <button type="button" className="azo-flow-btn" aria-label="Zoom in" onClick={viewport.zoomIn}>
            +
          </button>
          <button type="button" className="azo-flow-btn" onClick={resetDrag} disabled={!drag.hasMoved}>
            Reset layout
          </button>
        </div>
        <span className="azo-flow-watch">
          <label>
            <input
              type="checkbox"
              checked={watching}
              disabled={watchBlockedReason !== null && !watching}
              onChange={(e) => onWatchingChange(e.target.checked)}
            />
            Watch for data
          </label>
          <InfoTip text={requestInfo} />
        </span>
        {watchBlockedReason !== null && <span className="azo-flow-watch-reason">{watchBlockedReason}</span>}
      </div>
      <p className="azo-flow-asof">
        {`Window: ${windowPhrase(live.windowSeconds)}. Lookback: ${lookbackPhrase(live.lookback)}. ${asOfText}`}
      </p>

      {drawn.cards.length === 0 ? (
        <div className="azo-flow-empty">Choose a source to onboard and its dataflow is drawn here.</div>
      ) : (
        <div
          ref={containerRef}
          className="azo-flow-canvas"
          onWheel={viewport.onWheel}
          onPointerDown={viewport.panHandlers.onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <svg width="100%" height="100%" role="group" aria-label={`Onboarding dataflow, ${PERSPECTIVE_LABEL[perspective]}`}>
            <g data-azo-viewport="" transform={viewport.transform}>
              {drawn.sections.map((s) => (
                <SectionBand
                  key={s.sourceId}
                  section={s}
                  infoOpen={info?.kind === "section" && info.id === s.sourceId}
                  onToggleInfo={() => toggleInfo({ kind: "section", id: s.sourceId })}
                />
              ))}
              {drawn.edges.map((e) => {
                const stateClass = e.flow.kind === "measured" ? ` is-${e.flow.state.kind}` : " is-no-counter";
                const cls = `azo-flow-edge${e.kind === "configures" ? " is-configures" : ""}${stateClass}`;
                return (
                  <g key={e.id}>
                    <AnimatedEdge
                      d={e.d}
                      animated={e.animated}
                      animatedCount={animatedCount}
                      className={cls}
                      pipeClassName="azo-flow-pipe"
                      packetClassName="azo-flow-packet"
                      attrs={{ "data-azo-edge": e.id }}
                    />
                    {e.label !== null && (
                      <>
                        {/* The state word only; the full sentence is in the (i) (AZR-45). */}
                        <text className="azo-flow-edge-label" x={e.label.textEnd.x} y={e.label.textEnd.y} textAnchor="end">
                          {e.label.text}
                        </text>
                        <InfoHitCircle
                          cx={e.label.info.x}
                          cy={e.label.info.y}
                          label={`About this hop: ${e.label.text}`}
                          expanded={info?.kind === "edge" && info.id === e.id}
                          onToggle={() => toggleInfo({ kind: "edge", id: e.id })}
                          classes={INFO_CLASSES}
                          attrs={EDGE_INFO_ATTRS}
                        />
                      </>
                    )}
                  </g>
                );
              })}
              {drawn.cards.map((c) => (
                <CardGroup
                  key={c.id}
                  card={c}
                  infoOpen={info?.kind === "card" && info.id === c.id}
                  onPointerDown={(e) => drag.onCardPointerDown(e, c.id, { x: c.x, y: c.y })}
                  onClick={() => {
                    if (!drag.wasDragged()) toggleInfo({ kind: "card", id: c.id });
                  }}
                  onKey={(e) => onCardKey(e, c.id)}
                  onToggleInfo={() => toggleInfo({ kind: "card", id: c.id })}
                />
              ))}
            </g>
          </svg>
          {popover}
        </div>
      )}

      <ul className="azo-flow-legend" aria-label="Legend">
        {LEGEND.map((l) => (
          <li key={l.word} className="azo-flow-legend-item">
            {l.word}
            <InfoTip text={l.info} />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SectionBandProps {
  readonly section: LaidSection;
  readonly infoOpen: boolean;
  readonly onToggleInfo: () => void;
}

function SectionBand({ section, infoOpen, onToggleInfo }: SectionBandProps) {
  return (
    <g data-azo-section={section.sourceId}>
      <rect className="azo-flow-section" x={section.x} y={section.y} width={section.width} height={section.height} rx={10} />
      <text className="azo-flow-section-caption" x={section.x + 36} y={section.captionY}>
        {section.title}
      </text>
      <InfoHitCircle
        cx={section.x + 20}
        cy={section.captionY - 4}
        label={`About ${section.title}`}
        expanded={infoOpen}
        onToggle={onToggleInfo}
        classes={INFO_CLASSES}
        attrs={SECTION_INFO_ATTRS}
      />
    </g>
  );
}

interface CardGroupProps {
  readonly card: LaidCard;
  readonly infoOpen: boolean;
  readonly onPointerDown: (e: PointerEvent<SVGGElement>) => void;
  readonly onClick: () => void;
  readonly onKey: (e: KeyboardEvent<SVGGElement>) => void;
  readonly onToggleInfo: () => void;
}

function CardGroup({ card, infoOpen, onPointerDown, onClick, onKey, onToggleInfo }: CardGroupProps) {
  const top = card.y + PAD_Y;
  const titleH = card.titleLines.length * TITLE_LINE_H;
  const statusY = top + titleH + 13;
  const factTop = top + titleH + STATUS_LINE_H + 11;
  return (
    <g data-azo-card-group={card.id}>
      <g
        className={`azo-flow-card is-${card.status.kind}`}
        data-azo-card={card.id}
        data-azo-kind={card.kind}
        role="button"
        tabIndex={0}
        aria-label={`${card.card.title}, ${CARD_KIND_LABEL[card.kind].toLowerCase()}, ${card.status.label}`}
        aria-expanded={infoOpen}
        onPointerDown={onPointerDown}
        onClick={onClick}
        onKeyDown={onKey}
      >
        <rect className="azo-flow-card-box" x={card.x} y={card.y} width={card.width} height={card.height} rx={8} />
        <text className="azo-flow-card-title">
          {card.titleLines.map((line, i) => (
            <tspan key={i} x={card.x + 10} y={top + 12 + i * TITLE_LINE_H}>
              {line}
            </tspan>
          ))}
        </text>
        <text className="azo-flow-card-status" x={card.x + 10} y={statusY}>
          {card.statusLine}
        </text>
        {card.factLines.map((f, i) => (
          <text key={i} className="azo-flow-card-fact" x={card.x + 10} y={factTop + i * FACT_LINE_H}>
            {f}
          </text>
        ))}
      </g>
      {/* A sibling of the card, not inside it: nested interactive roles are invalid. */}
      <InfoHitCircle
        cx={card.x + card.width - 12}
        cy={card.y + 12}
        label={`About ${card.card.title}`}
        expanded={infoOpen}
        onToggle={onToggleInfo}
        classes={INFO_CLASSES}
        attrs={CARD_INFO_ATTRS}
      />
    </g>
  );
}
