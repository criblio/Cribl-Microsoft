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
 * Eight things here exist ONLY in the component and are pinned nowhere else:
 *   - the three-step flow itself, and the invariant underneath it - NOTHING
 *     ENTERS THE SAMPLE STORE WITHOUT A DELIBERATE CLICK, which is a statement
 *     about a rendered button and a handler;
 *   - the PREVIEW between the fetch and the store write (user report
 *     2026-08-25), and the property that makes it worth having: the searches are
 *     spent once, by the fetch, and the commit runs none. A preview that
 *     re-fetched would double the job count on the most expensive step in the
 *     app, and nothing in the pure module could see it;
 *   - the field and bounds the fetch is addressed with, which must be the ones
 *     the query established and the operator can see, not recomposed at submit;
 *   - the promises the two buttons await, and the controls they lock meanwhile;
 *   - the commit summary outliving the log-type list, which is the difference
 *     between a partial haul reported as partial and one rounded up to clean;
 *   - the commit BUTTON agreeing with the commit HANDLER's own guard, so a
 *     query with no field to fetch by disables the control instead of leaving
 *     it enabled over a handler that silently returns;
 *   - the caveat beside a dataset offered as its own log type, which exists
 *     ONLY on screen: nothing downstream can say "that name is the dataset's,
 *     not something we found in your data", and without it the row reads as a
 *     log type this app discovered;
 *   - the same caveat beside the row for events that carry NO value in the
 *     discriminator field, which is the harder case: that row sits IN a list of
 *     names the data really did supply, so an uncaveated "(no msgid)" reads as
 *     one more of them.
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
  datasetAsLogType: false,
  truncated: false,
  notes: [],
  ok: true,
  ...over,
});

/**
 * A populated dataset that nothing splits: ONE log type under the DATASET'S own
 * name, counted at dataset scale, with no discriminator field to fetch by.
 */
const DATASET_AS_LOG_TYPE = queryResult({
  noDiscriminator: true,
  datasetAsLogType: true,
  logTypes: [{ logType: "cribl_logs", eventCount: 1216 }],
  notes: ["Rename the sample on its chip once added."],
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
      // `string | undefined`, matching the prop: a dataset offered as its own
      // log type is fetched with NO field, and a spy typed `string` would let
      // the panel default it to something the operator never saw.
      _field: string | undefined,
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
/**
 * The two primary actions, addressed by their OWN classes rather than by
 * position. One spends search jobs and the other writes to the store, and a
 * helper that picked "the first .next-action-button" would silently follow
 * whichever block moved first.
 */
const fetchButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".lake-fetch-button");
const commitButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".lake-commit-button");
const perLogType = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>(".lake-bound input") as HTMLInputElement;
const outcomes = (c: HTMLElement) => c.querySelectorAll(".lake-outcome");
const outcomeStatus = (c: HTMLElement) =>
  c.querySelector(".lake-outcome")?.getAttribute("data-status");
const outcomeHeadline = (c: HTMLElement) =>
  c.querySelector(".lake-outcome .panel-desc")?.textContent;
/** The preview between the fetch and the store write. */
const previewRows = (c: HTMLElement) => c.querySelectorAll(".lake-previews li");
const previewText = (c: HTMLElement) =>
  [...c.querySelectorAll(".lake-preview")].map((p) => p.textContent);
const previewHeadline = (c: HTMLElement) =>
  c.querySelector(".lake-fetched .panel-desc")?.textContent;

/** Step one: count the log types. */
const runQuery = (c: HTMLElement) =>
  act(async () => {
    fireEvent.click(findButton(c));
  });

/** Step two: fetch events for the ticked rows. Nothing is stored by this. */
const fetchEvents = (c: HTMLElement) =>
  act(async () => {
    fireEvent.click(fetchButton(c) as HTMLButtonElement);
  });

/** Step three: store the previewed events. No search runs here. */
const addSamples = (c: HTMLElement) =>
  act(async () => {
    fireEvent.click(commitButton(c) as HTMLButtonElement);
  });

/** The whole take, for the pins that are not about the steps themselves. */
const fetchAndAdd = async (c: HTMLElement) => {
  await fetchEvents(c);
  await addSamples(c);
};

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
    (
      _field: string | undefined,
      _logTypes: readonly string[],
      _eventsPerLogType: number,
    ) =>
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
    expect(fetchButton(container)).toBeNull();
    expect(commitButton(container)).toBeNull();
    expect(previewRows(container)).toHaveLength(0);
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
    // CHANGED 2026-08-26: the same window, no longer as the Kusto tokens the
    // query was written in. This sentence is the only thing turning the counts
    // beside it into facts, so "-24h" - which reads as a minus sign - was the
    // least legible line on the screen. The bounds are still the query's own.
    expect(window[0].textContent).toBe(
      "Volumes cover the last 24 hours, grouped by sourcetype.",
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

  it("adds the BYTE ESTIMATE to a row whose events were sampled", async () => {
    // The plan's last Phase 5 item: a count cannot be reasoned about against a
    // Sentinel bill, which is charged by volume. The figure is a sampled mean
    // times a window-wide count, so the row says "~" and "estimated".
    const { container } = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        logTypes: [
          // 1,000 x 2,048 = 2,048,000 B, which formats as "2 MB".
          { logType: "TRAFFIC", eventCount: 1000, meanEventBytes: 2048 },
          // Counted but never sampled: the count stands alone.
          { logType: "SECURITY", eventCount: 22792 },
        ],
      }),
    });
    await runQuery(container);

    const volumes = container.querySelectorAll(".lake-volume");
    expect(volumes).toHaveLength(2);
    expect(volumes[0].textContent).toBe(
      `${(1000).toLocaleString()} events, ~2 MB estimated`,
    );
    // NOT "22,792 events, ~0 B estimated". An unsampled log type gets no byte
    // figure at all rather than a defaulted zero, which would read as measured.
    expect(volumes[1].textContent).toBe(`${(22792).toLocaleString()} events`);
    expect(volumes[1].textContent).not.toContain("0 B");
  });

  it("counts ONE event in the singular, like every sibling count on screen", async () => {
    // The volume row was the only count in this area with no plural handling, so
    // a log type with one event in the window rendered "1 events" - on the row
    // the operator reads to decide whether it is worth a search.
    const { container } = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        logTypes: [
          { logType: "RARE", eventCount: 1 },
          { logType: "TWO", eventCount: 2 },
          // Singular AND an estimate, which is where a naive fix breaks.
          { logType: "ONE_SIZED", eventCount: 1, meanEventBytes: 2048 },
        ],
      }),
    });
    await runQuery(container);

    const volumes = container.querySelectorAll(".lake-volume");
    expect(volumes[0].textContent).toBe("1 event");
    expect(volumes[0].textContent).not.toBe("1 events");
    expect(volumes[1].textContent).toBe("2 events");
    expect(volumes[2].textContent).toBe("1 event, ~2 KB estimated");
  });

  it("claims a pre-selection only when it actually made one", async () => {
    // The hint said "The highest-volume ones are pre-selected" over a list where
    // nothing was ticked, which happens by design whenever every row would
    // replace a sample the operator already has. The behaviour is right; the
    // sentence sent them hunting for a tick that was never made.
    const { container } = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        logTypes: [
          { logType: "TRAFFIC", eventCount: 9 },
          { logType: "THREAT", eventCount: 4 },
        ],
      }),
      props: { existingLogTypes: ["traffic", "threat"] },
    });
    await runQuery(container);

    expect(ticked(container)).toBe(0);
    expect(container.textContent).toContain("None are pre-selected");
    expect(container.textContent).not.toContain("ones are pre-selected");
    cleanup();

    // And where there IS a pre-selection, it is still described as one.
    const some = renderPanel();
    await runQuery(some.container);
    expect(ticked(some.container)).toBe(3);
    expect(some.container.textContent).toContain(
      "The highest-volume ones you do not already have are pre-selected.",
    );
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
    // CHANGED 2026-08-26: it no longer adds "The highest-volume ones are shown",
    // which was the third telling of that on one screen - the ready headline
    // ends "highest volume first" and core's note names the cap with its number.
    expect(warning[0].textContent).not.toContain("highest-volume");
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
    //
    // A FOURTH joined them on 2026-08-25 and is pinned in its own block below:
    // a populated dataset that nothing splits, which is now OFFERED under its
    // own name instead of joining the three dead ends here.
    const failed = renderPanel({
      query: queryResult({ ok: false, notes: ["The search returned HTTP 403."] }),
    });
    await runQuery(failed.container);
    expect(status(failed.container)).toBe("failed");
    expect(headline(failed.container)).toContain("could not be read");
    expect(failed.container.textContent).toContain("The search returned HTTP 403.");
    expect(rows(failed.container)).toHaveLength(0);
    expect(fetchButton(failed.container)).toBeNull();
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
    // CHANGED 2026-08-26 from the raw "-24h"/"now" tokens; see windowLabel.
    expect(headline(empty.container)).toContain("the last 24 hours");
    expect(empty.container.textContent).toContain("The window held no events.");
    expect(rows(empty.container)).toHaveLength(0);
    expect(fetchButton(empty.container)).toBeNull();
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
    expect(fetchButton(unsplittable.container)).toBeNull();
    const unsplittableHeadline = headline(unsplittable.container);

    // Three statuses, three sentences: no pair may collapse into one.
    expect(
      new Set([failedHeadline, emptyHeadline, unsplittableHeadline]).size,
    ).toBe(3);
  });

  it("does not tell an operator a counted dataset holds nothing", async () => {
    // Core's own note under this headline said the dataset carries the field and
    // the counting returned no groups - so the two contradicted each other on
    // one screen, and the headline was the confident-wrong half. It is reachable
    // only after step one returned rows, which is why the field is present on a
    // result with no log types at all.
    const { container } = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        notes: [
          'Events in "cribl_logs" carry a "sourcetype" field, but counting it returned no groups. The window may be too narrow, or every event may leave the field empty.',
        ],
      }),
    });
    await runQuery(container);

    expect(status(container)).toBe("no-groups");
    expect(headline(container)).toBe(
      'The dataset "cribl_logs" holds events, but grouping them by sourcetype produced no log types.',
    );
    expect(headline(container)).not.toContain("holds no");
    // Core's note is the half that says WHICH cause, and it stays.
    expect(container.textContent).toContain("counting it returned no groups");
    // Still a dead end for this query: nothing to tick, nothing to fetch.
    expect(rows(container)).toHaveLength(0);
    expect(fetchButton(container)).toBeNull();
    expect(container.querySelectorAll(".lake-window")).toHaveLength(0);
  });
});

/**
 * A DATASET OFFERED AS ITS OWN LOG TYPE (2026-08-25).
 *
 * Measured live: of 31 lake datasets 24 were empty over -24h and only ONE of the
 * populated ones yielded a discriminator. `winevt_dcronly` - 1,216 events, a
 * single Windows channel - is single-log-type by design, which is how a lake is
 * organised, and the panel answered it with a dead-end sentence pointing at a
 * different acquisition mode entirely.
 *
 * What must be true on screen now, and none of it is visible to the pure tests:
 * the row is RENDERED and TICKABLE, the commit button is enabled, the fetch is
 * addressed with NO field, and the caveat naming the dataset is on screen beside
 * it. That last one is the honesty condition - without it the operator reads
 * `winevt_dcronly` as a log type this app discovered in their data.
 */
describe("LakePanel - when the dataset itself is the log type", () => {
  const named = (c: HTMLElement) => c.querySelectorAll(".lake-dataset-named");

  it("renders the row, its measured volume and its window", async () => {
    const { container } = renderPanel({ query: DATASET_AS_LOG_TYPE });
    await runQuery(container);

    expect(status(container)).toBe("dataset-as-log-type");
    expect(headline(container)).toBe(
      'Nothing on these events tells one log type from another, so "cribl_logs" is offered as a single log type.',
    );
    expect(rows(container)).toHaveLength(1);
    expect(ticked(container)).toBe(1);
    expect(
      container.querySelector(".lake-log-type-name")?.textContent,
    ).toBe("cribl_logs");
    // The dataset's own total, formatted with the same call the component makes.
    expect(container.querySelector(".lake-volume")?.textContent).toBe(
      `${(1216).toLocaleString()} events`,
    );
    // A volume is not a fact without its window, and this row carries one.
    const window = container.querySelectorAll(".lake-window");
    expect(window).toHaveLength(1);
    // No "grouped by" clause: there is no field, and claiming one would be a lie
    // about how the number was produced.
    expect(window[0].textContent).toBe("Volumes cover the last 24 hours.");
  });

  it("says on screen that the name is the DATASET'S, not a discovered log type", async () => {
    // The honesty condition. Without this the row is indistinguishable from
    // GLOBALPROTECT or TRAFFIC - a log type the app claims to have found.
    const { container } = renderPanel({ query: DATASET_AS_LOG_TYPE });
    await runQuery(container);

    const caveat = named(container);
    expect(caveat).toHaveLength(1);
    expect(caveat[0].textContent).toContain("the dataset's");
    expect(caveat[0].textContent).toContain("not a log type found in the data");
    expect(caveat[0].textContent).toContain("Rename it on its chip once added");
    cleanup();

    // And it is NOT permanent scenery: a grouped list carries no such caveat,
    // or it would qualify names that came straight out of the data.
    const grouped = renderPanel();
    await runQuery(grouped.container);
    expect(named(grouped.container)).toHaveLength(0);
    cleanup();

    // Nor does an empty dataset, which has nothing to name at all.
    const empty = renderPanel({ query: queryResult() });
    await runQuery(empty.container);
    expect(named(empty.container)).toHaveLength(0);
    expect(rows(empty.container)).toHaveLength(0);
  });

  it("commits it with NO discriminator field, and stores it under the dataset's name", async () => {
    // The commit path used to assume a field on both sides: the button was
    // disabled without one and the handler returned early. Both now allow it
    // for exactly this case, and the fetch is addressed with `undefined` rather
    // than a string nobody chose.
    const { container, onFetchEvents, onCommit } = renderPanel({
      query: DATASET_AS_LOG_TYPE,
      fetched: fetchResult({ events: [events("cribl_logs", 3)] }),
    });
    await runQuery(container);

    expect(fetchButton(container)?.disabled).toBe(false);
    expect(perLogType(container).value).toBe(String(DEFAULT_SAMPLE_LIMIT));

    await fetchAndAdd(container);

    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    expect(onFetchEvents).toHaveBeenCalledWith(
      undefined,
      ["cribl_logs"],
      DEFAULT_SAMPLE_LIMIT,
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0][0];
    expect(committed.map((s) => s.logType)).toEqual(["cribl_logs"]);
    expect(committed[0].parsed.records).toHaveLength(3);
    expect(outcomeStatus(container)).toBe("done");
    expect(outcomeHeadline(container)).toBe(
      "Added 1 sample from this dataset.",
    );
  });

  it("offers NOTHING when core reported no field AND no row", async () => {
    // The old shape, which core no longer produces but the port's type still
    // permits. It must stay a dead end: a row-less panel rendered as ready
    // would show a commit button with nothing whatever behind it.
    const { container, onFetchEvents } = renderPanel({
      query: queryResult({ noDiscriminator: true }),
    });
    await runQuery(container);

    expect(status(container)).toBe("no-discriminator");
    expect(rows(container)).toHaveLength(0);
    expect(fetchButton(container)).toBeNull();
    expect(named(container)).toHaveLength(0);
    expect(onFetchEvents).toHaveBeenCalledTimes(0);
  });

  it("warns about replacing the operator's own sample of the same name", async () => {
    // The dataset's name collides like any other label - the row is an ordinary
    // choice once it exists, and the store is still replace-by-logType.
    const { container } = renderPanel({
      query: DATASET_AS_LOG_TYPE,
      props: { existingLogTypes: ["Cribl_Logs"] },
    });
    await runQuery(container);

    expect(ticked(container)).toBe(0);
    expect(fetchButton(container)?.disabled).toBe(true);
    fireEvent.click(boxes(container)[0]);

    const replaces = container.querySelectorAll(".lake-replaces");
    expect(replaces).toHaveLength(2);
    expect(replaces[1].textContent).toBe(
      "Adding these replaces your existing Cribl_Logs sample.",
    );
  });
});

describe("LakePanel - nothing enters the store without a click", () => {
  it("counts, then fetches, then commits - each on its own click", async () => {
    // The three-step flow's whole point. Step one returns counts, which are what
    // the operator CHOOSES from and useless as a sample. Step two returns the
    // events and STOPS - that pause is the preview. Step three writes. A panel
    // that fetched bodies on the back of the query, or committed on the back of
    // the fetch, would satisfy every pure test in the suite.
    const { container, onFetchEvents, onCommit } = renderPanel();
    await runQuery(container);

    expect(rows(container)).toHaveLength(3);
    expect(ticked(container)).toBe(3);
    expect(onFetchEvents).toHaveBeenCalledTimes(0);
    expect(onCommit).toHaveBeenCalledTimes(0);
    expect(previewRows(container)).toHaveLength(0);

    await fetchEvents(container);

    // The events are in hand and NOTHING is in the store yet.
    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(0);
    expect(previewRows(container)).toHaveLength(3);
    expect(commitButton(container)?.disabled).toBe(false);

    await addSamples(container);

    // The store write costs NO search: the commit re-uses the fetch's events.
    // A commit that re-fetched would double the job count on the most expensive
    // step in the app, and the sample would be a different set of events from
    // the one just approved.
    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0][0];
    expect(committed.map((s) => s.logType)).toEqual([
      "GLOBALPROTECT",
      "TRAFFIC",
      "THREAT",
    ]);
    expect(committed[0].parsed.records).toHaveLength(2);
    // The counts and the preview have both done their job and go, so a second
    // press cannot commit the same haul twice.
    expect(rows(container)).toHaveLength(0);
    expect(previewRows(container)).toHaveLength(0);
    expect(fetchButton(container)).toBeNull();
    expect(commitButton(container)).toBeNull();
    expect(outcomeStatus(container)).toBe("done");
  });

  it("previews the ACTUAL fetched lines, collapsed, before anything is stored", async () => {
    // The user-reported gap (2026-08-25): Lake samples carried a syslog
    // transport envelope around the vendor's own bytes and there was nowhere to
    // see it until after the commit. What makes this pin worth having is the
    // TEXT - a preview showing a tidied or re-serialized line would render
    // perfectly and hide the one thing the operator is looking for.
    const wrapped = (seq: number) =>
      `<13>1 2026-08-25T16:35:3${seq}.206Z cribl-hw01 PAN-OS - CONFIG - ` +
      `1,2026/08/25 16:35:3${seq},007,CONFIG,0,${seq}`;
    const rawEvents = [wrapped(0), wrapped(1)];
    const { container, onCommit } = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        logTypes: [{ logType: "CONFIG", eventCount: 12 }],
      }),
      fetched: fetchResult({ events: [{ logType: "CONFIG", rawEvents }] }),
    });
    await runQuery(container);
    await fetchEvents(container);

    expect(previewRows(container)).toHaveLength(1);
    expect(previewHeadline(container)).toBe(
      "Fetched 2 events in 1 log type. Nothing is added until you confirm.",
    );
    // Byte for byte, envelope and all - this is the whole feature.
    expect(previewText(container)).toEqual([rawEvents.join("\n")]);
    expect(previewText(container)[0]).toContain("cribl-hw01");

    // COLLAPSED, as the capture panel's preview is: five log types of fifty
    // events each would otherwise bury the button that commits them.
    const details = container.querySelectorAll<HTMLDetailsElement>(
      ".lake-previews details",
    );
    expect(details).toHaveLength(1);
    expect(details[0].open).toBe(false);
    expect(details[0].querySelector("summary")?.textContent).toBe("Preview");

    // And what is previewed is what is STORED - the same lines, unedited. This
    // is the assertion the feature exists for: an operator who reads the box and
    // presses the button gets exactly what they read.
    expect(onCommit).toHaveBeenCalledTimes(0);
    await addSamples(container);
    expect(onCommit.mock.calls[0][0][0].rawEvents).toEqual(rawEvents);
  });

  it("shows FETCHED and STORED together when the two numbers differ", async () => {
    // The user's report: the confirm screen said "Fetched 200 events in 4 log
    // types" with every row at "50 events", and the chips that followed read 26,
    // 19 and 17 - two numbers about the same haul with nothing on screen
    // connecting them. The mechanism was investigated and the obvious causes
    // ruled out, so this does not fix a drop; it makes the difference visible
    // where the claim is made, so a recurrence explains itself.
    const { container } = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        logTypes: [{ logType: "CONFIG", eventCount: 12 }],
      }),
      fetched: fetchResult({
        events: [
          {
            logType: "CONFIG",
            // Four lines, one of them blank - it parses to no record.
            rawEvents: ['{"a":1}', '{"a":2}', '{"a":3}', "   "],
          },
        ],
      }),
    });
    await runQuery(container);
    await fetchEvents(container);

    expect(previewHeadline(container)).toBe(
      "Fetched 4 events in 1 log type, which parse into 3 stored events. Nothing is added until you confirm.",
    );
    expect(
      container.querySelector(".lake-preview-count")?.textContent,
    ).toBe("4 events, 3 stored");
  });

  it("says nothing extra when fetched and stored AGREE", async () => {
    // Restating one number twice on every haul is noise, and noise is what stops
    // the caveat being read on the haul that needs it.
    const { container } = renderPanel();
    await runQuery(container);
    await fetchEvents(container);

    expect(previewHeadline(container)).toBe(
      "Fetched 4 events in 3 log types. Nothing is added until you confirm.",
    );
    expect(
      [...container.querySelectorAll(".lake-preview-count")].map(
        (n) => n.textContent,
      ),
    ).toEqual(["2 events", "1 event", "1 event"]);
  });

  it("locks the picks while a haul waits, and lets them go on Discard", async () => {
    // The events below were fetched for the rows ticked at the time. Re-ticking
    // underneath them would leave the panel describing one selection and
    // committing another - so the way out is Add or Discard, and Discard keeps
    // the counts the operator already paid a search for.
    const { container, onQuery, onFetchEvents, onCommit } = renderPanel();
    await runQuery(container);
    await fetchEvents(container);

    expect([...boxes(container)].filter((b) => b.disabled)).toHaveLength(3);
    expect(perLogType(container).disabled).toBe(true);
    expect(fetchButton(container)?.disabled).toBe(true);
    expect(findButton(container).disabled).toBe(true);

    fireEvent.click(screen.getByText("Discard these events"));

    expect(previewRows(container)).toHaveLength(0);
    expect(onCommit).toHaveBeenCalledTimes(0);
    // The counts survive, unlocked, so picking again costs no second count.
    expect(rows(container)).toHaveLength(3);
    expect([...boxes(container)].filter((b) => b.disabled)).toHaveLength(0);
    expect(fetchButton(container)?.disabled).toBe(false);
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onFetchEvents).toHaveBeenCalledTimes(1);
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

    await fetchEvents(container);

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

    await fetchEvents(container);

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
    expect(fetchButton(container)?.disabled).toBe(true);

    fireEvent.click(fetchButton(container) as HTMLButtonElement);
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
      "Volumes cover the last 24 hours.",
    );

    expect(fetchButton(container)?.disabled).toBe(true);
    fireEvent.click(fetchButton(container) as HTMLButtonElement);
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
    // The OPERATOR'S label, not the dataset's: the row is the dataset's
    // "TRAFFIC", but the sample about to be overwritten is the one their screen
    // calls "traffic", and that is the one the warning is about.
    expect(replaces[1].textContent).toBe(
      "Adding these replaces your existing traffic sample.",
    );
  });

  it("names ONE sample when two ticked rows fold onto the operator's one", async () => {
    // A dataset holding both casings as discriminator values, against a sample
    // the operator called "Traffic". Both rows really do replace it, so both
    // carry their own note - but there is ONE sample between them, and naming
    // two would have them brace for a loss twice the size of the real one.
    const { container } = renderPanel({
      query: queryResult({
        discriminatorField: "sourcetype",
        logTypes: [
          { logType: "TRAFFIC", eventCount: 412908 },
          { logType: "traffic", eventCount: 1201 },
        ],
      }),
      props: { existingLogTypes: ["Traffic"] },
    });
    await runQuery(container);

    // Both are collisions, so neither is pre-ticked; the operator asks for them.
    expect(rows(container)).toHaveLength(2);
    expect([...boxes(container)].map((b) => b.checked)).toEqual([false, false]);
    fireEvent.click(boxes(container)[0]);
    fireEvent.click(boxes(container)[1]);
    expect(ticked(container)).toBe(2);

    // Two row notes plus the one warning beside the button.
    const replaces = container.querySelectorAll(".lake-replaces");
    expect(replaces).toHaveLength(3);
    expect(replaces[2].textContent).toBe(
      "Adding these replaces your existing Traffic sample.",
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
    expect(fetchButton(container)).toBeNull();
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
    fireEvent.click(fetchButton(container) as HTMLButtonElement);

    expect(outcomeStatus(container)).toBe("fetching");
    expect(outcomeHeadline(container)).toBe("Fetching events...");
    expect(fetchButton(container)?.textContent).toBe("Fetching events...");
    expect(fetchButton(container)?.disabled).toBe(true);
    expect(findButton(container).disabled).toBe(true);
    expect(discardButton(container).disabled).toBe(true);
    expect(perLogType(container).disabled).toBe(true);
    expect([...boxes(container)].filter((b) => b.disabled)).toHaveLength(3);
    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    // Still nothing in the store: the fetch has not even answered.
    expect(onCommit).toHaveBeenCalledTimes(0);

    await finish(FETCHED);

    // The fetch answered into a PREVIEW, not into the store.
    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(0);
    expect(previewRows(container)).toHaveLength(3);
    expect(rows(container)).toHaveLength(3);
  });

  it("locks the panel while the STORE WRITE runs, and says which one it is", async () => {
    // A second lock, for a second await. The store is replace-by-logType so a
    // double commit is idempotent - what this stops is the operator ACTING on a
    // panel mid-write: discarding the events, or re-fetching them, against a
    // commit whose result they cannot see yet.
    let resolveCommit: () => void = () => {};
    const onCommit = vi.fn(
      (_samples: TaggedSample[]) =>
        new Promise<void>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const { container } = renderPanel({ props: { onCommit } });

    await runQuery(container);
    await fetchEvents(container);
    fireEvent.click(commitButton(container) as HTMLButtonElement);

    expect(onCommit).toHaveBeenCalledTimes(1);
    // Named apart from the fetch: they fail differently, and "Fetching" over a
    // store write would send a failure hunt at the wrong half of the flow.
    expect(commitButton(container)?.textContent).toBe("Adding samples...");
    expect(commitButton(container)?.disabled).toBe(true);
    expect(previewRows(container)).toHaveLength(3);
    expect(findButton(container).disabled).toBe(true);

    await act(async () => resolveCommit());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(previewRows(container)).toHaveLength(0);
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
    await fetchEvents(container);

    // The hole is visible BEFORE the commit too: the row is previewed with its
    // blank line and marked as one the commit will not take.
    expect(previewRows(container)).toHaveLength(3);
    const dropped = container.querySelectorAll(".lake-preview-dropped");
    expect(dropped).toHaveLength(1);
    expect(previewRows(container)[2].textContent).toContain("THREAT");
    expect(dropped[0].textContent).toBe(
      "these lines parsed to no record, so this one will not be added",
    );

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

    await fetchEvents(container);

    // Both rows preview as ADDABLE, because both really are added - as one
    // sample. Marking the second "will not be added" would be the pre-commit
    // version of the lie the summary below stopped telling.
    expect(previewRows(container)).toHaveLength(2);
    expect(container.querySelectorAll(".lake-preview-dropped")).toHaveLength(0);

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

  it("previews NOTHING and keeps the counts when a fetch yields no sample", async () => {
    // THREE different answers that must not fold together: the search failed,
    // the search answered with no events at all, or it answered with events that
    // carried no records. None may put a husk in the store, none may render an
    // empty preview box - which would read as "this is what your data looks
    // like" - and all three must leave the rows up, because re-running the count
    // to pick again would spend a search the operator already paid for.
    const failed = renderPanel({
      fetched: fetchResult({
        ok: false,
        notes: ['"TRAFFIC" could not be fetched.'],
      }),
    });
    await runQuery(failed.container);
    await fetchEvents(failed.container);

    expect(failed.onCommit).toHaveBeenCalledTimes(0);
    expect(previewRows(failed.container)).toHaveLength(0);
    expect(commitButton(failed.container)).toBeNull();
    expect(outcomeStatus(failed.container)).toBe("failed");
    expect(outcomeHeadline(failed.container)).toContain("nothing was added");
    expect(failed.container.textContent).toContain(
      '"TRAFFIC" could not be fetched.',
    );
    expect(rows(failed.container)).toHaveLength(3);
    expect(fetchButton(failed.container)?.disabled).toBe(false);
    const failedHeadline = outcomeHeadline(failed.container);
    cleanup();

    // The search ran and the window held none of the picked log types. Reported
    // as "Events came back, but none of them parsed" until 2026-08-25 - a
    // sentence about events that never existed, sending the operator to inspect
    // the shape of data they do not have.
    const none = renderPanel({
      fetched: fetchResult({
        notes: ['"TRAFFIC" returned no events in this window.'],
      }),
    });
    await runQuery(none.container);
    await fetchEvents(none.container);

    expect(none.onCommit).toHaveBeenCalledTimes(0);
    expect(previewRows(none.container)).toHaveLength(0);
    expect(outcomeStatus(none.container)).toBe("no-events");
    expect(outcomeHeadline(none.container)).toContain("returned no events");
    expect(none.container.textContent).toContain(
      '"TRAFFIC" returned no events in this window.',
    );
    expect(rows(none.container)).toHaveLength(3);
    const noneHeadline = outcomeHeadline(none.container);
    cleanup();

    const unusable = renderPanel({
      fetched: fetchResult({
        events: [{ logType: "GLOBALPROTECT", rawEvents: ["   "] }],
      }),
    });
    await runQuery(unusable.container);
    await fetchEvents(unusable.container);

    expect(unusable.onCommit).toHaveBeenCalledTimes(0);
    expect(previewRows(unusable.container)).toHaveLength(0);
    expect(outcomeStatus(unusable.container)).toBe("unusable");
    expect(outcomeHeadline(unusable.container)).toContain("none of them parsed");
    expect(rows(unusable.container)).toHaveLength(3);

    expect(
      new Set([
        failedHeadline,
        noneHeadline,
        outcomeHeadline(unusable.container),
      ]).size,
    ).toBe(3);
  });

  /**
   * A PARTIAL FETCH, END TO END (2026-08-26).
   *
   * The defect this closes was only visible here: `deriveLakeCommitView` said
   * "nothing was added" while `commit` had ALREADY called `onCommit` with the
   * samples that did arrive - so the store and the sentence describing it
   * disagreed, on one screen, at the same moment. Only the component holds both
   * halves.
   */
  it("stores what a partial fetch returned, and says so instead of denying it", async () => {
    const { container, onCommit } = renderPanel({
      fetched: fetchResult({
        // Core's `ok` is `failed === 0`, so ONE lost log type makes this false
        // while two perfectly good hauls sit in `events`.
        ok: false,
        events: [events("GLOBALPROTECT", 2), events("TRAFFIC", 1)],
        notes: ['"THREAT" could not be fetched: HTTP 400.'],
      }),
    });
    await runQuery(container);
    await fetchEvents(container);

    // The preview is offered at all, which the `ok` test never reached: a
    // partial haul used to be reported before its events were ever shown.
    expect(previewRows(container)).toHaveLength(2);

    await addSamples(container);

    // TWO SAMPLES REALLY WERE WRITTEN.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].map((s) => s.logType)).toEqual([
      "GLOBALPROTECT",
      "TRAFFIC",
    ]);
    // ...so the panel must not say nothing was.
    expect(outcomeStatus(container)).toBe("partial");
    expect(outcomeHeadline(container)).toBe(
      "Added 2 samples from the 3 log types you picked. 1 of them could not be fetched, or returned nothing usable - the notes below name which.",
    );
    expect(outcomeHeadline(container)).not.toContain("nothing was added");
    // And the note naming the lost one survives beside it.
    expect(container.textContent).toContain(
      '"THREAT" could not be fetched: HTTP 400.',
    );
  });

  /**
   * A REFUSED STORE WRITE (2026-08-26).
   *
   * `commit` awaited `onCommit` inside try/finally with NO catch. A rejected
   * write un-disabled the button and changed nothing else: no outcome, no error,
   * the preview still sitting there - indistinguishable from a slow store. This
   * pin exists only here because the rejection is the component's to catch.
   */
  it("names a REJECTED store write and keeps the events to retry from", async () => {
    const onCommit = vi.fn(async (_samples: TaggedSample[]) => {
      throw new Error("KV store quota exceeded");
    });
    const { container } = renderPanel({ props: { onCommit } });
    await runQuery(container);
    await fetchEvents(container);

    await addSamples(container);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(outcomes(container)).toHaveLength(1);
    expect(outcomeStatus(container)).toBe("store-failed");
    expect(outcomeHeadline(container)).toContain("could not be saved");
    // The platform's own words, not a paraphrase - it is the only clue there is.
    expect(outcomeHeadline(container)).toContain("KV store quota exceeded");
    // NOTHING is claimed about what landed: a rejected write does not say where
    // it stopped.
    expect(outcomeHeadline(container)).not.toContain("Added");
    expect(outcomeHeadline(container)).not.toContain("nothing was added");

    // The retry is a second press of the same button over the same events, and
    // it costs no search - so all of it is still on screen and usable.
    expect(previewRows(container)).toHaveLength(3);
    expect(commitButton(container)?.disabled).toBe(false);
    expect(rows(container)).toHaveLength(3);

    await addSamples(container);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("clears the store error once a retry succeeds", async () => {
    // A failure sentence left standing over a successful commit is the same
    // defect pointed the other way.
    let attempts = 0;
    const onCommit = vi.fn(async (_samples: TaggedSample[]) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    });
    const { container } = renderPanel({ props: { onCommit } });
    await runQuery(container);
    await fetchEvents(container);

    await addSamples(container);
    expect(outcomeStatus(container)).toBe("store-failed");

    await addSamples(container);

    expect(outcomeStatus(container)).toBe("done");
    expect(outcomeHeadline(container)).toBe(
      "Added 3 samples from this dataset.",
    );
    expect(container.textContent).not.toContain("could not be saved");
  });

  it("stops printing 'nothing is added until you confirm' once something was", async () => {
    // The commit clears the counts, which returns the query headline to its idle
    // instruction - directly above a summary saying what was just added.
    const { container } = renderPanel();
    await runQuery(container);
    expect(headline(container)).toContain("3 log types");

    await fetchAndAdd(container);

    expect(outcomeHeadline(container)).toBe(
      "Added 3 samples from this dataset.",
    );
    expect(container.textContent).not.toContain(
      "Nothing is added until you confirm",
    );
    // Not permanently gone: the next query is what the sentence is about.
    await runQuery(container);
    expect(headline(container)).toContain("3 log types");
  });

  it("drops the previous dataset's counts AND its summary when the dataset changes", async () => {
    // Both survive a fetch that added nothing, so both would still be on screen
    // under the new dataset's name - counts read as this dataset's, and a
    // failure attributed to a dataset that never ran.
    const { container, props, rerender } = renderPanel({
      fetched: fetchResult({ ok: false, notes: ["The search returned HTTP 400."] }),
    });
    await runQuery(container);
    await fetchEvents(container);
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

  it("drops a WAITING haul when the dataset changes, rather than committing it", async () => {
    // The preview outlives the click that fetched it, so it can outlive the
    // dataset too - and a commit taken from it would file one dataset's events
    // under a panel headed by another's name.
    const { container, props, rerender, onCommit } = renderPanel();
    await runQuery(container);
    await fetchEvents(container);
    expect(previewRows(container)).toHaveLength(3);

    rerender(<LakePanel {...props} datasetId="corelight" />);

    expect(previewRows(container)).toHaveLength(0);
    expect(commitButton(container)).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(0);
    expect(status(container)).toBe("idle");
  });
});

/**
 * THE ROW FOR EVENTS THAT CARRY NO VALUE (user report 2026-08-25).
 *
 * Observed live on a PaloAlto lake dataset: 13 log types listed, and then "1
 * group carried no msgid value and was left out". Those events had a real count
 * and no route to becoming a sample - unshapeable, and unshaped in the
 * generated pack.
 *
 * Core now offers them as a row labelled "(no msgid)". What only the component
 * can be held to is the honesty of that row ON SCREEN: it is rendered, it is
 * tickable, it is fetched with the field the query established - and the caveat
 * saying the label describes what these events LACK sits BESIDE it, among
 * twelve names that really did come out of the data. Nothing downstream can say
 * that; without it the operator reads a thirteenth vendor log type.
 */
describe("LakePanel - the group whose discriminator value is absent", () => {
  const unnamedHints = (c: HTMLElement) => c.querySelectorAll(".lake-unnamed");

  /** Two real log types and core's minted row, all inside the tick budget. */
  const WITH_UNNAMED = queryResult({
    discriminatorField: "msgid",
    logTypes: [
      { logType: "TRAFFIC", eventCount: 412908 },
      { logType: "(no msgid)", eventCount: 4211, unnamed: true },
    ],
  });

  it("renders the row, its count, and the caveat naming the field", async () => {
    const { container } = renderPanel({ query: WITH_UNNAMED });

    await runQuery(container);

    expect(rows(container)).toHaveLength(2);
    const row = rows(container)[1];
    expect(row.querySelector(".lake-log-type-name")?.textContent).toBe(
      "(no msgid)",
    );
    // THE PLATFORM'S COUNT, on screen, formatted like every other row's.
    expect(row.querySelector(".lake-volume")?.textContent).toContain(
      "4,211 events",
    );
    // ONE caveat, on THAT row, and it names the field - "no value" means
    // nothing without one.
    expect(unnamedHints(container)).toHaveLength(1);
    const caveat = row.querySelector(".lake-unnamed")?.textContent ?? "";
    expect(caveat).toContain("carry no msgid value");
    expect(caveat).toContain("not a log type found in the data");
  });

  it("shows no such caveat when every row came out of the data", async () => {
    const { container } = renderPanel();

    await runQuery(container);

    expect(rows(container)).toHaveLength(3);
    expect(unnamedHints(container)).toHaveLength(0);
  });

  it("fetches it with the field the query established, like any other row", async () => {
    // The row is takeable, which is the whole point of offering it - and it is
    // addressed with the SAME field, because core's query builder is what turns
    // that pick into the no-value filter. A panel that dropped the field here
    // would send it down the unfiltered dataset-as-log-type path instead.
    const { container, onFetchEvents } = renderPanel({
      query: WITH_UNNAMED,
      fetched: fetchResult({
        events: [
          {
            logType: "(no msgid)",
            rawEvents: ['{"seq":1}', '{"seq":2}'],
          },
        ],
      }),
    });
    await runQuery(container);
    // Untick the real log type so only the minted row is asked for.
    fireEvent.click(boxes(container)[0]);
    expect(ticked(container)).toBe(1);

    await fetchEvents(container);

    expect(onFetchEvents).toHaveBeenCalledTimes(1);
    expect(onFetchEvents.mock.calls[0][0]).toBe("msgid");
    expect(onFetchEvents.mock.calls[0][1]).toEqual(["(no msgid)"]);
    expect(previewRows(container)).toHaveLength(1);
  });

  it("stores it under the label it was offered as, with nothing renamed", async () => {
    const { container, onCommit } = renderPanel({
      query: WITH_UNNAMED,
      fetched: fetchResult({
        events: [{ logType: "(no msgid)", rawEvents: ['{"seq":1}'] }],
      }),
    });
    await runQuery(container);
    fireEvent.click(boxes(container)[0]);

    await fetchAndAdd(container);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].map((s) => s.logType)).toEqual([
      "(no msgid)",
    ]);
  });
});
