/**
 * arch-layout pins: the shared dagre geometry is deterministic, sized, and
 * keeps every node inside the reported canvas (the SVG exporter and the
 * interactive canvas both consume it).
 */

import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_PATTERNS,
  ARCHITECTURE_PRESETS,
  recommendPatterns,
  unifyPatternDiagrams,
} from "@soc/core";
import {
  CHIP_ROW_H,
  NODE_H,
  NODE_W,
  applyDiagramRemovals,
  edgeKey,
  layoutDiagram,
  nodeBadge,
  sourceTypeChips,
} from "./arch-layout";

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
      expect(node.height).toBeGreaterThanOrEqual(NODE_H);
      expect(node.x + NODE_W).toBeLessThanOrEqual(laidOut.width);
      expect(node.y + node.height).toBeLessThanOrEqual(laidOut.height);
    }
  });

  it("reserves collision-free spots for edge labels in every preset merge", () => {
    // 2026-07-30 user report: labels struck through cards. Edge labels are
    // declared to dagre as virtual nodes; this pins that the reserved label
    // box never intersects a card, across every preset's merged diagram.
    for (const preset of ARCHITECTURE_PRESETS) {
      const matches = recommendPatterns(preset.selection)
        .filter((r) => r.fit === "match")
        .map((r) => r.pattern);
      const laidOut = layoutDiagram(unifyPatternDiagrams(matches));
      for (const edge of laidOut.edges) {
        if (edge.labelPoint === undefined || edge.label === undefined) {
          continue;
        }
        const w = Math.min(edge.label.length * 5.5 + 12, 160);
        const h = edge.label.length * 5.5 > 150 ? 30 : 18;
        const left = edge.labelPoint.x - w / 2;
        const top = edge.labelPoint.y - h / 2;
        for (const node of laidOut.nodes) {
          const overlaps =
            left < node.x + NODE_W &&
            left + w > node.x &&
            top < node.y + node.height &&
            top + h > node.y;
          expect(
            overlaps,
            `${preset.id}: label '${edge.label}' overlaps card '${node.label}'`,
          ).toBe(false);
        }
      }
    }
  });

  it("tags the receiving Cribl node with its source types and grows the card", () => {
    const laidOut = layoutDiagram(diagram);
    const stream = laidOut.nodes.find((n) => n.id === "criblstream")!;
    // direct-dcr + event-hub-fanin: the Event Hub ingress names its source.
    expect(stream.sourceTypes).toContain("Azure Event Hubs");
    expect(stream.height).toBe(NODE_H + CHIP_ROW_H);
    const law = laidOut.nodes.find((n) => n.id === "loganalyticsworkspace")!;
    expect(law.sourceTypes).toEqual([]);
    expect(law.height).toBe(NODE_H);
  });

  it("is deterministic and passes edges through with their cost", () => {
    expect(layoutDiagram(diagram)).toEqual(layoutDiagram(diagram));
    const laidOut = layoutDiagram(diagram);
    expect(
      laidOut.edges.find((e) => e.from === "kinddirectdcr" && e.to === "loganalyticsworkspace")
        ?.cost,
    ).toBe("premium");
  });
});

describe("applyDiagramRemovals", () => {
  const diagram = unifyPatternDiagrams([
    ARCHITECTURE_PATTERNS.find((p) => p.id === "direct-dcr")!,
  ]);

  it("removing a node drops every edge touching it", () => {
    const result = applyDiagramRemovals(diagram, new Set(["criblstream"]), new Set());
    expect(result.nodes.some((n) => n.id === "criblstream")).toBe(false);
    expect(
      result.edges.some((e) => e.from === "criblstream" || e.to === "criblstream"),
    ).toBe(false);
    // The untouched nodes stay.
    expect(result.nodes.some((n) => n.id === "loganalyticsworkspace")).toBe(true);
  });

  it("removing an edge keeps both of its nodes", () => {
    const key = edgeKey({ from: "kinddirectdcr", to: "loganalyticsworkspace" });
    const result = applyDiagramRemovals(diagram, new Set(), new Set([key]));
    expect(
      result.edges.some((e) => e.from === "kinddirectdcr" && e.to === "loganalyticsworkspace"),
    ).toBe(false);
    expect(result.nodes).toHaveLength(diagram.nodes.length);
  });

  it("ignores unknown ids and is identity for empty removals", () => {
    expect(applyDiagramRemovals(diagram, new Set(["nope"]), new Set(["a>b"]))).toEqual(
      diagram,
    );
  });
});

describe("sourceTypeChips", () => {
  it("passes through up to three types and collapses the rest", () => {
    expect(sourceTypeChips(["Syslog"])).toEqual(["Syslog"]);
    expect(sourceTypeChips(["A", "B", "C", "D", "E"])).toEqual(["A", "B", "C", "+2"]);
  });
});

describe("nodeBadge", () => {
  it("derives destination badges from the label", () => {
    expect(nodeBadge("Microsoft Sentinel", "destination")).toBe("Sentinel");
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
