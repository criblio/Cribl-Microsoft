/**
 * logging-map-layout pins (AZR-19): the tree is laid out TOP TO BOTTOM, names
 * wrap within the card, hand-placed positions move only their card, and Fit
 * never drops below the legible zoom.
 */

import { describe, expect, it } from "vitest";

import { MAX_ZOOM, MIN_LEGIBLE_ZOOM, MIN_ZOOM } from "../../components/diagram/geometry";
import {
  LABEL_MAX_LINES,
  NODE_W,
  applyPositions,
  clampZoom,
  edgeAnchors,
  edgePath,
  fit,
  layoutLoggingMap,
  nodeHeight,
  wrapText,
  type LaidOutCard,
} from "./logging-map-layout";
import type { DiagramCard, DiagramGraph } from "./logging-map-state";

const card = (id: string, chipCount = 0, title = id): DiagramCard => ({
  id,
  kind: "scope",
  countOf: null,
  scopeId: id,
  title,
  chipCount,
});

/** root -> a, b ; a -> a1, a2 ; b -> b1 (a count card) */
function tree(): DiagramGraph {
  return {
    cards: [card("root", 2), card("a", 1), card("a1"), card("a2", 3), card("b"), { ...card("b1"), kind: "count", countOf: "collapsed" }],
    edges: [
      { from: "root", to: "a" },
      { from: "root", to: "b" },
      { from: "a", to: "a1" },
      { from: "a", to: "a2" },
      { from: "b", to: "b1" },
    ],
  };
}

function byId(cards: readonly LaidOutCard[]): Map<string, LaidOutCard> {
  return new Map(cards.map((c) => [c.id, c]));
}

describe("layoutLoggingMap: a hierarchy, top to bottom", () => {
  it("places every child below its parent's bottom edge", () => {
    const laid = layoutLoggingMap(tree());
    const m = byId(laid.cards);
    for (const e of tree().edges) {
      const p = m.get(e.from) as LaidOutCard;
      const c = m.get(e.to) as LaidOutCard;
      expect(c.y).toBeGreaterThan(p.y + p.height);
    }
    expect(laid.edges).toHaveLength(5);
  });

  it("siblings share a row and sit side by side", () => {
    const m = byId(layoutLoggingMap(tree()).cards);
    const a = m.get("a") as LaidOutCard;
    const b = m.get("b") as LaidOutCard;
    expect(a.y + a.height / 2).toBeCloseTo(b.y + b.height / 2, 5);
    expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(NODE_W);
  });

  it("keeps every card inside the reported canvas", () => {
    const laid = layoutLoggingMap(tree());
    for (const c of laid.cards) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.width).toBeLessThanOrEqual(laid.width);
      expect(c.y + c.height).toBeLessThanOrEqual(laid.height);
    }
  });

  it("card height grows with chips, capped at four rows", () => {
    expect(nodeHeight(1, 0)).toBeLessThan(nodeHeight(1, 1));
    expect(nodeHeight(1, 4)).toBe(nodeHeight(1, 9));
    const m = byId(layoutLoggingMap(tree()).cards);
    expect(m.get("a2")?.height).toBe(nodeHeight(1, 3));
  });

  it("an empty graph lays out to nothing", () => {
    expect(layoutLoggingMap({ cards: [], edges: [] })).toEqual({ cards: [], edges: [], width: 0, height: 0 });
  });

  it("anchors an edge from the parent's bottom middle to the child's top middle", () => {
    const m = byId(layoutLoggingMap(tree()).cards);
    const p = m.get("root") as LaidOutCard;
    const c = m.get("a") as LaidOutCard;
    const { start, end } = edgeAnchors(p, c);
    expect(start).toEqual({ x: p.x + p.width / 2, y: p.y + p.height });
    expect(end).toEqual({ x: c.x + c.width / 2, y: c.y });
    expect(edgePath([], start, end).startsWith(`M ${start.x} ${start.y} C`)).toBe(true);
    expect(edgePath([], start, end).endsWith(`${end.x} ${end.y}`)).toBe(true);
  });
});

describe("wrapText", () => {
  it("caps at three lines and ends the last with an ellipsis", () => {
    const w = wrapText("a-very-long-management-group-name-that-keeps-going-and-going-past-three-lines");
    expect(w.lines).toHaveLength(LABEL_MAX_LINES);
    expect(w.overflow).toBe(true);
    expect(w.lines[LABEL_MAX_LINES - 1]?.endsWith("…")).toBe(true);
  });

  it("leaves a short name on one line", () => {
    expect(wrapText("Short name")).toEqual({ lines: ["Short name"], overflow: false });
  });
});

describe("applyPositions: the one seam the card drag feeds (AZR-20)", () => {
  it("moves only the given card and re-routes only its edges", () => {
    const laid = layoutLoggingMap(tree());
    const before = byId(laid.cards);
    const a = before.get("a") as LaidOutCard;
    const moved = applyPositions(laid, { a: { x: a.x + 300, y: a.y + 40 } });
    const after = byId(moved.cards);
    expect(after.get("a")).toMatchObject({ x: a.x + 300, y: a.y + 40 });
    for (const id of ["root", "a1", "a2", "b", "b1"]) expect(after.get(id)).toBe(before.get(id));
    const rerouted = moved.edges.filter((e) => e.points.length === 0).map((e) => `${e.from}>${e.to}`).sort();
    expect(rerouted).toEqual(["a>a1", "a>a2", "root>a"]);
    const kept = moved.edges.find((e) => e.from === "b");
    expect(kept).toBe(laid.edges.find((e) => e.from === "b"));
    expect(moved.width).toBeGreaterThanOrEqual(a.x + 300 + a.width);
  });

  it("ignores unknown ids and returns the same layout when nothing moves", () => {
    const laid = layoutLoggingMap(tree());
    expect(applyPositions(laid, undefined)).toBe(laid);
    expect(applyPositions(laid, { ghost: { x: 5, y: 5 } })).toBe(laid);
  });
});

describe("fit and zoom", () => {
  function wide(): DiagramGraph {
    const cards = [card("root")];
    const edges = [];
    for (let i = 0; i < 30; i++) {
      cards.push(card(`s${i}`));
      edges.push({ from: "root", to: `s${i}` });
    }
    return { cards, edges };
  }

  it("never fits below the legible floor, and pans to the root for a wide tree", () => {
    const laid = layoutLoggingMap(wide());
    const view = fit(laid, { width: 800, height: 600 });
    expect(laid.width * MIN_LEGIBLE_ZOOM).toBeGreaterThan(800);
    expect(view.zoom).toBe(MIN_LEGIBLE_ZOOM);
    expect(view.panX).toBeLessThan(0);
    const root = laid.cards[0] as LaidOutCard;
    const rootCentre = (root.x + root.width / 2) * view.zoom + view.panX;
    expect(rootCentre).toBeCloseTo(400, 5);
  });

  it("centres a small tree at no more than 1:1", () => {
    const laid = layoutLoggingMap(tree());
    const view = fit(laid, { width: 4000, height: 3000 });
    expect(view.zoom).toBe(1);
    expect(view.panX).toBeCloseTo((4000 - laid.width) / 2, 5);
  });

  it("manual zoom clamps to its own wider limits", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(0.3)).toBe(0.3);
  });
});
