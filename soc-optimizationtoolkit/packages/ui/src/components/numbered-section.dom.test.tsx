// @vitest-environment happy-dom
/**
 * DOM regression tests for the NumberedSection collapse (live report
 * 2026-07-13: collapsing the DCR Gap Analysis section and re-expanding it
 * lost the analysis - the collapsed body rendered as null, unmounting the
 * whole subtree and destroying its React state). A collapsed body must stay
 * MOUNTED and merely hidden.
 */

import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { NumberedSection } from "./numbered-section";

afterEach(cleanup);

/** A child with click-counted state - the stand-in for an analysis result. */
function StatefulChild() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      count:{count}
    </button>
  );
}

function renderSection() {
  return render(
    <NumberedSection number={3} title="Run DCR Gap Analysis" status="available" infoTip="tip">
      <StatefulChild />
    </NumberedSection>,
  );
}

describe("NumberedSection collapse", () => {
  it("keeps the body MOUNTED (state intact) across collapse and re-expand", () => {
    const { getByText, getByRole } = renderSection();

    // Build up child state - two clicks.
    fireEvent.click(getByText("count:0"));
    fireEvent.click(getByText("count:1"));
    expect(getByText("count:2")).toBeTruthy();

    // Collapse: the body is hidden but the child is still in the DOM.
    fireEvent.click(getByRole("button", { name: "Collapse Run DCR Gap Analysis" }));
    const child = getByText("count:2");
    expect(child.closest("div[hidden]")).not.toBeNull();

    // Re-expand: the same child, same state - no remount, no reset.
    fireEvent.click(getByRole("button", { name: "Expand Run DCR Gap Analysis" }));
    expect(getByText("count:2").closest("div[hidden]")).toBeNull();
  });

  it("header click toggles the collapse too", () => {
    const { getByText } = renderSection();
    fireEvent.click(getByText("count:0"));

    fireEvent.click(getByText("Run DCR Gap Analysis"));
    expect(getByText("count:1").closest("div[hidden]")).not.toBeNull();

    fireEvent.click(getByText("Run DCR Gap Analysis"));
    expect(getByText("count:1").closest("div[hidden]")).toBeNull();
  });
});
