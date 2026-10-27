// @vitest-environment happy-dom
/**
 * Canvas pins for the Azure Logging Map (AZR-19): the house diagram
 * standard's interaction contract (sibling (i), keyboard select, scoped ids,
 * popover dismissal, no animation) and its movable cards (AZR-20, which
 * replaced the approved mockup's no-drag rule once the owner chose the
 * standard).
 *
 * happy-dom cannot lay out or paint, so these pin structure and behaviour;
 * how it looks is the Live Preview check.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { normaliseScopeId, type ReadLoggingMapResult } from "@soc/core";

import { LoggingMapCanvas } from "./logging-map-canvas";
import { NODE_W } from "./logging-map-layout";
import { initialState, loggingMapReducer, type LoggingMapUiState } from "./logging-map-state";
import { MG_ALPHA, SUB_A, SUB_C, fixtureResult } from "./logging-map-test-fixture";

afterEach(cleanup);

function Harness({ result, initial }: { result: ReadLoggingMapResult; initial?: Partial<LoggingMapUiState> }) {
  const [state, setState] = useState<LoggingMapUiState>({ ...initialState(result.map), ...initial });
  return (
    <LoggingMapCanvas
      map={result.map}
      state={state}
      onSelect={(scopeId) => setState((s) => loggingMapReducer(s, { type: "select", scopeId }))}
      onToggleCollapsed={(scopeId) => setState((s) => loggingMapReducer(s, { type: "toggle-collapsed", scopeId, map: result.map }))}
      onToggleFolded={(scopeId) => setState((s) => loggingMapReducer(s, { type: "toggle-folded", scopeId, map: result.map }))}
    />
  );
}

function cardEl(container: HTMLElement, scopeId: string): SVGGElement {
  const el = container.querySelector<SVGGElement>(`[data-lm-card="${normaliseScopeId(scopeId)}"]`);
  if (el === null) throw new Error(`no card for ${scopeId}`);
  return el;
}

function infoOf(container: HTMLElement, scopeId: string): SVGGElement {
  const group = container.querySelector(`[data-lm-card-group="${normaliseScopeId(scopeId)}"]`);
  const info = group?.querySelector<SVGGElement>(":scope > [data-lm-info]");
  if (info === null || info === undefined) throw new Error(`no (i) for ${scopeId}`);
  return info;
}

describe("LoggingMapCanvas - cards and their (i)", () => {
  it("every card has a sibling (i), never a nested one", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} />);
    const cards = container.querySelectorAll("[data-lm-card]");
    // Root, Alpha, Beta (collapsed at depth 3), Sub A, Sub C, and Beta's count card.
    expect(cards.length).toBe(6);
    expect(container.querySelectorAll(".lm-card-count").length).toBe(1);
    expect(container.querySelectorAll("[data-lm-info]").length).toBe(cards.length);
    for (const c of cards) {
      expect(c.querySelector("[data-lm-info]")).toBeNull();
      const info = c.parentElement?.querySelector(":scope > [data-lm-info]");
      expect(info?.getAttribute("role")).toBe("button");
      expect(info?.getAttribute("tabindex")).toBe("0");
    }
  });

  it("clicking the (i) opens the popover and leaves aria-pressed unchanged", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} initial={{ selectedScope: null }} />);
    const card = cardEl(container, SUB_A);
    expect(card.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(infoOf(container, SUB_A));
    expect(card.getAttribute("aria-pressed")).toBe("false");
    expect(infoOf(container, SUB_A).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[role='dialog']")?.textContent).toContain("Sub A");
  });

  it("Enter and Space on a focused card select it", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} initial={{ selectedScope: null }} />);
    fireEvent.keyDown(cardEl(container, SUB_A), { key: "Enter" });
    expect(cardEl(container, SUB_A).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(cardEl(container, SUB_C), { key: " " });
    expect(cardEl(container, SUB_C).getAttribute("aria-pressed")).toBe("true");
    expect(cardEl(container, SUB_A).getAttribute("aria-pressed")).toBe("false");
  });

  it("two canvases on one page share no element id", async () => {
    const result = await fixtureResult();
    const { container } = render(
      <>
        <Harness result={result} />
        <Harness result={result} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
    // and each hatch reference resolves to its own canvas's pattern
    for (const svg of container.querySelectorAll("svg")) {
      const own = svg.querySelector("pattern")?.id;
      for (const h of svg.querySelectorAll(".lm-card-hatch")) expect(h.getAttribute("fill")).toBe(`url(#${own})`);
    }
  });
});

describe("LoggingMapCanvas - popover dismissal", () => {
  async function opened() {
    const result = await fixtureResult();
    const utils = render(<Harness result={result} />);
    fireEvent.click(infoOf(utils.container, SUB_A));
    expect(utils.container.querySelector("[role='dialog']")).not.toBeNull();
    return utils;
  }

  it("wheel closes the popover", async () => {
    const { container } = await opened();
    fireEvent.wheel(container.querySelector(".lm-canvas") as Element, { deltaY: 100 });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("Escape closes the popover", async () => {
    const { container } = await opened();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("zoom and Fit close the popover", async () => {
    const { container, getByRole } = await opened();
    fireEvent.click(getByRole("button", { name: "Zoom in" }));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    fireEvent.click(infoOf(container, SUB_A));
    fireEvent.click(getByRole("button", { name: "Fit" }));
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("an outside pointerdown closes it; one on the popover does not", async () => {
    const { container } = await opened();
    act(() => {
      container.querySelector("[role='dialog']")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});

describe("LoggingMapCanvas - configuration, not flow", () => {
  it("draws no animation of any kind", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} />);
    expect(container.querySelectorAll("animate, animateMotion, animateTransform, set").length).toBe(0);
    expect(container.querySelectorAll("[class*='anim'], [class*='pipe'], [class*='packet']").length).toBe(0);
  });

  it("the same gesture on the empty canvas does pan the view (so the drag pins below can fail)", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} />);
    const canvas = container.querySelector(".lm-canvas") as HTMLElement;
    const viewport = container.querySelector("[data-lm-viewport]") as SVGGElement;
    const viewBefore = viewport.getAttribute("transform");
    fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(canvas, { button: 0, buttons: 1, clientX: 25, clientY: 25, pointerId: 1 });
    expect(viewport.getAttribute("transform")).not.toBe(viewBefore);
  });
});

// AZR-20: the owner chose the house standard's "Movable cards" over the
// mockup's no-drag. These replace the no-drag pin, inverted.
describe("LoggingMapCanvas - movable cards (AZR-20)", () => {
  const press = (el: Element, x: number, y: number) =>
    fireEvent.pointerDown(el, { button: 0, buttons: 1, clientX: x, clientY: y, pointerId: 1 });
  const move = (el: Element, x: number, y: number) =>
    fireEvent.pointerMove(el, { button: 0, buttons: 1, clientX: x, clientY: y, pointerId: 1 });
  const up = (el: Element, x: number, y: number) =>
    fireEvent.pointerUp(el, { button: 0, buttons: 0, clientX: x, clientY: y, pointerId: 1 });

  function boxOf(container: HTMLElement, scopeId: string) {
    const rect = cardEl(container, scopeId).querySelector(".lm-card-box") as SVGRectElement;
    return { x: Number(rect.getAttribute("x")), y: Number(rect.getAttribute("y")) };
  }
  function edgeDs(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".lm-edge")].map((p) => p.getAttribute("d") ?? "");
  }
  /** The edge into a card ends at the card's top middle (layout edgeAnchors). */
  function edgeEndingAt(container: HTMLElement, box: { x: number; y: number }): string | undefined {
    return edgeDs(container).find((d) => d.endsWith(` ${box.x + NODE_W / 2} ${box.y}`));
  }
  function zoomOf(container: HTMLElement): number {
    const t = container.querySelector("[data-lm-viewport]")?.getAttribute("transform") ?? "";
    return Number(/scale\(([^)]+)\)/.exec(t)?.[1]);
  }

  it("a drag past the threshold moves the card by the pointer delta over the zoom, its edge follows, and the view does not pan", async () => {
    const result = await fixtureResult();
    const { container, getByRole } = render(<Harness result={result} />);
    // Zoom away from 1 first, so a drag that ignored the zoom would fail.
    fireEvent.click(getByRole("button", { name: "Zoom in" }));
    const card = cardEl(container, SUB_A);
    const start = boxOf(container, SUB_A);
    expect(edgeEndingAt(container, start)).toBeDefined();
    const viewport = container.querySelector("[data-lm-viewport]") as SVGGElement;
    const viewBefore = viewport.getAttribute("transform");
    const k = zoomOf(container);
    expect(k).toBeGreaterThan(0);
    expect(Math.abs(k - 1)).toBeGreaterThan(0.05);

    press(card, 100, 100);
    move(card, 120, 100);
    move(card, 120, 130);
    up(card, 120, 130);

    const moved = boxOf(container, SUB_A);
    expect(moved.x).toBeCloseTo(start.x + 20 / k, 6);
    expect(moved.y).toBeCloseTo(start.y + 30 / k, 6);
    expect(edgeEndingAt(container, moved)).toBeDefined();
    expect(edgeEndingAt(container, start)).toBeUndefined();
    expect(viewport.getAttribute("transform")).toBe(viewBefore);
  });

  it("a press that moves less than the threshold is a click: it selects and moves nothing", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} initial={{ selectedScope: null }} />);
    const card = cardEl(container, SUB_A);
    const start = boxOf(container, SUB_A);
    press(card, 100, 100);
    move(card, 102, 101);
    up(card, 102, 101);
    fireEvent.click(card);
    expect(boxOf(container, SUB_A)).toEqual(start);
    expect(card.getAttribute("aria-pressed")).toBe("true");
  });

  it("a drag keeps the same focused card element, swallows only its closing click, and every (i) stays keyboard-reachable", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} initial={{ selectedScope: null }} />);
    const card = cardEl(container, SUB_A);
    act(() => card.focus());
    expect(document.activeElement).toBe(card);

    press(card, 100, 100);
    move(card, 140, 140);
    up(card, 140, 140);
    fireEvent.click(card);

    // Same node, still focused, and the click that ended the drag did not select.
    expect(cardEl(container, SUB_A)).toBe(card);
    expect(document.activeElement).toBe(card);
    expect(card.getAttribute("aria-pressed")).toBe("false");
    // The keyboard path is untouched by the drag.
    fireEvent.keyDown(card, { key: "Enter" });
    expect(card.getAttribute("aria-pressed")).toBe("true");
    const cards = container.querySelectorAll("[data-lm-card]");
    const infos = container.querySelectorAll("[data-lm-info]");
    expect(infos.length).toBe(cards.length);
    for (const info of infos) {
      expect(info.getAttribute("role")).toBe("button");
      expect(info.getAttribute("tabindex")).toBe("0");
    }
    fireEvent.keyDown(infoOf(container, SUB_A), { key: "Enter" });
    expect(container.querySelector("[role='dialog']")?.textContent).toContain("Sub A");
  });

  it("Reset layout is disabled until a card moves, then restores the computed positions and edges", async () => {
    const result = await fixtureResult();
    const { container, getByRole } = render(<Harness result={result} />);
    const reset = getByRole("button", { name: "Reset layout" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    const start = boxOf(container, SUB_A);
    const startC = boxOf(container, SUB_C);
    const d0 = edgeDs(container);

    const card = cardEl(container, SUB_A);
    press(card, 100, 100);
    move(card, 160, 150);
    up(card, 160, 150);
    expect(boxOf(container, SUB_A)).not.toEqual(start);
    expect(edgeDs(container)).not.toEqual(d0);
    // Only the dragged card moved.
    expect(boxOf(container, SUB_C)).toEqual(startC);
    expect(reset.disabled).toBe(false);

    fireEvent.click(reset);
    expect(boxOf(container, SUB_A)).toEqual(start);
    expect(edgeDs(container)).toEqual(d0);
    expect(reset.disabled).toBe(true);
  });
});

describe("LoggingMapCanvas - encoding", () => {
  it("an unreadable subscription is a dashed card with the lock note", async () => {
    const result = await fixtureResult({ assignmentsRefused: [SUB_A] });
    const { container } = render(<Harness result={result} />);
    const card = cardEl(container, SUB_A);
    expect(card.getAttribute("class")).toContain("is-unread");
    expect(card.querySelector(".lm-card-status")?.textContent).toBe("can't be read, needs Reader");
    expect(cardEl(container, SUB_C).getAttribute("class")).not.toContain("is-unread");
  });

  it("tracing hatches the notScoped subscription and dims nothing it could not judge", async () => {
    const result = await fixtureResult();
    const key = [...result.map.assignmentsByKey.keys()].find((k) => k.endsWith("platform-diag")) ?? "";
    const { container } = render(<Harness result={result} initial={{ tracedAssignment: key }} />);
    const subC = [...container.querySelectorAll<SVGGElement>("[data-lm-card]")].find((c) =>
      c.getAttribute("aria-label")?.startsWith("Sub C"),
    );
    expect(subC?.getAttribute("class")).toContain("lm-mark-gap-excluded");
    expect(subC?.querySelector(".lm-card-hatch")).not.toBeNull();
    expect(subC?.querySelector(".lm-card-status")?.textContent).toBe("excluded (notScopes)");
    expect(cardEl(container, SUB_A).getAttribute("class")).toContain("lm-mark-covered");
  });

  it("an assignment SET AT a subscription carries its gap pill there: resourceSelectors give 'regions:'", async () => {
    const result = await fixtureResult({ subAssignment: "selectors" });
    const { container } = render(<Harness result={result} />);
    const chip = [...cardEl(container, SUB_A).querySelectorAll("[data-lm-chip]")].find((c) =>
      c.querySelector(".lm-chip-text")?.textContent?.startsWith("Sub-Diag"),
    );
    expect(chip?.getAttribute("class")).not.toContain("inherited");
    expect(chip?.querySelector(".lm-chip-pill")?.textContent).toBe("regions: eastus");
  });

  it("an assignment SET AT a subscription with a resource-group notScope reads '1 below excluded'", async () => {
    const result = await fixtureResult({ subAssignment: "rg-notscope" });
    const { container } = render(<Harness result={result} />);
    const chip = [...cardEl(container, SUB_A).querySelectorAll("[data-lm-chip]")].find((c) =>
      c.querySelector(".lm-chip-text")?.textContent?.startsWith("Sub-Diag"),
    );
    expect(chip?.querySelector(".lm-chip-pill")?.textContent).toBe("1 below excluded");
  });
});

describe("LoggingMapCanvas - the (i) popover never states a refused list as a count", () => {
  function popoverText(container: HTMLElement, scopeId: string): string {
    fireEvent.click(infoOf(container, scopeId));
    return container.querySelector("[role='dialog']")?.textContent ?? "";
  }

  it("a subscription whose assignments read was refused says 'Set here: unknown', never 'Set here: 0'", async () => {
    const result = await fixtureResult({ assignmentsRefused: [SUB_A] });
    const { container } = render(<Harness result={result} />);
    const text = popoverText(container, SUB_A);
    expect(text).not.toMatch(/Set here: \d/);
    expect(text).toContain("Set here: unknown.");
  });

  it("a management group whose read was refused gives a lower bound seen from below, not a complete figure", async () => {
    const result = await fixtureResult({ assignmentsRefused: [MG_ALPHA] });
    const { container } = render(<Harness result={result} />);
    const text = popoverText(container, MG_ALPHA);
    expect(text).not.toMatch(/Set here: 2\./);
    expect(text).toContain("Set here: at least 2, seen from scopes below.");
  });

  it("a readable scope keeps its verified figure (so the two pins above can fail)", async () => {
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} />);
    expect(popoverText(container, SUB_C)).toContain("Set here: 0.");
  });
});
