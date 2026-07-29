/**
 * arch-layout pins: the shared dagre geometry is deterministic, sized, and
 * keeps every node inside the reported canvas (the SVG exporter and the
 * interactive canvas both consume it).
 */

import { describe, expect, it } from "vitest";
import { ARCHITECTURE_PATTERNS, unifyPatternDiagrams } from "@soc/core";
import { NODE_H, NODE_W, layoutDiagram, nodeBadge } from "./arch-layout";

describe("layoutDiagram", () => {
  const diagram = unifyPatternDiagrams([
    ARCHITECTURE_PATTERNS.find((p) => p.id === "direct-dcr")!,
    ARCHITECTURE_PATTERNS.find((p) => p.id === "event-hub-fanin")!,
  ]);

  it("reports a positive canvas and keeps every node inside it", () => {
    const laidOut = layoutDiagram(diagram);
    expect(laidOut.width).toBeGreaterThan(0);
    expect(laidOut.height).toBeGreaterThan(0);
    expect(laidOut.nodes).toHaveLength(diagram.nodes.length);
    for (const node of laidOut.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + NODE_W).toBeLessThanOrEqual(laidOut.width);
      expect(node.y + NODE_H).toBeLessThanOrEqual(laidOut.height);
    }
  });

  it("is deterministic and passes edges through with their cost", () => {
    expect(layoutDiagram(diagram)).toEqual(layoutDiagram(diagram));
    const laidOut = layoutDiagram(diagram);
    expect(
      laidOut.edges.find((e) => e.from === "kinddirectdcr" && e.to === "sentinella")
        ?.cost,
    ).toBe("premium");
  });
});

describe("nodeBadge", () => {
  it("derives destination badges from the label", () => {
    expect(nodeBadge("Sentinel / LA", "destination")).toBe("Sentinel");
    expect(nodeBadge("Cribl Lake", "destination")).toBe("Cribl");
    expect(nodeBadge("Azure Data Explorer", "destination")).toBe("Azure");
    expect(nodeBadge("Downstream consumers", "destination")).toBe("Destination");
  });

  it("keeps fixed badges on the other tiers", () => {
    expect(nodeBadge("Anything", "source")).toBe("Source");
    expect(nodeBadge("Anything", "cribl")).toBe("Cribl");
    expect(nodeBadge("Anything", "azure")).toBe("Azure");
  });
});
