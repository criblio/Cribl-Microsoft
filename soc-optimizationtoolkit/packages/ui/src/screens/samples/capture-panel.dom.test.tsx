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
 * Four things here exist ONLY in the component and are pinned nowhere else:
 *   - the filterEdited latch, which stops a checkbox silently discarding the
 *     operator's hand-edited filter;
 *   - the promise the run button awaits, and the controls it locks meanwhile;
 *   - the promise the COMMIT awaits, which locks the same controls for a
 *     different reason: the preview on screen is already on its way to the store;
 *   - the source-change reset, which is the difference between a stale result
 *     and one the operator believes came from the source now on screen.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_MAX_EVENTS,
  MAX_DURATION_SECONDS,
  MAX_EVENTS_LIMIT,
} from "@soc/core";
import type {
  CaptureSamplesResult,
  SampleSourceRef,
  SplitSample,
  TaggedSample,
} from "@soc/core";
import { CapturePanel } from "./capture-panel";
import type { CapturePanelProps } from "./capture-panel";
import { composeFilter } from "./capture-panel-state";
import type { RecommendedLogType } from "./sample-coverage-state";

afterEach(cleanup);

/**
 * Evaluate a rendered filter the way Cribl does - as JavaScript, against one
 * event. `__inputId` is the type-qualified form the platform really sends.
 *
 * WHY EVALUATED RATHER THAN STRING-MATCHED, the same reason capture-panel-
 * state.test.ts gives: how core addresses `__inputId` is core's decision and it
 * has already changed once. The clause now carries an equality arm kept only in
 * case a deployment hands back a bare id, so it is the arm most likely to be
 * dropped - and a literal copy of it here would break a pin about this PANEL for
 * a change that costs the product nothing. What the panel owes the operator is
 * that the box on screen selects the source they picked and no other.
 *
 * Kept local rather than shared with the sibling suite: `new Function` must not
 * appear in shipped UI source, which is where a shared helper would have to live.
 */
function select(filter: string, inputId: string, raw: string): boolean {
  // eslint-disable-next-line no-new-func
  return new Function("__inputId", "_raw", `return ${filter};`)(
    inputId,
    raw,
  ) as boolean;
}

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
/** Discard, which only exists once there is a preview to throw away. */
const discardButton = (c: HTMLElement) =>
  c.querySelectorAll<HTMLButtonElement>(".run-button")[1];
const commitButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".next-action-button");
const resultRows = (c: HTMLElement) => c.querySelectorAll(".capture-results li");
const status = (c: HTMLElement) =>
  c.querySelector(".capture-panel")?.getAttribute("data-status");
/** What the last commit established, which outlives the preview it came from. */
const outcomes = (c: HTMLElement) => c.querySelectorAll(".capture-outcome");
const outcomeStatus = (c: HTMLElement) =>
  c.querySelector(".capture-outcome")?.getAttribute("data-status");
const outcomeHeadline = (c: HTMLElement) =>
  c.querySelector(".capture-outcome .panel-desc")?.textContent;
/** The query headline. The outcome renders a .panel-desc of its own. */
const headline = (c: HTMLElement) =>
  c.querySelector(".capture-panel > .panel-desc")?.textContent;

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

/** A commit the test controls the timing of, to catch the panel mid-write. */
function deferredCommit() {
  let resolveWith: () => void = () => {};
  const onCommit = vi.fn(
    (_samples: TaggedSample[]) =>
      new Promise<void>((resolve) => {
        resolveWith = () => resolve();
      }),
  );
  return { onCommit, finish: () => act(async () => resolveWith()) };
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
    // The SOURCE clause is evaluated rather than matched: what the operator is
    // owed is a box that selects the source they picked, whatever shape core
    // gives that clause.
    expect(select(shown, "syslog:in_syslog", "1,x,TRAFFIC,y")).toBe(true);
    expect(select(shown, "syslog:in_other", "1,x,TRAFFIC,y")).toBe(false);
    expect(shown).toContain("TRAFFIC");
    expect(shown).toContain("CONFIG");
    // Unticked types must not be in the filter, or the checkboxes mean nothing -
    // and an event of one must not survive it.
    expect(shown).not.toContain("HIPMATCH");
    expect(shown).not.toContain("THREAT");
    expect(select(shown, "syslog:in_syslog", "1,x,HIPMATCH,y")).toBe(false);

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
    // The clause it offers is the one this panel would have composed for this
    // source, taken from the composer rather than restated here - so an arm
    // added to or dropped from core's predicate cannot break a pin about the
    // WARNING. What matters is that the fix names the selected source, and that
    // pasting it back gets the operator what the panel promised.
    const sourceClause = composeFilter("in_syslog", []);
    expect(warnings[0].textContent).toContain(sourceClause);
    expect(select(sourceClause, "syslog:in_syslog", "anything")).toBe(true);
    expect(select(sourceClause, "syslog:in_other", "anything")).toBe(false);

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

  it("advertises CORE's ceilings, not numbers of its own", () => {
    // Compared against the constants rather than against 10000 and 12 on
    // purpose: the defect being pinned is DRIFT. The panel carried a literal
    // max={10000} until 2026-08-20, so the day the capture API's ceiling moves,
    // the box would go on offering the old one - and the seconds box, which had
    // no max at all, would go on inviting a 30s capture that the platform
    // bridge kills at 15s after the operator has waited for it.
    const { container } = renderPanel();
    expect(bounds(container)[0].getAttribute("max")).toBe(String(MAX_EVENTS_LIMIT));
    expect(bounds(container)[1].getAttribute("max")).toBe(
      String(MAX_DURATION_SECONDS),
    );
    // Floors stay where they were; this pin is about the upper end only.
    expect(bounds(container)[0].getAttribute("min")).toBe("1");
    expect(bounds(container)[1].getAttribute("min")).toBe("1");
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

  it("locks the panel while the COMMIT is in flight, and clears only after it lands", async () => {
    // The commit is awaited, and until it resolves this preview describes
    // samples already on their way into the store. Every control here was
    // enabled throughout that window - the `busy` prop that was meant to close
    // it was never passed by the one caller, so it defaulted to false forever.
    // The store is replace-by-logType, so a second commit is idempotent and
    // nothing is corrupted; what this stops is the operator ACTING on a panel
    // mid-write - discarding the preview, or re-running the capture over it.
    const { onCommit, finish } = deferredCommit();
    const { container } = renderPanel({ onCommit });

    await act(async () => {
      fireEvent.click(runButton(container));
    });
    expect(resultRows(container)).toHaveLength(2);
    expect(commitButton(container)?.disabled).toBe(false);

    fireEvent.click(commitButton(container) as HTMLButtonElement);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(commitButton(container)?.disabled).toBe(true);
    expect(commitButton(container)?.textContent).toBe("Adding samples...");
    expect(discardButton(container).disabled).toBe(true);
    expect(runButton(container).disabled).toBe(true);
    expect(filterBox(container).disabled).toBe(true);
    expect([...boxes(container)].filter((b) => b.disabled)).toHaveLength(4);
    expect([...bounds(container)].filter((b) => b.disabled)).toHaveLength(2);
    // The preview stays up meanwhile: clearing it before the store answered
    // would leave a failed commit with nothing on screen to retry from.
    expect(resultRows(container)).toHaveLength(2);

    await finish();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(resultRows(container)).toHaveLength(0);
    expect(status(container)).toBe("idle");
    expect(runButton(container).disabled).toBe(false);
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

/**
 * WHAT THE COMMIT REPORTS AFTERWARDS (2026-08-26 audit).
 *
 * This panel had no outcome state at all. A commit called plannedCaptureSamples
 * - which silently drops any log type whose lines parse to no record - and then
 * cleared the result, returning the headline to its IDLE sentence: "Capture a
 * short, filtered sample from this source. Nothing is added until you confirm."
 * That is false the moment after a commit, and identical whether 3 of 3 or 1 of 3
 * log types were stored. The Lake panel's header rejects exactly this: "clearing
 * the panel on success would round a partial haul up to a clean one."
 *
 * These live only in the component: the pure view is now pinned in
 * capture-panel-state.test.ts, but WHETHER THE PANEL RENDERS IT, and whether the
 * false idle sentence is still printed over it, is a statement about this file.
 */
describe("CapturePanel - what the commit reports afterwards", () => {
  /** A capture whose middle split holds nothing storable. */
  const ONE_HUSK = result({
    rawEvents: ['{"type":"TRAFFIC"}', "   ", '{"type":"THREAT"}'],
    splits: [
      split("TRAFFIC", ['{"type":"TRAFFIC"}']),
      split("JUNK", ["   "]),
      split("THREAT", ['{"type":"THREAT"}']),
    ],
  });

  const runCapture = (c: HTMLElement) =>
    act(async () => {
      fireEvent.click(runButton(c));
    });
  const addSamples = (c: HTMLElement) =>
    act(async () => {
      fireEvent.click(commitButton(c) as HTMLButtonElement);
    });

  it("reports a FULL commit instead of reverting to the idle instruction", async () => {
    const { container } = renderPanel();
    await runCapture(container);
    await addSamples(container);

    expect(outcomes(container)).toHaveLength(1);
    expect(outcomeStatus(container)).toBe("done");
    expect(outcomeHeadline(container)).toBe("Added 2 samples from this capture.");
    // The sentence that used to occupy this screen, about a capture that had
    // just been added.
    expect(container.textContent).not.toContain(
      "Nothing is added until you confirm",
    );
  });

  it("NAMES a partial commit rather than rounding it up to a clean one", async () => {
    const onCapture = vi.fn(
      async (_filter: string, _maxEvents: number, _duration: number) => ONE_HUSK,
    );
    const { container, onCommit } = renderPanel({ onCapture });
    await runCapture(container);

    // Three log types on screen, and the store is about to get two.
    expect(resultRows(container)).toHaveLength(3);

    await addSamples(container);

    expect(onCommit.mock.calls[0][0].map((s) => s.logType)).toEqual([
      "TRAFFIC",
      "THREAT",
    ]);
    expect(outcomeStatus(container)).toBe("partial");
    expect(outcomeHeadline(container)).toBe(
      "Added 2 of the 3 log types this capture returned; the rest held nothing this app could parse into a record.",
    );
    // The whole defect: it must not read the same as a clean commit.
    expect(outcomeHeadline(container)).not.toBe(
      "Added 3 samples from this capture.",
    );
  });

  it("keeps the preview when a commit stored NOTHING, and says so", async () => {
    // Every split a husk. Clearing the screen would leave the operator with an
    // idle panel and no idea why nothing appeared - and the only way back to the
    // events is another capture.
    const onCapture = vi.fn(
      async (_filter: string, _maxEvents: number, _duration: number) =>
        result({
          rawEvents: ["   "],
          splits: [split("JUNK", ["   "])],
        }),
    );
    const { container, onCommit } = renderPanel({ onCapture });
    await runCapture(container);
    await addSamples(container);

    expect(onCommit.mock.calls[0][0]).toEqual([]);
    expect(outcomeStatus(container)).toBe("unusable");
    expect(outcomeHeadline(container)).toContain("nothing was added");
    expect(resultRows(container)).toHaveLength(1);
  });

  it("names a REJECTED store write and keeps the capture to retry from", async () => {
    // The commit was awaited with no catch, so a refused write un-disabled the
    // button and changed nothing else - indistinguishable from a slow store.
    const onCommit = vi.fn(async (_samples: TaggedSample[]) => {
      throw new Error("KV store quota exceeded");
    });
    const { container } = renderPanel({ onCommit });
    await runCapture(container);
    await addSamples(container);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(outcomeStatus(container)).toBe("store-failed");
    expect(outcomeHeadline(container)).toContain("could not be saved");
    expect(outcomeHeadline(container)).toContain("KV store quota exceeded");
    // Nothing is claimed about what landed, and the capture is still here.
    expect(outcomeHeadline(container)).not.toContain("Added");
    expect(resultRows(container)).toHaveLength(2);
    expect(commitButton(container)?.disabled).toBe(false);
    // Both halves stay readable: what was captured AND why it would not save.
    expect(headline(container)).toBe("Captured 3 events in 2 log types (ndjson).");

    await addSamples(container);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("clears the summary when a new capture starts", async () => {
    // It describes the PREVIOUS capture; left up over a running one it reads as
    // the answer to the request now in flight.
    const { container } = renderPanel();
    await runCapture(container);
    await addSamples(container);
    expect(outcomes(container)).toHaveLength(1);

    await runCapture(container);

    expect(outcomes(container)).toHaveLength(0);
    expect(headline(container)).toBe("Captured 3 events in 2 log types (ndjson).");
  });

  it("drops the summary when the SOURCE changes", async () => {
    // Left up, it reads as a report about the source now named above it.
    const { props } = makeProps();
    const { container, rerender } = render(<CapturePanel {...props} />);
    await act(async () => {
      fireEvent.click(runButton(container));
    });
    await addSamples(container);
    expect(outcomes(container)).toHaveLength(1);

    rerender(<CapturePanel {...props} source={OTHER_SOURCE} />);

    expect(outcomes(container)).toHaveLength(0);
    expect(headline(container)).toContain("Nothing is added until you confirm");
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
    // Evaluated for the same reason as above: the pin is that the recomposed
    // filter now selects the NEW source and no longer the old one, which is what
    // "the filter edit was dropped" has to mean to be worth anything.
    const recomposed = filterBox(container).value;
    expect(select(recomposed, "syslog:in_http", "1,x,TRAFFIC,y")).toBe(true);
    expect(select(recomposed, "syslog:in_syslog", "1,x,TRAFFIC,y")).toBe(false);
    expect(recomposed).not.toContain("in_syslog");
    expect(recomposed).not.toContain("hand_edited");
    expect(ticked(container)).toBe(2);
    expect(screen.getByText("Capture from in_http")).toBeTruthy();
  });
});
