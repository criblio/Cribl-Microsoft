// @vitest-environment happy-dom
/**
 * DBT-126: the (i) must open on a click and stay open, and inside a <label>
 * it must not also operate the control the label wraps. DBT-125 moves page
 * prose into these tips, many of them inside field labels, so both defects
 * would have landed on every field of the Sentinel Integration page.
 *
 * Open state is read from aria-expanded on the icon - the same attribute a
 * screen reader announces, so the test asserts what a user is told.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { InfoTip } from "./info-tip";

afterEach(cleanup);

function icon(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(".info-tip-icon");
  if (found === null) throw new Error("no info-tip icon rendered");
  return found;
}

/** A real pointer press: mousedown, then focus, then click - in that order. */
function press(el: HTMLElement): void {
  fireEvent.mouseDown(el);
  el.focus();
  fireEvent.click(el);
}

describe("InfoTip open state (DBT-126)", () => {
  it("stays OPEN after a pointer press - the focus and the click are one gesture", () => {
    const { container } = render(<InfoTip text="What this field holds." />);
    press(icon(container));
    expect(icon(container).getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on a second press", () => {
    const { container } = render(<InfoTip text="What this field holds." />);
    press(icon(container));
    fireEvent.click(icon(container));
    expect(icon(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open when the pointer leaves a tip the reader pinned by clicking", () => {
    const { container } = render(<InfoTip text="What this field holds." />);
    fireEvent.mouseEnter(icon(container));
    press(icon(container));
    fireEvent.mouseLeave(icon(container));
    expect(icon(container).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens on hover alone and closes when the pointer leaves", () => {
    const { container } = render(<InfoTip text="What this field holds." />);
    fireEvent.mouseEnter(icon(container));
    expect(icon(container).getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseLeave(icon(container));
    expect(icon(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles with Enter and Space for keyboard users", () => {
    const { container } = render(<InfoTip text="What this field holds." />);
    fireEvent.keyDown(icon(container), { key: "Enter" });
    expect(icon(container).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(icon(container), { key: " " });
    expect(icon(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and on an outside mousedown or touchstart", () => {
    const { container } = render(<InfoTip text="What this field holds." />);
    press(icon(container));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(icon(container).getAttribute("aria-expanded")).toBe("false");

    press(icon(container));
    fireEvent.mouseDown(document.body);
    expect(icon(container).getAttribute("aria-expanded")).toBe("false");

    press(icon(container));
    fireEvent.touchStart(document.body);
    expect(icon(container).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("InfoTip inside a label (DBT-126)", () => {
  // What keeps a label's control from toggling is the click being CANCELLED:
  // a browser runs label activation after dispatch ends and skips it for a
  // cancelled event. happy-dom runs it as the event passes the label, which is
  // BEFORE React's root listener sees it, so the checkbox itself cannot be
  // asserted here without lying about browsers either way. The cancelled flag
  // is the contract; the checkbox was confirmed in the Live Preview.
  it("opens and stays open when pressed inside a label", () => {
    const { container } = render(
      <label>
        <input type="checkbox" />
        <span>
          Create a DCE <InfoTip text="What a DCE adds." />
        </span>
      </label>,
    );
    press(icon(container));
    expect(icon(container).getAttribute("aria-expanded")).toBe("true");
  });

  it("marks the click handled, so no ancestor activation runs", () => {
    const { container } = render(<InfoTip text="What this field holds." />);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    icon(container).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
});
