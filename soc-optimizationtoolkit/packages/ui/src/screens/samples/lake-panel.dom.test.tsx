// @vitest-environment happy-dom
/**
 * DOM pins for the Lake panel (plan Phase 4, ADR 0003).
 *
 * lake-panel-state.test.ts already covers what the panel DECIDES - which rows
 * start ticked, how a failed read differs from an empty dataset, what a partial
 * haul is called. These cover what it SHOWS and what it SENDS, which is the
 * class of defect a pure test structurally cannot see: deriveLakeQueryView would
 * go on returning a perfect "ready" view for a panel that had started
 * auto-committing, had stopped rendering the checkboxes, or had rendered the
 * counts without the window that makes them mean anything. The table picker is
 * the cautionary tale: fourteen thoroughly-tested pure decisions behind a panel
 * that had quietly lost its job.
 *
 * Five things here exist ONLY in the component and are pinned nowhere else:
 *   - the two-step flow itself, and the invariant underneath it - NOTHING ENTERS
 *     THE SAMPLE STORE WITHOUT A DELIBERATE CLICK, which is a statement about a
 *     rendered button and a handler;
 *   - the field and bounds the fetch is addressed with, which must be the ones
 *     the query established and the operator can see, not recomposed at submit;
 *   - the promises the two buttons await, and the controls they lock meanwhile;
 *   - the commit summary outliving the log-type list, which is the difference
 *     between a partial haul reported as partial and one rounded up to clean;
 *   - the commit BUTTON agreeing with the commit HANDLER's own guard, so a
 *     query with no field to fetch by disables the control instead of leaving
 *     it enabled over a handler that silently returns.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_SAMPLE_LIMIT } from "@soc/core";
import type {
  FetchLakeEventsResult,
  LakeLogTypeEvents,
  QueryLakeSamplesResult,
  TaggedSample,
} from "@soc/core";
import { LakePanel } from "./lake-panel";
import type { LakePanelProps } from "./lake-panel";

afterEach(cleanup);

const WINDOW = { earliest: "-24h", latest: "now" };

const queryResult = (
  over: Partial<QueryLakeSamplesResult> = {},
): QueryLakeSamplesResult => ({
  datasetId: "cribl_logs",
  logTypes: [],
  window: WINDOW,
  noDiscriminator: false,
  truncated: false,
  notes: [],
  ok: true,
  ...over,
});

const fetchResult = (
  over: Partial<FetchLakeEventsResult> = {},
): FetchLakeEventsResult => ({
  events: [],
  notes: [],
  ok: true,
  ...over,
});

/**
 * One of each thing a row has to render: two counted volumes and one whose count
 * came back in a column this app does not recognize. All three fit inside the
 * pre-selection budget, so all three arrive ticked.
 */
const THREE_TYPES = queryResult({
  discriminatorField: "sourcetype",
  logTypes: [
    { logType: "GLOBALPROTECT", eventCount: 890114 },
    { logType: "TRAFFIC", eventCount: 412908 },
    { logType: "THREAT" },
  ],
});

/** NDJSON so the commit's re-tag parses to real records rather than a husk. */
const events = (logType: string, count: number): LakeLogTypeEvents => ({
  logType,
  rawEvents: Array.from(
    { length: count },
    (_unused, i) => `{"sourcetype":"${logType}","seq":${i}}`,
  ),
});

const FETCHED = fetchResult({
  events: [events("GLOBALPROTECT", 2), events("TRAFFIC", 1), events("THREAT", 1)],
});

interface Scenario {
  /** What "Find log types" resolves with. */
  query?: QueryLakeSamplesResult;
  /** What "Add as samples" resolves with. */
  fetched?: FetchLakeEventsResult;
  /** Prop overrides, including hand-made ports for the in-flight pins. */
  props?: Partial<LakePanelProps>;
}

/**
 * The panel plus its three spies, handed back separately so the mock types
 * survive - folding them into LakePanelProps would widen them to plain
 * functions and lose `.mock.calls`.
 */
function renderPanel(scenario: Scenario = {}) {
  const onQuery = vi.fn(async () => scenario.query ?? THREE_TYPES);
  const onFetchEvents = vi.fn(
    async (
      _field: string,
      _logTypes: readonly string[],
      _eventsPerLogType: number,
    ) => scenario.fetched ?? FETCHED,
  );
  const onCommit = vi.fn(async (_samples: TaggedSample[]) => {});
  const props: LakePanelProps = {
    datasetId: "cribl_logs",
    searchGroupId: "search-group",
    existingLogTypes: [],
    onQuery,
    onFetchEvents,
    onCommit,
    ...scenario.props,
  };
  return {
    ...render(<LakePanel {...props} />),
    props,
    onQuery,
    onFetchEvents,
    onCommit,
  };
}

const status = (c: HTMLElement) =>
  c.querySelector(".lake-panel")?.getAttribute("data-status");
/** The query headline. The commit summary renders a .panel-desc of its own. */
const headline = (c: HTMLElement) =>
  c.querySelector(".lake-panel > .panel-desc")?.textContent;
const rows = (c: HTMLElement) => c.querySelectorAll(".lake-log-types li");
const boxes = (c: HTMLElement) =>
  c.querySelectorAll<HTMLInputElement>(".lake-log-types input[type=checkbox]");
const ticked = (c: HTMLElement) => [...boxes(c)].filter((b) => b.checked).length;
/** Find log types is first in document order; Discard shares its class. */
const findButton = (c: HTMLElement) =>
  c.querySelectorAll<HTMLButtonElement>(".run-button")[0];
const discardButton = (c: HTMLElement) =>
  c.querySelectorAll<HTMLButtonElement>(".run-button")[1];
const commitButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".next-action-button");
const perLogType = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>(".lake-bound input") as HTMLInputElement;
const outcomes = (c: HTMLElement) => c.querySelectorAll(".lake-outcome");
const outcomeStatus = (c: HTMLElement) =>
  c.querySelector(".lake-outcome")?.getAttribute("data-status");
const outcomeHeadline = (c: HTMLElement) =>
  c.querySelector(".lake-outcome .panel-desc")?.textContent;

/** Step one: count the log types. */
const runQuery = (c: HTMLElement) =>
  act(async () => {
    fireEvent.click(findButton(c));
  });

/** Step two: fetch events for the ticked rows and commit them. */
const addSamples = (c: HTMLElement) =>
  act(async () => {
    fireEvent.click(commitButton(c) as HTMLButtonElement);
  });

/** A query the test controls the timing of, for the in-flight pins. */
function deferredQuery() {
  let resolveWith: (value: QueryLakeSamplesResult) => void = () => {};
  const onQuery = vi.fn(
    () =>
      new Promise<QueryLakeSamplesResult>((resolve) => {
        resolveWith = resolve;
      }),
  );
  return {
    onQuery,
    finish: (value: QueryLakeSamplesResult) => act(async () => resolveWith(value)),
  };
}

/** The same, for the events fetch behind "Add as samples". */
function deferredFetch() {
  let resolveWith: (value: FetchLakeEventsResult) => void = () => {};
  const onFetchEvents = vi.fn(
    (_field: string, _logTypes: readonly string[], _eventsPerLogType: number) =>
      new Promise<FetchLakeEventsResult>((resolve) => {
        resolveWith = resolve;
      }),
  );
  return {
    onFetchEvents,
    finish: (value: FetchLakeEventsResult) => act(async () => resolveWith(value)),
  };
}

describe("LakePanel - before anything is counted", () => {
  it("reads nothing on its own, and offers no way to commit", () => {
    // A panel that queried on mount would spend a search on a dataset the
    // operator only glanced at, and would render counts they never asked for.
    const { container, onQuery, onFetchEvents, onCommit } = renderPanel();

    expect(status(container)).toBe("idle");
    expect(headline(container)).toContain("Nothing is added until you confirm");
    expect(rows(container)).toHaveLength(0);
    expect(commitButton(container)).toBeNull();
    expect(container.querySelectorAll(".lake-window")).toHaveLength(0);
    expect(outcomes(container)).toHaveLength(0);
    expect(findButton(container).textContent).toBe("Find log types");
    expect(findButton(container).disabled).toBe(false);
    expect(onQuery).toHaveBeenCalledTimes(0);
    expect(onFetchEvents).toHaveBeenCalledTimes(0);
    expect(onCommit).toHaveBeenCalledTimes(0);
  });

  it("disables the query WITH a reason when there is no Search group", () => {
    // Without this the button 404s at the leader, and a 404 here reads exactly
    // like an empty dataset - sending the operator to widen a window that was
    // never the problem. The escape hatch is named in the same breath.
    const { container, onQuery } = renderPanel({ props: { searchGroupId: "" } });

    const reason = container.querySelectorAll(".lake-unavailable");
    expect(reason).toHaveLength(1);
    expect(reason[0].textContent).toContain("No Cribl Search group was found");
    expect(reason[0].textContent).toContain(
      "Capturing from a live source or uploading a file still works",
    );
    expect(findButton(container).disabled).toBe(true);

    fireEvent.click(findButton(container));
    expect(onQuery).toHaveBeenCalledTimes(0);

    cleanup();
    // Whitespace is not a group id either - it is the same dead end.
    const blank = renderPanel({ props: { searchGroupId: "   " } });
    expect(blank.container.querySelectorAll(".lake-unavailable")).toHaveLength(1);
    expect(findButton(blank.container).disabled).toBe(true);

    cleanup();
    // And the warning must not be permanent scenery: with a group there is none.
    const usable = renderPanel();
    expect(usable.container.querySelectorAll(".lake-unavailable")).toHaveLength(0);
    expect(findButton(usable.container).disabled).toBe(false);
  });
});

describe("LakePanel - what the counts say", () => {
  it("renders every volume WITH the window it covers", async () => {
    // The window exists nowhere else on screen: the rows carry bare numbers, and
    // "890,114 events" over an unstated period is not a fact. The sentence is
    // the only thing that turns the counts into one.
    const { container, onQuery } = renderPanel();
    await runQuery(container);

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(status(container)).toBe("ready");
    expect(headline(container)).toBe(
      '3 log types in "cribl_logs", highest volume first.',
    );
    expect(rows(container)).toHaveLength(3);

    const window = container.querySelectorAll(".lake-window");
    expect(window).toHaveLength(1);
    expect(window[0].textContent).toBe(
      "Volumes cover -24h to now, grouped by sourcetype.",
    );

    // Formatted with the SAME call the component makes, so this pins the number
    // rendered rather than the test runner's locale.
    const volumes = container.querySelectorAll(".lake-volume");
    expect(volumes).toHaveLength(3);
    expect(volumes[0].textContent).toBe(`${(890114).toLocaleString()} events`);
    expect(volumes[1].textContent).toBe(`${(412908).toLocaleString()} events`);
    // An unreadable count is SAID to be unknown, never shown as zero - zero is a
    // claim about the data, and the row would be making it up.
    expect(volumes[2].textContent).toBe("volume unknown");
  });

  it("says when the list hit the row cap, and does not say so otherwise", async () => {
    // A truncated list reads as the whole dataset. An operator who believed it
    // would onboard the top rows and never look for the log type that mattered.
    const capped = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        truncated: true,
        logTypes: [{ logType: "TRAFFIC", eventCount: 5 }],
      }),
    });
    await runQuery(capped.container);

    const warning = capped.container.querySelectorAll(".lake-truncated");
    expect(warning).toHaveLength(1);
    expect(warning[0].textContent).toContain("hit the row cap");
    expect(warning[0].textContent).toContain("may hold more log types");
    cleanup();

    // A complete list must not carry the caveat, or it stops being read.
    const whole = renderPanel();
    await runQuery(whole.container);
    expect(whole.container.querySelectorAll(".lake-truncated")).toHaveLength(0);
  });

  it("tells a FAILED read, an EMPTY dataset and NO DISCRIMINATOR apart", async () => {
    // Three answers that send the operator to three different places -
    // credentials and search permission, a wider window or another dataset, and
    // an unsplittable feed they must name themselves. Folding any two would tell
    // them something false about their data, and each is one branch away from
    // rendering as another.
    const failed = renderPanel({
      query: queryResult({ ok: false, notes: ["The search returned HTTP 403."] }),
    });
    await runQuery(failed.container);
    expect(status(failed.container)).toBe("failed");
    expect(headline(failed.container)).toContain("could not be read");
    expect(failed.container.textContent).toContain("The search returned HTTP 403.");
    expect(rows(failed.container)).toHaveLength(0);
    expect(commitButton(failed.container)).toBeNull();
    // No window sentence either: there are no volumes for it to qualify.
    expect(failed.container.querySelectorAll(".lake-window")).toHaveLength(0);
    const failedHeadline = headline(failed.container);
    cleanup();

    const empty = renderPanel({
      query: queryResult({ notes: ["The window held no events."] }),
    });
    await runQuery(empty.container);
    expect(status(empty.container)).toBe("empty");
    expect(headline(empty.container)).toContain("answered");
    // The window is IN the sentence - "holds nothing" is only true of a period.
    expect(headline(empty.container)).toContain("-24h");
    expect(headline(empty.container)).toContain("now");
    expect(empty.container.textContent).toContain("The window held no events.");
    expect(rows(empty.container)).toHaveLength(0);
    expect(commitButton(empty.container)).toBeNull();
    const emptyHeadline = headline(empty.container);
    cleanup();

    const unsplittable = renderPanel({
      query: queryResult({
        noDiscriminator: true,
        notes: ["No field distinguishes one event from another."],
      }),
    });
    await runQuery(unsplittable.container);
    expect(status(unsplittable.container)).toBe("no-discriminator");
    expect(headline(unsplittable.container)).toContain(
      "tells one log type from another",
    );
    expect(rows(unsplittable.container)).toHaveLength(0);
    expect(commitButton(unsplittable.container)).toBeNull();
    const unsplittableHeadline = headline(unsplittable.container);

    // Three statuses, three sentences: no pair may collapse into one.
    expect(
      new Set([failedHeadline, emptyHeadline, unsplittableHeadline]).size,
    ).toBe(3);
  });
});

describe("LakePanel - nothing enters the store without a click", () => {
  it("counts the dataset and commits NOTHING until Add as samples is pressed", async () => {
    // The two-step flow's whole point: step one returns counts, which are what
    // the operator CHOOSES from and useless as a sample. A panel that fetched
    // bodies or committed on the back of the query would satisfy every pure test
    // in the suite.
    const { container, onFetchEvents, onCommit } = renderPanel();
    await runQuery(container);

    expect(rows(container)).toHaveLength(3);
    expect(ticked(container)).toBe(3);
    expect(onFetchEvents).toHaveBeenCalledTimes(0);
    expect(onCommit).toHaveBeenCalledTimes(0);

    await addSamples(container);

    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0][0];
    expect(committed.map((s) => s.logType)).toEqual([
      "GLOBALPROTECT",
      "TRAFFIC",
      "THREAT",
    ]);
    expect(committed[0].parsed.records).toHaveLength(2);
    // The counts have done their job and go, so a second press cannot commit the
    // same haul twice.
    expect(rows(container)).toHaveLength(0);
    expect(commitButton(container)).toBeNull();
    expect(outcomeStatus(container)).toBe("done");
  });

  it("fetches with the field the query established and the bound on screen", async () => {
    // What is shown is what is sent. A panel that re-derived the discriminator
    // at submit time, or ignored the bound, would address a search the operator
    // never saw - and the pure module would still be perfectly correct.
    const { container, onFetchEvents } = renderPanel();
    await runQuery(container);

    expect(perLogType(container).value).toBe(String(DEFAULT_SAMPLE_LIMIT));
    fireEvent.change(perLogType(container), { target: { value: "25" } });
    fireEvent.click(boxes(container)[1]); // untick TRAFFIC
    expect(ticked(container)).toBe(2);

    await addSamples(container);

    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    // Exactly the ticked rows: an unticked one arriving here would cost a search
    // and overwrite a sample the operator had just declined to replace.
    expect(onFetchEvents).toHaveBeenCalledWith(
      "sourcetype",
      ["GLOBALPROTECT", "THREAT"],
      25,
    );
  });

  it("reads a CLEARED bound as the default, not as one event", async () => {
    // Number("") is 0, which clampLimit floors to 1 - so clearing the box to
    // retype fetched ONE event per log type and returned a note blaming a bound
    // the operator never typed. A sample of one is not obviously wrong on
    // screen, which is what made it worth pinning.
    const { container, onFetchEvents } = renderPanel();
    await runQuery(container);

    fireEvent.change(perLogType(container), { target: { value: "" } });
    // And the box stays empty while they type, rather than snapping back to the
    // default and landing the next keystroke on the end of it.
    expect(perLogType(container).value).toBe("");

    await addSamples(container);

    expect(onFetchEvents).toHaveBeenCalledWith(
      "sourcetype",
      expect.anything(),
      DEFAULT_SAMPLE_LIMIT,
    );
  });

  it("offers no fetch at all once every row is unticked", async () => {
    // An enabled button over an empty selection fetches nothing and reports a
    // failure, which reads as a broken dataset rather than an empty choice.
    const { container, onFetchEvents } = renderPanel();
    await runQuery(container);

    for (let i = 0; i < 3; i += 1) fireEvent.click(boxes(container)[i]);
    expect(ticked(container)).toBe(0);
    expect(commitButton(container)?.disabled).toBe(true);

    fireEvent.click(commitButton(container) as HTMLButtonElement);
    expect(onFetchEvents).toHaveBeenCalledTimes(0);
  });

  it("offers NO fetch when the counts came back with no field to fetch BY", async () => {
    // The commit handler cannot address step two without the discriminator, so
    // it returns early - but the button used to stay enabled over it, and a
    // button that does nothing whatever when pressed reads as a broken app
    // rather than as a missing field. queryLakeSamples sets the field on every
    // path that returns log types, so this shape only arrives from a port that
    // is TYPED to allow it; the control and the guard now agree either way.
    const { container, onFetchEvents } = renderPanel({
      query: queryResult({ logTypes: [{ logType: "TRAFFIC", eventCount: 5 }] }),
    });
    await runQuery(container);

    // A ready list, ticked, and still nothing to address a fetch with.
    expect(status(container)).toBe("ready");
    expect(rows(container)).toHaveLength(1);
    expect(ticked(container)).toBe(1);
    expect(container.querySelector(".lake-window")?.textContent).toBe(
      "Volumes cover -24h to now.",
    );

    expect(commitButton(container)?.disabled).toBe(true);
    fireEvent.click(commitButton(container) as HTMLButtonElement);
    expect(onFetchEvents).toHaveBeenCalledTimes(0);
  });

  it("discards the counts without fetching or committing anything", async () => {
    const { container, onFetchEvents, onCommit } = renderPanel();
    await runQuery(container);
    expect(rows(container)).toHaveLength(3);

    fireEvent.click(screen.getByText("Discard"));

    expect(rows(container)).toHaveLength(0);
    expect(status(container)).toBe("idle");
    expect(onFetchEvents).toHaveBeenCalledTimes(0);
    expect(onCommit).toHaveBeenCalledTimes(0);
  });

  it("names what a commit would REPLACE, on the row and beside the button", async () => {
    // The store is replace-by-logType, so this loss is otherwise invisible - and
    // it is the operator's own curated sample being overwritten. The warning
    // beside the button follows the TICKS, so it appears only once they have
    // asked for the collision.
    const { container } = renderPanel({
      props: { existingLogTypes: ["traffic"] },
    });
    await runQuery(container);

    expect(rows(container)).toHaveLength(3);
    expect([...boxes(container)].map((b) => b.checked)).toEqual([
      true,
      false,
      true,
    ]);

    // One warning while the collision is left alone: the row's own note.
    expect(container.querySelectorAll(".lake-replaces")).toHaveLength(1);
    expect(rows(container)[1].textContent).toContain("taking it replaces yours");
    expect(rows(container)[0].textContent).not.toContain("replaces");
    expect(rows(container)[2].textContent).not.toContain("replaces");

    fireEvent.click(boxes(container)[1]);

    const replaces = container.querySelectorAll(".lake-replaces");
    expect(replaces).toHaveLength(2);
    expect(replaces[1].textContent).toBe(
      "Adding these replaces your existing TRAFFIC sample.",
    );
  });
});

describe("LakePanel - while a read is in flight", () => {
  it("locks the panel and offers no picks while the count runs", async () => {
    // A second click would run a second search against a panel already waiting,
    // and a stale list beside a live spinner reads as the answer to the query
    // now running.
    const { onQuery, finish } = deferredQuery();
    const { container } = renderPanel({ props: { onQuery } });

    fireEvent.click(findButton(container));

    expect(status(container)).toBe("querying");
    expect(findButton(container).textContent).toBe("Finding log types...");
    expect(findButton(container).disabled).toBe(true);
    expect(rows(container)).toHaveLength(0);
    expect(commitButton(container)).toBeNull();
    expect(onQuery).toHaveBeenCalledTimes(1);

    await finish(THREE_TYPES);

    expect(status(container)).toBe("ready");
    expect(findButton(container).disabled).toBe(false);
    expect(rows(container)).toHaveLength(3);
    expect(onQuery).toHaveBeenCalledTimes(1);
  });

  it("locks every control while the events are fetched, and commits nothing yet", async () => {
    // Every one of these is a request already sent: re-ticking a row mid-fetch
    // would describe a selection that is no longer the one being fetched, and a
    // second press would spend the searches twice.
    const { onFetchEvents, finish } = deferredFetch();
    const { container, onCommit } = renderPanel({ props: { onFetchEvents } });

    await runQuery(container);
    fireEvent.click(commitButton(container) as HTMLButtonElement);

    expect(outcomeStatus(container)).toBe("fetching");
    expect(outcomeHeadline(container)).toBe("Fetching events...");
    expect(commitButton(container)?.textContent).toBe("Fetching events...");
    expect(commitButton(container)?.disabled).toBe(true);
    expect(findButton(container).disabled).toBe(true);
    expect(discardButton(container).disabled).toBe(true);
    expect(perLogType(container).disabled).toBe(true);
    expect([...boxes(container)].filter((b) => b.disabled)).toHaveLength(3);
    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    // Still nothing in the store: the fetch has not even answered.
    expect(onCommit).toHaveBeenCalledTimes(0);

    await finish(FETCHED);

    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(rows(container)).toHaveLength(0);
    expect(outcomeStatus(container)).toBe("done");
  });
});

describe("LakePanel - what the commit reports afterwards", () => {
  it("keeps a PARTIAL summary in view after the counts are cleared", async () => {
    // The reason the summary outlives the list. A fetch can lose one log type
    // and keep the rest, and once the rows are gone this sentence is the only
    // place the hole is visible - "Added 2 samples" would round it up to clean.
    const { container, onCommit } = renderPanel({
      fetched: fetchResult({
        events: [
          events("GLOBALPROTECT", 2),
          events("TRAFFIC", 1),
          { logType: "THREAT", rawEvents: ["   "] },
        ],
        notes: ['"THREAT" returned nothing but blank lines.'],
      }),
    });

    await runQuery(container);
    await addSamples(container);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].map((s) => s.logType)).toEqual([
      "GLOBALPROTECT",
      "TRAFFIC",
    ]);

    expect(rows(container)).toHaveLength(0);
    expect(outcomes(container)).toHaveLength(1);
    expect(outcomeStatus(container)).toBe("done");
    expect(outcomeHeadline(container)).toBe(
      "Added 2 of the 3 log types you picked; the rest returned nothing usable.",
    );
    expect(outcomeHeadline(container)).not.toBe(
      "Added 2 samples from this dataset.",
    );
    expect(container.textContent).toContain(
      '"THREAT" returned nothing but blank lines.',
    );
  });

  it("calls a case-variant COLLAPSE a collapse, not data that never arrived", async () => {
    // The dataset holds "TRAFFIC" and "traffic", and the operator already has a
    // sample called "traffic". Both picks adopt their label, so the commit folds
    // them into ONE sample - and the summary used to report the second as
    // "returned nothing usable", which is the opposite of what happened to it:
    // it was overwritten, not empty. That sentence would send the operator off
    // to widen a window over data sitting in the sample they just added.
    const { container, onCommit } = renderPanel({
      props: { existingLogTypes: ["traffic"] },
      query: queryResult({
        discriminatorField: "sourcetype",
        logTypes: [
          { logType: "TRAFFIC", eventCount: 9 },
          { logType: "traffic", eventCount: 4 },
        ],
      }),
      fetched: fetchResult({
        events: [events("TRAFFIC", 2), events("traffic", 1)],
      }),
    });
    await runQuery(container);

    // Both collide with the operator's own sample, so both arrive unticked.
    expect(ticked(container)).toBe(0);
    fireEvent.click(boxes(container)[0]);
    fireEvent.click(boxes(container)[1]);
    expect(ticked(container)).toBe(2);

    await addSamples(container);

    // One sample, under the operator's own casing: that IS the collapse.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].map((s) => s.logType)).toEqual(["traffic"]);
    expect(outcomeStatus(container)).toBe("done");
    expect(outcomeHeadline(container)).toBe(
      "Added 1 of the 2 log types you picked; 1 shares a sample name with another and was added as part of it.",
    );
    expect(outcomeHeadline(container)).not.toContain("returned nothing usable");
  });

  it("adds nothing and KEEPS the counts when the fetch fails or parses to nothing", async () => {
    // Two different answers that must not fold together: the search failed, or
    // the search answered and the events carried no records. Neither may put a
    // husk in the store, and both must leave the rows up - re-running the count
    // to pick again would spend a search the operator already paid for.
    const failed = renderPanel({
      fetched: fetchResult({
        ok: false,
        notes: ['"TRAFFIC" could not be fetched.'],
      }),
    });
    await runQuery(failed.container);
    await addSamples(failed.container);

    expect(failed.onCommit).toHaveBeenCalledTimes(0);
    expect(outcomeStatus(failed.container)).toBe("failed");
    expect(outcomeHeadline(failed.container)).toContain("nothing was added");
    expect(failed.container.textContent).toContain(
      '"TRAFFIC" could not be fetched.',
    );
    expect(rows(failed.container)).toHaveLength(3);
    expect(commitButton(failed.container)?.disabled).toBe(false);
    const failedStatus = outcomeStatus(failed.container);
    cleanup();

    const unusable = renderPanel({
      fetched: fetchResult({
        events: [{ logType: "GLOBALPROTECT", rawEvents: ["   "] }],
      }),
    });
    await runQuery(unusable.container);
    await addSamples(unusable.container);

    expect(unusable.onCommit).toHaveBeenCalledTimes(0);
    expect(outcomeStatus(unusable.container)).toBe("unusable");
    expect(outcomeHeadline(unusable.container)).toContain("none of them parsed");
    expect(rows(unusable.container)).toHaveLength(3);
    expect(failedStatus).not.toBe(outcomeStatus(unusable.container));
  });

  it("drops the previous dataset's counts AND its summary when the dataset changes", async () => {
    // Both survive a fetch that added nothing, so both would still be on screen
    // under the new dataset's name - counts read as this dataset's, and a
    // failure attributed to a dataset that never ran.
    const { container, props, rerender } = renderPanel({
      fetched: fetchResult({ ok: false, notes: ["The search returned HTTP 400."] }),
    });
    await runQuery(container);
    await addSamples(container);
    expect(rows(container)).toHaveLength(3);
    expect(outcomes(container)).toHaveLength(1);

    rerender(<LakePanel {...props} datasetId="corelight" />);

    expect(rows(container)).toHaveLength(0);
    expect(outcomes(container)).toHaveLength(0);
    expect(status(container)).toBe("idle");
    expect(container.querySelectorAll(".field-label")[0].textContent).toBe(
      "Lake dataset: corelight",
    );
  });
});
