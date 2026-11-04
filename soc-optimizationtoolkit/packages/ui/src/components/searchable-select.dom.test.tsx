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

import { describe, expect, it, vi } from "vitest";
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
      label="Additional worker groups"
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
          label="Worker group"
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
      <SearchableSelect options={[]} value="" onChange={() => {}} emptyText="Nothing listed here" label="Test picker" />,
    );
    openPopover(container);
    expect(emptyRow(container)).toBe("Nothing listed here");
    cleanup();
  });

  it("defaults to the no-options text when emptyText is omitted, single and multi", () => {
    const single = render(<SearchableSelect options={[]} value="" onChange={() => {}} label="Test picker" />);
    openPopover(single.container);
    expect(emptyRow(single.container)).toBe(NO_OPTIONS_TEXT);
    expect(emptyRow(single.container)).not.toBe("No matches");
    cleanup();

    const multi = render(<SearchableMultiSelect options={[]} values={[]} onChange={() => {}} label="Test picker" />);
    openPopover(multi.container);
    expect(emptyRow(multi.container)).toBe(NO_OPTIONS_TEXT);
    cleanup();
  });

  it("still says 'No matches' when options exist and the filter excludes them all", () => {
    const { container } = render(
      <SearchableSelect options={OPTIONS} value="" onChange={() => {}} emptyText="Nothing listed here" label="Test picker" />,
    );
    openPopover(container);
    const filter = container.querySelector(".searchable-select-search") as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "zzz-no-such-group" } });
    expect(emptyRow(container)).toBe("No matches");
    cleanup();
  });
});

// DBT-249: the label decoy absorbs a wrapping <label>, so the trigger was an
// unnamed button. `label` names it; `title` carries a hover hint.
describe("SearchableSelect accessible name (DBT-249)", () => {
  it("names the trigger with label, even inside a wrapping <label>, and names the filter after it", () => {
    const { getByRole, getByLabelText, container } = render(
      <label>
        <span>Event Hub namespace</span>
        <SearchableSelect options={OPTIONS} value="" onChange={() => {}} label="Event Hub namespace" title="why" />
      </label>,
    );
    const trigger = getByRole("button", { name: "Event Hub namespace" });
    expect(trigger.getAttribute("title")).toBe("why");
    fireEvent.click(trigger);
    expect(getByLabelText("Filter Event Hub namespace").tagName).toBe("INPUT");
    expect(container.querySelectorAll(".searchable-select-option").length).toBe(3);
    cleanup();
  });

  it("keeps an explicit ariaLabel as the filter's name", () => {
    const { getByRole, getByLabelText } = render(
      <SearchableSelect options={OPTIONS} value="" onChange={() => {}} label="Worker group" ariaLabel="Filter worker groups" />,
    );
    fireEvent.click(getByRole("button", { name: "Worker group" }));
    expect(getByLabelText("Filter worker groups").tagName).toBe("INPUT");
    cleanup();
  });

  it("names the multi-select trigger the same way", () => {
    const { getByRole } = render(
      <SearchableMultiSelect options={OPTIONS} values={[]} onChange={() => {}} label="Additional worker groups" />,
    );
    expect(getByRole("button", { name: "Additional worker groups" })).toBeTruthy();
    cleanup();
  });
});

// DBT-249 review: the conversions exposed two gaps a native <select> did not
// have - focus fell to <body> after a pick, and no single option could be
// disabled (DBT-209's refused Action choices became clickable).
describe("SearchableSelect focus and disabled options (DBT-249)", () => {
  it("returns focus to the trigger after a click pick, an Enter pick and Escape", () => {
    const onChange = vi.fn();
    const { getByRole, container } = render(
      <SearchableSelect options={OPTIONS} value="" onChange={onChange} label="Group" />,
    );
    const trigger = getByRole("button", { name: "Group" });
    fireEvent.click(trigger);
    fireEvent.click(container.querySelectorAll(".searchable-select-option")[1]!);
    expect(onChange).toHaveBeenLastCalledWith("DatacenterEast");
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".searchable-select-option")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    cleanup();
  });

  it("shows a disabled option, marks it, and never chooses it by click or Enter", () => {
    const onChange = vi.fn();
    const opts = [
      { value: "keep", label: "keep" },
      { value: "rename", label: "rename (choose a Dest Field first)", disabled: true },
    ];
    const { getByRole, container } = render(
      <SearchableSelect options={opts} value="keep" onChange={onChange} label="Action" />,
    );
    fireEvent.click(getByRole("button", { name: "Action" }));
    const rows = container.querySelectorAll(".searchable-select-option");
    expect(rows.length).toBe(2);
    expect(rows[1]!.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(rows[1]!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.mouseEnter(rows[1]!);
    fireEvent.keyDown(container.querySelector("input[type=text], input:not([type])")!, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    cleanup();
  });

  it("never toggles a disabled option in the multi-select", () => {
    const onChange = vi.fn();
    const { getByRole, container } = render(
      <SearchableMultiSelect
        options={[{ value: "a", label: "a" }, { value: "b", label: "b", disabled: true }]}
        values={[]}
        onChange={onChange}
        label="Groups"
      />,
    );
    fireEvent.click(getByRole("button", { name: "Groups" }));
    fireEvent.click(container.querySelectorAll(".searchable-select-option")[1]!);
    expect(onChange).not.toHaveBeenCalled();
    cleanup();
  });
});

// DBT-249 follow-up (operator 2026-11-03): a native <select>'s empty option
// let an operator clear a choice; clearLabel brings that back explicitly.
describe("SearchableSelect clearLabel", () => {
  it("offers the clear choice only once something is chosen, and clearing sends an empty value", () => {
    const onChange = vi.fn();
    const empty = render(<SearchableSelect options={OPTIONS} value="" onChange={onChange} label="Group" clearLabel="None" />);
    fireEvent.click(empty.getByRole("button", { name: "Group" }));
    expect([...empty.container.querySelectorAll(".searchable-select-option")].map((o) => o.textContent)).not.toContain("None");
    cleanup();

    const chosen = render(<SearchableSelect options={OPTIONS} value="o11yDemo" onChange={onChange} label="Group" clearLabel="None" />);
    fireEvent.click(chosen.getByRole("button", { name: "Group" }));
    const rows = [...chosen.container.querySelectorAll(".searchable-select-option")];
    expect(rows[0]!.textContent).toBe("None");
    fireEvent.click(rows[0]!);
    expect(onChange).toHaveBeenLastCalledWith("");
    cleanup();
  });

  it("offers no clear choice without clearLabel", () => {
    const { getByRole, container } = render(
      <SearchableSelect options={OPTIONS} value="o11yDemo" onChange={() => {}} label="Group" />,
    );
    fireEvent.click(getByRole("button", { name: "Group" }));
    expect(container.querySelectorAll(".searchable-select-option").length).toBe(OPTIONS.length);
    cleanup();
  });
});

describe("SearchableSelect - focus returns to the control (DBT-251)", () => {
  function Single() {
    const [value, setValue] = useState("o11yDemo");
    const [focusedAtChange, setFocusedAtChange] = useState("");
    return (
      <div>
        <output data-testid="focused-at-change">{focusedAtChange}</output>
        <SearchableSelect
          label="Group"
          options={OPTIONS}
          value={value}
          onChange={(v) => {
            // What a host that opens a panel on change would record as its opener.
            setFocusedAtChange(document.activeElement?.className ?? "");
            setValue(v);
          }}
        />
      </div>
    );
  }

  it("focuses the control BEFORE onChange runs, on a click pick", () => {
    const { container, getByTestId } = render(<Single />);
    const control = container.querySelector<HTMLButtonElement>(".searchable-select-control")!;
    fireEvent.click(control);
    const option = [...container.querySelectorAll(".searchable-select-option")].find(
      (o) => o.textContent === "DatacenterEast",
    )!;
    fireEvent.click(option);
    expect(getByTestId("focused-at-change").textContent).toBe("searchable-select-control");
    expect(document.activeElement).toBe(control);
    cleanup();
  });

  it("focuses the control on an Enter pick and on Escape", () => {
    const { container } = render(<Single />);
    const control = container.querySelector<HTMLButtonElement>(".searchable-select-control")!;
    fireEvent.click(control);
    const search = container.querySelector<HTMLInputElement>(".searchable-select-search")!;
    fireEvent.change(search, { target: { value: "east" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(document.activeElement).toBe(control);
    expect(control.textContent).toBe("DatacenterEast");

    fireEvent.click(control);
    fireEvent.keyDown(container.querySelector(".searchable-select-search")!, { key: "Escape" });
    expect(document.activeElement).toBe(control);
    cleanup();
  });
});
