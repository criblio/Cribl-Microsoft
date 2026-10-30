/**
 * diagram geometry pins (AZR-30). Characterization of the functions lifted
 * from logging-map-layout.ts: EXACT outputs, so a change in the lift shows
 * here as well as in the unmodified AZR-19 pins. Plus edgePathLR, checked on
 * parsed coordinates.
 */

import { describe, expect, it } from "vitest";

import * as layout from "../../screens/azure-logging-map/logging-map-layout";
import {
  CARD_LINE_CHARS,
  LABEL_CHARS_PER_LINE,
  LABEL_MAX_LINES,
  MAX_ZOOM,
  MIN_LEGIBLE_ZOOM,
  MIN_ZOOM,
  clampZoom,
  edgePath,
  edgePathLR,
  fit,
  fitLine,
  wrapText,
} from "./geometry";

describe("constants", () => {
  it("keep the logging map's values", () => {
    expect([CARD_LINE_CHARS, LABEL_CHARS_PER_LINE, LABEL_MAX_LINES]).toEqual([30, 24, 3]);
    expect([MIN_LEGIBLE_ZOOM, MIN_ZOOM, MAX_ZOOM]).toEqual([0.55, 0.2, 2]);
  });
});

describe("the logging map re-exports the lifted functions, not copies", () => {
  it("is the same function object for every moved name", () => {
    expect(layout.fitLine).toBe(fitLine);
    expect(layout.wrapText).toBe(wrapText);
    expect(layout.edgePath).toBe(edgePath);
    expect(layout.clampZoom).toBe(clampZoom);
    expect(layout.fit).toBe(fit);
    expect(layout.MIN_LEGIBLE_ZOOM).toBe(MIN_LEGIBLE_ZOOM);
  });
});

describe("fitLine", () => {
  it("leaves a short line and ellipsises a long one at the default 30", () => {
    expect(fitLine("short")).toBe("short");
    expect(fitLine("a".repeat(30))).toBe("a".repeat(30));
    expect(fitLine("abcdefghijklmnopqrstuvwxyz0123456789")).toBe("abcdefghijklmnopqrstuvwxyz012…");
    expect(fitLine("abcd efgh", 6)).toBe("abcd…");
  });
});

describe("wrapText", () => {
  it("caps the AZR-19 long name at three lines, exactly", () => {
    expect(wrapText("a-very-long-management-group-name-that-keeps-going-and-going-past-three-lines")).toEqual({
      lines: ["a-very-long-management-", "group-name-that-keeps-", "going-and-going-past-…"],
      overflow: true,
    });
  });

  it("leaves a short name on one line, and an empty one as one empty line", () => {
    expect(wrapText("Short name")).toEqual({ lines: ["Short name"], overflow: false });
    expect(wrapText("")).toEqual({ lines: [""], overflow: false });
  });

  it("hard-splits a token longer than a line", () => {
    expect(wrapText("abcdefghij", 4, 5)).toEqual({ lines: ["abcd", "efgh", "ij"], overflow: false });
  });

  it("ellipsises a full last line to perLine characters", () => {
    expect(wrapText("abcdefghijkl", 4, 2)).toEqual({ lines: ["abcd", "efg…"], overflow: true });
  });
});

describe("edgePath", () => {
  it("draws a vertical S-curve between two anchors", () => {
    expect(edgePath([], { x: 10, y: 20 }, { x: 110, y: 120 })).toBe("M 10 20 C 10 70, 110 70, 110 120");
    expect(edgePath([], { x: 0, y: 0 }, { x: 0, y: 10 })).toBe("M 0 0 C 0 18, 0 -8, 0 10");
  });

  it("smooths through inner waypoints and replaces the boundary points with the anchors", () => {
    const pts = [{ x: 999, y: 999 }, { x: 50, y: 50 }, { x: 999, y: 999 }];
    expect(edgePath(pts, { x: 0, y: 0 }, { x: 100, y: 100 })).toBe("M 0 0 Q 50 50, 75 75 L 100 100");
  });
});

describe("clampZoom", () => {
  it("clamps to [0.2, 2]", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(0.3)).toBe(0.3);
  });
});

describe("fit", () => {
  const card = (x: number) => ({ x, width: 200 });

  it("is the identity for an empty layout or viewport", () => {
    expect(fit({ cards: [], width: 100, height: 100 }, { width: 800, height: 600 })).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(fit({ cards: [card(0)], width: 100, height: 100 }, { width: 0, height: 600 })).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it("centres a small layout at 1:1", () => {
    expect(fit({ cards: [card(0)], width: 400, height: 200 }, { width: 800, height: 600 })).toEqual({ zoom: 1, panX: 200, panY: 200 });
  });

  it("shrinks to fit above the floor", () => {
    expect(fit({ cards: [card(0)], width: 1000, height: 500 }, { width: 800, height: 600 })).toEqual({ zoom: 0.8, panX: 0, panY: 100 });
  });

  it("stops at the legible floor and centres the first card", () => {
    const view = fit({ cards: [card(2000)], width: 4000, height: 500 }, { width: 800, height: 600 });
    expect(view.zoom).toBe(MIN_LEGIBLE_ZOOM);
    expect(view.panX).toBeCloseTo(400 - 2100 * 0.55, 9);
    expect(view.panY).toBeCloseTo((600 - 500 * 0.55) / 2, 9);
  });

  it("never pans past the left edge of the content", () => {
    expect(fit({ cards: [card(0)], width: 4000, height: 500 }, { width: 800, height: 600 }).panX).toBe(0);
  });
});

/** Parse "M sx sy C c1x c1y, c2x c2y, ex ey" into numbers. */
function parseCurve(d: string): number[] {
  const m = /^M (\S+) (\S+) C (\S+) (\S+), (\S+) (\S+), (\S+) (\S+)$/.exec(d);
  if (!m) throw new Error(`not a single cubic: ${d}`);
  return m.slice(1).map(Number);
}

describe("edgePathLR", () => {
  it("runs from the right edge mid-height to the left edge mid-height", () => {
    const from = { x: 10, y: 20, width: 200, height: 60 };
    const to = { x: 300, y: 100, width: 180, height: 40 };
    const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = parseCurve(edgePathLR(from, to));
    expect([sx, sy]).toEqual([210, 50]);
    expect([ex, ey]).toEqual([300, 120]);
    // Horizontal tangents: leaves and enters sideways.
    expect(c1y).toBe(sy);
    expect(c2y).toBe(ey);
    expect(c1x).toBeGreaterThan(sx as number);
    expect(c2x).toBeLessThan(ex as number);
  });

  it("keeps a minimum bend when the cards are close", () => {
    const [sx, , c1x] = parseCurve(edgePathLR({ x: 0, y: 0, width: 100, height: 20 }, { x: 110, y: 0, width: 100, height: 20 }));
    expect((c1x as number) - (sx as number)).toBe(18);
  });
});
