/**
 * ArchitectureScreen - the reference-architecture advisor (roadmap Phase 4
 * QUEUED item). Select the Cribl products and Azure resources in use; the
 * pure @soc/core architecture-patterns recommender returns the matching
 * patterns (and the one-addition-away near-misses), each rendered as a card
 * with rationale, considerations, and a tiered flow diagram drawn as
 * SELF-CONTAINED inline SVG (strict-CSP safe - no external assets).
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
} from "@soc/core";
import type {
  ArchitecturePattern,
  AzureResource,
  CriblProduct,
  DiagramNode,
  PatternDiagram,
  PatternRecommendation,
} from "@soc/core";
import { SearchableMultiSelect } from "../../components/searchable-select";

// ---------------------------------------------------------------------------
// Diagram renderer: tiered columns, forward/back/same-column edges, pure SVG.
// ---------------------------------------------------------------------------

const TIER_ORDER = ["source", "cribl", "azure", "destination"] as const;
const NODE_W = 150;
const NODE_H = 44;
const NODE_GAP = 18;
const COL_W = 190;
const PAD = 12;

interface PlacedNode extends DiagramNode {
  x: number;
  y: number;
}

/** Split a long label into at most two lines at the space nearest the middle. */
function wrapLabel(label: string): string[] {
  if (label.length <= 17) {
    return [label];
  }
  const mid = Math.floor(label.length / 2);
  let split = -1;
  for (let offset = 0; offset < label.length; offset += 1) {
    if (label[mid - offset] === " ") {
      split = mid - offset;
      break;
    }
    if (label[mid + offset] === " ") {
      split = mid + offset;
      break;
    }
  }
  return split === -1
    ? [label]
    : [label.slice(0, split), label.slice(split + 1)];
}

/** Compute tiered positions for a diagram's nodes. */
function placeNodes(diagram: PatternDiagram): {
  placed: Map<string, PlacedNode>;
  width: number;
  height: number;
} {
  const tiersPresent = TIER_ORDER.filter((tier) =>
    diagram.nodes.some((n) => n.tier === tier),
  );
  const columns = tiersPresent.map((tier) =>
    diagram.nodes.filter((n) => n.tier === tier),
  );
  const maxRows = Math.max(...columns.map((c) => c.length));
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * NODE_GAP;
  const width = PAD * 2 + tiersPresent.length * COL_W - (COL_W - NODE_W);

  const placed = new Map<string, PlacedNode>();
  columns.forEach((column, colIndex) => {
    const columnHeight =
      column.length * NODE_H + (column.length - 1) * NODE_GAP;
    const startY = PAD + (height - PAD * 2 - columnHeight) / 2;
    column.forEach((node, rowIndex) => {
      placed.set(node.id, {
        ...node,
        x: PAD + colIndex * COL_W,
        y: startY + rowIndex * (NODE_H + NODE_GAP),
      });
    });
  });
  return { placed, width, height };
}

/** The fill class per tier (colors live in styles.css for theme support). */
const TIER_CLASS: Record<string, string> = {
  source: "arch-node-source",
  cribl: "arch-node-cribl",
  azure: "arch-node-azure",
  destination: "arch-node-destination",
};

function PatternDiagramSvg({ diagram }: { diagram: PatternDiagram }) {
  const { placed, width, height } = placeNodes(diagram);

  return (
    <svg
      className="arch-diagram-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Architecture flow diagram"
    >
      <defs>
        <marker
          id="arch-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" className="arch-arrowhead" />
        </marker>
      </defs>

      {diagram.edges.map((edge, index) => {
        const from = placed.get(edge.from);
        const to = placed.get(edge.to);
        if (from === undefined || to === undefined) {
          return null;
        }
        let x1: number;
        let y1: number;
        let x2: number;
        let y2: number;
        let back = false;
        if (from.x < to.x) {
          // Forward edge: right edge -> left edge.
          x1 = from.x + NODE_W;
          y1 = from.y + NODE_H / 2;
          x2 = to.x;
          y2 = to.y + NODE_H / 2;
        } else if (from.x > to.x) {
          // Back edge (e.g. replay): left edge -> right edge, dashed.
          back = true;
          x1 = from.x;
          y1 = from.y + NODE_H / 2;
          x2 = to.x + NODE_W;
          y2 = to.y + NODE_H / 2;
        } else if (from.y < to.y) {
          // Same column, downward: bottom -> top.
          x1 = from.x + NODE_W / 2;
          y1 = from.y + NODE_H;
          x2 = to.x + NODE_W / 2;
          y2 = to.y;
        } else {
          // Same column, upward: top -> bottom.
          x1 = from.x + NODE_W / 2;
          y1 = from.y;
          x2 = to.x + NODE_W / 2;
          y2 = to.y + NODE_H;
        }
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        return (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              className={back ? "arch-edge arch-edge-back" : "arch-edge"}
              markerEnd="url(#arch-arrow)"
            />
            {edge.label !== undefined && (
              <text x={midX} y={midY - 5} className="arch-edge-label">
                {edge.label}
              </text>
            )}
          </g>
        );
      })}

      {[...placed.values()].map((node) => {
        const lines = wrapLabel(node.label);
        return (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={NODE_W}
              height={NODE_H}
              rx="8"
              className={`arch-node ${TIER_CLASS[node.tier] ?? ""}`}
            />
            <text
              x={node.x + NODE_W / 2}
              y={node.y + NODE_H / 2 + (lines.length === 1 ? 4 : -2)}
              className="arch-node-label"
            >
              {lines.map((line, lineIndex) => (
                <tspan
                  key={lineIndex}
                  x={node.x + NODE_W / 2}
                  dy={lineIndex === 0 ? 0 : 12}
                >
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pattern cards
// ---------------------------------------------------------------------------

function PatternCard({ pattern }: { pattern: ArchitecturePattern }) {
  return (
    <div className="arch-card">
      <div className="arch-card-head">
        <span className="arch-card-title">{pattern.title}</span>
      </div>
      <p className="panel-desc">{pattern.summary}</p>
      <div className="arch-diagram">
        <PatternDiagramSvg diagram={pattern.diagram} />
      </div>
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

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

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

  return (
    <div className="panel arch-screen">
      <h2 className="panel-title">Architecture Patterns</h2>
      <p className="panel-desc">
        Select the Cribl products and Azure resources in use to see the
        matching reference architectures - each with a flow diagram, the
        rationale, and the operational considerations. Advisory only: nothing
        here deploys anything.
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

      {products.length === 0 && resources.length === 0 ? (
        <p className="field-hint">
          Pick at least one product or resource to see recommendations. Not
          sure where to start? Cribl Stream + Microsoft Sentinel shows the
          pattern this app deploys.
        </p>
      ) : (
        <>
          {matches.length === 0 && (
            <p className="field-hint">
              No pattern matches this exact combination yet
              {nears.length > 0
                ? " - the near matches below show what one more selection unlocks."
                : "."}
            </p>
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
