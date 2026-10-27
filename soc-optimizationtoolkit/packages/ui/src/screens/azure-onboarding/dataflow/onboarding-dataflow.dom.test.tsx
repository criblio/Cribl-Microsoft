// @vitest-environment happy-dom
/**
 * Pins for the onboarding dataflow diagram (AZR-30, AZR-33): measured-only
 * animation, perspective folding, one (i) per focusable card, drag and Reset
 * through the shared shell, the visible "as of" and window, and that this
 * folder writes no canvas engine of its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeFlowRequest,
  emptyProgress,
  stepsFor,
  withCriblSource,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  type CoverageSelection,
  type LaneFlowState,
  type OnboardingProgress,
  type OnboardingSourceId,
} from "@soc/core";

import { OnboardingDataflow, type OnboardingDataflowProps } from "./onboarding-dataflow";
import type { LiveFlow } from "./use-live-flow";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SELECTION: CoverageSelection = { mode: "Centralized", enabled: [], subSelections: {} };

function progressFor(ids: readonly OnboardingSourceId[], withSources = true): OnboardingProgress {
  let p = withPlanValues(emptyProgress(), {
    ...emptyProgress().planValues,
    subscriptionId: "sub1",
    resourceGroup: "rg1",
    namespace: "ns1",
    hubName: "defender-hub",
    storageAccount: "flowacct",
    queueName: "flowq",
  });
  for (const id of ids) {
    p = withSourceMode(withSourceChosen(p, id, true), id, "manual");
    if (withSources) {
      p = withCriblSource(p, id, { groupId: "g1", inputId: `azure_onb_${id}`, inputType: "eventhub", secretId: `s_${id}` });
    }
  }
  return p;
}

function liveWith(states: LiveFlow["states"], asOf: number | null = null): LiveFlow {
  return {
    polling: states !== null,
    states,
    lookbackStatus: "answered",
    lastQuery: "window",
    asOf,
    windowSeconds: 300,
    lookback: "-24h",
    requests: { window: describeFlowRequest("g1", "window"), lookback: describeFlowRequest("g1", "lookback") },
    unmatchedLabels: [],
  };
}

const TWO: readonly OnboardingSourceId[] = ["entraId", "activityLog"];

function props(over: Partial<OnboardingDataflowProps> = {}, ids: readonly OnboardingSourceId[] = TWO): OnboardingDataflowProps {
  return {
    laneInput: { selection: SELECTION, progress: progressFor(ids), stepsFor, verdicts: null, arrival: null, criblSide: null },
    live: liveWith(null),
    watching: false,
    onWatchingChange: () => undefined,
    ...over,
  };
}

const FLOWING: LaneFlowState = { kind: "flowing", events: 42 };
const IDLE: LaneFlowState = { kind: "idle", seenInLookback: true };
const NEVER: LaneFlowState = { kind: "never-seen", lookback: "-24h" };
const NOT_MEASURED: LaneFlowState = { kind: "not-measured", reason: "no-permission", detail: "HTTP 403" };

function count(c: HTMLElement, sel: string): number {
  return c.querySelectorAll(sel).length;
}

describe("OnboardingDataflow - measured-only animation", () => {
  it("idle, never-seen and not-measured lanes draw zero packets and zero pipes", () => {
    for (const s of [IDLE, NEVER, NOT_MEASURED]) {
      const { container, unmount } = render(
        <OnboardingDataflow {...props({ watching: true, live: liveWith({ entraId: s, activityLog: s }) })} />,
      );
      expect(count(container, "animateMotion")).toBe(0);
      expect(count(container, ".azo-flow-pipe")).toBe(0);
      unmount();
    }
  });

  it("with Watch off nothing animates, even with flowing states in hand", () => {
    const { container } = render(
      <OnboardingDataflow {...props({ watching: false, live: liveWith({ entraId: FLOWING, activityLog: FLOWING }) })} />,
    );
    expect(count(container, "animateMotion")).toBe(0);
    expect(count(container, ".azo-flow-pipe")).toBe(0);
  });

  it("one flowing lane gives exactly one animated edge, on the transport -> Cribl source hop", () => {
    const { container } = render(
      <OnboardingDataflow {...props({ watching: true, live: liveWith({ entraId: FLOWING, activityLog: IDLE }) })} />,
    );
    const pipes = container.querySelectorAll(".azo-flow-pipe");
    expect(pipes).toHaveLength(1);
    const edge = pipes[0]?.closest("[data-azo-edge]")?.getAttribute("data-azo-edge");
    expect(edge).toBe("entraId:transport->entraId:cribl-source");
    expect(count(container, "animateMotion")).toBeGreaterThan(0);
    expect(container.textContent).toContain("flowing: 42 events in the window");
  });

  it("a no-permission read is captioned 'not measured: no permission', never 0", () => {
    const { container } = render(
      <OnboardingDataflow {...props({ watching: true, live: liveWith({ entraId: NOT_MEASURED, activityLog: NOT_MEASURED }) })} />,
    );
    const labels = Array.from(container.querySelectorAll(".azo-flow-edge-label")).map((n) => n.textContent);
    expect(labels).toEqual(["not measured: no permission", "not measured: no permission"]);
    expect(labels.join(" ")).not.toMatch(/\b0\b/);
  });
});

describe("OnboardingDataflow - perspectives", () => {
  it("the Cribl side folds Azure into one card per lane; the Azure side folds Cribl", () => {
    const { container, getByLabelText } = render(<OnboardingDataflow {...props()} />);
    expect(count(container, '[data-azo-kind="emitter"]')).toBe(2);
    expect(count(container, '[data-azo-kind="azure-folded"]')).toBe(0);

    fireEvent.click(getByLabelText("Cribl side"));
    expect(count(container, '[data-azo-kind="azure-folded"]')).toBe(2);
    expect(count(container, '[data-azo-kind="emitter"]')).toBe(0);
    expect(count(container, '[data-azo-kind="transport"]')).toBe(0);
    expect(count(container, '[data-azo-kind="route"]')).toBe(2);

    fireEvent.click(getByLabelText("Azure side"));
    expect(count(container, '[data-azo-kind="cribl-folded"]')).toBe(2);
    expect(count(container, '[data-azo-kind="cribl-source"]')).toBe(0);
    expect(count(container, '[data-azo-kind="step"]')).toBeGreaterThan(0);
  });
});

describe("OnboardingDataflow - info affordances", () => {
  it("every focusable card has exactly one (i), and every section caption has one", () => {
    for (const p of ["Azure side", "Cribl side", "End to end"]) {
      const { container, getByLabelText, unmount } = render(<OnboardingDataflow {...props()} />);
      fireEvent.click(getByLabelText(p));
      const cards = container.querySelectorAll('[data-azo-card][tabindex="0"]');
      expect(cards.length).toBeGreaterThan(0);
      expect(count(container, "[data-azo-card-info]")).toBe(cards.length);
      expect(count(container, "[data-azo-section-info]")).toBe(count(container, "[data-azo-section]"));
      for (const card of Array.from(cards)) {
        const group = card.closest("[data-azo-card-group]");
        expect(group?.querySelectorAll("[data-azo-card-info]")).toHaveLength(1);
      }
      unmount();
    }
  });

  it("Enter on a card opens its popover and Escape closes it", () => {
    const { container, getByRole, queryByRole } = render(<OnboardingDataflow {...props()} />);
    const card = container.querySelector('[data-azo-kind="emitter"]') as Element;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(getByRole("dialog").getAttribute("aria-label")).toMatch(/^About /);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
  });

  it("Space on a card opens its popover and prevents the default (page scroll)", () => {
    const { container, getByRole } = render(<OnboardingDataflow {...props()} />);
    const card = container.querySelector('[data-azo-kind="emitter"]') as Element;
    const notCancelled = fireEvent.keyDown(card, { key: " " });
    expect(notCancelled).toBe(false);
    expect(getByRole("dialog").getAttribute("aria-label")).toMatch(/^About /);
  });

  it("the toolbar (i) carries the literal request: method, path and body", () => {
    const { container } = render(<OnboardingDataflow {...props()} />);
    const text = container.querySelector(".azo-flow-watch")?.textContent ?? "";
    expect(text).toContain("POST /m/g1/system/metrics/query");
    expect(text).toContain("total.in_events");
  });

  it("the window and the as-of time are visible", () => {
    const { container, rerender } = render(<OnboardingDataflow {...props()} />);
    const asof = () => container.querySelector(".azo-flow-asof")?.textContent ?? "";
    expect(asof()).toContain("the last 5 minutes");
    expect(asof()).toContain("Not watching");
    rerender(<OnboardingDataflow {...props({ watching: true, live: liveWith({ entraId: IDLE }, Date.UTC(2026, 0, 1)) })} />);
    expect(asof()).toMatch(/As of /);
  });

  it("the legend lists every state word, each with an (i)", () => {
    const { container } = render(<OnboardingDataflow {...props()} />);
    const items = Array.from(container.querySelectorAll(".azo-flow-legend-item"));
    expect(items.map((i) => i.firstChild?.textContent)).toEqual(["flowing", "idle", "never seen", "not measured", "no counter"]);
    for (const i of items) expect(i.querySelectorAll(".info-tip-icon")).toHaveLength(1);
  });

  it("a blocked Watch shows its reason and cannot be turned on", () => {
    const onWatchingChange = vi.fn();
    const { getByLabelText, getByText } = render(
      <OnboardingDataflow {...props({ watchBlockedReason: "Load worker groups first", onWatchingChange })} />,
    );
    const box = getByLabelText(/Watch for data/) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(getByText("Load worker groups first")).toBeTruthy();
  });

  it("no chosen source draws an explanation, not an empty canvas", () => {
    const { container } = render(
      <OnboardingDataflow
        {...props({
          laneInput: { selection: SELECTION, progress: emptyProgress(), stepsFor, verdicts: null, arrival: null, criblSide: null },
        })}
      />,
    );
    expect(container.querySelector(".azo-flow-empty")?.textContent).toMatch(/Choose a source/);
    expect(count(container, "[data-azo-card]")).toBe(0);
  });
});

describe("OnboardingDataflow - drag through the shared shell", () => {
  function boxOf(container: HTMLElement, id: string) {
    const rect = container.querySelector(`[data-azo-card="${id}"] rect`) as SVGRectElement;
    return { x: Number(rect.getAttribute("x")), y: Number(rect.getAttribute("y")) };
  }
  const press = (el: Element, x: number, y: number) =>
    fireEvent.pointerDown(el, { button: 0, buttons: 1, clientX: x, clientY: y, pointerId: 1 });
  const move = (el: Element, x: number, y: number) =>
    fireEvent.pointerMove(el, { button: 0, buttons: 1, clientX: x, clientY: y, pointerId: 1 });
  const up = (el: Element, x: number, y: number) =>
    fireEvent.pointerUp(el, { button: 0, buttons: 0, clientX: x, clientY: y, pointerId: 1 });

  it("a 3px move is not a drag; a drag past 4px moves the card and its edge; Reset restores", () => {
    const { container, getByRole } = render(<OnboardingDataflow {...props()} />);
    const id = "entraId:cribl-source";
    const card = container.querySelector(`[data-azo-card="${id}"]`) as Element;
    const start = boxOf(container, id);
    const edgeD = () =>
      container.querySelector('[data-azo-edge="entraId:transport->entraId:cribl-source"] path')?.getAttribute("d");
    const d0 = edgeD();

    press(card, 100, 100);
    move(card, 103, 100);
    up(card, 103, 100);
    expect(boxOf(container, id)).toEqual(start);

    press(card, 100, 100);
    move(card, 110, 108);
    up(card, 110, 108);
    const moved = boxOf(container, id);
    expect(moved).not.toEqual(start);
    expect(edgeD()).not.toBe(d0);

    fireEvent.click(getByRole("button", { name: "Reset layout" }));
    expect(boxOf(container, id)).toEqual(start);
    expect(edgeD()).toBe(d0);
  });
});

describe("dataflow folder - no canvas engine of its own", () => {
  it("contains no animateMotion, wheel or timer implementation (those come from components/diagram and the poller)", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(sources).toContain("onboarding-dataflow.tsx");
    for (const f of sources) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/animateMotion/);
      expect(text, f).not.toMatch(/addEventListener\(\s*["']wheel/);
      expect(text, f).not.toMatch(/(const|function)\s+onWheel\b/);
      expect(text, f).not.toMatch(/\bset(Interval|Timeout)\s*\(/);
      expect(text, f).not.toMatch(/<mpath\b/);
    }
  });
});
