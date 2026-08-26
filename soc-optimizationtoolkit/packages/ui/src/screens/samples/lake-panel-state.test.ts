/**
 * Pins for the Lake panel's pure decisions (plan Phase 4, ADR 0003).
 *
 * The failures worth guarding here are all failures of MEANING rather than of
 * mechanism - each one renders something plausible while telling the operator
 * the opposite of the truth:
 *
 *   - reporting a failed read as an empty dataset (or the reverse), which sends
 *     them to fix the wrong thing;
 *   - showing a volume without the window it covers, which is not a fact;
 *   - showing a truncated log-type list as if it were the whole dataset;
 *   - letting a commit silently overwrite a sample they curated, or promising a
 *     replacement that appends a duplicate instead;
 *   - naming more samples in the replace warning than the operator actually
 *     has, which puts them off a commit that would cost them one sample;
 *   - rounding a partial haul up to a success;
 *   - blaming a shortfall on empty data when the picks were folded into one
 *     sample, which sends them to widen a window over data they already have;
 *   - previewing something OTHER than what the commit will write, which is
 *     worse than showing nothing: it clears the operator to store bytes they
 *     were never actually shown.
 */

import { describe, expect, it } from "vitest";
import type {
  FetchLakeEventsResult,
  QueryLakeSamplesResult,
} from "@soc/core";
import {
  DEFAULT_PRESELECTED,
  canFetchLakeSamples,
  deriveLakeCommitView,
  deriveLakeQueryView,
  lakeCollisions,
  lakeLogTypeChoices,
  lakeOffersSamples,
  lakePreselectionHint,
  lakePreviewHeadline,
  lakeSamplePreviews,
  mergedLakeLogTypeCount,
  plannedLakeSamples,
  selectedLakeLogTypes,
  toggleLakeChoice,
  windowLabel,
} from "./lake-panel-state";
import { PREVIEW_LINES } from "./planned-samples";

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
 * What core returns for a populated dataset that nothing splits: ONE log type,
 * named after the dataset, with a volume measured by an ungrouped
 * `summarize count()` and NO discriminator field.
 */
const DATASET_AS_LOG_TYPE = queryResult({
  noDiscriminator: true,
  datasetAsLogType: true,
  logTypes: [{ logType: "cribl_logs", eventCount: 1216 }],
  notes: ["named after the dataset"],
});

const fetchResult = (
  over: Partial<FetchLakeEventsResult> = {},
): FetchLakeEventsResult => ({
  events: [],
  notes: [],
  ok: true,
  ...over,
});

describe("lakeLogTypeChoices", () => {
  it("pre-selects the highest-volume types up to the budget, offers the rest", () => {
    // Every ticked box costs another search at commit time, so a two-hundred
    // log-type dataset must not arrive fully ticked.
    const choices = lakeLogTypeChoices([
      { logType: "A", eventCount: 7 },
      { logType: "B", eventCount: 6 },
      { logType: "C", eventCount: 5 },
      { logType: "D", eventCount: 4 },
      { logType: "E", eventCount: 3 },
      { logType: "F", eventCount: 2 },
      { logType: "G", eventCount: 1 },
    ]);
    expect(DEFAULT_PRESELECTED).toBe(5);
    expect(choices.map((c) => c.selected)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    // Offered, never hidden - the operator may want the rare one.
    expect(choices.map((c) => c.value)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
    ]);
  });

  // The BYTE ESTIMATE on a pickable row (plan Phase 5, last item). Whether a log
  // type is worth ticking is partly a cost question, and Sentinel charges by
  // volume - but the figure is a sampled mean times a window-wide count, so it
  // must be absent rather than zero whenever it cannot be computed.

  it("carries the estimate for a row whose events were sampled", () => {
    const choices = lakeLogTypeChoices([
      { logType: "TRAFFIC", eventCount: 890123, meanEventBytes: 620 },
    ]);

    expect(choices[0].eventCount).toBe(890123);
    // 890,123 x 620 = 551,876,260.
    expect(choices[0].estimatedBytes).toBe(551876260);
  });

  it("leaves a counted-but-unsampled row unestimated - never zero", () => {
    const choices = lakeLogTypeChoices([
      { logType: "SECURITY", eventCount: 22792 },
    ]);

    expect(choices[0].eventCount).toBe(22792);
    expect(choices[0].estimatedBytes).toBeUndefined();
    // The KEY is absent, so a renderer testing for the property shows nothing.
    expect("estimatedBytes" in choices[0]).toBe(false);
  });

  it("estimates nothing from a mean with no count to multiply", () => {
    // The unreadable-count row: it already renders "volume unknown", and a byte
    // figure beside that would be a total nobody could have measured.
    const choices = lakeLogTypeChoices([
      { logType: "TRAFFIC", meanEventBytes: 620 },
    ]);

    expect(choices[0].eventCount).toBeUndefined();
    expect("estimatedBytes" in choices[0]).toBe(false);
  });

  // THE ROW WITH NO NAME (user report 2026-08-25). Core offers the `summarize
  // by` group whose value was ABSENT under a label it minted from the field.
  // The panel's job is to take that row like any other AND to carry core's own
  // word for which row it is, so the caveat never has to be inferred from how
  // the label is spelled.

  it("marks core's minted row as unnamed, and every other row as named", () => {
    const choices = lakeLogTypeChoices([
      { logType: "TRAFFIC", eventCount: 890123, meanEventBytes: 620 },
      { logType: "(no msgid)", eventCount: 4211, unnamed: true },
    ]);

    expect(choices.map((c) => c.unnamed)).toEqual([false, true]);
    // Takeable like any other row: offered, tickable, and pre-selected on its
    // volume rather than pushed to the end for lacking a name.
    expect(choices[1].selected).toBe(true);
    expect(selectedLakeLogTypes(choices)).toEqual(["TRAFFIC", "(no msgid)"]);
    // THE PLATFORM'S COUNT SURVIVES. It is a real group of real events; only
    // the name is ours.
    expect(choices[1].eventCount).toBe(4211);
    // And its byte estimate is absent because it was never sampled - the
    // standing rule, applied here unchanged.
    expect("estimatedBytes" in choices[1]).toBe(false);
  });

  it("estimates the unnamed row's bytes when its OWN events were sampled", () => {
    const choices = lakeLogTypeChoices([
      { logType: "(no msgid)", eventCount: 4211, meanEventBytes: 300, unnamed: true },
    ]);

    // 4,211 x 300 = 1,263,300. The events are real, so their cost is too.
    expect(choices[0].estimatedBytes).toBe(1263300);
    expect(choices[0].unnamed).toBe(true);
  });

  it("marks nothing unnamed when every row came out of the data", () => {
    const choices = lakeLogTypeChoices([
      { logType: "TRAFFIC", eventCount: 3 },
      { logType: "THREAT", eventCount: 2 },
    ]);

    expect(choices.every((c) => c.unnamed === false)).toBe(true);
  });

  it("reads the flag from CORE, never from the shape of the label", () => {
    // A vendor whose own log type is spelled with parentheses is still a log
    // type found in the data. A UI-side rule that decided by looking for "(no "
    // would caveat this row about a field it does carry.
    const choices = lakeLogTypeChoices([{ logType: "(no msgid)", eventCount: 9 }]);

    expect(choices[0].unnamed).toBe(false);
  });

  it("does NOT pre-select a log type the operator already provided", () => {
    const choices = lakeLogTypeChoices(
      [
        { logType: "TRAFFIC", eventCount: 412908 },
        { logType: "THREAT", eventCount: 38201 },
      ],
      ["TRAFFIC"],
    );
    expect(choices.map((c) => c.selected)).toEqual([false, true]);
    expect(choices[0].replacesExisting).toBe(true);
    expect(choices[0].note).toContain("replaces yours");
    expect(choices[1].replacesExisting).toBe(false);
    expect(choices[1].note).toBeUndefined();
  });

  it("matches an existing sample case-INSENSITIVELY", () => {
    // The store keys on the label the operator typed. Search reports whatever
    // casing the data carries, so without folding the case the panel would not
    // know "TRAFFIC" and "traffic" collide.
    const choices = lakeLogTypeChoices([{ logType: "TRAFFIC" }], ["  traffic "]);
    expect(choices[0].replacesExisting).toBe(true);
    expect(choices[0].selected).toBe(false);
  });

  it("does not let an already-provided type spend the pre-selection budget", () => {
    // It was never a candidate for a search, so it must not crowd out one that
    // is - otherwise a dataset whose top rows are all provided arrives with
    // nothing ticked at all.
    const choices = lakeLogTypeChoices(
      [
        { logType: "OLD1" },
        { logType: "OLD2" },
        { logType: "N1" },
        { logType: "N2" },
        { logType: "N3" },
        { logType: "N4" },
        { logType: "N5" },
        { logType: "N6" },
      ],
      ["old1", "old2"],
    );
    expect(selectedLakeLogTypes(choices)).toEqual([
      "N1",
      "N2",
      "N3",
      "N4",
      "N5",
    ]);
  });

  it("carries the label each row would be STORED under", () => {
    // The row shows the dataset's casing, but the store keys the operator's -
    // so the label a commit writes, and the one a warning must name, is theirs.
    // Both case variants resolve to it; a log type they do not have keeps the
    // dataset's own name, because nothing of theirs is at stake there.
    const choices = lakeLogTypeChoices(
      [{ logType: "TRAFFIC" }, { logType: "traffic" }, { logType: "THREAT" }],
      ["Traffic"],
    );
    expect(choices.map((c) => c.value)).toEqual([
      "TRAFFIC",
      "traffic",
      "THREAT",
    ]);
    expect(choices.map((c) => c.storeLabel)).toEqual([
      "Traffic",
      "Traffic",
      "THREAT",
    ]);
  });

  it("carries a volume through, and leaves an unreadable one UNDEFINED", () => {
    // Not defaulted to 0: a volume of zero is a claim about the data, and the
    // usecase deliberately declined to make it.
    const choices = lakeLogTypeChoices([
      { logType: "TRAFFIC", eventCount: 412908 },
      { logType: "THREAT" },
    ]);
    expect(choices[0].eventCount).toBe(412908);
    expect(choices[1].eventCount).toBeUndefined();
  });
});

describe("toggle + collisions", () => {
  const choices = lakeLogTypeChoices(
    [
      { logType: "TRAFFIC", eventCount: 412908 },
      { logType: "THREAT", eventCount: 38201 },
    ],
    ["TRAFFIC"],
  );

  it("ticking an offered type adds it, in the order offered", () => {
    const next = toggleLakeChoice(choices, "TRAFFIC");
    expect(selectedLakeLogTypes(next)).toEqual(["TRAFFIC", "THREAT"]);
  });

  it("unticking removes it and leaves the others alone", () => {
    const next = toggleLakeChoice(choices, "THREAT");
    expect(selectedLakeLogTypes(next)).toEqual([]);
    expect(next[0].replacesExisting).toBe(true);
  });

  it("warns about a collision only while it is actually TICKED", () => {
    // Unlike a capture, which commits everything it returned, here the
    // selection decides what collides. Warning about a row the operator already
    // unticked trains them to ignore the warning.
    expect(lakeCollisions(choices)).toEqual([]);
    const ticked = toggleLakeChoice(choices, "TRAFFIC");
    expect(lakeCollisions(ticked)).toEqual(["TRAFFIC"]);
    expect(lakeCollisions(toggleLakeChoice(ticked, "TRAFFIC"))).toEqual([]);
  });

  it("names the sample by the OPERATOR'S label, not by Search's casing", () => {
    // The warning is about a sample of theirs, and "your existing TRAFFIC
    // sample" names one they do not have - their chip reads "traffic". The
    // commit adopts their label too, so anything else makes the warning and the
    // sample it replaced disagree about what was called what.
    const one = lakeLogTypeChoices([{ logType: "TRAFFIC" }], ["traffic"]);
    expect(lakeCollisions(toggleLakeChoice(one, "TRAFFIC"))).toEqual([
      "traffic",
    ]);
  });

  it("names ONE sample when two ticks fold onto one of the operator's", () => {
    // The dataset holds both casings as discriminator values and the operator
    // has a sample under a third. All three are the same store key, so both
    // ticks replace that ONE sample - and naming two would tell them they are
    // about to lose a sample that does not exist, over a commit that costs them
    // one. The pre-commit mirror of the shortfall mergedLakeLogTypeCount fixed.
    const variants = lakeLogTypeChoices(
      [
        { logType: "TRAFFIC", eventCount: 412908 },
        { logType: "traffic", eventCount: 1201 },
      ],
      ["Traffic"],
    );
    const both = toggleLakeChoice(
      toggleLakeChoice(variants, "TRAFFIC"),
      "traffic",
    );
    // Two rows really are ticked - the fold is in what they are CALLED, not in
    // what gets fetched, and both are still fetched and committed.
    expect(selectedLakeLogTypes(both)).toEqual(["TRAFFIC", "traffic"]);
    expect(lakeCollisions(both)).toEqual(["Traffic"]);
  });

  it("still names every DISTINCT sample a commit would replace", () => {
    // The other side of the fold: collapsing to one entry per sample must not
    // become one entry per commit, which would hide a second sample the
    // operator is about to lose.
    const two = lakeLogTypeChoices(
      [{ logType: "TRAFFIC" }, { logType: "THREAT" }],
      ["traffic", "threat"],
    );
    const both = toggleLakeChoice(toggleLakeChoice(two, "TRAFFIC"), "THREAT");
    expect(lakeCollisions(both)).toEqual(["traffic", "threat"]);
  });
});

describe("deriveLakeQueryView", () => {
  it("says nothing is added until confirmed, and claims no window, before a run", () => {
    const view = deriveLakeQueryView(null, false);
    expect(view.status).toBe("idle");
    expect(view.headline).toContain("Nothing is added until you confirm");
    // A count without its window is not a fact, so there is no window to show
    // before there are counts.
    expect(view.window).toBeNull();
  });

  it("reports a FAILED read separately from an EMPTY dataset", () => {
    // The whole point of the usecase's `ok` flag. A failed read is a
    // credentials or search-permission problem; an empty one is a window or
    // dataset problem, and they send the operator to opposite places.
    const failed = deriveLakeQueryView(
      queryResult({ ok: false, notes: ["HTTP 403"] }),
      false,
    );
    expect(failed.status).toBe("failed");
    expect(failed.headline).toContain("could not be read");
    expect(failed.notes).toEqual(["HTTP 403"]);

    const empty = deriveLakeQueryView(
      queryResult({ ok: true, notes: ["holds no events"] }),
      false,
    );
    expect(empty.status).toBe("empty");
    expect(empty.headline).toContain("answered");
    // CHANGED 2026-08-26: the window is still IN the sentence - "holds nothing"
    // is only true of a period - but it is no longer the raw Kusto tokens
    // "-24h" and "now", which were the app quoting its own query language at
    // someone who never wrote it. The pin follows the copy deliberately; what it
    // guards is that the window is still stated, and windowLabel's own pins
    // guard the translation.
    expect(empty.headline).toContain("the last 24 hours");
    expect(empty.headline).not.toContain("-24h");
    expect(empty.notes).toEqual(["holds no events"]);
  });

  /**
   * A DATASET KNOWN TO HOLD EVENTS, described as holding none (2026-08-26).
   *
   * Core reaches a row-less `ok: true` result down two paths. One is an empty
   * window. The other runs only after step one returned rows - the dataset
   * PROVABLY holds events - and reports that the GROUPING came back with no
   * groups; core's own note beside it says as much, so the old shared headline
   * contradicted the note printed underneath it. The field is the evidence that
   * separates them: core cannot name a discriminator without having read events
   * to find one.
   */
  it("does not call a dataset it counted events in an EMPTY one", () => {
    const counted = deriveLakeQueryView(
      queryResult({
        discriminatorField: "sourcetype",
        notes: [
          'Events in "cribl_logs" carry a "sourcetype" field, but counting it returned no groups.',
        ],
      }),
      false,
    );

    expect(counted.status).toBe("no-groups");
    expect(counted.headline).toBe(
      'The dataset "cribl_logs" holds events, but grouping them by sourcetype produced no log types.',
    );
    // The half that was a confident wrong answer: it must not say the dataset
    // holds nothing, in any of the shapes that sentence took.
    expect(counted.headline).not.toContain("holds no");
    expect(counted.headline).not.toContain("answered, and holds");
    // Core's explanation survives - it is the half that says WHICH cause.
    expect(counted.notes).toHaveLength(1);
    // Nothing to take, exactly as before: this is not a new offering status.
    expect(lakeOffersSamples(counted)).toBe(false);
    expect(canFetchLakeSamples(counted, 3)).toBe(false);
  });

  it("keeps an EMPTY WINDOW and an EMPTY GROUPING apart, headline and status", () => {
    // The two are one condition apart in core and were one sentence apart on
    // screen: the operator is sent to widen a window in one case and to look at
    // a field's values in the other.
    const emptyWindow = deriveLakeQueryView(queryResult(), false);
    const emptyGrouping = deriveLakeQueryView(
      queryResult({ discriminatorField: "sourcetype" }),
      false,
    );

    expect(emptyWindow.status).toBe("empty");
    expect(emptyGrouping.status).toBe("no-groups");
    expect(emptyWindow.headline).not.toBe(emptyGrouping.headline);
    // Only the window one claims the dataset is empty, because only it observed
    // an empty dataset.
    expect(emptyWindow.headline).toContain("holds no events");
    expect(emptyGrouping.headline).toContain("holds events");
    // FIVE distinct sentences for five distinct answers now, none folding into
    // another.
    expect(
      new Set([
        deriveLakeQueryView(queryResult({ ok: false }), false).headline,
        emptyWindow.headline,
        emptyGrouping.headline,
        deriveLakeQueryView(queryResult({ noDiscriminator: true }), false)
          .headline,
        deriveLakeQueryView(DATASET_AS_LOG_TYPE, false).headline,
      ]).size,
    ).toBe(5);
  });

  it("carries the field onto the no-groups view, because the headline names it", () => {
    // "grouping them by sourcetype" is only sayable from the field, and a view
    // that dropped it would have to fall back to a vaguer sentence.
    const counted = deriveLakeQueryView(
      queryResult({ discriminatorField: "msgid" }),
      false,
    );
    expect(counted.discriminatorField).toBe("msgid");
    expect(counted.headline).toContain("msgid");
  });

  it("gives NO DISCRIMINATOR its own status, not empty", () => {
    // A dataset full of events that nothing distinguishes is not an idle
    // dataset, and telling the operator it is would send them to widen a window
    // that is already wide enough.
    //
    // This is now the shape where core offered NOTHING with it - which core no
    // longer produces, but the port's type still permits and the branch below
    // is one condition away from rendering a row-less panel as ready.
    const view = deriveLakeQueryView(
      queryResult({ noDiscriminator: true, notes: ["no field distinguishes"] }),
      false,
    );
    expect(view.status).toBe("no-discriminator");
    expect(view.headline).toContain("tells one log type from another");
    expect(view.notes).toEqual(["no field distinguishes"]);
    expect(view.datasetAsLogType).toBe(false);
    // Nothing to take: no controls, no commit.
    expect(lakeOffersSamples(view)).toBe(false);
    expect(canFetchLakeSamples(view, 1)).toBe(false);
  });

  it("gives a DATASET OFFERED AS ONE LOG TYPE a status of its own, and a commit", () => {
    // The gap this closes. `winevt_dcronly` holds 1,216 events of one Windows
    // channel; nothing splits them, and the app used to answer with a dead-end
    // sentence pointing at a different acquisition mode. It is a takeable
    // sample, so the view carries the window and the controls that a grouped
    // list carries - the ONE thing it must add is that the name is the
    // dataset's.
    const view = deriveLakeQueryView(DATASET_AS_LOG_TYPE, false);

    expect(view.status).toBe("dataset-as-log-type");
    expect(view.headline).toBe(
      'Nothing on these events tells one log type from another, so "cribl_logs" is offered as a single log type.',
    );
    expect(view.datasetAsLogType).toBe(true);
    // No field, and that is the point - the fetch runs unfiltered.
    expect(view.discriminatorField).toBeUndefined();
    // A volume needs its window, and this one has a real volume.
    expect(view.window).toEqual(WINDOW);
    expect(view.notes).toEqual(["named after the dataset"]);
    expect(lakeOffersSamples(view)).toBe(true);
    expect(canFetchLakeSamples(view, 1)).toBe(true);
  });

  it("keeps EMPTY and DATASET-AS-LOG-TYPE apart, which is the whole point", () => {
    // The two used to be one dead end on screen: no rows, no commit, go away.
    // They are opposite facts - one dataset is idle, the other is full - and
    // they send the operator to opposite places.
    const empty = deriveLakeQueryView(queryResult(), false);
    const single = deriveLakeQueryView(DATASET_AS_LOG_TYPE, false);

    expect(empty.status).toBe("empty");
    expect(single.status).toBe("dataset-as-log-type");
    expect(empty.headline).not.toBe(single.headline);
    expect(empty.datasetAsLogType).toBe(false);
    expect(lakeOffersSamples(empty)).toBe(false);
    expect(lakeOffersSamples(single)).toBe(true);
    // Four distinct sentences for four distinct answers, none folding into
    // another.
    const headlines = [
      deriveLakeQueryView(queryResult({ ok: false }), false).headline,
      empty.headline,
      deriveLakeQueryView(queryResult({ noDiscriminator: true }), false).headline,
      single.headline,
    ];
    expect(new Set(headlines).size).toBe(4);
  });

  it("offers the dataset's row like any other, volume and all", () => {
    // Downstream of the view: the row is an ordinary choice, so it pre-selects,
    // collides and stores exactly as a discovered log type does. Its volume is
    // the dataset's own total, carried through unchanged.
    const choices = lakeLogTypeChoices(
      DATASET_AS_LOG_TYPE.logTypes,
      [],
    );
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe("cribl_logs");
    expect(choices[0].eventCount).toBe(1216);
    expect(choices[0].selected).toBe(true);
    expect(selectedLakeLogTypes(choices)).toEqual(["cribl_logs"]);
  });

  it("still offers the sample when core could not count the dataset", () => {
    // A lost count costs the NUMBER, never the offer. The row renders with no
    // volume - never zero, and never the size of the sample core read to find a
    // field - and is still committable.
    const uncounted = queryResult({
      noDiscriminator: true,
      datasetAsLogType: true,
      logTypes: [{ logType: "cribl_logs" }],
    });
    const view = deriveLakeQueryView(uncounted, false);

    expect(view.status).toBe("dataset-as-log-type");
    expect(canFetchLakeSamples(view, 1)).toBe(true);
    expect(lakeLogTypeChoices(uncounted.logTypes)[0].eventCount).toBeUndefined();
  });

  it("summarises a ready result and carries the window and the group field", () => {
    const view = deriveLakeQueryView(
      queryResult({
        discriminatorField: "sourcetype",
        logTypes: [
          { logType: "GLOBALPROTECT", eventCount: 890114 },
          { logType: "TRAFFIC", eventCount: 412908 },
        ],
      }),
      false,
    );
    expect(view.status).toBe("ready");
    expect(view.headline).toBe(
      '2 log types in "cribl_logs", highest volume first.',
    );
    expect(view.window).toEqual({ earliest: "-24h", latest: "now" });
    // Step two cannot be addressed without it, so it has to survive the
    // projection.
    expect(view.discriminatorField).toBe("sourcetype");
    expect(view.truncated).toBe(false);
  });

  it("carries TRUNCATED through, because a capped list reads as complete", () => {
    const view = deriveLakeQueryView(
      queryResult({
        discriminatorField: "sourcetype",
        truncated: true,
        logTypes: [{ logType: "TRAFFIC", eventCount: 1 }],
      }),
      false,
    );
    expect(view.truncated).toBe(true);
    expect(view.headline).toBe('1 log type in "cribl_logs", highest volume first.');
  });

  it("shows QUERYING even when a previous result is in hand", () => {
    // A stale list beside a live spinner is read as the answer to the query
    // now running.
    const view = deriveLakeQueryView(
      queryResult({ logTypes: [{ logType: "TRAFFIC", eventCount: 5 }] }),
      true,
    );
    expect(view.status).toBe("querying");
    expect(view.window).toBeNull();
  });
});

/**
 * The one condition the BUTTON and the HANDLER both ask.
 *
 * They were written twice and the button was left enabled over a handler that
 * silently returned (2026-08-20 audit) - a control that does nothing whatever
 * when pressed reads as a broken app. Now there is one function, and it has a
 * second rule to get right: a missing discriminator is addressable when the
 * DATASET is the log type and never otherwise, because the fetch it addresses
 * is unfiltered and returns the whole dataset.
 */
describe("canFetchLakeSamples", () => {
  const ready = deriveLakeQueryView(
    queryResult({
      discriminatorField: "sourcetype",
      logTypes: [{ logType: "TRAFFIC", eventCount: 5 }],
    }),
    false,
  );

  it("needs a selection, whatever the status", () => {
    expect(canFetchLakeSamples(ready, 0)).toBe(false);
    expect(canFetchLakeSamples(ready, 1)).toBe(true);
    expect(canFetchLakeSamples(deriveLakeQueryView(DATASET_AS_LOG_TYPE, false), 0)).toBe(
      false,
    );
  });

  it("refuses every status with nothing on offer", () => {
    for (const view of [
      deriveLakeQueryView(null, false),
      deriveLakeQueryView(null, true),
      deriveLakeQueryView(queryResult({ ok: false }), false),
      deriveLakeQueryView(queryResult(), false),
      deriveLakeQueryView(queryResult({ noDiscriminator: true }), false),
    ]) {
      expect(canFetchLakeSamples(view, 3)).toBe(false);
      expect(lakeOffersSamples(view)).toBe(false);
    }
  });

  it("refuses a READY list that carries no field to fetch by", () => {
    // Log types came back with nothing to filter them with. Allowing this would
    // run the unfiltered query once per row and store the whole dataset under
    // each of their names - log types the app never observed together.
    const fieldless = deriveLakeQueryView(
      queryResult({ logTypes: [{ logType: "TRAFFIC", eventCount: 5 }] }),
      false,
    );
    expect(fieldless.status).toBe("ready");
    expect(fieldless.datasetAsLogType).toBe(false);
    expect(canFetchLakeSamples(fieldless, 1)).toBe(false);
  });

  it("allows a MISSING field only when the dataset itself is the log type", () => {
    const single = deriveLakeQueryView(DATASET_AS_LOG_TYPE, false);
    expect(single.discriminatorField).toBeUndefined();
    expect(canFetchLakeSamples(single, 1)).toBe(true);
  });
});

/**
 * CHANGED 2026-08-26: the bounds are still the ones the query used, but they are
 * no longer printed as raw Kusto tokens.
 *
 * "-24h" and "now" are query-language literals, and this sentence is the ONE
 * thing that turns a bare count into a fact - so it was the least legible line
 * on the screen, with a leading "-" that reads as a minus sign rather than as
 * "ago". The previous pin asserted the tokens verbatim; it is replaced rather
 * than weakened, and the replacement adds the property that actually matters:
 * a bound this module cannot parse is passed through UNTRANSLATED, never guessed
 * at, because a phrase invented for it would state a window nobody queried.
 */
describe("windowLabel", () => {
  it("renders a relative-to-now window as the period it covers", () => {
    expect(windowLabel({ earliest: "-24h", latest: "now" })).toBe(
      "the last 24 hours",
    );
    expect(windowLabel({ earliest: "-7d", latest: "now" })).toBe(
      "the last 7 days",
    );
    // Singular, on the bound most likely to be typed by hand.
    expect(windowLabel({ earliest: "-1h", latest: "now" })).toBe(
      "the last hour",
    );
    expect(windowLabel({ earliest: "-1d", latest: "now" })).toBe("the last day");
  });

  it("renders a window that does NOT end at now as two bounds", () => {
    expect(windowLabel({ earliest: "-7d", latest: "-1d" })).toBe(
      "7 days ago to 1 day ago",
    );
    expect(windowLabel({ earliest: "-90m", latest: "-30m" })).toBe(
      "90 minutes ago to 30 minutes ago",
    );
  });

  it("passes an UNRECOGNISED bound through untouched, rather than guessing", () => {
    // An absolute timestamp, a token from a Kusto dialect this app does not
    // parse, an empty string. Printing the operator's own bound back is the only
    // honest answer; translating it would state a window that was never queried.
    expect(
      windowLabel({ earliest: "2026-08-01T00:00:00Z", latest: "now" }),
    ).toBe("2026-08-01T00:00:00Z to now");
    expect(windowLabel({ earliest: "-3fortnights", latest: "now" })).toBe(
      "-3fortnights to now",
    );
    // "-0h" is not a period, so it is not translated into one either.
    expect(windowLabel({ earliest: "-0h", latest: "now" })).toBe("-0h to now");
  });

  it("reads an empty latest bound as now, which is what Search does with it", () => {
    expect(windowLabel({ earliest: "-24h", latest: "" })).toBe(
      "the last 24 hours",
    );
  });
});

/**
 * THE PREVIEW, which exists because a Lake sample's bytes were invisible until
 * after they were stored (user report 2026-08-25).
 *
 * The failure it must not have is subtle and total: a preview that shows
 * anything other than what the commit writes is worse than no preview, because
 * the operator has now approved bytes they did not see. So these pins compare
 * the previewed text against the SAMPLE, not against a fixture.
 *
 * ONE EXCEPTION, and it is the right way round: where core UNWRAPS a transport
 * frame (a syslog-framed payload that JSON.parses, since 2026-08-25), the
 * preview still shows the bytes that arrived and the store holds the unwrapped
 * payload. The operator sees MORE than is stored, never something other than
 * what is stored - and seeing the frame is what they asked for. Pinned
 * explicitly below rather than left as a gap between two tests.
 */
describe("lakeSamplePreviews", () => {
  /**
   * The shape that caused the report: the vendor's own PAN-OS line arriving
   * inside a syslog transport frame. Whether core strips it is core's business
   * (rowRawText); what matters here is that whatever arrives is what is SHOWN.
   *
   * The payload is a POSITIONAL PAN-OS CSV line, which is what the comment
   * above always described. It used to be a JSON object, and that stopped being
   * a fair example on 2026-08-25 when core taught parseNdjson to strip a syslog
   * frame from a payload that JSON.parses: a self-describing payload is now
   * unwrapped on the way into the store, so it can no longer demonstrate an
   * envelope SURVIVING. A positional CSV line cannot describe itself, is stored
   * verbatim, and therefore still can - see the companion test below, which
   * pins the JSON case as the divergence it now genuinely is.
   */
  const WRAPPED =
    "<13>1 2026-08-25T16:35:36.206Z cribl-hw01 PAN-OS - CONFIG - " +
    "1,2021/10/25 20:25:39,,CONFIG,0,2021/10/25 20:25:44";

  /** The same frame around a payload that CAN describe itself. */
  const WRAPPED_JSON =
    "<13>1 2026-08-25T16:35:36.206Z cribl-hw01 PAN-OS - CONFIG - " +
    '{"type":"CONFIG","seq":0}';

  const fetched = (logType: string, rawEvents: string[]) => [
    { logType, rawEvents },
  ];

  it("previews the FETCHED bytes, verbatim, and only the first few", () => {
    const rawEvents = [
      '{"n":0}',
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
      '{"n":4}',
    ];
    const events = fetched("TRAFFIC", rawEvents);
    const previews = lakeSamplePreviews(
      events,
      plannedLakeSamples(events, "lake:cribl_logs"),
    );

    expect(previews).toHaveLength(1);
    expect(PREVIEW_LINES).toBe(3);
    // The exact lines, in order, unedited - not a count of them.
    expect(previews[0].preview).toEqual(['{"n":0}', '{"n":1}', '{"n":2}']);
    // The WHOLE haul is still reported: previewing 3 of 5 must not read as a
    // sample of 3, which would understate what the commit is about to store.
    expect(previews[0].eventCount).toBe(5);
  });

  it("shows the SAME TEXT the commit will store, envelope and all", () => {
    // The pin the whole feature rests on. A preview that reformatted, trimmed
    // or re-serialized would hide exactly the defect it exists to surface - the
    // operator would read a clean vendor line and store a wrapped one.
    const events = fetched("CONFIG", [WRAPPED]);
    const samples = plannedLakeSamples(events, "lake:cribl_logs");
    const previews = lakeSamplePreviews(events, samples);

    expect(samples).toHaveLength(1);
    expect(previews[0].preview).toEqual(samples[0].rawEvents);
    expect(previews[0].preview[0]).toBe(WRAPPED);
    // And it is legible AS an envelope: the operator can see the frame around
    // the payload, which is the whole reason they asked to look.
    expect(previews[0].preview[0]).toContain("cribl-hw01");
  });

  it("shows the frame even where the commit will UNWRAP it (JSON payload)", () => {
    // The one place the preview and the store legitimately differ, pinned here
    // so it is a decision on the record rather than a surprise found later.
    //
    // Since 2026-08-25 core strips a syslog frame from a payload that
    // JSON.parses, so a wrapped JSON line is stored as its OWN fields. The
    // preview still shows the bytes that ARRIVED, frame and all, and that is
    // the right way round: the operator asked to see the transport wrapper
    // precisely because it was invisible before, and showing less than arrived
    // would restore the original defect. They see more than is stored, never
    // something other than what is stored.
    const events = fetched("CONFIG", [WRAPPED_JSON]);
    const samples = plannedLakeSamples(events, "lake:cribl_logs");
    const previews = lakeSamplePreviews(events, samples);

    // Previewed: the wire bytes, envelope intact.
    expect(previews[0].preview[0]).toBe(WRAPPED_JSON);
    expect(previews[0].preview[0]).toContain("cribl-hw01");
    // Stored: the payload alone, unwrapped and re-serialized.
    expect(samples[0].format).toBe("ndjson");
    expect(samples[0].rawEvents).toEqual(['{"type":"CONFIG","seq":0}']);
    // The envelope fields are GONE, not merely reordered - if the RFC 5424
    // branch of stripSyslogPrefix regressed, "Priority"/"MsgID" would be back
    // as record keys and this is what would catch it.
    expect(Object.keys(samples[0].parsed.records[0])).toEqual(["type", "seq"]);
  });

  it("names the label these events would be STORED under, not just the row's", () => {
    // The row is Search's casing; the sample about to be overwritten is the
    // operator's. Both come from the same store fold the commit uses, so the
    // preview cannot promise a replacement the commit declines to make.
    const events = fetched("TRAFFIC", ['{"a":1}']);
    const samples = plannedLakeSamples(events, "lake:cribl_logs", ["traffic"]);
    const previews = lakeSamplePreviews(events, samples, ["traffic"]);

    expect(previews[0].logType).toBe("TRAFFIC");
    expect(previews[0].storeLabel).toBe("traffic");
    expect(previews[0].replacesExisting).toBe(true);
    expect(samples[0].logType).toBe("traffic");
    expect(previews[0].willBeAdded).toBe(true);
  });

  it("marks a row the commit will DROP, rather than leaving it to the summary", () => {
    // Blank lines parse to no record, so plannedLakeSamples refuses to store a
    // husk - and until now the operator learned that only from a shortfall
    // sentence after the fact, with the log-type list already gone.
    const events = [
      { logType: "GOOD", rawEvents: ['{"a":1}'] },
      { logType: "JUNK", rawEvents: ["   "] },
    ];
    const samples = plannedLakeSamples(events, "lake:cribl_logs");
    const previews = lakeSamplePreviews(events, samples);

    expect(samples.map((s) => s.logType)).toEqual(["GOOD"]);
    expect(previews.map((p) => p.logType)).toEqual(["GOOD", "JUNK"]);
    expect(previews.map((p) => p.willBeAdded)).toEqual([true, false]);
    // The dropped row is still SHOWN with its bytes: "this is what came back and
    // it is unusable" is the answer, not a row that quietly disappears.
    expect(previews[1].preview).toEqual(["   "]);
  });

  it("calls a MERGED pair added, because both really are", () => {
    // Two case variants folding onto the operator's one label cost one sample
    // and lose nothing. Marking the second "will not be added" would be the
    // pre-commit version of the shortfall lie mergedLakeLogTypeCount fixed.
    const events = [
      { logType: "TRAFFIC", rawEvents: ['{"n":"upper"}'] },
      { logType: "traffic", rawEvents: ['{"n":"lower"}'] },
    ];
    const samples = plannedLakeSamples(events, "lake:cribl_logs", ["Traffic"]);
    const previews = lakeSamplePreviews(events, samples, ["Traffic"]);

    expect(samples.map((s) => s.logType)).toEqual(["Traffic"]);
    expect(previews.map((p) => p.storeLabel)).toEqual(["Traffic", "Traffic"]);
    expect(previews.map((p) => p.willBeAdded)).toEqual([true, true]);
  });

  it("previews nothing for a haul that came back empty", () => {
    // No events, no rows - never a row with an empty body, which reads as "your
    // data looks like this" about data that never arrived.
    expect(lakeSamplePreviews([], [])).toEqual([]);
  });
});

describe("lakePreviewHeadline", () => {
  const previews = (counts: number[]) =>
    lakeSamplePreviews(
      counts.map((count, i) => ({
        logType: `T${i}`,
        rawEvents: Array.from({ length: count }, () => '{"a":1}'),
      })),
      [],
    );

  it("counts the whole haul and says nothing is stored yet", () => {
    expect(lakePreviewHeadline(previews([2, 1, 1]))).toBe(
      "Fetched 4 events in 3 log types. Nothing is added until you confirm.",
    );
    expect(lakePreviewHeadline(previews([1]))).toBe(
      "Fetched 1 event in 1 log type. Nothing is added until you confirm.",
    );
  });

  it("says NOTHING at all for an empty haul", () => {
    // The panel renders no preview block then, and deriveLakeCommitView owns
    // that sentence - two modules describing an empty haul is two chances to
    // confuse "nothing came back" with "nothing was usable".
    expect(lakePreviewHeadline([])).toBe("");
  });

  /**
   * FETCHED AND STORED NEVER RECONCILED (user report 2026-08-26).
   *
   * "Fetched 200 events in 4 log types", each row at "50 events", and the chips
   * that followed read 26, 19 and 17. The mechanism was investigated and the
   * obvious causes ruled out, so this does not fix a drop - it states both
   * numbers when they differ, so a recurrence reads as an accounting difference
   * on the screen that made the claim rather than as corruption two clicks later.
   */
  it("states the STORED total beside the fetched one when they differ", () => {
    // Four raw lines, of which one is a blank that parses to no record.
    const events = [
      {
        logType: "TRAFFIC",
        rawEvents: ['{"a":1}', '{"a":2}', '{"a":3}', "   "],
      },
    ];
    const samples = plannedLakeSamples(events, "lake:cribl_logs");
    const headline = lakePreviewHeadline(
      lakeSamplePreviews(events, samples),
      samples,
    );

    expect(samples[0].parsed.eventCount).toBe(3);
    expect(headline).toBe(
      "Fetched 4 events in 1 log type, which parse into 3 stored events. Nothing is added until you confirm.",
    );
  });

  it("says nothing extra when the two numbers AGREE", () => {
    // Restating one number twice on every haul is noise, and noise is what stops
    // the caveat being read on the haul that needs it.
    const events = [{ logType: "TRAFFIC", rawEvents: ['{"a":1}', '{"a":2}'] }];
    const samples = plannedLakeSamples(events, "lake:cribl_logs");

    expect(
      lakePreviewHeadline(lakeSamplePreviews(events, samples), samples),
    ).toBe("Fetched 2 events in 1 log type. Nothing is added until you confirm.");
  });

  it("counts a MERGED pair's stored events once, not once per row", () => {
    // Two picks folding onto the operator's label are ONE sample. Summing the
    // rows would count its events twice and invent a mismatch.
    const events = [
      { logType: "TRAFFIC", rawEvents: ['{"n":"upper"}'] },
      { logType: "traffic", rawEvents: ['{"n":"lower"}'] },
    ];
    const samples = plannedLakeSamples(events, "lake:cribl_logs", ["Traffic"]);
    const previews = lakeSamplePreviews(events, samples, ["Traffic"]);

    expect(samples).toHaveLength(1);
    // Two lines fetched, one sample of one event stored - and both numbers said.
    expect(lakePreviewHeadline(previews, samples)).toBe(
      "Fetched 2 events in 2 log types, which parse into 1 stored event. Nothing is added until you confirm.",
    );
    // The ROW-level figure goes absent for both, because neither row owns it.
    expect(previews.map((p) => p.storedEventCount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("carries the stored count on a row that owns it, and only when known", () => {
    const events = [
      { logType: "GOOD", rawEvents: ['{"a":1}', '{"a":2}', "   "] },
      { logType: "JUNK", rawEvents: ["   "] },
    ];
    const samples = plannedLakeSamples(events, "lake:cribl_logs");
    const previews = lakeSamplePreviews(events, samples);

    expect(previews[0].eventCount).toBe(3);
    expect(previews[0].storedEventCount).toBe(2);
    // JUNK produced no sample at all, so there is no stored count to state -
    // absent rather than zero, which would read as a measured emptiness.
    expect(previews[1].willBeAdded).toBe(false);
    expect("storedEventCount" in previews[1]).toBe(false);
  });

  it("leaves the headline unchanged for a caller with no samples in hand", () => {
    // The reconciliation is opt-in: a caller that cannot supply the stored side
    // gets the sentence it always got, rather than a total silently read as 0.
    expect(lakePreviewHeadline(previews([2, 1, 1]))).toBe(
      "Fetched 4 events in 3 log types. Nothing is added until you confirm.",
    );
  });
});

/**
 * WHAT THE HINT ABOVE THE LIST MAY CLAIM (2026-08-26 audit).
 *
 * "The highest-volume ones are pre-selected" was printed unconditionally, and it
 * is false in exactly the case lakeLogTypeChoices creates on purpose: when every
 * row would replace a sample the operator already has, nothing is ticked at all.
 */
describe("lakePreselectionHint", () => {
  it("says nothing is pre-selected when nothing is, and why", () => {
    const allProvided = lakeLogTypeChoices(
      [{ logType: "TRAFFIC" }, { logType: "THREAT" }],
      ["traffic", "threat"],
    );

    expect(selectedLakeLogTypes(allProvided)).toEqual([]);
    expect(lakePreselectionHint(allProvided)).toBe(
      "None are pre-selected: you already have a sample for every log type here, so taking one replaces yours.",
    );
    expect(lakePreselectionHint(allProvided)).not.toContain("are pre-selected;");
  });

  it("claims a pre-selection only when there was one to make", () => {
    const some = lakeLogTypeChoices(
      [{ logType: "TRAFFIC" }, { logType: "THREAT" }],
      ["traffic"],
    );

    expect(selectedLakeLogTypes(some)).toEqual(["THREAT"]);
    expect(lakePreselectionHint(some)).toBe(
      "The highest-volume ones you do not already have are pre-selected.",
    );
  });

  it("describes the list as it ARRIVED, not as it is ticked now", () => {
    // Derived from the live ticks it would rewrite itself under the operator,
    // and a hint that changes when you tick a box is not a hint about
    // pre-selection.
    const choices = lakeLogTypeChoices([
      { logType: "TRAFFIC" },
      { logType: "THREAT" },
    ]);
    const before = lakePreselectionHint(choices);
    const untickedAll = toggleLakeChoice(
      toggleLakeChoice(choices, "TRAFFIC"),
      "THREAT",
    );

    expect(selectedLakeLogTypes(untickedAll)).toEqual([]);
    expect(lakePreselectionHint(untickedAll)).toBe(before);
  });

  it("says nothing at all when there are no rows to describe", () => {
    expect(lakePreselectionHint([])).toBe("");
  });
});

describe("deriveLakeCommitView", () => {
  it("is silent before a fetch and busy during one", () => {
    expect(deriveLakeCommitView(null, false, 0, 0).status).toBe("idle");
    expect(deriveLakeCommitView(null, false, 0, 0).headline).toBe("");
    const busy = deriveLakeCommitView(null, true, 0, 0);
    expect(busy.status).toBe("fetching");
    expect(busy.notes).toEqual([]);
  });

  it("reports a FAILED fetch separately from events that parsed to nothing", () => {
    const failed = deriveLakeCommitView(
      fetchResult({ ok: false, notes: ['"TRAFFIC" could not be fetched'] }),
      false,
      0,
      1,
    );
    expect(failed.status).toBe("failed");
    expect(failed.headline).toContain("nothing was added");
    expect(failed.notes).toEqual(['"TRAFFIC" could not be fetched']);

    // Search answered and the events arrived; they just parsed to no records.
    // That is a data problem, not an access problem.
    const unusable = deriveLakeCommitView(
      fetchResult({ ok: true, events: [{ logType: "T", rawEvents: ["   "] }] }),
      false,
      0,
      1,
    );
    expect(unusable.status).toBe("unusable");
    expect(unusable.headline).toContain("none of them parsed");
  });

  it("tells NO EVENTS apart from events that parsed to nothing", () => {
    // A successful fetch that returned nothing at all was reported as "Events
    // came back, but none of them parsed into a usable sample" - a sentence
    // about events that do not exist. The two send the operator to opposite
    // places: a wider window or a different log type, versus a look at the shape
    // of data they do have.
    const none = deriveLakeCommitView(fetchResult({ events: [] }), false, 0, 2);
    const husks = deriveLakeCommitView(
      fetchResult({ events: [{ logType: "T", rawEvents: ["   "] }] }),
      false,
      0,
      1,
    );

    expect(none.status).toBe("no-events");
    expect(none.headline).toContain("returned no events");
    expect(none.headline).not.toContain("parsed");
    expect(husks.status).toBe("unusable");
    // Three distinct sentences for three distinct answers, and a failed read is
    // the third - none of them may collapse into another.
    const failed = deriveLakeCommitView(
      fetchResult({ ok: false }),
      false,
      0,
      1,
    );
    expect(new Set([none.headline, husks.headline, failed.headline]).size).toBe(
      3,
    );
  });

  it("keeps the platform's own notes on the no-events answer", () => {
    // fetchLakeLogTypeEvents names each log type that returned nothing. That is
    // the only per-log-type detail there is, and dropping it would leave the
    // operator with a summary and no idea which pick was empty.
    const view = deriveLakeCommitView(
      fetchResult({
        notes: ['"THREAT" returned no events in this window, so it was not added.'],
      }),
      false,
      0,
      1,
    );
    expect(view.status).toBe("no-events");
    expect(view.notes).toEqual([
      '"THREAT" returned no events in this window, so it was not added.',
    ]);
  });

  it("NAMES a partial haul rather than rounding it up to a success", () => {
    // fetchLakeLogTypeEvents keeps the good log types when one fails, so
    // "added 2" after ticking 3 is a success with a hole in it - invisible
    // unless the count the operator asked for is repeated back.
    const view = deriveLakeCommitView(
      fetchResult({ notes: ['"THREAT" returned no events in this window'] }),
      false,
      2,
      3,
    );
    expect(view.status).toBe("done");
    expect(view.headline).toBe(
      "Added 2 of the 3 log types you picked; the rest returned nothing usable.",
    );
    expect(view.notes).toEqual(['"THREAT" returned no events in this window']);
  });

  it("calls a COLLAPSE a collapse rather than data that never arrived", () => {
    // Two picks that resolve to ONE sample name cost one sample, and the
    // shortfall that leaves is not a hole in the data - the second was
    // OVERWRITTEN, not empty. Reporting it as "returned nothing usable" sends
    // the operator to widen a window over events sitting in the sample they
    // just added.
    const one = deriveLakeCommitView(fetchResult(), false, 1, 2, 1);
    expect(one.status).toBe("done");
    expect(one.headline).toBe(
      "Added 1 of the 2 log types you picked; 1 shares a sample name with another and was added as part of it.",
    );
    expect(one.headline).not.toContain("nothing usable");

    const two = deriveLakeCommitView(fetchResult(), false, 1, 3, 2);
    expect(two.headline).toBe(
      "Added 1 of the 3 log types you picked; 2 share a sample name with another and were added as part of it.",
    );
  });

  it("names BOTH causes when a haul lost picks to each", () => {
    // A merge and an empty log type in the same commit. Neither may be absorbed
    // into the other: one is nothing to act on, the other is.
    const view = deriveLakeCommitView(fetchResult(), false, 1, 3, 1);
    expect(view.headline).toBe(
      "Added 1 of the 3 log types you picked; 1 shares a sample name with another and was added as part of it, and 1 returned nothing usable.",
    );
  });

  it("reports a full haul plainly", () => {
    expect(deriveLakeCommitView(fetchResult(), false, 2, 2).headline).toBe(
      "Added 2 samples from this dataset.",
    );
    expect(deriveLakeCommitView(fetchResult(), false, 1, 1).headline).toBe(
      "Added 1 sample from this dataset.",
    );
  });

  /**
   * A PARTIAL FETCH THAT STORED SAMPLES AND SAID NOTHING WAS ADDED (2026-08-26).
   *
   * Core's `ok` is `failed === 0` - false when ANY log type failed, not when all
   * did. This projection tested `ok` before it looked at what had been stored, so
   * ticking five log types and losing one produced four samples in the store
   * under the headline "No events could be fetched for the log types you picked,
   * so nothing was added", with the four new chips directly below it. Every pin
   * that existed for `ok: false` passed `plannedCount: 0`, which is exactly why
   * it never surfaced - so these pass a plannedCount that is not zero.
   */
  it("reports what a PARTIALLY FAILED fetch actually stored", () => {
    const view = deriveLakeCommitView(
      fetchResult({
        ok: false,
        events: [
          { logType: "A", rawEvents: ['{"a":1}'] },
          { logType: "B", rawEvents: ['{"b":1}'] },
          { logType: "C", rawEvents: ['{"c":1}'] },
          { logType: "D", rawEvents: ['{"d":1}'] },
        ],
        notes: ['"THREAT" could not be fetched: HTTP 400.'],
      }),
      false,
      4,
      5,
    );

    // NOT "failed", which is what four stored samples were reported as.
    expect(view.status).toBe("partial");
    expect(view.headline).toBe(
      "Added 4 samples from the 5 log types you picked. 1 of them could not be fetched, or returned nothing usable - the notes below name which.",
    );
    // The sentence that was printed over four new chips must not survive
    // anywhere in this answer.
    expect(view.headline).not.toContain("nothing was added");
    expect(view.notes).toEqual(['"THREAT" could not be fetched: HTTP 400.']);
  });

  it("keeps a PARTIAL fetch and a TOTAL failure as different answers", () => {
    // Same `ok: false` on both sides; what separates them is whether anything
    // reached the store. Folding them is the defect this block exists for.
    const partial = deriveLakeCommitView(
      fetchResult({ ok: false, events: [{ logType: "A", rawEvents: ["x"] }] }),
      false,
      1,
      2,
    );
    const total = deriveLakeCommitView(fetchResult({ ok: false }), false, 0, 2);

    expect(partial.status).toBe("partial");
    expect(total.status).toBe("failed");
    expect(partial.headline).not.toBe(total.headline);
    expect(partial.headline).toContain("Added 1 sample");
    expect(total.headline).toContain("nothing was added");
  });

  it("names a MERGE exactly and the rest only as far as it is known", () => {
    // The merged count IS measured, so it is stated as a number. The rest of the
    // shortfall is a mix of failed fetches and unusable events that `ok: false`
    // does not break down - core reports that per log type in `notes` and nowhere
    // else - so it is named as both causes rather than attributed to one.
    const view = deriveLakeCommitView(
      fetchResult({ ok: false, events: [{ logType: "A", rawEvents: ["x"] }] }),
      false,
      1,
      4,
      1,
    );

    expect(view.headline).toBe(
      "Added 1 sample from the 4 log types you picked. 1 shares a sample name with another and was added as part of it. 2 of them could not be fetched, or returned nothing usable - the notes below name which.",
    );
  });

  it("still names the failure when the merge accounts for the whole shortfall", () => {
    // plannedCount + merged === requestedCount, so there is no remainder to
    // attribute - and a haul that says only "1 was added as part of another"
    // would have hidden a failed log type entirely.
    const view = deriveLakeCommitView(
      fetchResult({ ok: false, events: [{ logType: "A", rawEvents: ["x"] }] }),
      false,
      1,
      2,
      1,
    );

    expect(view.status).toBe("partial");
    expect(view.headline).toContain("added as part of it");
    expect(view.headline).toContain("Some could not be fetched");
  });

  it("still says nothing was added when a partial failure stored NOTHING", () => {
    // The other side of reading the store first: some log types failed and the
    // ones that answered parsed to no records. Nothing reached the store, so
    // this is not a partial success - and the notes still name each failure.
    const view = deriveLakeCommitView(
      fetchResult({
        ok: false,
        events: [{ logType: "A", rawEvents: ["   "] }],
        notes: ['"B" could not be fetched.'],
      }),
      false,
      0,
      2,
    );

    expect(view.status).toBe("unusable");
    expect(view.headline).toContain("nothing was added");
    expect(view.notes).toEqual(['"B" could not be fetched.']);
  });

  /**
   * A REJECTED STORE WRITE, which rendered as NOTHING AT ALL (2026-08-26).
   *
   * The commit awaited `onCommit` with no catch, so a store that refused left
   * the button enabled and changed nothing else - no outcome, no error, the
   * preview still sitting there. That is the empty-versus-failed collapse in a
   * third direction: failure shown as absence.
   */
  it("names a REFUSED store write, and says the events are still there", () => {
    const view = deriveLakeCommitView(
      null,
      false,
      0,
      3,
      0,
      "KV store quota exceeded",
    );

    expect(view.status).toBe("store-failed");
    expect(view.headline).toBe(
      'The samples could not be saved: KV store quota exceeded. The fetched events are still here - press "Add as samples" to try again.',
    );
    // It must NOT claim how much landed: a rejected write does not report where
    // it stopped, and "nothing was added" would be a guess.
    expect(view.headline).not.toContain("nothing was added");
  });

  it("keeps a refused WRITE apart from a failed FETCH", () => {
    // They send the operator to opposite halves of the app - the store, versus
    // Cribl Search - and both used to be silent or mislabelled.
    const write = deriveLakeCommitView(null, false, 0, 1, 0, "disk full");
    const fetch = deriveLakeCommitView(fetchResult({ ok: false }), false, 0, 1);

    expect(write.status).toBe("store-failed");
    expect(fetch.status).toBe("failed");
    expect(write.headline).not.toBe(fetch.headline);
  });

  it("lets a store failure win over a stale outcome, and a fetch over both", () => {
    // Ordering, which decides what an operator reads when two things are true at
    // once. A live request outranks any report; a refused write outranks the
    // report of the commit before it, because it is the thing that just happened.
    expect(
      deriveLakeCommitView(fetchResult(), true, 2, 2, 0, "disk full").status,
    ).toBe("fetching");
    expect(
      deriveLakeCommitView(fetchResult(), false, 2, 2, 0, "disk full").status,
    ).toBe("store-failed");
  });
});

describe("plannedLakeSamples", () => {
  it("re-tags through the SAME content-first parse an upload uses", () => {
    // What makes a Lake sample and an uploaded one indistinguishable
    // downstream: the format is detected from the raw lines, never taken on
    // trust from whatever produced them.
    const samples = plannedLakeSamples(
      [
        {
          logType: "TRAFFIC",
          rawEvents: [
            "CEF:0|Palo Alto|PAN-OS|10.2|end|TRAFFIC|3|src=10.0.0.1",
          ],
        },
      ],
      "lake:cribl_logs",
    );
    expect(samples).toHaveLength(1);
    expect(samples[0].logType).toBe("TRAFFIC");
    expect(samples[0].format).toBe("cef");
    expect(samples[0].rawEvents[0]).toContain("CEF:0|");
  });

  it("drops a log type whose lines parse to ZERO records", () => {
    // A sample with a name and no fields is worse than none: it satisfies the
    // "samples provided" check while giving the mapping nothing to work with.
    const samples = plannedLakeSamples(
      [
        { logType: "JUNK", rawEvents: ["   "] },
        { logType: "GOOD", rawEvents: ['{"a":1}'] },
      ],
      "lake:cribl_logs",
    );
    expect(samples.map((s) => s.logType)).toEqual(["GOOD"]);
    expect(samples.every((s) => s.parsed.records.length > 0)).toBe(true);
  });

  it("drops a log type that returned no lines at all", () => {
    expect(
      plannedLakeSamples([{ logType: "EMPTY", rawEvents: [] }], "lake:x"),
    ).toEqual([]);
  });

  it("ADOPTS the operator's casing so the promised replacement really happens", () => {
    // The store keys case-SENSITIVELY. Taking Search's "TRAFFIC" after the
    // operator uploaded "traffic" would APPEND a second sample while the panel
    // had just promised to replace the first - and the pack builds a route pair
    // per unique log type, so it would silently gain an overlapping pair where
    // only the first receives events.
    const samples = plannedLakeSamples(
      [{ logType: "TRAFFIC", rawEvents: ['{"a":1}'] }],
      "lake:cribl_logs",
      ["traffic"],
    );
    expect(samples[0].logType).toBe("traffic");
  });

  it("keeps Search's label when nothing existing matches", () => {
    const samples = plannedLakeSamples(
      [{ logType: "TRAFFIC", rawEvents: ['{"a":1}'] }],
      "lake:cribl_logs",
      ["threat"],
    );
    expect(samples[0].logType).toBe("TRAFFIC");
  });

  it("folds a CASE VARIANT onto the operator's label, which is a collapse", () => {
    // The shape mergedLakeLogTypeCount exists to account for: a dataset holding
    // both casings while the operator already has one of them. Two picks, one
    // sample - and the second one is overwritten rather than missing.
    const samples = plannedLakeSamples(
      [
        { logType: "TRAFFIC", rawEvents: ['{"n":"upper"}'] },
        { logType: "traffic", rawEvents: ['{"n":"lower"}'] },
      ],
      "lake:cribl_logs",
      ["traffic"],
    );
    expect(samples.map((s) => s.logType)).toEqual(["traffic"]);
    expect(samples[0].parsed.records[0].n).toBe("lower");
  });

  it("collapses duplicate log types, last wins, first position kept", () => {
    // Mirrors the store's own replace-by-logType semantics, so one commit
    // cannot produce two chips with the same name.
    const samples = plannedLakeSamples(
      [
        { logType: "A", rawEvents: ['{"n":"first"}'] },
        { logType: "B", rawEvents: ['{"n":"other"}'] },
        { logType: "A", rawEvents: ['{"n":"second"}'] },
      ],
      "lake:cribl_logs",
    );
    expect(samples.map((s) => s.logType)).toEqual(["A", "B"]);
    expect(samples[0].parsed.records[0].n).toBe("second");
  });
});

describe("mergedLakeLogTypeCount", () => {
  const both = (existing: string[]) =>
    plannedLakeSamples(
      [
        { logType: "TRAFFIC", rawEvents: ['{"n":"upper"}'] },
        { logType: "traffic", rawEvents: ['{"n":"lower"}'] },
      ],
      "lake:cribl_logs",
      existing,
    );

  it("counts the EXTRA pick, not the group - two picks cost one sample", () => {
    const samples = both(["traffic"]);
    expect(samples).toHaveLength(1);
    expect(mergedLakeLogTypeCount(["TRAFFIC", "traffic"], samples, ["traffic"])).toBe(1);
  });

  it("counts nothing when the case variants stay two separate samples", () => {
    // With no existing label to adopt, neither pick is folded anywhere: the
    // store keeps both casings, and calling that a merge would explain away a
    // shortfall that never happened.
    const samples = both([]);
    expect(samples.map((s) => s.logType)).toEqual(["TRAFFIC", "traffic"]);
    expect(mergedLakeLogTypeCount(["TRAFFIC", "traffic"], samples)).toBe(0);
  });

  it("counts nothing when the shared label produced NO sample at all", () => {
    // Both picks returned blank lines, so both genuinely returned nothing
    // usable. Calling one of them "added as part of" a sample that does not
    // exist is the same lie as the one this count exists to stop, pointed the
    // other way.
    const samples = plannedLakeSamples(
      [
        { logType: "TRAFFIC", rawEvents: ["   "] },
        { logType: "traffic", rawEvents: ["   "] },
      ],
      "lake:cribl_logs",
      ["traffic"],
    );
    expect(samples).toEqual([]);
    expect(mergedLakeLogTypeCount(["TRAFFIC", "traffic"], samples, ["traffic"])).toBe(0);
  });

  it("counts nothing for a pick whose fetch brought back NOTHING", () => {
    // The case-variant pair again, but this time only one of them returned
    // events - the other 400'd, and core kept the good one (partial success is
    // success). Without the fetched list the failed pick was counted as "added
    // as part of" its sibling's sample: a claim that its events are sitting in a
    // sample they never reached, printed over a shortfall the operator should
    // act on.
    const samples = plannedLakeSamples(
      [{ logType: "traffic", rawEvents: ['{"n":"lower"}'] }],
      "lake:cribl_logs",
      ["traffic"],
    );

    expect(samples).toHaveLength(1);
    expect(
      mergedLakeLogTypeCount(["TRAFFIC", "traffic"], samples, ["traffic"], [
        "traffic",
      ]),
    ).toBe(0);
    // And when BOTH came back, it is a merge again - the fetched list narrows
    // the count, it does not disable it.
    expect(
      mergedLakeLogTypeCount(["TRAFFIC", "traffic"], both(["traffic"]), ["traffic"], [
        "TRAFFIC",
        "traffic",
      ]),
    ).toBe(1);
  });

  it("counts nothing for picks that each became their own sample", () => {
    const samples = plannedLakeSamples(
      [
        { logType: "TRAFFIC", rawEvents: ['{"a":1}'] },
        { logType: "THREAT", rawEvents: ['{"a":2}'] },
      ],
      "lake:cribl_logs",
    );
    expect(mergedLakeLogTypeCount(["TRAFFIC", "THREAT"], samples)).toBe(0);
  });
});
