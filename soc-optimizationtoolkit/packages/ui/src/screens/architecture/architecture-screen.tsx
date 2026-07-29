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

import { useEffect, useMemo, useState } from "react";
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
  isStreamWorkerGroup,
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
  LiveArchitectureSnapshot,
  LogSource,
  PatternDiagram,
  PatternRecommendation,
} from "@soc/core";
import { SearchableMultiSelect } from "../../components/searchable-select";
import { ArchitectureFlow } from "./architecture-flow";
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

/** SVG + PNG download buttons for whichever diagram is active. */
function ExportRow({
  diagram,
  onExport,
  baseName,
}: {
  diagram: PatternDiagram;
  onExport: OnExport;
  baseName: string;
}) {
  const [note, setNote] = useState("");
  if (onExport === undefined) {
    return null;
  }
  return (
    <div className="arch-export-row">
      <button
        type="button"
        className="arch-export-btn"
        onClick={() => {
          setNote("");
          void onExport(`${baseName}.svg`, "image/svg+xml", diagramToSvg(diagram))
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
          void svgToPngBytes(diagramToSvg(diagram))
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

/** The premium/economical badge legend under a canvas. */
function CostLegend() {
  return (
    <div className="arch-cost-legend">
      <span className="arch-flow-cost-badge arch-flow-cost-premium">premium</span>
      <span>lands in the analytics tier - billed per GB ingested</span>
      <span className="arch-flow-cost-badge arch-flow-cost-economical">
        economical
      </span>
      <span>low-cost retention or egress path</span>
      <span className="arch-legend-line-search" aria-hidden="true" />
      <span>Cribl Search send path - findings return through Stream</span>
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
  // Source/destination focus (user directive 2026-07-29): pick which
  // endpoints to present; the diagram keeps only flows between them, with
  // everything in-between. Empty = show all. Resets with each new snapshot.
  const [focusSources, setFocusSources] = useState<string[]>([]);
  const [focusOutputs, setFocusOutputs] = useState<string[]>([]);
  useEffect(() => {
    setFocusSources([]);
    setFocusOutputs([]);
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

  // The UNFOCUSED build supplies the endpoint pick lists (what could be
  // shown under the current Azure toggle); the focused build is what draws.
  const endpointResult = useMemo(
    () =>
      snapshot === null
        ? null
        : buildLiveDiagram(snapshot, { azureOnly, uiBase: criblUiBase }),
    [snapshot, azureOnly, criblUiBase],
  );
  const liveResult = useMemo(
    () =>
      snapshot === null
        ? null
        : buildLiveDiagram(snapshot, {
            azureOnly,
            uiBase: criblUiBase,
            focusSources,
            focusOutputs,
          }),
    [snapshot, azureOnly, criblUiBase, focusSources, focusOutputs],
  );
  const sourceChoices = useMemo(
    () =>
      (endpointResult?.diagram.nodes ?? [])
        .filter((n) => n.id.startsWith("in:"))
        .map((n) => ({ id: n.id.slice(3), label: n.label, hint: n.badge ?? "" })),
    [endpointResult],
  );
  const destChoices = useMemo(
    () =>
      (endpointResult?.diagram.nodes ?? [])
        .filter((n) => n.id.startsWith("out:"))
        .map((n) => ({ id: n.id.slice(4), label: n.label, hint: n.badge ?? "" })),
    [endpointResult],
  );
  const toggleIn = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

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
              ? "Load live dataflow"
              : "Refresh"}
        </button>
      </div>
      {liveError !== "" && (
        <span className="field-hint eh-warning">{liveError}</span>
      )}
      {liveResult !== null && (sourceChoices.length > 1 || destChoices.length > 1) && (
        <div className="arch-live-focus">
          {sourceChoices.length > 1 && (
            <>
              <span className="field-label">Show only these sources</span>
              <div className="arch-preset-row">
                {sourceChoices.map((choice) => (
                  <button
                    type="button"
                    key={choice.id}
                    title={choice.hint}
                    className={
                      "arch-preset-chip" +
                      (focusSources.includes(choice.id)
                        ? " arch-preset-chip-active"
                        : "")
                    }
                    onClick={() =>
                      setFocusSources((prev) => toggleIn(prev, choice.id))
                    }
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {destChoices.length > 1 && (
            <>
              <span className="field-label">Show only these destinations</span>
              <div className="arch-preset-row">
                {destChoices.map((choice) => (
                  <button
                    type="button"
                    key={choice.id}
                    title={choice.hint}
                    className={
                      "arch-preset-chip" +
                      (focusOutputs.includes(choice.id)
                        ? " arch-preset-chip-active"
                        : "")
                    }
                    onClick={() =>
                      setFocusOutputs((prev) => toggleIn(prev, choice.id))
                    }
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {(focusSources.length > 0 || focusOutputs.length > 0) && (
            <button
              type="button"
              className="arch-export-btn"
              onClick={() => {
                setFocusSources([]);
                setFocusOutputs([]);
              }}
            >
              Show all flows
            </button>
          )}
        </div>
      )}
      {liveResult !== null && (
        <>
          <ExportRow
            diagram={liveResult.diagram}
            onExport={onExport}
            baseName={`live-dataflow-${snapshot?.groupId ?? "group"}`}
          />
          <ArchitectureFlow diagram={liveResult.diagram} />
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
  const [viewMode, setViewMode] = useState<"patterns" | "live">("patterns");

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
          Live dataflow
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
              <ExportRow
                diagram={unifiedDiagram}
                onExport={onExport}
                baseName="dataflow-diagram"
              />
              <ArchitectureFlow diagram={unifiedDiagram} />
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
