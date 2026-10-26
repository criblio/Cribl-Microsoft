// @vitest-environment happy-dom
/**
 * Canvas pins for the Azure Logging Map (AZR-19): the house diagram
 * standard's interaction contract (sibling (i), keyboard select, scoped ids,
 * popover dismissal, no animation) and the approved mockup's NO-DRAG rule,
 * which deviates from that standard pending its decision card.
 *
 * happy-dom cannot lay out or paint, so these pin structure and behaviour;
 * how it looks is the Live Preview check.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { normaliseScopeId, type ReadLoggingMapResult } from "@soc/core";

import { LoggingMapCanvas } from "./logging-map-canvas";
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

  it("has no drag: pressing and moving 20px on a card moves neither the card nor the view", async () => {
    // Pins the APPROVED MOCKUP (no drag) until the drag-vs-standard decision card is answered.
    const result = await fixtureResult();
    const { container } = render(<Harness result={result} />);
    const card = cardEl(container, SUB_A);
    const box = card.querySelector(".lm-card-box") as SVGRectElement;
    const before = { x: box.getAttribute("x"), y: box.getAttribute("y") };
    const viewport = container.querySelector("[data-lm-viewport]") as SVGGElement;
    const viewBefore = viewport.getAttribute("transform");
    fireEvent.pointerDown(card, { button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { button: 0, buttons: 1, clientX: 120, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { button: 0, buttons: 1, clientX: 120, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(card, { button: 0, buttons: 0, clientX: 120, clientY: 120, pointerId: 1 });
    const after = cardEl(container, SUB_A).querySelector(".lm-card-box") as SVGRectElement;
    expect({ x: after.getAttribute("x"), y: after.getAttribute("y") }).toEqual(before);
    expect(viewport.getAttribute("transform")).toBe(viewBefore);
  });

  it("the same gesture on the empty canvas does pan the view (so the pin above can fail)", async () => {
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
