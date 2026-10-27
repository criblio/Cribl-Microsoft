// @vitest-environment happy-dom
/**
 * Pins for the shared diagram canvas shell (AZR-30): the thresholds, the
 * drag (reset, clamp, swallowed click, missed release), the (i) and its
 * popover dismissal, and the measured-only animated edge.
 *
 * The harness composes the shell exactly as a consumer must (viewport pan
 * handlers on the container, card drag ahead of the pan, onViewChange closing
 * the popover), so these pins also prove the pieces fit together.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useCallback, useState } from "react";

import {
  AnimatedEdge,
  DiagramInfoPopover,
  INFO_GLYPH_R,
  INFO_HIT_R,
  InfoHitCircle,
  MAX_ANIMATED_EDGES,
  PACKETS_PER_EDGE,
  useCardDrag,
  useDiagramViewport,
  type Point,
} from "./index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LAYOUT = { cards: [{ x: 0, width: 100 }], width: 400, height: 200 };
const ORIGIN: Point = { x: 10, y: 20 };
const CLASSES = { group: "t-info", hit: "t-info-hit", glyph: "t-info-glyph", letter: "t-info-i" };

function Harness({
  clamp,
  onCardClick,
  keepOpen = "[data-t-info]",
}: {
  clamp?: (id: string, p: Point) => Point;
  onCardClick?: () => void;
  keepOpen?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const viewport = useDiagramViewport({ layout: LAYOUT, onViewChange: close, panIgnoreSelector: "[data-t-card], [data-t-info]" });
  const drag = useCardDrag({ zoom: viewport.view.k, clamp, onDragStart: close });
  const pos = drag.positions.c1 ?? ORIGIN;
  return (
    <div>
      <button type="button" onClick={viewport.zoomIn}>
        Zoom in
      </button>
      <button type="button" onClick={viewport.fit}>
        Fit
      </button>
      <button type="button" onClick={drag.reset} disabled={!drag.hasMoved}>
        Reset layout
      </button>
      <div
        ref={viewport.containerRef}
        data-t-canvas=""
        onWheel={viewport.onWheel}
        onPointerDown={viewport.panHandlers.onPointerDown}
        onPointerMove={(e) => {
          if (!drag.onPointerMove(e)) viewport.panHandlers.onPointerMove(e);
        }}
        onPointerUp={(e) => {
          drag.endDrag(e);
          viewport.panHandlers.onPointerUp(e);
        }}
        onPointerCancel={(e) => {
          drag.endDrag(e);
          viewport.panHandlers.onPointerCancel(e);
        }}
      >
        <svg>
          <g data-t-viewport="" transform={viewport.transform}>
            <g
              data-t-card=""
              role="button"
              tabIndex={0}
              aria-label="Card"
              onPointerDown={(e) => drag.onCardPointerDown(e, "c1", pos)}
              onClick={() => {
                if (!drag.wasDragged()) onCardClick?.();
              }}
            >
              <rect data-t-box="" x={pos.x} y={pos.y} width={100} height={40} />
            </g>
            <InfoHitCircle
              cx={pos.x + 90}
              cy={pos.y + 10}
              label="About Card"
              expanded={open}
              onToggle={() => setOpen((v) => !v)}
              classes={CLASSES}
              attrs={{ "data-t-info": "" }}
            />
          </g>
        </svg>
        {open && (
          <DiagramInfoPopover className="t-pop" label="About Card" left={0} top={0} onClose={close} keepOpenSelector={keepOpen}>
            <p>facts</p>
          </DiagramInfoPopover>
        )}
      </div>
    </div>
  );
}

function q<T extends Element>(c: HTMLElement, sel: string): T {
  const el = c.querySelector<T>(sel);
  if (el === null) throw new Error(`missing ${sel}`);
  return el;
}

function boxAt(c: HTMLElement) {
  const box = q<SVGRectElement>(c, "[data-t-box]");
  return { x: Number(box.getAttribute("x")), y: Number(box.getAttribute("y")) };
}

function press(el: Element, x: number, y: number) {
  fireEvent.pointerDown(el, { button: 0, buttons: 1, clientX: x, clientY: y, pointerId: 1 });
}
function move(el: Element, x: number, y: number, buttons = 1) {
  fireEvent.pointerMove(el, { button: 0, buttons, clientX: x, clientY: y, pointerId: 1 });
}
function up(el: Element, x: number, y: number) {
  fireEvent.pointerUp(el, { button: 0, buttons: 0, clientX: x, clientY: y, pointerId: 1 });
}

describe("diagram shell - drag and pan thresholds", () => {
  it("a 3px move on a card is not a drag, and the click still selects", () => {
    const onCardClick = vi.fn();
    const { container } = render(<Harness onCardClick={onCardClick} />);
    const card = q(container, "[data-t-card]");
    press(card, 100, 100);
    move(card, 103, 100);
    up(card, 103, 100);
    fireEvent.click(card);
    expect(boxAt(container)).toEqual(ORIGIN);
    expect(onCardClick).toHaveBeenCalledTimes(1);
  });

  it("a 5px move on a card drags it, and the click that ends the drag is swallowed", () => {
    const onCardClick = vi.fn();
    const { container } = render(<Harness onCardClick={onCardClick} />);
    const card = q(container, "[data-t-card]");
    const vp = q(container, "[data-t-viewport]").getAttribute("transform");
    press(card, 100, 100);
    move(card, 105, 100);
    up(card, 105, 100);
    fireEvent.click(card);
    expect(boxAt(container)).toEqual({ x: ORIGIN.x + 5, y: ORIGIN.y });
    expect(onCardClick).not.toHaveBeenCalled();
    // A card drag never pans the view.
    expect(q(container, "[data-t-viewport]").getAttribute("transform")).toBe(vp);
  });

  it("a 3px move on the empty canvas does not pan; 5px does", () => {
    const { container } = render(<Harness />);
    const canvas = q(container, "[data-t-canvas]");
    const vp = () => q(container, "[data-t-viewport]").getAttribute("transform");
    const before = vp();
    press(canvas, 100, 100);
    move(canvas, 103, 100);
    expect(vp()).toBe(before);
    move(canvas, 105, 100);
    expect(vp()).toBe("translate(5 0) scale(1)");
  });

  it("a move with the primary button already up ends the drag (a missed release cannot stick)", () => {
    const { container } = render(<Harness />);
    const card = q(container, "[data-t-card]");
    press(card, 100, 100);
    move(card, 110, 100);
    move(card, 140, 100, 0);
    move(card, 160, 100);
    expect(boxAt(container)).toEqual({ x: ORIGIN.x + 10, y: ORIGIN.y });
  });

  it("Reset layout restores the computed position", () => {
    const { container, getByRole } = render(<Harness />);
    const card = q(container, "[data-t-card]");
    expect((getByRole("button", { name: "Reset layout" }) as HTMLButtonElement).disabled).toBe(true);
    press(card, 100, 100);
    move(card, 130, 150);
    up(card, 130, 150);
    expect(boxAt(container)).toEqual({ x: ORIGIN.x + 30, y: ORIGIN.y + 50 });
    fireEvent.click(getByRole("button", { name: "Reset layout" }));
    expect(boxAt(container)).toEqual(ORIGIN);
  });

  it("the clamp callback is honoured", () => {
    const clamp = (_id: string, p: Point): Point => ({ x: p.x, y: Math.min(p.y, 60) });
    const { container } = render(<Harness clamp={clamp} />);
    const card = q(container, "[data-t-card]");
    press(card, 100, 100);
    move(card, 100, 10_100);
    expect(boxAt(container)).toEqual({ x: ORIGIN.x, y: 60 });
  });
});

describe("diagram shell - the (i) and its popover", () => {
  function opened() {
    const utils = render(<Harness />);
    fireEvent.click(q(utils.container, "[data-t-info]"));
    expect(utils.container.querySelector("[role='dialog']")).not.toBeNull();
    return utils;
  }

  it("the (i) is a keyboard-reachable sibling of the card, and its hit circle is ~1.5x the glyph", () => {
    const { container } = render(<Harness />);
    const info = q(container, "[data-t-info]");
    expect(q(container, "[data-t-card]").querySelector("[data-t-info]")).toBeNull();
    expect(info.getAttribute("role")).toBe("button");
    expect(info.getAttribute("tabindex")).toBe("0");
    const hit = Number(q(container, ".t-info-hit").getAttribute("r"));
    const glyph = Number(q(container, ".t-info-glyph").getAttribute("r"));
    expect(hit).toBe(INFO_HIT_R);
    expect(glyph).toBe(INFO_GLYPH_R);
    expect(hit / glyph).toBeCloseTo(1.5, 1);
    fireEvent.keyDown(info, { key: "Enter" });
    expect(info.getAttribute("aria-expanded")).toBe("true");
  });

  it("Escape closes the popover", () => {
    const { container } = opened();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("an outside pointerdown closes it; one on the popover or the (i) does not", () => {
    const { container } = opened();
    act(() => {
      q(container, "[role='dialog'] p").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    act(() => {
      q(container, ".t-info-glyph").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("a view change (zoom, fit, wheel) closes it through onViewChange", () => {
    const { container, getByRole } = opened();
    fireEvent.click(getByRole("button", { name: "Zoom in" }));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    fireEvent.click(q(container, "[data-t-info]"));
    fireEvent.click(getByRole("button", { name: "Fit" }));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    fireEvent.click(q(container, "[data-t-info]"));
    fireEvent.wheel(q(container, "[data-t-canvas]"), { deltaY: 100 });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("a pan closes it through onViewChange, not only through the press", () => {
    // The canvas counts as inside here, so the press alone cannot close it.
    const { container } = render(<Harness keepOpen="[data-t-info], [data-t-canvas]" />);
    fireEvent.click(q(container, "[data-t-info]"));
    const canvas = q(container, "[data-t-canvas]");
    press(canvas, 50, 50);
    move(canvas, 52, 50);
    expect(container.querySelector("[role='dialog']")).not.toBeNull();
    move(canvas, 60, 60);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function edge(animated: boolean, animatedCount = 1) {
  return render(
    <svg>
      <AnimatedEdge
        d="M 0 0 C 10 0, 20 10, 30 10"
        animated={animated}
        animatedCount={animatedCount}
        className="t-edge"
        pipeClassName="t-pipe"
        packetClassName="t-packet"
      />
    </svg>,
  ).container;
}

describe("diagram shell - AnimatedEdge moves only on measured flow", () => {
  it("animated=false draws the base path only: no animateMotion, no pipe class", () => {
    stubReducedMotion(false);
    const c = edge(false);
    expect(c.querySelectorAll(".t-edge").length).toBe(1);
    expect(c.querySelectorAll("animateMotion").length).toBe(0);
    expect(c.querySelectorAll(".t-pipe").length).toBe(0);
  });

  it("animated=true draws the pipe and packets riding the scoped base path", () => {
    stubReducedMotion(false);
    const c = edge(true);
    expect(c.querySelectorAll(".t-pipe").length).toBe(1);
    expect(c.querySelectorAll("animateMotion").length).toBe(PACKETS_PER_EDGE);
    const id = c.querySelector(".t-edge")?.id ?? "";
    expect(id).not.toBe("");
    for (const m of c.querySelectorAll("mpath")) expect(m.getAttribute("href")).toBe(`#${id}`);
  });

  it("reduced motion drops the packets but keeps the pipe class (CSS stops the dash)", () => {
    stubReducedMotion(true);
    const c = edge(true);
    expect(c.querySelectorAll("animateMotion").length).toBe(0);
    expect(c.querySelectorAll(".t-pipe").length).toBe(1);
  });

  it(`above ${MAX_ANIMATED_EDGES} animated edges the packets are dropped; at the cap they are kept`, () => {
    stubReducedMotion(false);
    expect(edge(true, MAX_ANIMATED_EDGES + 1).querySelectorAll("animateMotion").length).toBe(0);
    cleanup();
    expect(edge(true, MAX_ANIMATED_EDGES).querySelectorAll("animateMotion").length).toBe(PACKETS_PER_EDGE);
  });

  it("two edges on one page never share a path id", () => {
    stubReducedMotion(false);
    const { container } = render(
      <svg>
        <AnimatedEdge d="M 0 0 L 1 1" animated animatedCount={2} className="t-edge" pipeClassName="t-pipe" packetClassName="t-packet" />
        <AnimatedEdge d="M 0 0 L 2 2" animated animatedCount={2} className="t-edge" pipeClassName="t-pipe" packetClassName="t-packet" />
      </svg>,
    );
    const ids = [...container.querySelectorAll(".t-edge")].map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });
});
