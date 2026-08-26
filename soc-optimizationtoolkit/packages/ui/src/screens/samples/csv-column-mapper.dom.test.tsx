// @vitest-environment happy-dom
/**
 * DOM pins for the interactive column-mapping tab (vendor field-definition plan,
 * "Gap 2").
 *
 * A state-model test cannot see the thing that makes this tab worth building.
 * The plan's claim is about the SURFACE: naming a box labelled `_7` is
 * guesswork, and naming the box that reads `192.168.0.2` is not. So the pins
 * here are about what is on screen next to each input - that the real values are
 * there, that several rows of them are there, and that no box arrives with a
 * guess already typed in it.
 *
 * They also pin the tab into the SHARED dialog: the third tab exists, and a
 * partial mapping reaches the shared live preview as coverage rather than as a
 * finished-looking definition.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ParsedSample, TaggedSample } from "@soc/core";
import { parseSampleContent } from "@soc/core";
import { buildTaggedSample } from "./sample-intake-state";
import { toResolutionItem } from "./csv-resolution-state";
import { CsvColumnMapper } from "./csv-column-mapper";
import { CsvHeaderDialog } from "./csv-header-dialog";
import { EMPTY_COLUMN_DRAFTS, setColumnDraft } from "./csv-column-mapping";
import type { ColumnDrafts } from "./csv-column-mapping";

afterEach(cleanup);

// A 6-column headerless feed whose port column repeats a value and whose flag
// column is mostly zeros - the case the design argues about, where one row's
// value is ambiguous and four rows' values are not.
const ROWS = [
  "2026-07-05,10.0.0.1,443,allow,web,0",
  "2026-07-05,10.0.0.2,80,deny,web,0",
  "2026-07-05,10.0.0.3,443,allow,web,1",
  "2026-07-05,10.0.0.4,22,allow,ssh,0",
];

function sample(rows = ROWS): TaggedSample {
  const parsed: ParsedSample = parseSampleContent(rows.join("\n"), {
    sourceName: "feed.csv",
  });
  return buildTaggedSample("Web", parsed);
}

const item = () => toResolutionItem(sample());

/** The mapper wired to real draft state, the way the dialog wires it. */
function StatefulMapper({ rows = ROWS }: { rows?: string[] }) {
  const [drafts, setDrafts] = useState<ColumnDrafts>(EMPTY_COLUMN_DRAFTS);
  const resolutionItem = toResolutionItem(sample(rows));
  return (
    <CsvColumnMapper
      item={resolutionItem}
      drafts={drafts}
      onDraftChange={(index, text) =>
        setDrafts((current) => setColumnDraft(current, index, text))
      }
      onClearAll={() => setDrafts(EMPTY_COLUMN_DRAFTS)}
    />
  );
}

/** The name box for one column position. */
function boxFor(positional: string): HTMLInputElement {
  return screen.getByLabelText(`Name for column ${positional}`) as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// The affordance: real values beside every box
// ---------------------------------------------------------------------------

describe("CsvColumnMapper - the values ARE the affordance", () => {
  it("offers a name box for EVERY position, labelled by its positional name", () => {
    render(<StatefulMapper />);
    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(6);
    for (const positional of ["_0", "_1", "_2", "_3", "_4", "_5"]) {
      expect(boxFor(positional)).toBeTruthy();
    }
  });

  it("shows SEVERAL rows' real values at each position, not one", () => {
    const { container } = render(<StatefulMapper />);
    const rows = container.querySelectorAll(".csv-map-row");
    expect(rows).toHaveLength(6);

    // Position 2 is a port column. One `443` would only hint; the four together
    // are what let an operator name it without guessing.
    const ports = within(rows[2] as HTMLElement)
      .getAllByText(/^\d+$/)
      .map((el) => el.textContent);
    expect(ports).toEqual(["443", "80", "443", "22"]);
  });

  it("KEEPS repeated values, because the repetition is the signal", () => {
    const { container } = render(<StatefulMapper />);
    const flag = container.querySelectorAll(".csv-map-row")[5] as HTMLElement;
    const values = Array.from(
      flag.querySelectorAll(".csv-map-value"),
      (el) => el.textContent,
    );
    // A flag column reads as a flag column BECAUSE it is mostly one value.
    expect(values).toEqual(["0", "0", "1", "0"]);
  });

  it("marks a blank value rather than rendering nothing at that position", () => {
    // PAN-OS CONFIG really does emit an empty serial; a silently missing value
    // is how an off-by-one hides.
    render(<StatefulMapper rows={["1,,CONFIG,a,b,c", "2,,CONFIG,d,e,f"]} />);
    expect(screen.getAllByText("(empty)").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Never invent a name
// ---------------------------------------------------------------------------

describe("CsvColumnMapper - nothing is invented", () => {
  it("arrives with EVERY box empty, however recognizable the values are", () => {
    render(<StatefulMapper />);
    // IP addresses, dates, ports, verbs - and not one pre-filled guess.
    for (const box of screen.getAllByRole("textbox")) {
      expect((box as HTMLInputElement).value).toBe("");
    }
    expect(
      screen.getByText(/No columns named yet - all 6 stay positional/),
    ).toBeTruthy();
  });

  it("says an unnamed box is unmapped instead of proposing something", () => {
    render(<StatefulMapper />);
    expect(boxFor("_1").placeholder).toBe("unmapped (_1)");
  });
});

// ---------------------------------------------------------------------------
// Partial mapping is the normal case
// ---------------------------------------------------------------------------

describe("CsvColumnMapper - partial mapping", () => {
  it("names one column and reports the rest as still positional", () => {
    render(<StatefulMapper />);
    fireEvent.change(boxFor("_1"), { target: { value: "src_ip" } });

    expect(boxFor("_1").value).toBe("src_ip");
    expect(boxFor("_3").value).toBe("");
    expect(
      screen.getByText(/1 of 6 columns named, 5 stay positional/),
    ).toBeTruthy();
  });

  it("clearing a box returns that position to unmapped", () => {
    render(<StatefulMapper />);
    fireEvent.change(boxFor("_1"), { target: { value: "src_ip" } });
    fireEvent.change(boxFor("_1"), { target: { value: "" } });
    expect(
      screen.getByText(/No columns named yet - all 6 stay positional/),
    ).toBeTruthy();
  });

  it("warns on the SPOT when two positions take the same name", () => {
    render(<StatefulMapper />);
    fireEvent.change(boxFor("_1"), { target: { value: "src" } });
    fireEvent.change(boxFor("_3"), { target: { value: "src" } });
    // Both boxes carry the note - the collapse is visible where it happens...
    expect(
      screen.getAllByText(/duplicate of another column/),
    ).toHaveLength(2);
    // ...and named in the summary, since the last one silently wins on apply.
    expect(screen.getByText(/Duplicate names?: src/)).toBeTruthy();
  });

  it("says so when a typed name is not usable, and leaves the column unmapped", () => {
    render(<StatefulMapper />);
    fireEvent.change(boxFor("_2"), { target: { value: "!!!" } });
    expect(screen.getByText(/not a usable name - stays unmapped/)).toBeTruthy();
    expect(
      screen.getByText(/No columns named yet - all 6 stay positional/),
    ).toBeTruthy();
  });

  it("clear-all is offered only once something is named", () => {
    render(<StatefulMapper />);
    const clear = screen.getByRole("button", { name: "Clear all names" });
    expect((clear as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(boxFor("_1"), { target: { value: "src_ip" } });
    expect((clear as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(clear);
    expect(boxFor("_1").value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The tab inside the shared dialog
// ---------------------------------------------------------------------------

describe("CsvHeaderDialog - the third tab", () => {
  function openMapper() {
    const onApply = vi.fn();
    const view = render(
      <CsvHeaderDialog
        item={item()}
        position={{ current: 1, total: 1 }}
        onApply={onApply}
        onSkip={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Name columns" }));
    return { ...view, onApply };
  }

  it("offers a third path for the operator who has no artifact to paste", () => {
    render(
      <CsvHeaderDialog
        item={item()}
        position={{ current: 1, total: 1 }}
        onApply={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Name columns" })).toBeTruthy();
  });

  it("renders into the SHARED preview, which counts the unmapped remainder", () => {
    const { container } = openMapper();
    fireEvent.change(boxFor("_1"), { target: { value: "src_ip" } });

    // The shared preview surface, not one of the mapper's own making.
    const preview = container.querySelector(".csv-preview") as HTMLElement;
    expect(preview).toBeTruthy();
    // The named position shows its real value beside the name...
    expect(within(preview).getByText("src_ip")).toBeTruthy();
    expect(within(preview).getByText("10.0.0.1")).toBeTruthy();
    // ...and the five nobody named are still visibly unmapped.
    expect(within(preview).getAllByText(/\(unmapped\)/)).toHaveLength(5);
  });

  it("keeps Apply shut until something is actually named", () => {
    openMapper();
    const apply = screen.getByRole("button", {
      name: "Apply headers",
    }) as HTMLButtonElement;
    // A mapping that names nothing resolves to the sample already stored, so
    // applying it would be Skip wearing a different hat.
    expect(apply.disabled).toBe(true);

    fireEvent.change(boxFor("_1"), { target: { value: "src_ip" } });
    expect(apply.disabled).toBe(false);
  });

  it("counts a 1-of-6 mapping as ONE name ready, not six", () => {
    openMapper();
    fireEvent.change(boxFor("_1"), { target: { value: "src_ip" } });
    // The array handed to Apply is full-length with positional names parked in
    // it; reporting its length would make a barely-started definition look done.
    expect(screen.getByText("1 name ready to apply")).toBeTruthy();
  });

  it("applies one name per column, positional where the operator left it alone", () => {
    const { onApply } = openMapper();
    fireEvent.change(boxFor("_1"), { target: { value: "src ip" } });
    fireEvent.change(boxFor("_3"), { target: { value: "action" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply headers" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    // Blanks would make the core parser DISCARD the unnamed columns; positional
    // names keep their values and keep them nameable later.
    expect(onApply.mock.calls[0][0]).toEqual([
      "_0",
      "src_ip",
      "_2",
      "action",
      "_4",
      "_5",
    ]);
  });

  it("keeps a half-finished mapping when the operator looks at another tab", () => {
    openMapper();
    fireEvent.change(boxFor("_1"), { target: { value: "src_ip" } });
    fireEvent.click(screen.getByRole("tab", { name: "Header row" }));
    fireEvent.click(screen.getByRole("tab", { name: "Name columns" }));
    expect(boxFor("_1").value).toBe("src_ip");
  });
});
