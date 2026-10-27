import { describe, expect, it } from "vitest";

import {
  DATAFLOW_PERSPECTIVES,
  ONBOARDING_SOURCES,
  buildOnboardingLanes,
  emptyProgress,
  stepsFor,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  type CoverageSelection,
  type DataflowPerspective,
  type OnboardingLane,
  type OnboardingProgress,
  type OnboardingSourceId,
} from "@soc/core";

import type { Box, Point } from "../../../components/diagram";
import {
  LANE_CARD_WIDTH,
  clampToSection,
  layoutLanes,
  relayoutEdges,
  type LaidEdge,
  type LaneLayout,
} from "./lane-layout";

// ---------------------------------------------------------------------------
// Fixtures: real lanes from the core builder, every source in How-to mode so
// the Azure side carries its step cards.
// ---------------------------------------------------------------------------

const SELECTION: CoverageSelection = { mode: "Centralized", enabled: [], subSelections: {} };

function progressFor(ids: readonly OnboardingSourceId[]): OnboardingProgress {
  let p = withPlanValues(emptyProgress(), {
    ...emptyProgress().planValues,
    subscriptionId: "sub1",
    resourceGroup: "rg1",
    namespace: "ns1",
    hubName: "defender-hub",
    storageAccount: "flowacct",
    queueName: "flowq",
  });
  for (const id of ids) p = withSourceMode(withSourceChosen(p, id, true), id, "manual");
  return p;
}

function lanesFor(ids: readonly OnboardingSourceId[], perspective: DataflowPerspective): readonly OnboardingLane[] {
  return buildOnboardingLanes({
    selection: SELECTION,
    progress: progressFor(ids),
    stepsFor,
    verdicts: null,
    arrival: null,
    criblSide: null,
    flow: null,
    perspective,
  }).lanes;
}

const ALL_IDS = ONBOARDING_SOURCES.map((s) => s.id);
// entraId and activityLog share the plan's one Event Hub namespace.
const FIXTURES: Record<string, readonly OnboardingSourceId[]> = {
  "1 lane": ["defenderExport"],
  "3 lanes (two share a namespace)": ["entraId", "activityLog", "vnetFlowLogs"],
  "8 lanes": ALL_IDS,
};

// ---------------------------------------------------------------------------
// Geometry checks (the standard's "Tests to ship": crossings, touches, shared
// runs, edges inside their section).
// ---------------------------------------------------------------------------

const SAMPLES = 32;

function parseCurve(d: string): Point[] {
  const n = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
  expect(n).toHaveLength(8);
  return [
    { x: n[0] as number, y: n[1] as number },
    { x: n[2] as number, y: n[3] as number },
    { x: n[4] as number, y: n[5] as number },
    { x: n[6] as number, y: n[7] as number },
  ];
}

function sample(edge: LaidEdge): Point[] {
  const [p0, p1, p2, p3] = parseCurve(edge.d) as [Point, Point, Point, Point];
  const out: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inside(p: Point, b: Box, margin: number): boolean {
  return p.x > b.x - margin && p.x < b.x + b.width + margin && p.y > b.y - margin && p.y < b.y + b.height + margin;
}

function crossings(layout: LaneLayout): string[] {
  const found: string[] = [];
  const pts = layout.edges.map(sample);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i] as Point[];
      const b = pts[j] as Point[];
      outer: for (let s = 0; s < a.length - 1; s++) {
        for (let t = 0; t < b.length - 1; t++) {
          if (segmentsCross(a[s] as Point, a[s + 1] as Point, b[t] as Point, b[t + 1] as Point)) {
            found.push(`${layout.edges[i]?.id} x ${layout.edges[j]?.id}`);
            break outer;
          }
        }
      }
    }
  }
  return found;
}

/** An edge passing through or grazing (2px) a card it does not join. */
function touches(layout: LaneLayout): string[] {
  const found: string[] = [];
  for (const e of layout.edges) {
    const pts = sample(e);
    for (const c of layout.cards) {
      if (c.id === e.from || c.id === e.to) continue;
      if (pts.some((p) => inside(p, c, 2))) found.push(`${e.id} touches ${c.id}`);
    }
  }
  return found;
}

/** Two edges overlapping along a segment: two consecutive samples of one within 1px of the other. */
function sharedRuns(layout: LaneLayout): string[] {
  const found: string[] = [];
  const pts = layout.edges.map(sample);
  for (let i = 0; i < pts.length; i++) {
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const a = pts[i] as Point[];
      const b = pts[j] as Point[];
      const near = a.map((p) => b.some((q, k) => k < b.length - 1 && distToSegment(p, q, b[k + 1] as Point) < 1));
      if (near.some((v, k) => v && near[k + 1] === true)) found.push(`${layout.edges[i]?.id} ~ ${layout.edges[j]?.id}`);
    }
  }
  return found;
}

function edgesOutsideSection(layout: LaneLayout): string[] {
  const found: string[] = [];
  for (const e of layout.edges) {
    const section = layout.sections.find((s) => s.sourceId === e.sourceId);
    if (section === undefined) {
      found.push(`${e.id} has no section`);
      continue;
    }
    const pts = [...sample(e), ...parseCurve(e.d)];
    if (pts.some((p) => !inside(p, section, 0.001))) found.push(`${e.id} leaves its section`);
  }
  return found;
}

function overlappingCards(layout: LaneLayout): string[] {
  const found: string[] = [];
  const cs = layout.cards;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i] as Box;
      const b = cs[j] as Box;
      const apart = a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y;
      if (!apart) found.push(`${cs[i]?.id} / ${cs[j]?.id}`);
    }
  }
  return found;
}

function cardsOutsideSection(layout: LaneLayout): string[] {
  return layout.cards
    .filter((c) => {
      const s = layout.sections.find((x) => x.sourceId === c.sourceId);
      return s === undefined || c.x < s.x || c.y < s.y || c.x + c.width > s.x + s.width || c.y + c.height > s.y + s.height;
    })
    .map((c) => c.id);
}

// ---------------------------------------------------------------------------

describe("layoutLanes: section per flow, every fixture in every perspective", () => {
  for (const [name, ids] of Object.entries(FIXTURES)) {
    for (const perspective of DATAFLOW_PERSPECTIVES) {
      describe(`${name}, ${perspective}`, () => {
        const lanes = lanesFor(ids, perspective);
        const layout = layoutLanes(lanes, perspective);

        it("draws one section per lane and every card and edge of every lane", () => {
          expect(layout.sections.map((s) => s.sourceId)).toEqual(lanes.map((l) => l.sourceId));
          expect(layout.cards).toHaveLength(lanes.reduce((n, l) => n + l.cards.length, 0));
          expect(layout.edges).toHaveLength(lanes.reduce((n, l) => n + l.edges.length, 0));
          expect(layout.edges.length).toBeGreaterThan(0);
        });

        it("has zero crossings, touches and shared runs, and no touching cards", () => {
          expect(crossings(layout)).toEqual([]);
          expect(touches(layout)).toEqual([]);
          expect(sharedRuns(layout)).toEqual([]);
          expect(overlappingCards(layout)).toEqual([]);
        });

        it("keeps every edge and every card inside its own section", () => {
          expect(edgesOutsideSection(layout)).toEqual([]);
          expect(cardsOutsideSection(layout)).toEqual([]);
        });

        it("stacks sections top to bottom without overlap", () => {
          for (let i = 1; i < layout.sections.length; i++) {
            const prev = layout.sections[i - 1] as Box;
            expect((layout.sections[i] as Box).y).toBeGreaterThan(prev.y + prev.height);
          }
        });
      });
    }
  }

  it("the Azure side actually carries step cards with configures edges (the fixtures exercise them)", () => {
    const layout = layoutLanes(lanesFor(ALL_IDS, "azure"), "azure");
    expect(layout.cards.filter((c) => c.kind === "step").length).toBeGreaterThan(8);
    expect(layout.edges.filter((e) => e.kind === "configures").length).toBeGreaterThan(8);
    // Several steps hang off one card, so distinct anchors are exercised.
    const perTarget = new Map<string, number>();
    for (const e of layout.edges) if (e.kind === "configures") perTarget.set(e.to, (perTarget.get(e.to) ?? 0) + 1);
    expect(Math.max(...perTarget.values())).toBeGreaterThan(1);
  });

  it("two lanes sharing a namespace each draw their own transport card with the one shared status", () => {
    const layout = layoutLanes(lanesFor(["entraId", "activityLog"], "end-to-end"), "end-to-end");
    const transports = layout.cards.filter((c) => c.kind === "transport");
    expect(transports.map((c) => c.sourceId)).toEqual(["activityLog", "entraId"]);
    expect(transports[0]?.card.sharedId).toBe(transports[1]?.card.sharedId);
    expect(transports[0]?.status).toEqual(transports[1]?.status);
    expect(transports[0]?.x).toBe(transports[1]?.x);
  });
});

describe("columns line up across sections", () => {
  it("the Cribl source card has the same x in every section (end-to-end and Cribl side)", () => {
    for (const perspective of ["end-to-end", "cribl"] as const) {
      const layout = layoutLanes(lanesFor(ALL_IDS, perspective), perspective);
      const xs = layout.cards.filter((c) => c.kind === "cribl-source").map((c) => c.x);
      expect(xs).toHaveLength(ALL_IDS.length);
      expect(new Set(xs).size).toBe(1);
    }
  });

  it("on the Azure side the folded Cribl card has the same x in every section", () => {
    const layout = layoutLanes(lanesFor(ALL_IDS, "azure"), "azure");
    const xs = layout.cards.filter((c) => c.kind === "cribl-folded").map((c) => c.x);
    expect(xs).toHaveLength(ALL_IDS.length);
    expect(new Set(xs).size).toBe(1);
  });

  it("aligns when one section uses fewer columns than another (a lane with no step cards)", () => {
    const [withSteps, other] = lanesFor(["entraId", "vnetFlowLogs"], "azure") as [OnboardingLane, OnboardingLane];
    const bare: OnboardingLane = {
      ...other,
      cards: other.cards.filter((c) => c.kind !== "step"),
      edges: other.edges.filter((e) => e.kind !== "configures"),
    };
    const layout = layoutLanes([withSteps, bare], "azure");
    for (const kind of ["emitter", "transport", "cribl-folded"] as const) {
      const xs = layout.cards.filter((c) => c.kind === kind).map((c) => c.x);
      expect(xs).toHaveLength(2);
      expect(new Set(xs).size).toBe(1);
    }
    expect(crossings(layout)).toEqual([]);
    expect(touches(layout)).toEqual([]);
  });

  it("a mixed 1-and-many fixture still aligns: Defender alone with the blob lane", () => {
    const layout = layoutLanes(lanesFor(["defenderExport", "vnetFlowLogs"], "end-to-end"), "end-to-end");
    for (const kind of ["emitter", "transport", "cribl-source", "route", "destination"] as const) {
      expect(new Set(layout.cards.filter((c) => c.kind === kind).map((c) => c.x)).size).toBe(1);
    }
    expect(layout.columns).toEqual(["emitter", "transport", "cribl-source", "route", "destination"]);
  });

  it("an empty lane list lays out nothing", () => {
    const layout = layoutLanes([], "end-to-end");
    expect(layout).toMatchObject({ sections: [], cards: [], edges: [], width: 0, height: 0 });
  });
});

describe("clampToSection (the drag clamp)", () => {
  const layout = layoutLanes(lanesFor(FIXTURES["3 lanes (two share a namespace)"] as OnboardingSourceId[], "end-to-end"), "end-to-end");
  const first = layout.cards.find((c) => c.sourceId === layout.sections[0]?.sourceId && c.kind === "transport");

  it("dy = +10000 keeps the card inside its own section", () => {
    expect(first).toBeDefined();
    const card = first as NonNullable<typeof first>;
    const section = layout.sections[0] as Box;
    const pos = clampToSection(layout, card.id, { x: card.x, y: card.y + 10000 });
    expect(pos.x).toBe(card.x);
    expect(pos.y).toBeLessThan(card.y + 10000);
    expect(pos.y + card.height).toBeLessThanOrEqual(section.y + section.height);
    expect(pos.y).toBeGreaterThanOrEqual(section.y);
  });

  it("clamps up, left and right too, and leaves a move inside the section alone", () => {
    const card = first as NonNullable<typeof first>;
    const section = layout.sections[0] as Box;
    const up = clampToSection(layout, card.id, { x: -5000, y: -5000 });
    expect(up.x).toBeGreaterThanOrEqual(section.x);
    expect(up.y).toBeGreaterThanOrEqual(section.y);
    const right = clampToSection(layout, card.id, { x: 99999, y: card.y });
    expect(right.x + LANE_CARD_WIDTH).toBeLessThanOrEqual(section.x + section.width);
    expect(clampToSection(layout, card.id, { x: card.x + 3, y: card.y })).toEqual({ x: card.x + 3, y: card.y });
  });

  it("an unknown card id returns the position unchanged", () => {
    expect(clampToSection(layout, "nope", { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });
});

describe("relayoutEdges", () => {
  const layout = layoutLanes(lanesFor(ALL_IDS, "azure"), "azure");

  it("with empty positions equals the computed layout", () => {
    expect(relayoutEdges(layout, {})).toEqual(layout);
  });

  it("moves a dragged card and redraws only its edges from its new position", () => {
    const card = layout.cards.find((c) => c.kind === "transport") as NonNullable<(typeof layout.cards)[number]>;
    const moved = relayoutEdges(layout, { [card.id]: { x: card.x + 10, y: card.y + 40 } });
    const after = moved.cards.find((c) => c.id === card.id);
    expect(after).toMatchObject({ x: card.x + 10, y: card.y + 40 });
    const touched = moved.edges.filter((e) => e.from === card.id || e.to === card.id);
    expect(touched.length).toBeGreaterThan(0);
    for (const e of touched) {
      const before = layout.edges.find((b) => b.id === e.id) as LaidEdge;
      expect(e.d).not.toBe(before.d);
      if (e.to === card.id) expect(e.end.x).toBe(card.x + 10);
      if (e.from === card.id) expect(e.start.x).toBe(card.x + 10 + card.width);
    }
    const untouched = moved.edges.filter((e) => e.from !== card.id && e.to !== card.id);
    for (const e of untouched) expect(e.d).toBe((layout.edges.find((b) => b.id === e.id) as LaidEdge).d);
  });
});
