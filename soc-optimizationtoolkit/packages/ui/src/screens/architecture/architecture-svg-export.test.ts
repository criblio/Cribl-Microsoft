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
    const groups = svg.match(/<g transform="translate\(/g) ?? [];
    expect(groups).toHaveLength(DIRECT_DCR.nodes.length);
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

  it("returns a minimal document for an empty diagram", () => {
    const svg = diagramToSvg({ nodes: [], edges: [] });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toContain("<g ");
  });
});
