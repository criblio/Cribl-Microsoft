/**
 * ArchitectureScreen - the reference-architecture advisor and the JOURNEY
 * landing page (user directives 2026-07-20): users arrive here to learn how
 * the ingestion works. Select the Cribl products and Azure resources in use;
 * the pure @soc/core recommender returns the matching patterns (and the
 * one-addition-away near-misses). The matched patterns' tiered diagrams are
 * MERGED (unifyPatternDiagrams) into ONE interactive data-flow canvas
 * (ArchitectureFlow) that recomputes and animates as the selection changes;
 * each pattern's rationale and considerations render as text below.
 *
 * ADVISORY ONLY: this screen recommends and visualizes; it deploys nothing,
 * calls nothing external, and needs no ports (requires: 'none' in both
 * shells). All decision logic is the pure core module; this component only
 * renders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARCHITECTURE_PRESETS,
  AZURE_RESOURCES,
  CRIBL_PRODUCTS,
  LOG_SOURCES,
  PRODUCT_WHEN_TO_USE,
  SOLUTION_INGESTION_ENTRIES,
  buildLiveDiagram,
  catalogLabel,
  fetchLiveArchitecture,
  ingestionTierLabel,
  applySentinelOverlay,
  buildFleetInventory,
  fetchEdgeFleetData,
  isStreamWorkerGroup,
  parseWorkerInventory,
  recommendWithSolutions,
  unifyPatternDiagrams,
} from "@soc/core";
import type {
  ArchitecturePattern,
  ArchitecturePreset,
  AzureResource,
  CriblClient,
  CriblGroupSummary,
  CriblProduct,
  EdgeFleetData,
  LiveArchitectureSnapshot,
  LogSource,
  PatternDiagram,
  PatternRecommendation,
} from "@soc/core";
import { SearchableMultiSelect } from "../../components/searchable-select";
import { ArchitectureFlow } from "./architecture-flow";
import type { DiagramEditState } from "./arch-edits";
import { PATTERN_DEPLOY_LINKS } from "./deploy-links";
import { diagramToSvg } from "./architecture-svg-export";
import { svgToPngBytes } from "./png-export";

/** One pattern's textual rationale + considerations (the diagram is unified). */
function PatternCard({
  pattern,
  onNavigate,
  canNavigate,
}: {
  pattern: ArchitecturePattern;
  onNavigate?: (routeId: string) => void;
  canNavigate?: (routeId: string) => boolean;
}) {
  const deployLink = PATTERN_DEPLOY_LINKS[pattern.id];
  return (
    <div className="arch-card">
      <div className="arch-card-head">
        <span className="arch-card-title">{pattern.title}</span>
      </div>
      <p className="panel-desc">{pattern.summary}</p>
      <p className="panel-desc">
        <strong>Why this pattern:</strong> {pattern.why}
      </p>
      <span className="field-label">Considerations</span>
      <ul className="arch-considerations">
        {pattern.considerations.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {deployLink !== undefined &&
        onNavigate !== undefined &&
        ((canNavigate?.(deployLink.routeId) ?? true) ? (
          <button
            type="button"
            className="arch-deploy-btn"
            onClick={() => onNavigate(deployLink.routeId)}
          >
            {deployLink.label}
          </button>
        ) : (
          <span className="field-hint">
            Deployable from this app once an Azure connection is configured
            (see Setup).
          </span>
        ))}
    </div>
  );
}

/** Order-insensitive equality of a picker state against a preset selection. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

function isActivePreset(
  preset: ArchitecturePreset,
  products: readonly string[],
  resources: readonly string[],
  sources: readonly string[],
): boolean {
  return (
    sameSet(products, preset.selection.products) &&
    sameSet(resources, preset.selection.resources) &&
    sameSet(sources, preset.selection.sources ?? [])
  );
}

function NearMissCard({ rec }: { rec: PatternRecommendation }) {
  return (
    <div className="arch-near">
      <span className="arch-near-title">{rec.pattern.title}</span>
      <span className="arch-near-unlock">
        unlocks by adding {rec.missing.map(catalogLabel).join(", ")}
      </span>
      <span className="field-hint">{rec.pattern.summary}</span>
    </div>
  );
}

export interface ArchitectureScreenProps {
  /** Navigate to a deploy surface. Absent = deploy buttons never render. */
  onNavigate?: (routeId: string) => void;
  /** Route visibility in the active mode. Absent = assume visible. */
  canNavigate?: (routeId: string) => boolean;
  /** Save an artifact (download). Absent = export buttons never render. */
  onExport?: (
    name: string,
    mimeType: string,
    data: string | Uint8Array,
  ) => Promise<void>;
  /** Cribl client for the LIVE view. Absent = the Live tab explains the gap. */
  cribl?: CriblClient;
  /**
   * The Cribl leader UI base (origin + product prefix). When set, live-node
   * info popovers link to the resource's page in the Cribl UI instead of
   * the generic docs (user directive 2026-07-29).
   */
  criblUiBase?: string;
}

type OnExport = ArchitectureScreenProps["onExport"];

/** SVG + PNG download buttons for whichever diagram is active. Exports
 * carry a TITLE block and the embedded legend (2026-07-30 best-practices
 * pass: a diagram that travels must say what it is and carry its key). */
function ExportRow({
  diagram,
  onExport,
  baseName,
  title,
  editsRef,
}: {
  diagram: PatternDiagram;
  onExport: OnExport;
  baseName: string;
  title: string;
  /** Latest canvas edits - what you arranged is what you export. */
  editsRef?: React.MutableRefObject<DiagramEditState | null>;
}) {
  const [note, setNote] = useState("");
  if (onExport === undefined) {
    return null;
  }
  const svg = () =>
    diagramToSvg(diagram, {
      title: `${title} - ${new Date().toISOString().slice(0, 10)}`,
      edits: editsRef?.current ?? undefined,
    });
  return (
    <div className="arch-export-row">
      <button
        type="button"
        className="arch-export-btn"
        onClick={() => {
          setNote("");
          void onExport(`${baseName}.svg`, "image/svg+xml", svg())
            .then(() => setNote(`Saved ${baseName}.svg`))
            .catch((err) => setNote(`Export failed: ${String(err)}`));
        }}
      >
        Download SVG
      </button>
      <button
        type="button"
        className="arch-export-btn"
        onClick={() => {
          setNote("");
          void svgToPngBytes(svg())
            .then((bytes) => onExport(`${baseName}.png`, "image/png", bytes))
            .then(() => setNote(`Saved ${baseName}.png`))
            .catch((err) => setNote(`Export failed: ${String(err)}`));
        }}
      >
        Download PNG
      </button>
      {note !== "" && <span className="field-hint">{note}</span>}
    </div>
  );
}

/** The node-category color key + premium/economical badges under a canvas. */
function CostLegend() {
  return (
    <div className="arch-cost-legend">
      <span className="arch-legend-node arch-legend-node-source" aria-hidden="true" />
      <span>source</span>
      <span className="arch-legend-node arch-legend-node-route" aria-hidden="true" />
      <span>route</span>
      <span className="arch-legend-node arch-legend-node-pipeline" aria-hidden="true" />
      <span>pipeline / pack</span>
      <span className="arch-legend-node arch-legend-node-destination" aria-hidden="true" />
      <span>destination</span>
      <span className="arch-flow-cost-badge arch-flow-cost-premium">premium</span>
      <span>per-GB ingest billing - Sentinel analytics tier or SIEM license</span>
      <span className="arch-flow-cost-badge arch-flow-cost-economical">
        economical
      </span>
      <span>low-cost retention or egress path</span>
      <span className="arch-legend-line-search" aria-hidden="true" />
      <span>Cribl Search send path - findings return through Stream</span>
      <span className="arch-legend-line-muted" aria-hidden="true" />
      <span>subdued - configured but not flowing (disabled, or a before-state)</span>
      <span className="arch-legend-copy-tag" aria-hidden="true">
        (copy)
      </span>
      <span>non-final route - clones the events and continues down the table</span>
    </div>
  );
}

/**
 * The LIVE view (2026-07-29 user direction): fetch a worker group's real
 * configuration and draw what exists - sources, event breakers,
 * pre-processing pipelines, the routing table, packs/pipelines,
 * post-processing pipelines, destinations - on the same interactive canvas.
 */
function LiveArchitecturePanel({
  cribl,
  onExport,
  criblUiBase,
}: {
  cribl: CriblClient;
  onExport: OnExport;
  criblUiBase?: string;
}) {
  const [groups, setGroups] = useState<CriblGroupSummary[] | null>(null);
  const [groupId, setGroupId] = useState("");
  const [liveError, setLiveError] = useState("");
  const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<LiveArchitectureSnapshot | null>(null);
  const [azureOnly, setAzureOnly] = useState(true);
  // Flow-inventory selection (user direction 2026-07-30): the builder
  // returns EVERY complete flow; the user checks which to render. Nothing
  // checked = draw them all. expandedPacks explodes a pack card into its
  // internal routes/pipelines/destinations. Both reset per snapshot.
  const [selectedFlows, setSelectedFlows] = useState<string[]>([]);
  const [expandedPacks, setExpandedPacks] = useState<string[]>([]);
  const [expandedPackRoutes, setExpandedPackRoutes] = useState<string[]>([]);
  const [routesExpanded, setRoutesExpanded] = useState(false);
  useEffect(() => {
    setSelectedFlows([]);
    setExpandedPacks([]);
    setExpandedPackRoutes([]);
    setRoutesExpanded(false);
  }, [snapshot]);

  const loadGroups = async () => {
    setLiveError("");
    try {
      const found = (await cribl.listGroups()).filter(isStreamWorkerGroup);
      setGroups(found);
      if (found.length > 0 && groupId === "") {
        setGroupId(found[0].id);
      }
    } catch (err) {
      setGroups(null);
      setLiveError(
        `Worker groups unavailable (is a Cribl connection active?): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const loadLive = async () => {
    if (loading || groupId === "") {
      return;
    }
    setLoading(true);
    setLiveError("");
    try {
      setSnapshot(await fetchLiveArchitecture(cribl, groupId));
    } catch (err) {
      setSnapshot(null);
      setLiveError(
        `Live configuration unavailable (is a Cribl connection active?): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoading(false);
    }
  };

  const liveResult = useMemo(
    () =>
      snapshot === null
        ? null
        : buildLiveDiagram(snapshot, {
            azureOnly,
            uiBase: criblUiBase,
            selectedFlows,
            expandedPacks,
            expandedPackRoutes,
            expandRoutes: routesExpanded,
          }),
    [
      snapshot,
      azureOnly,
      criblUiBase,
      selectedFlows,
      expandedPacks,
      expandedPackRoutes,
      routesExpanded,
    ],
  );
  // The inventory is filter-independent; the Azure toggle narrows the LIST
  // to what it can actually draw.
  const visibleFlows = useMemo(
    () => (liveResult?.flows ?? []).filter((flow) => !azureOnly || flow.azure),
    [liveResult, azureOnly],
  );
  // Latest canvas edits, for titled exports that match the arrangement.
  const liveEditsRef = useRef<DiagramEditState | null>(null);
  const onLiveCanvasState = useCallback((state: DiagramEditState) => {
    liveEditsRef.current = state;
  }, []);
  const toggleNodeExpand = useCallback((nodeId: string) => {
    const toggleIn = (prev: string[], id: string): string[] =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
    if (nodeId === "routes") {
      setRoutesExpanded((prev) => !prev);
      return;
    }
    if (nodeId.startsWith("routes:")) {
      // A pack's INTERNAL routing table (the hub inside an exploded pack).
      const packId = nodeId.slice("routes:".length);
      setExpandedPackRoutes((prev) => toggleIn(prev, packId));
      return;
    }
    if (nodeId.startsWith("pack:")) {
      setExpandedPacks((prev) => toggleIn(prev, nodeId.slice("pack:".length)));
    }
  }, []);

  return (
    <>
      <p className="panel-desc">
        The REAL flow of the selected worker group: sources, event breakers,
        pre-processing pipelines, the routing table, packs and pipelines,
        post-processing pipelines, and destinations - read live from the
        connected Cribl environment. Nothing here changes any configuration.
      </p>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void loadGroups()}>
          {groups === null ? "Load worker groups" : "Reload worker groups"}
        </button>
        {groups !== null && groups.length > 0 && (
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.id}
              </option>
            ))}
          </select>
        )}
        <label className="integrate-check">
          <input
            type="checkbox"
            checked={azureOnly}
            onChange={(e) => setAzureOnly(e.target.checked)}
          />
          <span className="integrate-check-text">Azure-related only</span>
        </label>
        <button
          className="next-action-button"
          onClick={() => void loadLive()}
          disabled={loading || groupId === ""}
        >
          {loading
            ? "Reading configuration..."
            : snapshot === null
              ? "Load Live Workgroup View"
              : "Refresh"}
        </button>
      </div>
      {liveError !== "" && (
        <span className="field-hint eh-warning">{liveError}</span>
      )}
      {liveResult !== null && visibleFlows.length > 1 && (
        <div className="arch-live-focus">
          <label className="field">
            <span className="field-label">
              Flow inventory ({visibleFlows.length}) - select flows to draw
              only those; empty = draw everything
            </span>
            <SearchableMultiSelect
              options={visibleFlows.map((flow) => ({
                value: flow.key,
                label: flow.label,
              }))}
              values={selectedFlows}
              onChange={setSelectedFlows}
              placeholder="All flows drawn - select to narrow..."
              ariaLabel="Filter flows"
            />
          </label>
          {selectedFlows.length > 0 && (
            <button
              type="button"
              className="arch-export-btn"
              onClick={() => setSelectedFlows([])}
            >
              Show all flows
            </button>
          )}
        </div>
      )}
      {liveResult !== null && (
        <>
          {liveResult.diagram.nodes.length > 25 && (
            <p className="field-hint">
              Large flow ({liveResult.diagram.nodes.length} components) - use
              the flow inventory above to draw a subset for an easier read.
            </p>
          )}
          <ExportRow
            diagram={liveResult.diagram}
            onExport={onExport}
            baseName={`live-workgroup-${snapshot?.groupId ?? "group"}`}
            title={`Live Workgroup View - worker group '${snapshot?.groupId ?? "group"}'`}
            editsRef={liveEditsRef}
          />
          <ArchitectureFlow
            diagram={liveResult.diagram}
            onToggleNodeExpand={toggleNodeExpand}
            storageKey={`live:${snapshot?.groupId ?? "group"}:${azureOnly ? "az" : "all"}`}
            onCanvasStateChange={onLiveCanvasState}
          />
          {liveResult.diagram.nodes.length > 0 && <CostLegend />}
          {liveResult.notes.length > 0 && (
            <div className="arch-live-notes">
              <span className="field-label">Notes</span>
              {liveResult.notes.map((note) => (
                <p className="field-hint" key={note}>
                  {note}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * The EDGE FLEETS view (user direction 2026-07-31): inventory every Cribl
 * Edge Fleet the leader reports, draw each fleet's real flows (one flow per
 * source/destination pair through the fleet's routing table), and name the
 * Cribl Stream worker group each cribl_tcp/cribl_http destination offloads
 * to - resolved by matching receiver hosts against the leader's worker
 * inventory.
 */
function EdgeFleetsPanel({
  cribl,
  onExport,
  criblUiBase,
}: {
  cribl: CriblClient;
  onExport: OnExport;
  criblUiBase?: string;
}) {
  const [data, setData] = useState<EdgeFleetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fleetsError, setFleetsError] = useState("");

  const loadFleets = async () => {
    if (loading) {
      return;
    }
    setLoading(true);
    setFleetsError("");
    try {
      setData(await fetchEdgeFleetData(cribl));
    } catch (err) {
      setData(null);
      setFleetsError(
        `Edge fleet inventory unavailable (is a Cribl connection active?): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoading(false);
    }
  };

  // One built inventory per fleet, plus its edits holder so titled exports
  // match the canvas arrangement. Rebuilt per load; the holders are plain
  // objects (not useRef) because the fleet COUNT is data-driven.
  const fleetViews = useMemo(() => {
    if (data === null) {
      return [];
    }
    const workers = parseWorkerInventory(data.workers);
    return data.fleets.map((fleet) => {
      const inventory = buildFleetInventory(fleet.id, fleet.snapshot, workers, {
        uiBase: criblUiBase,
      });
      const offloadByOutput = new Map(
        inventory.offloads.map((offload) => [offload.outputId, offload]),
      );
      // Group flows end in the destination id (key g:{input}>{route}>{output});
      // append the resolved offload group so the LIST answers the question
      // without opening the diagram.
      const flowRows = inventory.flows.map((flow) => {
        const outputId = flow.key.startsWith("g:")
          ? flow.key.slice(flow.key.lastIndexOf(">") + 1)
          : "";
        const offload = offloadByOutput.get(outputId);
        const suffix =
          offload !== undefined && offload.workerGroups.length > 0
            ? ` [offloads to Stream worker group ${offload.workerGroups.join(", ")}]`
            : "";
        return { key: flow.key, text: flow.label + suffix };
      });
      const editsRef: { current: DiagramEditState | null } = { current: null };
      return {
        inventory,
        flowRows,
        editsRef,
        onCanvasState: (state: DiagramEditState) => {
          editsRef.current = state;
        },
      };
    });
  }, [data, criblUiBase]);

  return (
    <>
      <p className="panel-desc">
        Every Cribl Edge Fleet on the connected leader, inventoried from its
        real configuration: one flow per source/destination pair through the
        fleet's routing table, with each Cribl Stream destination resolved to
        the worker group that receives the offloaded data. Nothing here
        changes any configuration.
      </p>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void loadFleets()}
          disabled={loading}
        >
          {loading
            ? "Reading fleet configurations..."
            : data === null
              ? "Load Live Edge View"
              : "Refresh"}
        </button>
      </div>
      {fleetsError !== "" && (
        <span className="field-hint eh-warning">{fleetsError}</span>
      )}
      {data !== null && fleetViews.length === 0 && (
        <p className="field-hint">
          No Edge Fleets reported by this leader - the groups list contains
          only Stream worker groups.
        </p>
      )}
      {data !== null && data.workers === undefined && fleetViews.length > 0 && (
        <p className="field-hint eh-warning">
          The leader's worker inventory could not be read - offload
          destinations show their raw receiver hosts instead of resolved
          Stream worker groups.
        </p>
      )}
      {data !== null && data.skippedFleets.length > 0 && (
        <p className="field-hint">
          Showing the first {data.fleets.length} fleets;{" "}
          {data.skippedFleets.length} more not fetched:{" "}
          {data.skippedFleets.join(", ")}.
        </p>
      )}
      {fleetViews.map(({ inventory, flowRows, editsRef, onCanvasState }) => (
        <section className="arch-fleet" key={inventory.fleetId}>
          <h3 className="arch-fleet-title">
            Edge fleet '{inventory.fleetId}'
          </h3>
          {inventory.offloads.length > 0 ? (
            <div className="arch-fleet-offloads">
              {inventory.offloads.map((offload) => (
                <span className="arch-fleet-offload" key={offload.outputId}>
                  {offload.outputId} ({offload.outputType}) offloads to{" "}
                  {offload.workerGroups.length > 0
                    ? `Stream worker group ${offload.workerGroups.join(", ")}`
                    : offload.hosts.length > 0
                      ? `${offload.hosts.join(", ")} (unresolved)`
                      : "(no receivers configured)"}
                </span>
              ))}
            </div>
          ) : (
            <p className="field-hint">
              No Cribl Stream offload destination (cribl_tcp/cribl_http)
              configured on this fleet.
            </p>
          )}
          {flowRows.length > 0 && (
            <div className="arch-fleet-flows">
              <span className="field-label">
                Flow inventory ({flowRows.length})
              </span>
              {flowRows.map((row) => (
                <p className="field-hint" key={row.key}>
                  {row.text}
                </p>
              ))}
            </div>
          )}
          <ExportRow
            diagram={inventory.diagram}
            onExport={onExport}
            baseName={`edge-fleet-${inventory.fleetId}`}
            title={`Live Edge View - fleet '${inventory.fleetId}'`}
            editsRef={editsRef}
          />
          <ArchitectureFlow
            diagram={inventory.diagram}
            storageKey={`fleet:${inventory.fleetId}`}
            onCanvasStateChange={onCanvasState}
          />
          {inventory.notes.length > 0 && (
            <div className="arch-live-notes">
              <span className="field-label">Notes</span>
              {inventory.notes.map((note) => (
                <p className="field-hint" key={note}>
                  {note}
                </p>
              ))}
            </div>
          )}
        </section>
      ))}
      {fleetViews.length > 0 && <CostLegend />}
    </>
  );
}

export function ArchitectureScreen({
  onNavigate,
  canNavigate,
  onExport,
  cribl,
  criblUiBase,
}: ArchitectureScreenProps = {}) {
  const [products, setProducts] = useState<string[]>([]);
  const [resources, setResources] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [solutionSources, setSolutionSources] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"patterns" | "live" | "fleets">(
    "patterns",
  );

  // The ~436-solution options come from the SHIPPED classification asset -
  // zero ports, tokens, or network; the hint carries tier + connector kind.
  const solutionOptions = useMemo(
    () =>
      SOLUTION_INGESTION_ENTRIES.map((entry) => ({
        value: entry.name,
        label: entry.name,
        hint:
          ingestionTierLabel(entry.tier) +
          (entry.kind !== "" ? ` - ${entry.kind}` : ""),
      })),
    [],
  );

  const recommendations = useMemo(
    () =>
      recommendWithSolutions({
        products: products as CriblProduct[],
        resources: resources as AzureResource[],
        sources: sources as LogSource[],
        solutionSources,
      }),
    [products, resources, sources, solutionSources],
  );
  const matches = recommendations.filter((r) => r.fit === "match");
  const nears = recommendations.filter((r) => r.fit === "near");

  // The single interactive diagram merges every matched pattern's flow.
  // Sentinel is a SERVICE on the workspace (user directive 2026-07-29):
  // selecting it tags the Log Analytics card instead of adding a node.
  const unifiedDiagram = useMemo(
    () =>
      applySentinelOverlay(unifyPatternDiagrams(matches.map((m) => m.pattern)), {
        products: products as CriblProduct[],
        resources: resources as AzureResource[],
        sources: sources as LogSource[],
      }),
    [matches, products, resources, sources],
  );

  // Latest canvas edits, for titled exports that match the arrangement.
  const patternsEditsRef = useRef<DiagramEditState | null>(null);
  const onPatternsCanvasState = useCallback((state: DiagramEditState) => {
    patternsEditsRef.current = state;
  }, []);

  const hasSelection =
    products.length > 0 ||
    resources.length > 0 ||
    sources.length > 0 ||
    solutionSources.length > 0;

  return (
    <div className="panel arch-screen">
      <h2 className="panel-title">Dataflow</h2>
      <p className="panel-desc">
        See how data flows from your sources through Cribl into Microsoft
        Sentinel. Select the Cribl products and Azure resources in use and the
        diagram below reshapes to match - drag nodes, bend lines with their
        grab dots, and remove elements (the hover x, or select and press
        Delete) to sketch YOUR variant; the layout re-flows around what is
        left and Restore brings pieces back. Edge labels name the exact Cribl
        source type receiving each feed. Advisory only: nothing here deploys
        anything.
      </p>

      <div className="arch-view-tabs" role="tablist" aria-label="Dataflow view">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "patterns"}
          className={
            "arch-view-tab" + (viewMode === "patterns" ? " arch-view-tab-active" : "")
          }
          onClick={() => setViewMode("patterns")}
        >
          Reference patterns
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "live"}
          className={
            "arch-view-tab" + (viewMode === "live" ? " arch-view-tab-active" : "")
          }
          onClick={() => setViewMode("live")}
        >
          Live Workgroup View
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "fleets"}
          className={
            "arch-view-tab" + (viewMode === "fleets" ? " arch-view-tab-active" : "")
          }
          onClick={() => setViewMode("fleets")}
        >
          Live Edge View
        </button>
      </div>

      {viewMode === "live" ? (
        cribl !== undefined ? (
          <LiveArchitecturePanel
            cribl={cribl}
            onExport={onExport}
            criblUiBase={criblUiBase}
          />
        ) : (
          <p className="field-hint">
            This shell did not provide a Cribl client for the live view - a
            wiring gap, not a runtime state.
          </p>
        )
      ) : viewMode === "fleets" ? (
        cribl !== undefined ? (
          <EdgeFleetsPanel
            cribl={cribl}
            onExport={onExport}
            criblUiBase={criblUiBase}
          />
        ) : (
          <p className="field-hint">
            This shell did not provide a Cribl client for the Live Edge View -
            a wiring gap, not a runtime state.
          </p>
        )
      ) : (
        <>
      <div className="arch-presets">
        <span className="field-label">Common journeys</span>
        <div className="arch-preset-row">
          {ARCHITECTURE_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              title={preset.description}
              className={
                "arch-preset-chip" +
                (isActivePreset(preset, products, resources, sources)
                  ? " arch-preset-chip-active"
                  : "")
              }
              onClick={() => {
                setProducts([...preset.selection.products]);
                setResources([...preset.selection.resources]);
                setSources([...(preset.selection.sources ?? [])]);
              }}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className="arch-preset-clear"
            disabled={!hasSelection}
            onClick={() => {
              setProducts([]);
              setResources([]);
              setSources([]);
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="arch-legend">
        {CRIBL_PRODUCTS.map((product) => (
          <div className="arch-legend-item" key={product.id}>
            <span className="arch-legend-name">{product.label}</span>
            <span className="arch-legend-what">{product.description}</span>
            <span className="arch-legend-when">{PRODUCT_WHEN_TO_USE[product.id]}</span>
          </div>
        ))}
      </div>

      <div className="form-grid arch-pickers">
        <label className="field">
          <span className="field-label">Cribl products in use</span>
          <SearchableMultiSelect
            options={CRIBL_PRODUCTS.map((p) => ({
              value: p.id,
              label: p.label,
            }))}
            values={products}
            onChange={setProducts}
            placeholder="Select Cribl products..."
            ariaLabel="Filter Cribl products"
          />
        </label>
        <label className="field">
          <span className="field-label">Azure resources in use</span>
          <SearchableMultiSelect
            options={AZURE_RESOURCES.map((r) => ({
              value: r.id,
              label: r.label,
            }))}
            values={resources}
            onChange={setResources}
            placeholder="Select Azure resources..."
            ariaLabel="Filter Azure resources"
          />
          <span className="field-hint">
            Sentinel implies its workspace; the data lake implies Sentinel.
            Event Hub and Blob Storage are listed per ROLE (source vs
            destination) so the diagram draws the correct side.
          </span>
        </label>
        <label className="field">
          <span className="field-label">Specific log sources (optional)</span>
          <SearchableMultiSelect
            options={LOG_SOURCES.map((s) => ({
              value: s.id,
              label: s.label,
            }))}
            values={sources}
            onChange={setSources}
            placeholder="Select log sources..."
            ariaLabel="Filter log sources"
          />
          <span className="field-hint">
            The Windows entries are the same data over different collection
            methods - each draws a different ingress edge (WEF, WEC relay,
            Cribl Edge, Winlogbeat, Splunk UF, or Azure Monitor Agent).
          </span>
        </label>
        <label className="field">
          <span className="field-label">Sources from Sentinel solutions (optional)</span>
          <SearchableMultiSelect
            options={solutionOptions}
            values={solutionSources}
            onChange={setSolutionSources}
            placeholder="Search the solution catalog..."
            ariaLabel="Filter Sentinel solutions"
          />
          <span className="field-hint">
            {SOLUTION_INGESTION_ENTRIES.length} solutions from the
            Azure-Sentinel repo; each solution&apos;s connector kind decides
            the drawn Cribl integration point (push, native pull, or
            agent/legacy with the custom-table alternative).
          </span>
        </label>
      </div>

      {!hasSelection ? (
        <p className="field-hint">
          Pick at least one product or resource to see the data flow. Not sure
          where to start? Cribl Stream + Microsoft Sentinel shows the pattern
          this app deploys.
        </p>
      ) : (
        <>
          {matches.length === 0 ? (
            <p className="field-hint">
              No pattern matches this exact combination yet
              {nears.length > 0
                ? " - the near matches below show what one more selection unlocks."
                : "."}
            </p>
          ) : (
            <>
              {unifiedDiagram.nodes.length > 25 && (
                <p className="field-hint">
                  Large diagram ({unifiedDiagram.nodes.length} components) -
                  narrow the selection or start from a preset for an easier
                  read; elements can also be removed directly on the canvas.
                </p>
              )}
              <ExportRow
                diagram={unifiedDiagram}
                onExport={onExport}
                baseName="dataflow-diagram"
                title="Dataflow - reference patterns"
                editsRef={patternsEditsRef}
              />
              <ArchitectureFlow
                diagram={unifiedDiagram}
                storageKey={`patterns:${[...products].sort().join("+")}/${[...resources].sort().join("+")}/${[...sources].sort().join("+")}/${[...solutionSources].sort().join("+")}`}
                onCanvasStateChange={onPatternsCanvasState}
              />
              <CostLegend />
            </>
          )}
          {matches.map((rec) => (
            <PatternCard
              key={rec.pattern.id}
              pattern={rec.pattern}
              onNavigate={onNavigate}
              canNavigate={canNavigate}
            />
          ))}
          {nears.length > 0 && (
            <div className="arch-near-block">
              <span className="field-label">
                One selection away ({nears.length})
              </span>
              {nears.map((rec) => (
                <NearMissCard key={rec.pattern.id} rec={rec} />
              ))}
            </div>
          )}
        </>
      )}
        </>
      )}
    </div>
  );
}
