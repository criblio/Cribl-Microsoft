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
 *     sample, which sends them to widen a window over data they already have.
 */

import { describe, expect, it } from "vitest";
import type {
  FetchLakeEventsResult,
  QueryLakeSamplesResult,
} from "@soc/core";
import {
  DEFAULT_PRESELECTED,
  deriveLakeCommitView,
  deriveLakeQueryView,
  lakeCollisions,
  lakeLogTypeChoices,
  mergedLakeLogTypeCount,
  plannedLakeSamples,
  selectedLakeLogTypes,
  toggleLakeChoice,
  windowLabel,
} from "./lake-panel-state";

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
    expect(empty.headline).toContain("-24h");
    expect(empty.headline).toContain("now");
    expect(empty.notes).toEqual(["holds no events"]);
  });

  it("gives NO DISCRIMINATOR its own status, not empty", () => {
    // A dataset full of events that nothing distinguishes is not an idle
    // dataset, and telling the operator it is would send them to widen a window
    // that is already wide enough.
    const view = deriveLakeQueryView(
      queryResult({ noDiscriminator: true, notes: ["no field distinguishes"] }),
      false,
    );
    expect(view.status).toBe("no-discriminator");
    expect(view.headline).toContain("tells one log type from another");
    expect(view.notes).toEqual(["no field distinguishes"]);
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

describe("windowLabel", () => {
  it("renders the relative bounds the query actually used", () => {
    expect(windowLabel({ earliest: "-24h", latest: "now" })).toBe("-24h to now");
    expect(windowLabel({ earliest: "-7d", latest: "-1d" })).toBe("-7d to -1d");
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
