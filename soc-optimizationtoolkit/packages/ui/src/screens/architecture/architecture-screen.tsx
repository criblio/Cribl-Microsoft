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

import { useMemo, useState } from "react";
import {
  AZURE_RESOURCES,
  CRIBL_PRODUCTS,
  catalogLabel,
  recommendPatterns,
  unifyPatternDiagrams,
} from "@soc/core";
import type {
  ArchitecturePattern,
  AzureResource,
  CriblProduct,
  PatternRecommendation,
} from "@soc/core";
import { SearchableMultiSelect } from "../../components/searchable-select";
import { ArchitectureFlow } from "./architecture-flow";

/** One pattern's textual rationale + considerations (the diagram is unified). */
function PatternCard({ pattern }: { pattern: ArchitecturePattern }) {
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
    </div>
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

export function ArchitectureScreen() {
  const [products, setProducts] = useState<string[]>([]);
  const [resources, setResources] = useState<string[]>([]);

  const recommendations = useMemo(
    () =>
      recommendPatterns({
        products: products as CriblProduct[],
        resources: resources as AzureResource[],
      }),
    [products, resources],
  );
  const matches = recommendations.filter((r) => r.fit === "match");
  const nears = recommendations.filter((r) => r.fit === "near");

  // The single interactive diagram merges every matched pattern's flow.
  const unifiedDiagram = useMemo(
    () => unifyPatternDiagrams(matches.map((m) => m.pattern)),
    [matches],
  );

  const hasSelection = products.length > 0 || resources.length > 0;

  return (
    <div className="panel arch-screen">
      <h2 className="panel-title">Architecture Patterns</h2>
      <p className="panel-desc">
        See how data flows from your sources through Cribl into Microsoft
        Sentinel. Select the Cribl products and Azure resources in use and the
        diagram below reshapes to match - drag nodes to explore, and read each
        pattern's rationale and considerations underneath. Advisory only:
        nothing here deploys anything.
      </p>

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
            Selecting Microsoft Sentinel implies its Log Analytics workspace.
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
            <ArchitectureFlow diagram={unifiedDiagram} />
          )}
          {matches.map((rec) => (
            <PatternCard key={rec.pattern.id} pattern={rec.pattern} />
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
    </div>
  );
}
