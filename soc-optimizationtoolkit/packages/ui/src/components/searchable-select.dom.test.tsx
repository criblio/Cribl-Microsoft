// @vitest-environment happy-dom
/**
 * DOM regression tests for the SearchableMultiSelect interaction (live report
 * 2026-07-09: "Deploy to multiple worker groups only allows 1 additional
 * deployment instead of multiple"). The pure filter/toggle math was already
 * pinned; these tests drive REAL clicks through the rendered DOM to pin the
 * interaction, including the integrate-screen structure where the control
 * sits INSIDE a <label> - a click anywhere in a label re-dispatches a click
 * to its first labelable descendant (the combobox control button), which
 * toggles the popover.
 */

import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import {
  NO_OPTIONS_TEXT,
  SearchableMultiSelect,
  SearchableSelect,
} from "./searchable-select";

const OPTIONS = [
  { value: "defaultHybrid", label: "defaultHybrid" },
  { value: "DatacenterEast", label: "DatacenterEast" },
  { value: "o11yDemo", label: "o11yDemo" },
];

/** Stateful harness mirroring integrate-screen's extraGroups wiring. */
function Harness({ wrapInLabel }: { wrapInLabel: boolean }) {
  const [values, setValues] = useState<string[]>([]);
  const control = (
    <SearchableMultiSelect
      options={OPTIONS}
      values={values}
      onChange={setValues}
      placeholder="Select additional worker groups..."
      ariaLabel="Filter worker groups"
    />
  );
  return (
    <div>
      <output data-testid="values">{values.join(",")}</output>
      {wrapInLabel ? (
        <label className="field">
          <span>Additional worker groups</span>
          {control}
        </label>
      ) : (
        <div className="field">
          <span>Additional worker groups</span>
          {control}
        </div>
      )}
    </div>
  );
}

function openPopover(container: HTMLElement) {
  const button = container.querySelector(".searchable-select-control");
  if (button === null) throw new Error("control button not found");
  fireEvent.click(button);
}

function clickOption(container: HTMLElement, label: string) {
  const options = [...container.querySelectorAll(".searchable-select-option")];
  const target = options.find((o) => o.textContent?.includes(label));
  if (target === undefined) {
    throw new Error(
      `option ${label} not rendered (popover closed?) - saw: ${options
        .map((o) => o.textContent)
        .join(", ")}`,
    );
  }
  fireEvent.click(target);
}

describe("SearchableMultiSelect DOM interaction", () => {
  it("accumulates several selections across clicks (unwrapped)", () => {
    const { container, getByTestId, unmount } = render(
      <Harness wrapInLabel={false} />,
    );
    openPopover(container);
    clickOption(container, "defaultHybrid");
    if (container.querySelector(".searchable-select-option") === null) {
      openPopover(container);
    }
    clickOption(container, "DatacenterEast");
    expect(getByTestId("values").textContent).toBe(
      "defaultHybrid,DatacenterEast",
    );
    unmount();
    cleanup();
  });

  it("accumulates two picks in ONE popover visit when wrapped in a <label> (integrate-screen structure)", () => {
    const { container, getByTestId, unmount } = render(
      <Harness wrapInLabel={true} />,
    );
    openPopover(container);
    clickOption(container, "defaultHybrid");
    // NO reopen between picks: the popover must survive the first click.
    clickOption(container, "DatacenterEast");
    expect(getByTestId("values").textContent).toBe(
      "defaultHybrid,DatacenterEast",
    );
    unmount();
    cleanup();
  });

  it("keeps the popover open after a pick so several can be checked in one visit", () => {
    const { container, unmount } = render(<Harness wrapInLabel={true} />);
    openPopover(container);
    clickOption(container, "defaultHybrid");
    // The popover must still be rendered after the pick - closing it after
    // every selection is what reads as "only allows 1".
    expect(container.querySelector(".searchable-select-option")).not.toBeNull();
    unmount();
    cleanup();
  });
});

/** Single-select harness, label-wrapped like the primary group picker. */
function SingleHarness() {
  const [value, setValue] = useState("");
  return (
    <div>
      <output data-testid="value">{value}</output>
      <label className="field">
        <span>Worker group</span>
        <SearchableSelect
          options={OPTIONS}
          value={value}
          onChange={setValue}
          ariaLabel="Filter worker groups"
        />
      </label>
    </div>
  );
}

describe("SearchableSelect DOM interaction (label-wrapped)", () => {
  it("closes cleanly after a pick instead of re-opening via label forwarding", () => {
    const { container, getByTestId, unmount } = render(<SingleHarness />);
    openPopover(container);
    clickOption(container, "DatacenterEast");
    expect(getByTestId("value").textContent).toBe("DatacenterEast");
    // Without the label-activation cancel, the forwarded click re-toggled
    // the just-closed popover back open.
    expect(container.querySelector(".searchable-select-option")).toBeNull();
    unmount();
    cleanup();
  });
});

/**
 * DBT-134: zero OPTIONS and zero MATCHES are different facts. The popover used
 * to say "No matches" for both, so a list nobody could see read as the
 * operator's own typo in the filter box.
 */
describe("Searchable selects: empty options are not 'No matches'", () => {
  function emptyRow(container: HTMLElement): string {
    return container.querySelector(".searchable-select-empty")?.textContent ?? "";
  }

  it("shows emptyText, not 'No matches', when there are no options at all", () => {
    const { container } = render(
      <SearchableSelect options={[]} value="" onChange={() => {}} emptyText="Nothing listed here" />,
    );
    openPopover(container);
    expect(emptyRow(container)).toBe("Nothing listed here");
    cleanup();
  });

  it("defaults to the no-options text when emptyText is omitted, single and multi", () => {
    const single = render(<SearchableSelect options={[]} value="" onChange={() => {}} />);
    openPopover(single.container);
    expect(emptyRow(single.container)).toBe(NO_OPTIONS_TEXT);
    expect(emptyRow(single.container)).not.toBe("No matches");
    cleanup();

    const multi = render(<SearchableMultiSelect options={[]} values={[]} onChange={() => {}} />);
    openPopover(multi.container);
    expect(emptyRow(multi.container)).toBe(NO_OPTIONS_TEXT);
    cleanup();
  });

  it("still says 'No matches' when options exist and the filter excludes them all", () => {
    const { container } = render(
      <SearchableSelect options={OPTIONS} value="" onChange={() => {}} emptyText="Nothing listed here" />,
    );
    openPopover(container);
    const filter = container.querySelector(".searchable-select-search") as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "zzz-no-such-group" } });
    expect(emptyRow(container)).toBe("No matches");
    cleanup();
  });
});
