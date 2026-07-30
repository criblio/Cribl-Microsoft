/**
 * architecture-svg-export pins: the exporter is pure and deterministic,
 * escapes labels, carries the cost tinting, and sizes from the shared
 * layout.
 */

import { describe, expect, it } from "vitest";
import { ARCHITECTURE_PATTERNS, unifyPatternDiagrams } from "@soc/core";
import type { PatternDiagram } from "@soc/core";
import { diagramToSvg } from "./architecture-svg-export";

const DIRECT_DCR = unifyPatternDiagrams([
  ARCHITECTURE_PATTERNS.find((p) => p.id === "direct-dcr")!,
]);

describe("diagramToSvg", () => {
  it("produces a standalone SVG document", () => {
    const svg = diagramToSvg(DIRECT_DCR);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toMatch(/width="\d+/);
  });

  it("is deterministic", () => {
    expect(diagramToSvg(DIRECT_DCR)).toBe(diagramToSvg(DIRECT_DCR));
  });

  it("renders one node group per diagram node", () => {
    const svg = diagramToSvg(DIRECT_DCR);
    const groups = svg.match(/<g data-node /g) ?? [];
    expect(groups).toHaveLength(DIRECT_DCR.nodes.length);
  });

  it("carries a title block and an embedded legend", () => {
    const svg = diagramToSvg(DIRECT_DCR, { title: "Dataflow - test" });
    expect(svg).toContain(">Dataflow - test</text>");
    // The legend strip: every semantic that appears on edges has a key row.
    expect(svg).toContain("premium: per-GB ingest billing");
    expect(svg).toContain("economical: low-cost store/egress");
    expect(svg).toContain("Search send path");
    expect(svg).toContain("subdued: configured, not flowing");
    // Untitled exports still carry the legend.
    expect(diagramToSvg(DIRECT_DCR)).toContain("premium: per-GB ingest billing");
  });

  it("draws stage bands behind multi-tier diagrams", () => {
    const svg = diagramToSvg(DIRECT_DCR);
    expect(svg).toContain(">SOURCES</text>");
    expect(svg).toContain(">CRIBL</text>");
  });

  it("escapes XML-hostile labels", () => {
    const diagram: PatternDiagram = {
      nodes: [
        { id: "a", label: "AT&T <edge>", tier: "source" },
        { id: "b", label: "Cribl Stream", tier: "cribl" },
        { id: "c", label: "Log Analytics workspace", tier: "destination" },
      ],
      edges: [
        { from: "a", to: "b", label: "R&D feed" },
        { from: "b", to: "c" },
      ],
    };
    const svg = diagramToSvg(diagram);
    expect(svg).toContain("AT&amp;T &lt;edge&gt;");
    expect(svg).toContain("R&amp;D feed");
    expect(svg).not.toContain("AT&T");
  });

  it("tints premium edges with the warn color and captions the tier", () => {
    const svg = diagramToSvg(DIRECT_DCR);
    expect(svg).toContain('stroke="#d46b08"');
    expect(svg).toContain(">PREMIUM</text>");
  });

  it("draws the Search send path in its own violet, cost caption intact", () => {
    const searchInPlace = unifyPatternDiagrams([
      ARCHITECTURE_PATTERNS.find((p) => p.id === "search-in-place")!,
    ]);
    const svg = diagramToSvg(searchInPlace);
    // The tone wins on the LINE (all three send-path legs), while the
    // premium caption on the DCR leg keeps its warn color.
    expect(svg).toContain('stroke="#722ed1"');
    expect(svg).toContain(">PREMIUM</text>");
  });

  it("wraps long unbroken labels onto two lines instead of overhanging", () => {
    const diagram: PatternDiagram = {
      nodes: [
        {
          id: "a",
          label: "Reduction_Zscaler_Internet_firewall",
          tier: "cribl",
        },
      ],
      edges: [],
    };
    const svg = diagramToSvg(diagram);
    expect(svg).toContain("<tspan");
    expect(svg).not.toContain(">Reduction_Zscaler_Internet_firewall</text>");
  });

  it("applies canvas edits: removals, positions, bends, and notes", () => {
    const svg = diagramToSvg(DIRECT_DCR, {
      title: "Edited",
      edits: {
        positions: { criblstream: { x: 500, y: 300 } },
        edges: {
          "criblstream>kinddirectdcr": { bends: [{ x: 640, y: 260 }] },
        },
        removedNodes: ["logsources"],
        removedEdges: [],
        notes: [{ id: "1", text: "cutover Q3", x: 40, y: 40 }],
      },
    });
    // The removed card is gone; the dragged card exports at its position.
    expect(svg).not.toContain("Log sources");
    expect(svg).toContain('data-node transform="translate(500,300)"');
    // The annotation exports as a sticky card.
    expect(svg).toContain("<g data-note");
    expect(svg).toContain("cutover Q3");
    // Bands describe the AUTOMATIC layout only - moved cards drop them.
    expect(svg).not.toContain(">SOURCES</text>");
  });

  it("returns a minimal document for an empty diagram", () => {
    const svg = diagramToSvg({ nodes: [], edges: [] });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toContain("<g ");
  });
});
