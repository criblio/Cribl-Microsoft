// @vitest-environment happy-dom
/**
 * DOM pins for the capture panel (plan Phase 4, ADR 0003).
 *
 * capture-panel-state.test.ts already covers what the panel DECIDES - which log
 * types to pre-tick, what a filter composes to, what a commit would overwrite.
 * These cover what it SHOWS and what it SENDS, which is where the panel's own
 * invariant lives: NOTHING ENTERS THE SAMPLE STORE WITHOUT A DELIBERATE CLICK.
 * That sentence is about a rendered button and a handler, so no pure test can
 * defend it - deriveCaptureView would go on returning a perfect "ready" view for
 * a panel that had started auto-committing, or had stopped rendering the
 * checkboxes at all. The table picker is the cautionary tale: fourteen
 * thoroughly-tested pure decisions behind a panel that had quietly lost its job.
 *
 * Three things here exist ONLY in the component and are pinned nowhere else:
 *   - the filterEdited latch, which stops a checkbox silently discarding the
 *     operator's hand-edited filter;
 *   - the promise the run button awaits, and the controls it locks meanwhile;
 *   - the source-change reset, which is the difference between a stale result
 *     and one the operator believes came from the source now on screen.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_DURATION_SECONDS, DEFAULT_MAX_EVENTS } from "@soc/core";
import type {
  CaptureSamplesResult,
  SampleSourceRef,
  SplitSample,
  TaggedSample,
} from "@soc/core";
import { CapturePanel } from "./capture-panel";
import type { CapturePanelProps } from "./capture-panel";
import type { RecommendedLogType } from "./sample-coverage-state";

afterEach(cleanup);

const SOURCE: SampleSourceRef = {
  kind: "cribl-source",
  id: "in_syslog",
  label: "in_syslog",
  groupId: "default",
};

const OTHER_SOURCE: SampleSourceRef = {
  kind: "cribl-source",
  id: "in_http",
  label: "in_http",
  groupId: "default",
};

/**
 * One of each tier the checkboxes have to tell apart: two the content needs,
 * one the operator already provided, one the vendor merely documents.
 */
const RECOMMENDED: readonly RecommendedLogType[] = [
  { value: "TRAFFIC", evidence: "detection", provided: false },
  { value: "CONFIG", evidence: "workbook", provided: false },
  { value: "THREAT", evidence: "detection", provided: true },
  { value: "HIPMATCH", evidence: "vendor", provided: false },
];

const result = (over: Partial<CaptureSamplesResult> = {}): CaptureSamplesResult => ({
  splits: [],
  rawEvents: [],
  format: "ndjson",
  noDiscriminator: false,
  notes: [],
  ok: true,
  ...over,
});

const split = (logType: string, rawEvents: string[]): SplitSample => ({
  logType,
  rawEvents,
  format: "ndjson",
  eventCount: rawEvents.length,
});

/** NDJSON so the commit's re-tag parses to real records rather than a husk. */
const TWO_TYPES = result({
  rawEvents: [
    '{"type":"TRAFFIC","src":"10.0.0.1"}',
    '{"type":"TRAFFIC","src":"10.0.0.2"}',
    '{"type":"THREAT","src":"10.0.0.3"}',
  ],
  splits: [
    split("TRAFFIC", [
      '{"type":"TRAFFIC","src":"10.0.0.1"}',
      '{"type":"TRAFFIC","src":"10.0.0.2"}',
    ]),
    split("THREAT", ['{"type":"THREAT","src":"10.0.0.3"}']),
  ],
});

/**
 * Props plus the two spies, handed back separately so the mock types survive -
 * folding them into CapturePanelProps would widen them to plain functions.
 */
function makeProps(over: Partial<CapturePanelProps> = {}) {
  const onCapture = vi.fn(
    async (_filter: string, _maxEvents: number, _duration: number) => TWO_TYPES,
  );
  const onCommit = vi.fn(async (_samples: TaggedSample[]) => {});
  const props: CapturePanelProps = {
    source: SOURCE,
    recommended: RECOMMENDED,
    existingLogTypes: [],
    onCapture,
    onCommit,
    ...over,
  };
  return { props, onCapture, onCommit };
}

function renderPanel(over: Partial<CapturePanelProps> = {}) {
  const { props, onCapture, onCommit } = makeProps(over);
  return { ...render(<CapturePanel {...props} />), onCapture, onCommit };
}

const boxes = (c: HTMLElement) =>
  c.querySelectorAll<HTMLInputElement>(".capture-log-types input[type=checkbox]");
const filterBox = (c: HTMLElement) =>
  c.querySelector<HTMLTextAreaElement>(".capture-filter") as HTMLTextAreaElement;
const bounds = (c: HTMLElement) =>
  c.querySelectorAll<HTMLInputElement>(".capture-bound input");
/** Run capture is first in document order; Discard shares its class. */
const runButton = (c: HTMLElement) =>
  c.querySelectorAll<HTMLButtonElement>(".run-button")[0];
const commitButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".next-action-button");
const resultRows = (c: HTMLElement) => c.querySelectorAll(".capture-results li");
const status = (c: HTMLElement) =>
  c.querySelector(".capture-panel")?.getAttribute("data-status");

const ticked = (c: HTMLElement) => [...boxes(c)].filter((b) => b.checked).length;

/** A capture the test controls the timing of, for the in-flight pins. */
function deferredCapture() {
  let resolveWith: (value: CaptureSamplesResult) => void = () => {};
  const onCapture = vi.fn(
    (_filter: string, _maxEvents: number, _duration: number) =>
      new Promise<CaptureSamplesResult>((resolve) => {
        resolveWith = resolve;
      }),
  );
  return {
    onCapture,
    finish: (value: CaptureSamplesResult) => act(async () => resolveWith(value)),
  };
}

describe("CapturePanel - what it offers before a run", () => {
  it("pre-ticks only what the solution's CONTENT still needs", () => {
    // Counts, not existence: every suggestion stays visible, and exactly the two
    // content-derived, not-yet-provided ones start ticked. A regression that
    // ticked everything would capture data the operator never asked for and
    // overwrite the THREAT sample they already curated.
    const { container } = renderPanel();

    expect(container.querySelectorAll(".capture-log-types li")).toHaveLength(4);
    expect(boxes(container)).toHaveLength(4);
    expect(ticked(container)).toBe(2);
    expect([...boxes(container)].map((b) => b.checked)).toEqual([
      true,
      true,
      false,
      false,
    ]);

    const rows = container.querySelectorAll(".capture-log-types li");
    expect(rows[2].textContent).toContain("capturing again replaces that sample");
    expect(rows[3].textContent).toContain("documented by the vendor");
    expect(status(container)).toBe("idle");
  });

  it("SHOWS the filter it would send, and captures nothing on its own", () => {
    // The plan's whole position on the filter is that it is visible and the
    // operator's. A panel that composed a correct filter and never rendered it
    // would pass every state test in the suite.
    const { container, onCapture } = renderPanel();

    const shown = filterBox(container).value;
    expect(shown).toContain('__inputId === "in_syslog"');
    expect(shown).toContain("TRAFFIC");
    expect(shown).toContain("CONFIG");
    // Unticked types must not be in the filter, or the checkboxes mean nothing.
    expect(shown).not.toContain("HIPMATCH");
    expect(shown).not.toContain("THREAT");

    // Rendering and editing are not running: only the button runs a capture.
    fireEvent.change(filterBox(container), { target: { value: "anything" } });
    expect(onCapture).toHaveBeenCalledTimes(0);
  });
});

describe("CapturePanel - the filter belongs to the operator", () => {
  it("rewrites the filter from the checkboxes UNTIL the operator edits it", () => {
    // The other half of the latch below. Without this pin, a latch stuck closed
    // from the first render would look identical to a working one.
    const { container } = renderPanel();

    fireEvent.click(boxes(container)[3]); // HIPMATCH
    expect(ticked(container)).toBe(3);
    expect(filterBox(container).value).toContain("HIPMATCH");
  });

  it("KEEPS a hand-edited filter when a checkbox is toggled afterwards", () => {
    // Silently discarding someone's edit is worse than letting the two
    // disagree, and this latch lives only in the component - the pure module
    // cannot see that an edit happened at all.
    const { container } = renderPanel();
    const edited = '__inputId === "in_syslog" && sourcetype == "pan:traffic"';

    fireEvent.change(filterBox(container), { target: { value: edited } });
    fireEvent.click(boxes(container)[3]); // HIPMATCH

    // The box still moved - it is the FILTER that stops being rewritten.
    expect(ticked(container)).toBe(3);
    expect(filterBox(container).value).toBe(edited);
  });

  it("warns when an edit drops the __inputId clause, and names the fix", () => {
    // The one edit that fails silently: the capture succeeds and returns a
    // mixture from every source in the group, which reads like an answer.
    const { container } = renderPanel();
    expect(container.querySelectorAll(".capture-filter-warning")).toHaveLength(0);

    fireEvent.change(filterBox(container), {
      target: { value: "/TRAFFIC/i.test(_raw)" },
    });
    const warnings = container.querySelectorAll(".capture-filter-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].textContent).toContain("EVERY source");
    expect(warnings[0].textContent).toContain('__inputId === "in_syslog"');

    fireEvent.change(filterBox(container), { target: { value: "" } });
    expect(
      container.querySelector(".capture-filter-warning")?.textContent,
    ).toContain("An empty filter captures every event");
  });
});

describe("CapturePanel - running a capture", () => {
  it("sends EXACTLY the filter and bounds on screen, once", async () => {
    // What is shown is what is sent. A panel that recomposed the filter at
    // submit time would send something the operator never saw - and the pure
    // composer would still be correct.
    const { container, onCapture } = renderPanel();
    const edited = '__inputId === "in_syslog" && level == "warn"';

    fireEvent.change(filterBox(container), { target: { value: edited } });
    fireEvent.change(bounds(container)[0], { target: { value: "25" } });

    await act(async () => {
      fireEvent.click(runButton(container));
    });

    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith(edited, 25, DEFAULT_DURATION_SECONDS);
  });

  it("starts from the documented bounds, not from zero", () => {
    const { container } = renderPanel();
    expect(bounds(container)[0].value).toBe(String(DEFAULT_MAX_EVENTS));
    expect(bounds(container)[1].value).toBe(String(DEFAULT_DURATION_SECONDS));
  });

  it("reads CLEARED bounds as the defaults, not as one event for one second", async () => {
    // Number("") is 0, and both bounds clamp up to a floor of 1. So clearing
    // these to retype captured ONE event, over ONE SECOND - and a one-second
    // capture of a quiet source returns nothing, which the panel then reports
    // as an idle source. The operator is told a fact about their data that we
    // invented out of an empty text box.
    const { container, onCapture } = renderPanel();

    fireEvent.change(bounds(container)[0], { target: { value: "" } });
    fireEvent.change(bounds(container)[1], { target: { value: "" } });
    // Both stay empty while being typed into, rather than snapping back to the
    // default and landing the next keystroke on the end of it.
    expect(bounds(container)[0].value).toBe("");
    expect(bounds(container)[1].value).toBe("");

    await act(async () => {
      fireEvent.click(runButton(container));
    });

    expect(onCapture).toHaveBeenCalledWith(
      expect.anything(),
      DEFAULT_MAX_EVENTS,
      DEFAULT_DURATION_SECONDS,
    );
  });

  it("locks every control while the capture is in flight, and offers NO commit", async () => {
    // A second click would run a second capture against a panel already
    // waiting, and an edit mid-flight would describe a request already sent.
    const { onCapture, finish } = deferredCapture();
    const { container } = renderPanel({ onCapture });

    fireEvent.click(runButton(container));

    expect(status(container)).toBe("running");
    expect(runButton(container).textContent).toBe("Capturing...");
    expect(runButton(container).disabled).toBe(true);
    expect(filterBox(container).disabled).toBe(true);
    expect([...boxes(container)].filter((b) => b.disabled)).toHaveLength(4);
    expect([...bounds(container)].filter((b) => b.disabled)).toHaveLength(2);
    // Nothing to commit yet, so there is no button to click by mistake.
    expect(commitButton(container)).toBeNull();
    expect(onCapture).toHaveBeenCalledTimes(1);

    await finish(TWO_TYPES);

    expect(status(container)).toBe("ready");
    expect(runButton(container).disabled).toBe(false);
    expect([...boxes(container)].filter((b) => b.disabled)).toHaveLength(0);
  });
});

describe("CapturePanel - nothing enters the store without a click", () => {
  it("previews the capture and commits NOTHING until the button is pressed", async () => {
    const { container, onCommit } = renderPanel();

    await act(async () => {
      fireEvent.click(runButton(container));
    });

    expect(resultRows(container)).toHaveLength(2);
    expect(container.querySelector(".panel-desc")?.textContent).toBe(
      "Captured 3 events in 2 log types (ndjson).",
    );
    expect(resultRows(container)[0].textContent).toContain("2 events");
    // Singular for one - the count is the operator's only sanity check here.
    expect(resultRows(container)[1].textContent).toContain("1 event");
    expect(resultRows(container)[1].textContent).not.toContain("1 events");
    // The whole invariant: a finished capture on screen, still uncommitted.
    expect(onCommit).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.click(commitButton(container) as HTMLButtonElement);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0][0];
    expect(committed.map((s) => s.logType)).toEqual(["TRAFFIC", "THREAT"]);
    expect(committed[0].parsed.records).toHaveLength(2);
    // And the preview clears, so a second click cannot commit the same capture.
    expect(resultRows(container)).toHaveLength(0);
    expect(status(container)).toBe("idle");
  });

  it("discards a capture without committing it", async () => {
    const { container, onCommit } = renderPanel();

    await act(async () => {
      fireEvent.click(runButton(container));
    });
    expect(resultRows(container)).toHaveLength(2);

    fireEvent.click(screen.getByText("Discard"));

    expect(onCommit).toHaveBeenCalledTimes(0);
    expect(resultRows(container)).toHaveLength(0);
    expect(status(container)).toBe("idle");
  });

  it("offers no commit at all for a capture that FAILED", async () => {
    // A failed capture has nothing to add, and an enabled button over an empty
    // preview is how an operator ends up committing a husk.
    const onCapture = vi.fn(
      async (_filter: string, _maxEvents: number, _duration: number) =>
        result({ ok: false, notes: ["The capture returned HTTP 403."] }),
    );
    const { container } = renderPanel({ onCapture });

    await act(async () => {
      fireEvent.click(runButton(container));
    });

    expect(status(container)).toBe("failed");
    expect(container.querySelector(".panel-desc")?.textContent).toBe(
      "The capture did not run.",
    );
    expect(container.textContent).toContain("The capture returned HTTP 403.");
    expect(resultRows(container)).toHaveLength(0);
    expect(commitButton(container)).toBeNull();
  });

  it("names what a commit would REPLACE, on the row and beside the button", async () => {
    // The store is replace-by-logType, so this loss is otherwise invisible -
    // and it is the operator's own curated sample being overwritten.
    const { container } = renderPanel({ existingLogTypes: ["traffic"] });

    await act(async () => {
      fireEvent.click(runButton(container));
    });

    // Exactly two: the TRAFFIC row's badge and the pre-commit warning. THREAT
    // collides with nothing and must carry no badge.
    const replaces = container.querySelectorAll(".capture-replaces");
    expect(replaces).toHaveLength(2);
    expect(resultRows(container)[0].textContent).toContain(
      "replaces your existing sample",
    );
    expect(resultRows(container)[1].textContent).not.toContain("replaces");
    expect(replaces[1].textContent).toBe(
      "Adding these replaces your existing TRAFFIC sample.",
    );
  });
});

describe("CapturePanel - changing source", () => {
  it("drops the previous source's result, filter edit and toggles", async () => {
    // A result left on screen after the source changed is the worst kind of
    // stale: it looks like it came from the source now named above it, and the
    // hand-edited filter would still address the OLD input id.
    const { props } = makeProps();
    const { container, rerender } = render(<CapturePanel {...props} />);

    fireEvent.change(filterBox(container), {
      target: { value: '__inputId === "in_syslog" && hand_edited' },
    });
    fireEvent.click(boxes(container)[3]);
    await act(async () => {
      fireEvent.click(runButton(container));
    });
    expect(resultRows(container)).toHaveLength(2);

    rerender(<CapturePanel {...props} source={OTHER_SOURCE} />);

    expect(resultRows(container)).toHaveLength(0);
    expect(status(container)).toBe("idle");
    expect(filterBox(container).value).toContain('__inputId === "in_http"');
    expect(filterBox(container).value).not.toContain("in_syslog");
    expect(filterBox(container).value).not.toContain("hand_edited");
    expect(ticked(container)).toBe(2);
    expect(screen.getByText("Capture from in_http")).toBeTruthy();
  });
});
