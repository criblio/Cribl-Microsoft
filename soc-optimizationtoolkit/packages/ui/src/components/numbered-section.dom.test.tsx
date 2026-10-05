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

  it("puts Collapse at the BOTTOM of the expanded body and Expand in the header", () => {
    // User direction 2026-07-13: a section is finished at its end, so the
    // put-it-away control lives after the body, not in the header.
    const { getByRole, queryByRole } = renderSection();

    const collapse = getByRole("button", { name: "Collapse Run DCR Gap Analysis" });
    expect(collapse.closest(".numbered-section-head")).toBeNull();
    // DBT-127 put Collapse in a foot row beside Done - next; the row itself
    // still comes straight after the body.
    const foot = collapse.closest(".numbered-section-foot");
    expect(foot?.previousElementSibling?.className).toBe("numbered-section-body");
    // No Expand affordance while expanded.
    expect(queryByRole("button", { name: "Expand Run DCR Gap Analysis" })).toBeNull();

    fireEvent.click(collapse);
    const expand = getByRole("button", { name: "Expand Run DCR Gap Analysis" });
    expect(expand.closest(".numbered-section-head")).not.toBeNull();
    // The bottom Collapse is hidden along with the body.
    expect(
      queryByRole("button", { name: "Collapse Run DCR Gap Analysis" }),
    ).toBeNull();
  });
});

describe("NumberedSection driven by the page (DBT-127)", () => {
  function Driven({ onDone }: { onDone: () => void }) {
    const [collapsed, setCollapsed] = useState(false);
    return (
      <NumberedSection
        number={1}
        title="Select Sentinel Solution"
        status="complete"
        infoTip="tip"
        anchorId="integrate-section-solution"
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        summary="PaloAlto-PAN-OS"
        onDone={() => {
          setCollapsed(true);
          onDone();
        }}
      >
        <StatefulChild />
      </NumberedSection>
    );
  }

  it("Done collapses to a one-line summary and keeps the body mounted", () => {
    let done = 0;
    const { container, getByText, getByRole } = render(<Driven onDone={() => done++} />);
    fireEvent.click(getByText("count:0"));
    fireEvent.click(getByRole("button", { name: "Done - next" }));

    expect(done).toBe(1);
    const summary = container.querySelector(".numbered-section-summary");
    expect(summary?.textContent).toBe("PaloAlto-PAN-OS");
    // Hidden, not unmounted: the click count survives.
    const body = getByText("count:1").closest("[hidden]");
    expect(body).not.toBeNull();
  });

  it("Expand reports back to the page that owns the state", () => {
    const { container, getByRole } = render(<Driven onDone={() => undefined} />);
    fireEvent.click(getByRole("button", { name: "Done - next" }));
    fireEvent.click(getByRole("button", { name: "Expand Select Sentinel Solution" }));
    expect(container.querySelector(".numbered-section-summary")).toBeNull();
    expect(container.querySelector("[hidden]")).toBeNull();
  });

  it("carries the anchor the footer pills scroll to", () => {
    const { container } = render(<Driven onDone={() => undefined} />);
    expect(container.querySelector("section")?.id).toBe("integrate-section-solution");
  });

  it("shows no summary and no Done button when the page does not drive it", () => {
    const { container, queryByRole } = renderSection();
    expect(queryByRole("button", { name: "Done - next" })).toBeNull();
    expect(container.querySelector(".numbered-section-summary")).toBeNull();
  });
});
