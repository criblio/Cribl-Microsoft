// @vitest-environment happy-dom
/**
 * Pins for useNumericField (2026-08-20 bug-hunt).
 *
 * The capture and Lake panels both pin this hook's behaviour end-to-end, which
 * is where it matters. These cover the edges neither panel exercises - a
 * negative bound, a non-numeric one, a decimal - because the hook is shared now
 * and the next panel to use it will not re-derive them.
 *
 * Exercised through a PROBE COMPONENT rather than renderHook, following
 * use-workspace-tables.dom.test.tsx: it keeps the pin honest about the hook
 * being used the way React actually uses it.
 */

import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { useNumericField } from "./use-numeric-field";

afterEach(cleanup);

/** Renders the box the hook drives, plus the value it would SEND. */
function Probe({ fallback }: { fallback: number }) {
  const field = useNumericField(fallback);
  return (
    <div>
      <input
        aria-label="bound"
        value={field.text}
        onChange={(e) => field.setText(e.target.value)}
      />
      <span data-testid="sent">{field.value}</span>
    </div>
  );
}

const box = () => screen.getByLabelText("bound") as HTMLInputElement;
const sent = () => screen.getByTestId("sent").textContent;

/** Type into the box, the way a user does. */
const type = (value: string) => {
  fireEvent.change(box(), { target: { value } });
};

describe("useNumericField", () => {
  it("starts at the default, in the box and in what it would send", () => {
    render(<Probe fallback={100} />);
    expect(box().value).toBe("100");
    expect(sent()).toBe("100");
  });

  it("sends what the operator typed", () => {
    render(<Probe fallback={100} />);
    type("25");
    expect(sent()).toBe("25");
  });

  it("lets the box be EMPTY while it is being typed into", () => {
    // The whole reason the text is held rather than the number. Coercing in the
    // change handler snaps the field back to the default mid-edit, so an
    // operator clearing "10" to type "25" ends up with "1025".
    render(<Probe fallback={100} />);
    type("");
    expect(box().value).toBe("");
  });

  it("sends the DEFAULT for an empty box, never zero and never one", () => {
    // Number("") is 0, and every consumer clamps up to a floor of 1. That turned
    // a cleared box into a capture of one event, or one second.
    render(<Probe fallback={100} />);
    type("");
    expect(sent()).toBe("100");
  });

  it("sends the default for a bound that is not a usable number", () => {
    render(<Probe fallback={100} />);
    for (const junk of ["abc", "-5", "0", "-"]) {
      type(junk);
      expect(sent()).toBe("100");
    }
  });

  it("passes a DECIMAL through rather than guessing", () => {
    // Rounding belongs to the usecase that owns the API's real bounds -
    // clampLimit already floors. Two places rounding differently is how the
    // number on screen stops matching the one on the wire.
    render(<Probe fallback={100} />);
    type("2.5");
    expect(sent()).toBe("2.5");
  });

  it("recovers once a usable number is typed again", () => {
    render(<Probe fallback={100} />);
    type("");
    expect(sent()).toBe("100");
    type("7");
    expect(sent()).toBe("7");
  });
});
