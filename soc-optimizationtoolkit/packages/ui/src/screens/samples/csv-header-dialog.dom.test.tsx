// @vitest-environment happy-dom
/**
 * DOM pins for the LIVE PREVIEW in the headerless-CSV dialog (vendor
 * field-definition plan, step 2).
 *
 * The state module covers what the preview DECIDES. These cover what it SHOWS,
 * which for this surface is the entire point: the defect class it exists to
 * catch - a positional definition that is off by one, or that quietly covers a
 * third of the columns - is invisible in a list of names and only becomes
 * obvious when names are rendered beside real values and the remainder is
 * counted on screen. A preview computed perfectly and rendered for only the
 * supplied names would pass every state test and still ship the bug.
 *
 * These deliberately do NOT click a "parse" button before asserting: that the
 * preview follows the TEXT, keystroke by keystroke, is one of the things under
 * test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CsvHeaderDialog } from "./csv-header-dialog";
import type { CsvResolutionItem } from "./csv-resolution-state";

afterEach(cleanup);

function makeItem(over: Partial<CsvResolutionItem> = {}): CsvResolutionItem {
  return {
    logType: "Traffic",
    sourceName: "feed.csv",
    csvContent: "",
    columnCount: 6,
    firstRows: ["t,1.1.1.1,443,allow,web,200"],
    ...over,
  };
}

function renderDialog(item: CsvResolutionItem) {
  const props = {
    item,
    position: { current: 1, total: 1 },
    onApply: vi.fn(),
    onSkip: vi.fn(),
  };
  return { ...render(<CsvHeaderDialog {...props} />), props };
}

/** The rendered [name, value] pairs, in position order. */
function pairs(c: HTMLElement): Array<[string, string]> {
  return Array.from(c.querySelectorAll(".csv-preview-row")).map((row) => [
    row.querySelector(".csv-preview-header")?.textContent ?? "",
    row.querySelector(".csv-preview-value")?.textContent ?? "",
  ]);
}

const coverage = (c: HTMLElement) =>
  c.querySelector(".csv-preview-coverage")?.textContent ?? "";

const activeTextarea = (c: HTMLElement) =>
  c.querySelector("textarea.sample-paste") as HTMLTextAreaElement;

const tabNamed = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('[role="tab"]')).find(
    (b) => b.textContent === label,
  ) as HTMLElement;

// A synthetic 38-column row, the width of a real PAN-OS TRAFFIC log.
const WIDE_ROW = Array.from({ length: 38 }, (_v, i) => `v${i}`).join(",");

describe("CsvHeaderDialog - the preview is LIVE", () => {
  it("re-renders name -> value on every keystroke, with no button to press", () => {
    const { container } = renderDialog(makeItem());

    // Before any input, every position is shown unmapped with its real value -
    // the operator can already see what is in the data.
    expect(pairs(container)[1]).toEqual(["_1 (unmapped)", "1.1.1.1"]);

    fireEvent.change(activeTextarea(container), {
      target: { value: "time,src" },
    });
    // No "Use header row" click happened. The preview already moved.
    expect(pairs(container).slice(0, 2)).toEqual([
      ["time", "t"],
      ["src", "1.1.1.1"],
    ]);

    // Keep typing: the preview follows rather than latching the earlier parse.
    fireEvent.change(activeTextarea(container), {
      target: { value: "time,src,dport" },
    });
    expect(pairs(container)[2]).toEqual(["dport", "443"]);
  });

  it("has no latched-parse buttons left to disagree with the textarea", () => {
    const { container } = renderDialog(makeItem());
    const labels = Array.from(container.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain("Use header row");
    expect(labels).not.toContain("Parse config");
    // Skip and Apply survive - those still need a decision.
    expect(labels).toContain("Skip");
    expect(labels).toContain("Apply headers");
  });

  it("renders the same preview from the feed-config tab", () => {
    const { container } = renderDialog(
      makeItem({ columnCount: 5, firstRows: ["t,cloud,h,1,http://x"] }),
    );
    fireEvent.click(tabNamed(container, "Paste feed config"));
    fireEvent.change(activeTextarea(container), {
      target: { value: "%s{datetime},%s{cloudname},%s{host},%d{action},%s{url}" },
    });

    expect(pairs(container)).toEqual([
      ["datetime", "t"],
      ["cloudname", "cloud"],
      ["host", "h"],
      ["action", "1"],
      ["url", "http://x"],
    ]);
    expect(coverage(container)).toBe("Names all 5 columns.");
  });
});

describe("CsvHeaderDialog - the unmapped remainder is on screen", () => {
  it("shows 12 of 38 as 12 of 38, not as a finished definition", () => {
    const { container } = renderDialog(
      makeItem({ columnCount: 38, firstRows: [WIDE_ROW] }),
    );
    fireEvent.change(activeTextarea(container), {
      target: {
        value: Array.from({ length: 12 }, (_v, i) => `c${i}`).join(","),
      },
    });

    expect(coverage(container)).toBe(
      "Names 12 of 38 columns - 26 still unmapped (_12 and so on).",
    );
    // The rendered rows past the definition carry their positional names AND
    // their real values, so the remainder is nameable rather than merely known.
    expect(pairs(container)[12]).toEqual(["_12 (unmapped)", "v12"]);
    // The cap hides rows; it says so, and it never touches the count above.
    expect(container.querySelectorAll(".csv-preview-row")).toHaveLength(15);
    expect(container.querySelector(".csv-preview-more")?.textContent).toContain(
      "23 more positions",
    );
  });

  it("marks unmapped rows so the remainder can be scanned, not counted by eye", () => {
    const { container } = renderDialog(makeItem());
    fireEvent.change(activeTextarea(container), {
      target: { value: "time,src" },
    });
    expect(container.querySelectorAll(".csv-preview-row-unmapped")).toHaveLength(
      4,
    );
  });

  it("NEVER invents a name for an unmapped position", () => {
    // Column 1 is unmistakably an IP and column 2 unmistakably a port. Both
    // stay positional: a confident wrong name survives into the destination
    // schema, while "_1" is visibly unfinished.
    const { container } = renderDialog(makeItem());
    expect(pairs(container).map(([name]) => name)).toEqual([
      "_0 (unmapped)",
      "_1 (unmapped)",
      "_2 (unmapped)",
      "_3 (unmapped)",
      "_4 (unmapped)",
      "_5 (unmapped)",
    ]);
    expect(coverage(container)).toBe(
      "Names 0 of 6 columns - 6 still unmapped (_0 and so on).",
    );
  });
});

describe("CsvHeaderDialog - the mismatch warning survives alongside coverage", () => {
  it("shows both, because they say different things", () => {
    const { container } = renderDialog(makeItem());
    // 8 names for 6 columns.
    fireEvent.change(activeTextarea(container), {
      target: { value: "a,b,c,d,e,f,g,h" },
    });

    const warning = container.querySelector(".csv-dialog-mismatch")?.textContent;
    expect(warning).toContain("Header count 8 differs from CSV columns 6");
    // Coverage reports the DATA's columns; the two surplus names map nothing
    // and are not allowed to inflate it.
    expect(coverage(container)).toBe("Names all 6 columns.");
    expect(pairs(container)).toHaveLength(8);
    expect(pairs(container)[7]).toEqual(["h", "(no value)"]);
  });
});

describe("CsvHeaderDialog - an off-by-one is visibly wrong", () => {
  // The PAN-OS CONFIG line from the plan: an EMPTY serial at position 2.
  const panos = makeItem({
    columnCount: 6,
    firstRows: ["1,2021/10/25 20:25:39,,CONFIG,0,2021/10/25 20:25:44"],
  });

  it("pairs the CORRECT definition with values that make sense", () => {
    const { container } = renderDialog(panos);
    fireEvent.change(activeTextarea(container), {
      target: {
        value:
          "future_use,receive_time,serial,type,subtype,generated_time",
      },
    });
    expect(pairs(container)).toEqual([
      ["future_use (skipped)", "1"],
      ["receive_time", "2021/10/25 20:25:39"],
      // The empty serial renders as an empty value, NOT as "(no value)": the
      // column is present on this row, it simply carries nothing.
      ["serial", ""],
      ["type", "CONFIG"],
      ["subtype", "0"],
      ["generated_time", "2021/10/25 20:25:44"],
    ]);
  });

  it("exposes the shift when the definition omits the empty column", () => {
    const { container } = renderDialog(panos);
    fireEvent.change(activeTextarea(container), {
      target: {
        value:
          "future_use,receive_time,type,subtype,config_version,generated_time",
      },
    });

    // Every count agrees this definition is finished: 6 names, 6 columns.
    expect(coverage(container)).toBe("Names all 6 columns.");
    expect(container.querySelector(".csv-dialog-mismatch")).toBeNull();

    // The VALUES are what give it away - the log type "CONFIG" is sitting under
    // `subtype`, and `type` is empty.
    expect(pairs(container)).toEqual([
      ["future_use (skipped)", "1"],
      ["receive_time", "2021/10/25 20:25:39"],
      ["type", ""],
      ["subtype", "CONFIG"],
      ["config_version", "0"],
      ["generated_time", "2021/10/25 20:25:44"],
    ]);
  });
});

describe("CsvHeaderDialog - what Apply sends is what the preview showed", () => {
  it("applies the names currently on screen, not an earlier parse", () => {
    const { container, props } = renderDialog(makeItem());
    fireEvent.change(activeTextarea(container), {
      target: { value: "time,src,dport" },
    });
    // Edit again; the first value must not survive anywhere.
    fireEvent.change(activeTextarea(container), {
      target: { value: "when,client,port" },
    });
    fireEvent.click(
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Apply headers",
      ) as HTMLElement,
    );
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onApply).toHaveBeenCalledWith(["when", "client", "port"]);
  });
});
