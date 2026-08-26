/**
 * Pins for query-lake-samples (plan Phase 4, ADR 0003).
 *
 * FIVE CLASSES OF FAILURE guarded here, and the first two are asserted on the
 * REQUEST rather than the result, because a wrong path or a wrong group answers
 * 404 and 404 degrades into an EMPTY LOG-TYPE LIST - which the operator reads as
 * a fact about their data rather than a bug in us.
 *
 *   ADDRESSING   /search/* is group-scoped under the SEARCH group, verified live
 *                2026-08-19 off Cribl's own UI traffic. The spec declares these
 *                paths bare and cannot settle it.
 *   THE QUERIES  KQL, not SPL, and TWO of them: a sample that answers WHICH
 *                FIELD, then a summarize that answers WHAT VALUES. A third
 *                fetches events for one chosen value, and must be able to fetch
 *                every value the second one LISTED - see the round-trip block.
 *   THE ROUTE    ONE job per query, and no second create anywhere. The sync
 *                `GET /search/query` was deleted 2026-08-25 once live probing
 *                showed it creates a job of its own - see the orphan block.
 *   THE SHAPES   what the LIVE API actually answers with, which for the job
 *                status is not what the spec's own example shows - see
 *                {@link jobStatus} and the status-envelope block.
 *   EMPTY vs FAILED  never collapsed, in either direction.
 *
 * A SIXTH since 2026-08-25: EMPTY vs SINGLE-LOG-TYPE. A dataset nothing splits
 * is now OFFERED under its own name with a measured volume rather than sent
 * away, and the one thing that must never happen is the two collapsing back
 * into each other - an empty window has nothing to offer and nothing to name,
 * while a populated one has both. Pinned side by side in "a dataset with events
 * but no discriminator is offered as ONE log type".
 */

import { describe, expect, it } from "vitest";

import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeLogger } from "../../testing/fake-logger";
import type { PortHttpResponse } from "../../ports/http";
import {
  COUNT_COLUMN,
  DEFAULT_EARLIEST,
  DEFAULT_LATEST,
  DEFAULT_MAX_LOG_TYPES,
  DEFAULT_SAMPLE_LIMIT,
  DISCRIMINATOR_SAMPLE_LIMIT,
  JOB_POLL_ATTEMPTS,
  JOB_POLL_INTERVAL_MS,
  MAX_SAMPLE_LIMIT,
  buildDiscriminatorSampleQuery,
  buildLogTypeCountQuery,
  buildLogTypeEventQuery,
  fetchLakeLogTypeEvents,
  queryLakeSamples,
  searchResultRows,
} from "./query-lake-samples";

const GROUP = "default_search";
const DATASET = "LogSources";

/** The SearchJobResults envelope line both result routes emit first. */
const META = {
  isFinished: true,
  job: { id: "j-1" },
  offset: 0,
  persistedEventCount: 2,
  totalEventCount: 2,
};

/** The documented shape: NDJSON, metadata line then one row per line. */
const ndjson = (rows: unknown[]): string =>
  [META, ...rows].map((row) => JSON.stringify(row)).join("\n");

const ok = (body: unknown): PortHttpResponse => ({ status: 200, body });

/**
 * A job-status response IN THE SHAPE THE LIVE API ANSWERS WITH, and the default
 * every status response in this file is scripted with.
 *
 * `GET /search/jobs/{id}/status?advanced=true` replies in the same
 * `{items:[...], count}` envelope the create call uses - confirmed live
 * 2026-08-24, body keys exactly `["items","count"]`, the status at
 * `items[0].status`. The OpenAPI spec says otherwise: its own
 * SearchJobStatusResponseExamplesRunning example is the FLATTENED
 * `{status:"running", timeCreated, ...}`, which is why the bare read is kept as
 * a fallback and pinned below rather than deleted.
 *
 * THE DEFECT THIS SHAPE EXISTS TO CATCH (found live 2026-08-24): the poll read
 * the top level only, so it found nothing on every attempt, held the status at
 * "", burned all JOB_POLL_ATTEMPTS and reported a job that was `completed` on
 * the FIRST poll as "still pending". Every Lake query failed, on every dataset -
 * and this suite stayed green the whole time, because every status response
 * here was scripted as a bare `{status}` no live workspace has ever sent.
 *
 * FakeCriblClient is deliberately NOT where this default lives. It is a FIFO
 * response queue with no knowledge of search jobs, and teaching it to synthesize
 * a status body for a path it recognized would make it a Cribl simulator rather
 * than a queue - the same reason `outputsList` is the single narrow exception
 * there. The shape belongs where the responses are scripted, which is here, and
 * a helper is enough to stop it drifting back.
 */
const jobStatus = (state: string): PortHttpResponse =>
  ok({ items: [{ status: state }], count: 1 });

/** Two log types, discriminated by a plain `type` field Search can group by. */
const SAMPLE_ROWS = [
  { type: "TRAFFIC", _raw: "1,2026/08/13,fw01,TRAFFIC,end" },
  { type: "THREAT", _raw: "1,2026/08/13,fw01,THREAT,vuln" },
];
const COUNT_ROWS = [
  { type: "THREAT", [COUNT_COLUMN]: 12 },
  { type: "TRAFFIC", [COUNT_COLUMN]: 890000 },
];

/**
 * The mean bytes/event step one MEASURES for each SAMPLE_ROWS log type (plan
 * Phase 5, last item).
 *
 * Both `_raw` values are 29 characters and there is exactly one event of each,
 * so each log type's mean is its own single event's length. Spelled out rather
 * than computed from the fixture, so editing either `_raw` has to be noticed
 * here instead of silently re-baselining every count assertion below.
 */
const SAMPLED_MEAN = 29;

function client(...responses: PortHttpResponse[]): FakeCriblClient {
  const cribl = new FakeCriblClient();
  cribl.respondWith(...responses);
  return cribl;
}

/**
 * ONE query's worth of responses: create, a single completed poll, one results
 * page. Three, because that is what one query now costs - the FIFO fake serves
 * them in order and throws on a fourth, so a fixture built from this helper
 * fails loudly if the code under test ever creates a second job for one query.
 *
 * Every fixture below was a ONE-response `ok(ndjson(...))` until 2026-08-25,
 * served by the sync route that has since been deleted. They were reshaped onto
 * the job path rather than dropped: the pins are about the RESULT - the counts,
 * the empty-vs-failed split, the numeric round trip - and none of that changed.
 */
const jobRun = (jobId: string, body: unknown): PortHttpResponse[] => [
  ok({ count: 1, items: [{ id: jobId }] }),
  jobStatus("completed"),
  ok(body),
];

/** The path every lifecycle walks, for one query's job id. */
const lifecycleOf = (jobId: string): string[] => [
  "POST /search/jobs",
  `GET /search/jobs/${jobId}/status`,
  `GET /search/jobs/${jobId}/results`,
];

/** The happy path: the sample query, then the summarize, one job each. */
function countingClient(): FakeCriblClient {
  return client(
    ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
    ...jobRun("j-2", ndjson(COUNT_ROWS)),
  );
}

/** How many search jobs a run created. The orphan pins turn on this. */
const jobsCreated = (cribl: FakeCriblClient): number =>
  cribl.calls.filter((c) => c.method === "POST" && c.path === "/search/jobs")
    .length;

const run = (cribl: FakeCriblClient, extra = {}) =>
  queryLakeSamples(cribl, { searchGroupId: GROUP, datasetId: DATASET, ...extra });

describe("the sample is the EVENT, not the transport envelope it arrived in", () => {
  // Live 2026-08-25: a Cribl syslog source leaves the vendor's bytes in
  // `message` and keeps the whole received frame in `_raw`. Taking `_raw` gave
  // the operator a 60-character RFC5424 header glued to the front of every
  // PAN-OS event - and because PAN-OS is POSITIONAL CSV, that shifted every
  // column. Of five log types from ONE dataset, CONFIG and USERID came back as
  // SYSLOG with nine envelope fields and no PAN-OS fields at all, while
  // TRAFFIC/THREAT/SYSTEM came back with 73/38/13 real ones.
  const lakeRow = (raw: string, message?: string): Record<string, unknown> =>
    message === undefined ? { _raw: raw } : { _raw: raw, message };

  const ENVELOPE = "<13>1 2026-08-25T16:35:36.206Z cribl-hw01 PAN-OS - CONFIG - ";
  const PAYLOAD = "1,2013/03/25 23:59:02,1606001116,CONFIG,0,0,2012/02/25 00:53:22";

  it("takes the payload when _raw provably ENDS WITH it", async () => {
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      jobStatus("completed"),
      ok(ndjson([lakeRow(ENVELOPE + PAYLOAD, PAYLOAD)])),
    );
    const out = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "msgid",
      logTypes: ["CONFIG"],
    });
    expect(out.ok).toBe(true);
    expect(out.events).toHaveLength(1);
    // The envelope is GONE, and the payload is byte-identical - not trimmed,
    // not re-serialized.
    expect(out.events[0].rawEvents).toEqual([PAYLOAD]);
    expect(out.events[0].rawEvents[0].startsWith("<13>")).toBe(false);
  });

  it("KEEPS _raw when message is not its tail - the test is proof, not a guess", async () => {
    // A source whose `message` is something else entirely. Stripping here would
    // discard the event and keep a fragment, so the rule must decline.
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      jobStatus("completed"),
      ok(ndjson([lakeRow(ENVELOPE + PAYLOAD, "an unrelated summary field")])),
    );
    const out = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "msgid",
      logTypes: ["CONFIG"],
    });
    expect(out.events[0].rawEvents).toEqual([ENVELOPE + PAYLOAD]);
  });

  it("KEEPS _raw when there is no message field at all", async () => {
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      jobStatus("completed"),
      ok(ndjson([lakeRow(PAYLOAD)])),
    );
    const out = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "msgid",
      logTypes: ["CONFIG"],
    });
    expect(out.events[0].rawEvents).toEqual([PAYLOAD]);
  });

  it("KEEPS _raw when message EQUALS it - stripping would empty the event", async () => {
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      jobStatus("completed"),
      ok(ndjson([lakeRow(PAYLOAD, PAYLOAD)])),
    );
    const out = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "msgid",
      logTypes: ["CONFIG"],
    });
    expect(out.events[0].rawEvents).toEqual([PAYLOAD]);
  });
});

describe("step one's sample size is a CORRECTNESS setting, not a performance one", () => {
  it("reads enough events that a skewed dataset still shows its minority log type", () => {
    // Detection needs >= 2 distinct values IN THE SAMPLE. Real datasets are
    // skewed, so too small a sample misses the minority value entirely and the
    // app then tells the operator their data has no log types when it has two.
    //
    // Measured live 2026-08-25 on winevt_plwindows: 766,570 DNS events to
    // 22,792 Security, i.e. 97.1% one value. At the old limit of 50 the chance
    // of drawing zero Security events is 0.971^50 = 23%, and BOTH outcomes were
    // observed on that dataset within one session - two runs found both
    // channels, two found one and reported "no discriminator".
    expect(DISCRIMINATOR_SAMPLE_LIMIT).toBe(500);
    const missChance = (n: number): number => Math.pow(0.971, n);
    expect(missChance(50)).toBeGreaterThan(0.2);
    expect(missChance(DISCRIMINATOR_SAMPLE_LIMIT)).toBeLessThan(1e-6);
  });

  it("does NOT enlarge a log-type FETCH, which is a different question", () => {
    // One constant used to serve both. Raising it wholesale would pull 500
    // events per selected log type: the fetch is about how much sample data to
    // hand the operator, step one is about whether the field can be found.
    expect(DEFAULT_SAMPLE_LIMIT).toBe(50);
    expect(DISCRIMINATOR_SAMPLE_LIMIT).toBeGreaterThan(DEFAULT_SAMPLE_LIMIT);
  });
});

describe("addressing - /search/* is GROUP-scoped under the SEARCH group", () => {
  it("POSTs /search/jobs in the search group's context", async () => {
    const cribl = countingClient();

    await run(cribl);

    const call = cribl.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/search/jobs");
    // The adapter renders this as /m/default_search/search/jobs. A leader-level
    // call (groupId undefined) is the failure this pin exists for.
    expect(call.groupId).toBe(GROUP);
    // And not only the create: a poll or a results page addressed at the leader
    // 404s just as invisibly.
    expect(cribl.calls.every((c) => c.groupId === GROUP)).toBe(true);
  });

  it("carries the query and window in the create BODY, the page bounds on the results GET", async () => {
    // The window travels in the body because a job is created with it; only the
    // results page is paginated, and it is a different call from the create.
    const cribl = countingClient();

    await run(cribl);

    expect(cribl.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | limit ${DISCRIMINATOR_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(cribl.calls[2].path).toBe("/search/jobs/j-1/results");
    expect(cribl.calls[2].query).toEqual({
      offset: "0",
      // The results page must be big enough to read BACK everything step one
      // asked for, so this tracks the sample size rather than the fetch size.
      limit: String(DISCRIMINATOR_SAMPLE_LIMIT),
    });
  });

  it("refuses to query at all with no SEARCH group, rather than 404ing", async () => {
    // A blank group id would address the leader, 404, and read as an empty
    // dataset. Nothing is sent.
    const cribl = new FakeCriblClient();

    const result = await queryLakeSamples(cribl, {
      searchGroupId: "",
      datasetId: DATASET,
    });

    expect(cribl.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("No Cribl Search group");
  });

  it("refuses to query with no dataset selected", async () => {
    const cribl = new FakeCriblClient();
    const result = await queryLakeSamples(cribl, {
      searchGroupId: GROUP,
      datasetId: "  ",
    });
    expect(cribl.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
  });
});

describe("the two queries - KQL, and the split the plan mandates", () => {
  it("asks for a small sample first, then summarizes the field it found", async () => {
    // "Capture answers which field; Search answers what values." The second
    // query must group by the field the FIRST one's rows established.
    const cribl = countingClient();

    const result = await queryLakeSamples(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
    });

    const created = cribl.calls.filter((c) => c.path === "/search/jobs");
    expect(created).toHaveLength(2);
    expect(created[0].body).toEqual({
      query: `dataset="${DATASET}" | limit ${DISCRIMINATOR_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(created[1].body).toEqual({
      query:
        `dataset="${DATASET}" | summarize ${COUNT_COLUMN}=count() by type` +
        ` | sort by ${COUNT_COLUMN} desc | limit ${DEFAULT_MAX_LOG_TYPES}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(result.discriminatorField).toBe("type");
  });

  it("sorts BEFORE limiting, so truncation drops the rarest, not the biggest", () => {
    const query = buildLogTypeCountQuery("ds", "subtype", 25);
    expect(query.indexOf("sort by")).toBeLessThan(query.indexOf("limit"));
    expect(query).toContain(`sort by ${COUNT_COLUMN} desc`);
  });

  it("escapes a quote in the dataset id instead of silently re-targeting", () => {
    // An unescaped quote changes WHICH dataset is read rather than failing.
    expect(buildDiscriminatorSampleQuery('od"d', 10)).toBe(
      'dataset="od\\"d" | limit 10',
    );
  });

  it("clamps the bounds and SAYS it did", async () => {
    const cribl = countingClient();

    const result = await run(cribl, { sampleLimit: 999999 });

    // The clamp has to reach BOTH places the bound is spent: the KQL the job is
    // created with, and the results page it is read back through.
    expect(cribl.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | limit ${MAX_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(cribl.calls[2].query?.limit).toBe(String(MAX_SAMPLE_LIMIT));
    expect(result.notes.join(" ")).toContain(String(MAX_SAMPLE_LIMIT));
  });
});

describe("the discriminator must be a field SEARCH can group by", () => {
  it("never asks the engine to group by a field it cannot see", async () => {
    // Selecting over a LOCALLY parsed _raw would hand step two a field the
    // engine cannot see; the summarize would return nothing, which reads as
    // "this dataset holds no log types". So step two's `by` clause is only ever
    // written from a field the SAMPLE ROWS carried.
    const cribl = client(
      ...jobRun("j-1", ndjson([{ _raw: "1,2026,fw,TRAFFIC,end" }])),
      ...jobRun("j-2", ndjson([{ [COUNT_COLUMN]: 1216 }])),
    );

    const result = await run(cribl);

    expect(result.discriminatorField).toBeUndefined();
    const created = cribl.calls.filter((c) => c.path === "/search/jobs");
    expect(created).toHaveLength(2);
    // "TRAFFIC" is sitting in that _raw. Nothing may group by it.
    expect(JSON.stringify(created[1].body)).not.toContain("TRAFFIC");
    expect(JSON.stringify(created[1].body)).not.toContain(" by ");
  });
});

/**
 * A DATASET THAT HOLDS ONE LOG TYPE IS AN ANSWER, NOT A DEAD END (2026-08-25).
 *
 * Measured live: of 31 lake datasets 24 were empty over -24h, and of the
 * populated ones exactly ONE yielded a discriminator. `winevt_dcronly` (1,216
 * events, one Windows channel) and `azure_alerts_validation` (265) are
 * single-log-type BY DESIGN - the data is split per dataset, which is how a lake
 * is organised. The app answered every one of them with "capture a sample and
 * name the log type yourself", sending the operator to a different acquisition
 * mode for data already in their lake.
 *
 * TWO THINGS ARE PINNED TOGETHER HERE and they are the whole feature:
 *
 *   THE OFFER    the dataset becomes ONE log type with a real volume, so the
 *                operator can take a sample from it.
 *   THE NAMING   that log type is the DATASET'S name and says so. This app does
 *                not get to claim a vendor log type it never observed, which is
 *                why `datasetAsLogType` is a flag rather than something a caller
 *                is left to infer from a string.
 *
 * And EMPTY is pinned right beside it, because the two used to be the same dead
 * end on screen: an empty window offers NOTHING and names NOTHING.
 */
describe("a dataset with events but no discriminator is offered as ONE log type", () => {
  /** One _raw-only row: real events, and nothing to group them by. */
  const UNSPLITTABLE = [{ _raw: "1,2026,fw,TRAFFIC,end" }];
  /**
   * The mean this path measures: `_raw` is 21 characters and it is the only
   * sampled row (plan Phase 5).
   *
   * A DATASET-WIDE MEAN IS THE RIGHT ONE HERE, uniquely. Everywhere else a mean
   * must come from the log type's own events, but having no discriminator is
   * exactly the statement that every sampled event belongs to this one log type
   * - so the whole sample IS its sample.
   */
  const UNSPLITTABLE_MEAN = 21;

  it("counts the whole dataset with an UNGROUPED summarize and offers it", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(UNSPLITTABLE)),
      ...jobRun("j-2", ndjson([{ [COUNT_COLUMN]: 1216 }])),
    );

    const result = await run(cribl);

    // Step two still runs - the same ONE extra job the `by` form costs, which
    // is why the two-jobs-per-query budget is unchanged.
    expect(jobsCreated(cribl)).toBe(2);
    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      ...lifecycleOf("j-1"),
      ...lifecycleOf("j-2"),
    ]);
    // NO `by` clause, no sort, no limit: an ungrouped summarize is one row.
    expect(cribl.calls[3].body).toEqual({
      query: `dataset="${DATASET}" | summarize ${COUNT_COLUMN}=count()`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });

    expect(result.ok).toBe(true);
    expect(result.noDiscriminator).toBe(true);
    expect(result.datasetAsLogType).toBe(true);
    expect(result.discriminatorField).toBeUndefined();
    // ONE log type, named after the dataset, carrying the MEASURED total - and
    // the mean event size measured off the same sample that failed to split.
    expect(result.logTypes).toEqual([
      {
        logType: DATASET,
        eventCount: 1216,
        meanEventBytes: UNSPLITTABLE_MEAN,
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("measures the WHOLE sample as this one log type's events", async () => {
    // Phase 5 on the single-log-type path, and the case where the mean is most
    // trustworthy: no discriminator MEANS every sampled event is this log type,
    // so nothing is being borrowed from a different one. Three events of
    // 10, 20 and 30 bytes average to 20.
    const cribl = client(
      ...jobRun(
        "j-1",
        ndjson([
          { _raw: "a".repeat(10) },
          { _raw: "b".repeat(20) },
          { _raw: "c".repeat(30) },
        ]),
      ),
      ...jobRun("j-2", ndjson([{ [COUNT_COLUMN]: 1000 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes).toEqual([
      { logType: DATASET, eventCount: 1000, meanEventBytes: 20 },
    ]);
    // Still ONE job per query - the mean cost no third search.
    expect(jobsCreated(cribl)).toBe(2);
  });

  it("says the name is the DATASET'S, not a log type found in the data", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(UNSPLITTABLE)),
      ...jobRun("j-2", ndjson([{ [COUNT_COLUMN]: 1216 }])),
    );

    const result = await run(cribl);

    const said = result.notes.join(" ");
    // CHANGED 2026-08-26: this used to assert core's PROSE said "named after the
    // dataset" / "not a log type found in the data". Those sentences moved to
    // the Lake panel, which already switched on the boolean below and was
    // saying both of them itself - four sentences for one idea on one card.
    //
    // The replacement is STRICTLY STRONGER, not weaker: the disclosure is now
    // pinned as the FACT that drives it, and a boolean cannot drift in wording
    // the way two independently-maintained sentences did. The panel owns the
    // words and pins them at its own layer (lake-panel.dom.test.tsx).
    expect(result.datasetAsLogType).toBe(true);
    expect(result.logTypes[0]?.logType).toBe(DATASET);
    // What core still says is the one thing the flag cannot carry: WHY nothing
    // was groupable. Kept, because no caller can derive it.
    expect(said).toContain("buried in the raw message");
    // The old dead-end advice is gone: the sample is right here to take.
    expect(said).not.toContain("capture a sample and name the log type yourself");
    // And core no longer re-states what the flag already says.
    expect(said).not.toContain("named after the dataset");
  });

  it("counts NOTHING off step one's rows, which are capped by our own bound", async () => {
    // The tempting shortcut, and the one thing this must never do. Step one is
    // capped at DISCRIMINATOR_SAMPLE_LIMIT, so its row count measures OUR bound:
    // a dataset with 1,216 events would report 500. The count has to come from
    // the engine, over the window, or not at all.
    const rows = Array.from({ length: 7 }, (_unused, i) => ({ _raw: `line ${i}` }));
    const cribl = client(
      ...jobRun("j-1", ndjson(rows)),
      ...jobRun("j-2", ndjson([{ [COUNT_COLUMN]: 1216 }])),
    );

    const result = await run(cribl);

    // Each `line N` is 6 characters, so the mean is 6 - measured off the sample
    // exactly as the count is NOT.
    expect(result.logTypes).toEqual([
      { logType: DATASET, eventCount: 1216, meanEventBytes: 6 },
    ]);
    expect(result.logTypes[0].eventCount).not.toBe(rows.length);
  });

  it("leaves the volume UNKNOWN when the count fails, and still offers the sample", async () => {
    // The count failing costs the NUMBER, never the offer: the dataset was read
    // and its events are still there to take. `ok` stays true, because nothing
    // about the read failed - the empty-vs-failed split, applied to a volume.
    const cribl = client(
      ...jobRun("j-1", ndjson(UNSPLITTABLE)),
      { status: 500, body: "boom" },
    );

    const result = await run(cribl);

    expect(result.ok).toBe(true);
    expect(result.datasetAsLogType).toBe(true);
    // The events WERE measured - step one read them - but with no count there is
    // nothing to multiply, so the row carries a mean and NO byte estimate.
    expect(result.logTypes).toEqual([
      { logType: DATASET, meanEventBytes: UNSPLITTABLE_MEAN },
    ]);
    // Undefined, NEVER zero - a volume of zero is a claim about the data.
    expect(result.logTypes[0].eventCount).toBeUndefined();
    expect(result.notes.join(" ")).toContain("unknown rather than zero");
    // THE OFFER SURVIVES, pinned as the FACT rather than as prose (2026-08-26).
    // This used to search `notes` for "single log type". That sentence moved to
    // the Lake panel, which switches on the flag below and was already saying it
    // in its own words - core repeating it put four sentences for one idea on a
    // single card. `datasetAsLogType` is what actually carries the offer, and a
    // boolean cannot drift in wording the way the two copies did.
    expect(result.datasetAsLogType).toBe(true);
    expect(result.logTypes.map((t) => t.logType)).toEqual([DATASET]);
  });

  /**
   * A SUCCESSFUL RESULT CARRIES NO FAILED SUB-QUERY'S ERROR TEXT (2026-08-26).
   *
   * THIS PIN DELIBERATELY REPLACES ONE. The old assertion was that the count
   * query's platform error DID appear in `notes`, merely AFTER the offer:
   *
   *     const detail = result.notes.findIndex((n) => n.includes("HTTP 500"));
   *     expect(detail).toBeGreaterThan(offer);
   *
   * Ordering was the wrong remedy and the live app showed why. `notes` is
   * operator-facing hint text and the Lake panel renders every entry the same
   * way beneath the headline the result earned - and this result is `ok: true`,
   * an OFFER. So an operator read "so 'X' is offered as a single log type"
   * followed by "the search job was still running after 20 status checks, so no
   * log types could be read", the second sentence denying the first, printed
   * beside a log type they could see and tick. Below that sat the sentence that
   * actually applied to them. Moving the error further down does not stop it
   * contradicting the offer; it only buries the explanation deeper.
   *
   * So the error text now goes to the LOGGER and the operator keeps the one
   * sentence that is true for them. What is pinned is the pair: nothing raw in
   * `notes`, and nothing lost from the log.
   */
  it("keeps the failed count query's platform error OUT of a successful result's notes", async () => {
    const logger = new FakeLogger();
    const cribl = client(
      ...jobRun("j-1", ndjson(UNSPLITTABLE)),
      { status: 500, body: "boom" },
    );

    const result = await queryLakeSamples(
      cribl,
      { searchGroupId: GROUP, datasetId: DATASET },
      logger,
    );

    expect(result.ok).toBe(true);
    const said = result.notes.join(" ");
    // Not the HTTP status, not the body, not the phrasing that denies the offer.
    expect(said).not.toContain("HTTP 500");
    expect(said).not.toContain("boom");
    expect(said).not.toContain("no log types could be read");
    // What the operator DOES get: the offer, and why the volume is missing.
    // The offer is the FLAG, not a sentence in `notes` - see the pin above; the
    // Lake panel owns the words and pins them at its own layer.
    expect(result.datasetAsLogType).toBe(true);
    expect(said).toContain("unknown rather than zero");
    expect(said).toContain("sample itself can still be taken");
    // Nothing was swallowed - the platform's words reached the logger instead.
    const warned = logger.entries.filter((e) => e.level === "warn");
    expect(warned).toHaveLength(1);
    expect(String(warned[0].context?.detail)).toContain("HTTP 500");
    expect(String(warned[0].context?.detail)).toContain("boom");
  });

  it("logs NO count-failure warning when the count query succeeded", async () => {
    // The mirror of the pin above, and what makes it a signal rather than a
    // habit: SearchRun.notes is empty on success, so a warning here would mean
    // the code had started reporting a healthy query as a failed one.
    const logger = new FakeLogger();
    const cribl = client(
      ...jobRun("j-1", ndjson(UNSPLITTABLE)),
      ...jobRun("j-2", ndjson([{ [COUNT_COLUMN]: 1216 }])),
    );

    const result = await queryLakeSamples(
      cribl,
      { searchGroupId: GROUP, datasetId: DATASET },
      logger,
    );

    expect(result.ok).toBe(true);
    expect(result.logTypes[0].eventCount).toBe(1216);
    expect(logger.entries.filter((e) => e.level === "warn")).toEqual([]);
    // And no stray error text rode in on the success path either.
    expect(result.notes.join(" ")).not.toContain("could not be counted");
  });

  it("leaves the volume UNKNOWN when the count column is unreadable", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(UNSPLITTABLE)),
      ...jobRun("j-2", ndjson([{ total: 1216 }])),
    );

    const result = await run(cribl);

    expect(result.ok).toBe(true);
    // The mean survives an unreadable COUNT - they are measured off different
    // queries - but with no count there is nothing to multiply, so no byte
    // estimate can follow it either.
    expect(result.logTypes).toEqual([
      { logType: DATASET, meanEventBytes: UNSPLITTABLE_MEAN },
    ]);
    expect(result.notes.join(" ")).toContain("unknown rather than zero");
  });

  it("EMPTY offers nothing and names nothing - the case this must not become", async () => {
    // The two used to be one dead end on screen: both showed no rows and sent
    // the operator away. They are different facts and must stay different
    // shapes - an empty window has nothing to name, and naming a dataset after
    // itself with no events in it would be inventing a log type outright.
    const cribl = client(...jobRun("j-1", ""));

    const result = await run(cribl);

    expect(jobsCreated(cribl)).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.noDiscriminator).toBe(false);
    expect(result.datasetAsLogType).toBe(false);
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("holds no events between -24h and now");
    expect(result.notes.join(" ")).not.toContain("single log type");
  });

  it("does NOT name a dataset after itself when the READ failed", async () => {
    // Nothing was established about the data at all. Offering a log type here
    // would put a name on a dataset the app never managed to look at.
    const cribl = client({ status: 403, body: "forbidden" });

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.datasetAsLogType).toBe(false);
    expect(result.logTypes).toEqual([]);
  });

  it("keeps datasetAsLogType FALSE for every name that came out of the data", async () => {
    // The flag is the honesty claim; a grouped list must never carry it, or the
    // caveat "this name is the dataset's" would print over real log types.
    const result = await run(countingClient());

    expect(result.datasetAsLogType).toBe(false);
    expect(result.noDiscriminator).toBe(false);
    expect(result.logTypes.map((t) => t.logType)).toEqual(["TRAFFIC", "THREAT"]);
  });
});

describe("the result", () => {
  it("returns per-log-type names AND volumes, biggest first", async () => {
    const result = await run(countingClient());

    expect(result.ok).toBe(true);
    // The mean rides along with every count: step one's rows were measured as
    // well as read, so each log type carries its own bytes-per-event.
    expect(result.logTypes).toEqual([
      { logType: "TRAFFIC", eventCount: 890000, meanEventBytes: SAMPLED_MEAN },
      { logType: "THREAT", eventCount: 12, meanEventBytes: SAMPLED_MEAN },
    ]);
    // A volume means nothing without the window it covers.
    expect(result.window).toEqual({
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(result.truncated).toBe(false);
  });

  it("keeps a NUMERIC discriminator value instead of dropping the log type", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson([{ eventType: 4624 }, { eventType: 4625 }])),
      ...jobRun("j-2", ndjson([{ eventType: 4624, [COUNT_COLUMN]: 7 }])),
    );

    const result = await run(cribl);

    expect(result.discriminatorField).toBe("eventType");
    // No `_raw` on these rows, so the mean is measured over the serialized row -
    // the same bytes fetchLakeLogTypeEvents would take as the sample.
    // `{"eventType":4624}` is 18 characters.
    expect(result.logTypes).toEqual([
      { logType: "4624", eventCount: 7, meanEventBytes: 18 },
    ]);
  });

  it("reports an unreadable volume as UNKNOWN, never as zero", async () => {
    // Zero is a claim about the data. We would be making it up.
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun("j-2", ndjson([{ type: "TRAFFIC", total: 5 }])),
    );

    const result = await run(cribl);

    // The events WERE measured - the sample held a TRAFFIC row - but the count
    // was not, so there is nothing to multiply and no byte estimate can follow.
    expect(result.logTypes).toEqual([
      { logType: "TRAFFIC", meanEventBytes: SAMPLED_MEAN },
    ]);
    expect(result.logTypes[0].eventCount).toBeUndefined();
    expect(result.notes.join(" ")).toContain("unknown rather than zero");
  });

  it("reads the engine's own count_ column when the alias is ignored", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun("j-2", ndjson([{ type: "TRAFFIC", count_: 42 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes).toEqual([
      { logType: "TRAFFIC", eventCount: 42, meanEventBytes: SAMPLED_MEAN },
    ]);
  });

  it("leaves out a group key it can read as neither a name nor an absence", async () => {
    // An object key is a shape this app does not understand. It is NOT the
    // events-carry-no-value group (that one is offered, see its own block
    // below) and must not be folded in with it - the fetch filter for "no
    // value" would not return these.
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 3 },
          { type: { nested: true }, [COUNT_COLUMN]: 9 },
        ]),
      ),
    );

    const result = await run(cribl);

    expect(result.logTypes).toHaveLength(1);
    expect(result.logTypes[0].logType).toBe("TRAFFIC");
    expect(result.notes.join(" ")).toContain(
      '1 group came back with a "type" value this app could not read as a name',
    );
    // And it is not smuggled in under the minted label either.
    expect(result.logTypes.some((t) => t.unnamed === true)).toBe(false);
  });

  it("says the list may be truncated when it fills the cap", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "A", [COUNT_COLUMN]: 2 },
          { type: "B", [COUNT_COLUMN]: 1 },
        ]),
      ),
    );

    const result = await run(cribl, { maxLogTypes: 2 });

    expect(result.truncated).toBe(true);
    expect(result.logTypes.map((t) => t.logType)).toEqual(["A", "B"]);
    expect(result.notes.join(" ")).toContain("may hold more");
  });
});

/**
 * EVENTS TO BYTES (sample-acquisition plan Phase 5, the last unbuilt item).
 *
 * A Lake volume reaching the operator as an event COUNT is hard to reason about
 * against a Sentinel bill, which is charged by volume. Step one already pulls
 * real events to decide WHICH FIELD and then throws their bodies away; these pin
 * that they are measured instead, per log type, at the cost of no extra job.
 *
 * What every case here is really guarding is the REFUSAL. The number is a mean
 * from a few hundred sampled events multiplied by a count over the whole window,
 * so where it cannot be measured it must be ABSENT - a defaulted zero would read
 * as a measurement and would under-report a cost, which is the expensive
 * direction to be wrong in.
 */
describe("the mean event size comes from STEP ONE's own events", () => {
  it("measures each log type over ITS OWN sampled events, not the dataset's", async () => {
    // Two log types whose events differ in size by 10x. A dataset-wide mean
    // would price both at roughly the same figure and be wrong about both.
    const big = "x".repeat(200);
    const small = "y".repeat(20);
    const cribl = client(
      ...jobRun(
        "j-1",
        ndjson([
          { type: "BIG", _raw: big },
          { type: "BIG", _raw: big },
          { type: "SMALL", _raw: small },
        ]),
      ),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "BIG", [COUNT_COLUMN]: 1000 },
          { type: "SMALL", [COUNT_COLUMN]: 5000 },
        ]),
      ),
    );

    const result = await run(cribl);

    expect(result.logTypes).toEqual([
      { logType: "SMALL", eventCount: 5000, meanEventBytes: 20 },
      { logType: "BIG", eventCount: 1000, meanEventBytes: 200 },
    ]);
    // Neither carries the dataset-wide mean, which would be (200+200+20)/3 = 140.
    expect(result.logTypes.map((t) => t.meanEventBytes)).not.toContain(140);
  });

  it("averages a log type's events rather than taking the first one", async () => {
    const cribl = client(
      ...jobRun(
        "j-1",
        ndjson([
          { type: "MIXED", _raw: "x".repeat(10) },
          { type: "MIXED", _raw: "x".repeat(30) },
          { type: "OTHER", _raw: "y" },
        ]),
      ),
      ...jobRun("j-2", ndjson([{ type: "MIXED", [COUNT_COLUMN]: 100 }])),
    );

    const result = await run(cribl);

    // (10 + 30) / 2 = 20, not 10 and not 30.
    expect(result.logTypes[0].meanEventBytes).toBe(20);
  });

  it("leaves a COUNTED but UNSAMPLED log type unmeasured - never zero", async () => {
    // The skew case, measured live on winevt_plwindows: a 97%-dominant value
    // can crowd the minority out of the sample while step two still counts it at
    // dataset scale. That log type gets no mean, and therefore no byte estimate.
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 890000 },
          { type: "NEVER_SAMPLED", [COUNT_COLUMN]: 4 },
        ]),
      ),
    );

    const result = await run(cribl);

    const unsampled = result.logTypes.find(
      (t) => t.logType === "NEVER_SAMPLED",
    );
    expect(unsampled?.eventCount).toBe(4);
    expect(unsampled?.meanEventBytes).toBeUndefined();
    // The KEY is absent, not present-and-undefined.
    expect("meanEventBytes" in (unsampled ?? {})).toBe(false);
  });

  it("measures the SERIALIZED row when there is no vendor _raw", async () => {
    // The same fallback fetchLakeLogTypeEvents uses to build the sample, so the
    // mean describes the bytes that path would actually take.
    const row = { type: "JSONONLY", extra: "abc" };
    const cribl = client(
      ...jobRun("j-1", ndjson([row, { type: "OTHER", extra: "z" }])),
      ...jobRun("j-2", ndjson([{ type: "JSONONLY", [COUNT_COLUMN]: 10 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes[0].meanEventBytes).toBe(
      JSON.stringify(row).length,
    );
    // Spelled out: `{"type":"JSONONLY","extra":"abc"}` is 33 characters.
    expect(result.logTypes[0].meanEventBytes).toBe(33);
  });

  it("falls back to the serialized row for an EMPTY _raw, never to a 0 mean", async () => {
    // readString treats "" as absent, so an empty _raw takes the same fallback
    // an absent one does - which is the right answer twice over: those ARE the
    // bytes fetchLakeLogTypeEvents would take for that row, and a mean of 0
    // would multiply a 500-event count into a confident "~0 B".
    const row = { type: "EMPTY", _raw: "" };
    const cribl = client(
      ...jobRun("j-1", ndjson([row, { type: "REAL", _raw: "abcde" }])),
      ...jobRun("j-2", ndjson([{ type: "EMPTY", [COUNT_COLUMN]: 500 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes[0].eventCount).toBe(500);
    // `{"type":"EMPTY","_raw":""}` is 26 characters - a real measurement of a
    // real row, and emphatically not zero.
    expect(result.logTypes[0].meanEventBytes).toBe(JSON.stringify(row).length);
    expect(result.logTypes[0].meanEventBytes).toBe(26);
  });

  it("costs NO extra search job - the events were already in hand", async () => {
    // The whole reason this is measured here rather than by a third query.
    const cribl = countingClient();

    await run(cribl);

    expect(jobsCreated(cribl)).toBe(2);
  });
});

describe("empty is a RESULT; failed is not", () => {
  it("names the empty WINDOW when the dataset answers with no events, on ONE job", async () => {
    // A COMPLETED job that returned no rows IS an empty window, and is believed
    // on the first asking. Until 2026-08-25 it was not: the sync route's empty
    // reply was treated as inconclusive and a job was spent confirming it - a
    // second job, on top of the one the sync route had silently created itself.
    const cribl = client(...jobRun("j-1", ""));

    const result = await run(cribl);

    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      lifecycleOf("j-1"),
    );
    expect(jobsCreated(cribl)).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.logTypes).toEqual([]);
    expect(result.noDiscriminator).toBe(false);
    expect(result.notes.join(" ")).toContain("holds no events between -24h and now");
  });

  it("reports a FAILED read when the job could not be created", async () => {
    // Nothing was ever established about the data, so this must not render like
    // the case above - a 403 that reads as "your dataset is empty" is the one
    // wrong answer this feature must never give.
    const cribl = client({ status: 403, body: "forbidden" });

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("search permission");
    expect(result.notes.join(" ")).not.toContain("holds no events");
  });

  it("distinguishes 'the field exists but counts nothing' from a failure", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun("j-2", ndjson([])),
    );

    const result = await run(cribl);

    expect(result.ok).toBe(true);
    expect(result.discriminatorField).toBe("type");
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("returned no groups");
  });

  it("folds a TRANSPORT failure into notes and never throws", async () => {
    const cribl = new FakeCriblClient(); // no scripted response: the fake throws

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("Capturing from a live source");
  });

  it("keeps the discriminator it learned when only the COUNT query fails", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      { status: 500, body: "boom" },
    );

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.discriminatorField).toBe("type");
    expect(result.notes.join(" ")).toContain("could not be counted");
  });
});

describe("the job lifecycle - the ONLY route, and the one PROVEN live", () => {
  it("runs create, status?advanced=true, results?offset&limit, all group-scoped", async () => {
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1", status: "new" }] }),
      jobStatus("running"),
      jobStatus("completed"),
      ok(ndjson(SAMPLE_ROWS)),
      ok({ count: 1, items: [{ id: "j-2" }] }),
      jobStatus("completed"),
      ok(ndjson(COUNT_ROWS)),
    );
    const sleeps: number[] = [];

    const result = await run(cribl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /search/jobs",
      "GET /search/jobs/j-1/status",
      "GET /search/jobs/j-1/status",
      "GET /search/jobs/j-1/results",
      "POST /search/jobs",
      "GET /search/jobs/j-2/status",
      "GET /search/jobs/j-2/results",
    ]);
    expect(cribl.calls.every((c) => c.groupId === GROUP)).toBe(true);
    expect(cribl.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | limit ${DISCRIMINATOR_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(cribl.calls[1].query).toEqual({ advanced: "true" });
    expect(cribl.calls[3].query).toEqual({
      offset: "0",
      // The results page must be big enough to read BACK everything step one
      // asked for, so this tracks the sample size rather than the fetch size.
      limit: String(DISCRIMINATOR_SAMPLE_LIMIT),
    });
    // Core reads no clock and starts no timer: the delay is the shell's, and it
    // is asked for only between polls that are still pending.
    expect(sleeps).toEqual([500]);
    expect(result.ok).toBe(true);
    expect(result.logTypes).toHaveLength(2);
  });

  it("percent-encodes a job id rather than growing a path segment", async () => {
    const cribl = client(
      ok({ count: 1, items: [{ id: "job/1" }] }),
      jobStatus("completed"),
      ok(ndjson([{ _raw: "no discriminator here" }])),
    );

    await run(cribl);

    expect(cribl.calls[1].path).toBe("/search/jobs/job%2F1/status");
  });

  /**
   * THE ORPHAN. Two pins, one per usecase, because the bug's size depended on
   * which one you ran (the second is in the fetch block below).
   *
   * The app used to try `GET /search/query` first, for a round trip it never
   * saved: given a window that route CREATES A JOB and answers 200 with
   * `{"job":{"id":...,"status":"queued"}}` and no rows (probed live
   * 2026-08-25). The app read the empty reply as a disappointment, fell through
   * to `POST /search/jobs`, and left the first job behind - so a two-query
   * queryLakeSamples run created FOUR jobs and orphaned two. The verdict was
   * memoized per runner and each usecase builds its own, so a full operator flow
   * re-learned the same lesson and orphaned two more.
   *
   * A COUNT is the only thing that catches it. Every result assertion in this
   * file - ok, log types, volumes, notes - was already green while it happened.
   */
  it("creates exactly ONE job per query, and never calls the sync route", async () => {
    const cribl = countingClient();

    const result = await run(cribl);

    expect(jobsCreated(cribl)).toBe(2);
    expect(cribl.calls.some((c) => c.path === "/search/query")).toBe(false);
    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      ...lifecycleOf("j-1"),
      ...lifecycleOf("j-2"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.logTypes).toHaveLength(2);
  });

  it("puts NO platform error text in the notes of a query that SUCCEEDED", async () => {
    // The sync route's failure note was unshifted to the FRONT of `notes`, and
    // the Lake panel renders notes under whatever headline the run earned - so
    // an operator whose query worked was shown "The direct search route answered
    // HTTP 400 ..." above their log types. A successful run's only notes are
    // ones about the DATA.
    const cribl = countingClient();

    const result = await run(cribl);

    expect(result.ok).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("treats a job that never finishes as FAILED, not as an empty dataset", async () => {
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      ...Array.from({ length: JOB_POLL_ATTEMPTS }, () => jobStatus("running")),
    );
    const sleeps: number[] = [];

    const result = await run(cribl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    // Bounded: create + exactly JOB_POLL_ATTEMPTS status reads, then it stops.
    expect(cribl.calls).toHaveLength(1 + JOB_POLL_ATTEMPTS);
    expect(sleeps).toHaveLength(JOB_POLL_ATTEMPTS - 1);
    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).toContain(`${JOB_POLL_ATTEMPTS} status checks`);
  });

  it("reports a job Cribl itself failed", async () => {
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      jobStatus("failed"),
    );

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).toContain("as failed");
  });

  it("reports a created job that carried no id", async () => {
    const cribl = client(ok({ count: 0, items: [] }));

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).toContain("no job id");
  });
});

/**
 * The status ENVELOPE, which is a different pin from the poll's boundedness.
 *
 * The block above pins that the loop stops. This one pins that it ever STARTS:
 * that the status is read out of the shape a live workspace actually sends.
 *
 * The defect (live 2026-08-24): the poll read a top-level `status` key that the
 * real response does not have, so it read undefined every time, the status
 * stayed "", and a job that was `completed` on the first attempt burned all
 * JOB_POLL_ATTEMPTS and was reported "still pending". EVERY Lake query failed on
 * EVERY dataset. The suite stayed green because every status response scripted
 * here was the spec's flattened `{status}` rather than the live envelope - the
 * fake agreeing with the code about a shape neither had checked, which is the
 * only way a total outage hides behind a green run.
 *
 * So each pin here asserts a COUNT - how many status requests were issued, how
 * many waits were asked for - rather than only that the call succeeded. Counts
 * are what separate "read the status on the first poll" from "read nothing
 * twenty times and gave up", and those two produced identical `ok` flags for
 * every case but the happy one.
 */
describe("the job status arrives in an ENVELOPE, not as a top-level key", () => {
  /** create -> one poll -> results, for each of the two queries. */
  const LIFECYCLE = [...lifecycleOf("j-1"), ...lifecycleOf("j-2")];

  const statusCalls = (cribl: FakeCriblClient): number =>
    cribl.calls.filter((c) => c.path.endsWith("/status")).length;

  it("completes on the FIRST poll when the status is at items[0].status", async () => {
    // The live shape. Before the fix this read nothing, slept, polled again,
    // and ran out of scripted responses - so the counts below, not the ok flag,
    // are what this pin turns on.
    const cribl = countingClient();
    const sleeps: number[] = [];

    const result = await run(cribl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual(LIFECYCLE);
    // ONE status request per job, not JOB_POLL_ATTEMPTS of them.
    expect(statusCalls(cribl)).toBe(2);
    // And no wait was ever asked for, because nothing was ever pending.
    expect(sleeps).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.discriminatorField).toBe("type");
    expect(result.logTypes).toEqual([
      { logType: "TRAFFIC", eventCount: 890000, meanEventBytes: SAMPLED_MEAN },
      { logType: "THREAT", eventCount: 12, meanEventBytes: SAMPLED_MEAN },
    ]);
  });

  it("still reads a BARE top-level status - the shape the spec documents", async () => {
    // The OpenAPI example is the flattened `{status:"running", ...}`, so the
    // fallback is not dead code: it is the only reading of the response Cribl
    // publishes. Both shapes must produce the identical lifecycle.
    const bare = (state: string): PortHttpResponse => ok({ status: state });
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      bare("completed"),
      ok(ndjson(SAMPLE_ROWS)),
      ok({ count: 1, items: [{ id: "j-2" }] }),
      bare("completed"),
      ok(ndjson(COUNT_ROWS)),
    );
    const sleeps: number[] = [];

    const result = await run(cribl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual(LIFECYCLE);
    expect(statusCalls(cribl)).toBe(2);
    expect(sleeps).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.logTypes).toEqual([
      { logType: "TRAFFIC", eventCount: 890000, meanEventBytes: SAMPLED_MEAN },
      { logType: "THREAT", eventCount: 12, meanEventBytes: SAMPLED_MEAN },
    ]);
  });

  it("keeps polling an ENVELOPE that says running, and names that state when it gives up", async () => {
    // The bound itself is pinned above; what this adds is WHAT WAS READ. A poll
    // that read nothing gives up saying the job was "still pending" - which is
    // the app admitting it never learned anything, in a sentence that reads to
    // an operator like a slow query. Naming `running` is the difference, and it
    // is only available to a reader that found the status in the envelope.
    const cribl = client(
      ok({ count: 1, items: [{ id: "j-1" }] }),
      ...Array.from({ length: JOB_POLL_ATTEMPTS }, () => jobStatus("running")),
    );
    const sleeps: number[] = [];

    const result = await run(cribl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    // Every scripted status response was consumed and no more were asked for.
    expect(statusCalls(cribl)).toBe(JOB_POLL_ATTEMPTS);
    expect(cribl.calls).toHaveLength(1 + JOB_POLL_ATTEMPTS);
    expect(sleeps).toHaveLength(JOB_POLL_ATTEMPTS - 1);
    expect(sleeps.every((ms) => ms === JOB_POLL_INTERVAL_MS)).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain(
      `still running after ${JOB_POLL_ATTEMPTS} status checks`,
    );
    // "pending" is what the app says when it read NO status at all.
    expect(result.notes.join(" ")).not.toContain("still pending");
    // And a job we stopped asking about is never an empty dataset.
    expect(result.notes.join(" ")).not.toContain("holds no events");
  });
});

describe("searchResultRows - the shapes an NDJSON body arrives in", () => {
  it("splits the documented NDJSON string and DROPS the metadata line", () => {
    // The metadata line describes the result set, not an event; counting it
    // would invent a log type out of totalEventCount.
    expect(searchResultRows(ndjson(COUNT_ROWS))).toEqual(COUNT_ROWS);
  });

  it("reads an already-parsed array and a {count, items} envelope", () => {
    expect(searchResultRows(COUNT_ROWS)).toEqual(COUNT_ROWS);
    expect(searchResultRows({ count: 2, items: COUNT_ROWS })).toEqual(COUNT_ROWS);
  });

  it("reads a single decoded row", () => {
    expect(searchResultRows({ type: "A", [COUNT_COLUMN]: 1 })).toEqual([
      { type: "A", [COUNT_COLUMN]: 1 },
    ]);
  });

  it("returns [] for an EMPTY body - the API answered, there is nothing", () => {
    expect(searchResultRows("")).toEqual([]);
    expect(searchResultRows("\n\n")).toEqual([]);
    expect(searchResultRows(null)).toEqual([]);
    expect(searchResultRows(JSON.stringify(META))).toEqual([]);
  });

  it("returns null for a body it does not understand - NOT an empty list", () => {
    // envelope.ts doctrine: a list silently read as empty is the worst failure
    // shape in this codebase.
    expect(searchResultRows("<html>gateway timeout</html>")).toBeNull();
    expect(searchResultRows(42)).toBeNull();
  });

  it("keeps the rows it could decode when one line is junk", () => {
    const body = `${JSON.stringify(META)}\nnot json\n${JSON.stringify(COUNT_ROWS[0])}`;
    expect(searchResultRows(body)).toEqual([COUNT_ROWS[0]]);
  });
});

describe("fetchLakeLogTypeEvents - counts choose, events sample", () => {
  const fetchRun = (cribl: FakeCriblClient, extra = {}) =>
    fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "type",
      logTypes: ["TRAFFIC"],
      ...extra,
    });

  it("filters to ONE log type and asks for events, not a summarize", () => {
    // The whole reason this is a third query: `summarize count()` returns one
    // row per log type with no event bodies, so it can never become a sample.
    const query = buildLogTypeEventQuery(DATASET, "type", "TRAFFIC", 50);
    expect(query).toBe(
      'dataset="LogSources" | where tostring(type)=="TRAFFIC" | limit 50',
    );
    expect(query).not.toContain("summarize");
  });

  it("escapes a quote in the log-type value", () => {
    // The dataset id comes from configuration; this value came from DATA, so a
    // quote in it would otherwise break out of the comparison literal.
    expect(buildLogTypeEventQuery(DATASET, "type", 'a"b', 5)).toContain(
      'tostring(type)=="a\\"b"',
    );
  });

  it("keeps the vendor _raw, which is the point of a Lake sample", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "1,2026/08/13,fw01,TRAFFIC,end" }])),
    );

    const result = await fetchRun(cribl);

    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].logType).toBe("TRAFFIC");
    expect(result.events[0].rawEvents).toEqual(["1,2026/08/13,fw01,TRAFFIC,end"]);
  });

  it("serializes a row with NO _raw rather than dropping the event", async () => {
    const cribl = client(...jobRun("j-1", ndjson([{ type: "TRAFFIC", a: 1 }])));

    const result = await fetchRun(cribl);

    expect(result.events[0].rawEvents).toEqual(['{"type":"TRAFFIC","a":1}']);
  });

  it("runs ONE query per chosen log type - each becomes its own sample", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "a" }])),
      ...jobRun("j-2", ndjson([{ type: "THREAT", _raw: "b" }])),
    );

    const result = await fetchRun(cribl, { logTypes: ["TRAFFIC", "THREAT"] });

    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      ...lifecycleOf("j-1"),
      ...lifecycleOf("j-2"),
    ]);
    expect(result.events.map((e) => e.logType)).toEqual(["TRAFFIC", "THREAT"]);
  });

  it("creates ONE job per log type - the SECOND half of the orphan pin", async () => {
    // The other half is in the job-lifecycle block. This usecase built its own
    // runner with its own memoized "sync is unusable" verdict, so it re-learned
    // the lesson from scratch and orphaned a job of its own - which is why a
    // full operator flow leaked TWO, and why the count is pinned in both
    // places rather than once.
    const cribl = client(
      ...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "a" }])),
      ...jobRun("j-2", ndjson([{ type: "THREAT", _raw: "b" }])),
    );

    const result = await fetchRun(cribl, { logTypes: ["TRAFFIC", "THREAT"] });

    expect(jobsCreated(cribl)).toBe(2);
    expect(cribl.calls.some((c) => c.path === "/search/query")).toBe(false);
    expect(result.ok).toBe(true);
    // A successful fetch says nothing to the operator about routes or HTTP.
    expect(result.notes).toEqual([]);
  });

  it("PARTIAL SUCCESS is success - one failure does not cost the others", async () => {
    // The operator picked several. Returning nothing because the second 400'd
    // would throw away a good sample they can use.
    const cribl = client(
      ...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "a" }])),
      { status: 400, body: "bad query" },
    );

    const result = await fetchRun(cribl, { logTypes: ["TRAFFIC", "THREAT"] });

    // ok is FALSE because one log type genuinely FAILED - but the good sample
    // is still returned, which is the point of partial success.
    expect(result.ok).toBe(false);
    expect(result.events.map((e) => e.logType)).toEqual(["TRAFFIC"]);
    expect(result.notes.join(" ")).toContain("THREAT");
  });

  /**
   * THE THREE STATES OF A FETCH, PINNED SIDE BY SIDE (2026-08-26).
   *
   * `ok` alone answers none of the questions a renderer asks, and the interface
   * doc used to say the opposite of the code: "False when EVERY requested log
   * type failed; a partial haul is ok". The implementation has always been
   * `ok: failed === 0`, false the moment ANY log type fails. A renderer believed
   * the prose, branched on `!ok` as "nothing was added", and printed exactly
   * that sentence to an operator whose partial haul was being stored.
   *
   * The pins above each cover one state; this one puts all three in one place so
   * the PAIRING is the pin. `ok` says whether anything failed; `events` says
   * whether anything was got. Neither answers for the other.
   */
  it("distinguishes complete, PARTIAL and total failure by (ok, events) TOGETHER", async () => {
    // COMPLETE: nothing failed, and a haul came back.
    const complete = await fetchRun(
      client(...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "a" }]))),
    );
    expect([complete.ok, complete.events.length]).toEqual([true, 1]);

    // COMPLETE AND EMPTY: nothing failed, the window simply holds none of it.
    // `ok` is TRUE here, so `ok` can never be read as "something came back".
    const empty = await fetchRun(client(...jobRun("j-1", "")));
    expect([empty.ok, empty.events.length]).toEqual([true, 0]);

    // PARTIAL: something failed AND something came back. This is the state the
    // wrong branch was built on - `!ok` here does NOT mean nothing was added.
    const partial = await fetchRun(
      client(
        ...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "a" }])),
        { status: 400, body: "bad query" },
      ),
      { logTypes: ["TRAFFIC", "THREAT"] },
    );
    expect([partial.ok, partial.events.length]).toEqual([false, 1]);
    expect(partial.events[0].rawEvents).toEqual(["a"]);

    // TOTAL: everything failed, and only here does `!ok` mean nothing was added.
    const total = await fetchRun(client({ status: 400, body: "bad query" }));
    expect([total.ok, total.events.length]).toEqual([false, 0]);

    // REFUSED before any query ran - reads as total failure, which is correct:
    // nothing was added and nothing is recoverable from this result.
    const refused = await fetchRun(new FakeCriblClient(), { logTypes: [] });
    expect([refused.ok, refused.events.length]).toEqual([false, 0]);
  });

  it("reports a log type that returned nothing, rather than an empty sample", async () => {
    // A job that COMPLETED and returned no rows is an empty window, believed on
    // the first asking. This fixture used to script four responses because an
    // empty sync answer was inconclusive and a job was spent confirming it;
    // three is the whole lifecycle now.
    const cribl = client(...jobRun("j-1", ""));

    const result = await fetchRun(cribl);

    expect(jobsCreated(cribl)).toBe(1);
    expect(result.events).toEqual([]);
    // ok is TRUE: every request succeeded and the window is simply empty.
    // This pin asserted false until the 2026-08-20 bug-hunt - it had codified
    // the empty-vs-failed collapse rather than guarding against it, which is
    // the one thing a pin must never do.
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("no events in this window");
  });

  it("requests NOTHING when the selection or addressing is incomplete", async () => {
    // A blank search group would 404 at the leader and read as a Cribl fault.
    //
    // `discriminatorField: ""` LEFT THIS LIST on 2026-08-25 and is pinned in the
    // block below instead: a missing field is no longer incomplete addressing,
    // it is the undiscriminated dataset, which has exactly one log type and a
    // query with no `where` clause.
    for (const bad of [
      { searchGroupId: "" },
      { datasetId: "" },
      { logTypes: [] },
    ]) {
      const cribl = new FakeCriblClient();
      const result = await fetchRun(cribl, bad);
      expect(cribl.calls).toHaveLength(0);
      expect(result.ok).toBe(false);
    }
  });

  it("addresses the SEARCH group, like every other /search/* call", async () => {
    const cribl = client(...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "a" }])));

    await fetchRun(cribl);

    // Every call in the lifecycle, not only the create - a poll addressed at
    // the leader 404s as invisibly as a create does.
    expect(cribl.calls.every((c) => c.groupId === GROUP)).toBe(true);
    expect(cribl.calls.every((c) => c.path.startsWith("/search/"))).toBe(true);
  });
});

/**
 * TAKING THE SAMPLE from a dataset that is its own log type (2026-08-25).
 *
 * The offer is worth nothing if the commit cannot address it, and the commit
 * path assumed a discriminator on both sides: the guard refused a blank field
 * outright, and the query builder composed a `where` clause round it. Both are
 * pinned here, along with the one thing that must NOT be allowed to follow -
 * fetching the whole dataset repeatedly under several names.
 */
describe("fetching the ONE log type of an undiscriminated dataset", () => {
  it("runs an UNFILTERED query and labels it with the name it was given", async () => {
    // No field exists, so there is nothing to compare against. A `where` here
    // would filter on a missing column, return nothing, and be reported as
    // "this log type returned no events in this window" about a dataset the app
    // had just counted - the empty-vs-failed collapse, again.
    const cribl = client(
      ...jobRun("j-1", ndjson([{ _raw: "1,2026,fw,TRAFFIC,end" }])),
    );

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      logTypes: [DATASET],
    });

    expect(jobsCreated(cribl)).toBe(1);
    expect(cribl.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(JSON.stringify(cribl.calls[0].body)).not.toContain("where");
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([
      { logType: DATASET, rawEvents: ["1,2026,fw,TRAFFIC,end"] },
    ]);
  });

  it("treats an EMPTY discriminatorField exactly as an absent one", async () => {
    // The panel hands through whatever the query reported, and a caller that
    // normalises undefined to "" must not fall into a different behaviour.
    const cribl = client(...jobRun("j-1", ndjson([{ _raw: "x" }])));

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "   ",
      logTypes: [DATASET],
    });

    expect(cribl.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(result.events).toEqual([{ logType: DATASET, rawEvents: ["x"] }]);
  });

  it("REFUSES several log types with no field, rather than fetching one dataset twice", async () => {
    // The query is unfiltered, so it answers the same for every name. Running
    // it per name would write the SAME events into the store under two labels -
    // the app claiming a log type it never observed, and the pack then building
    // a route pair for each. Refused, not narrowed to the first: a caller that
    // asked for two is working from a wrong belief.
    const cribl = new FakeCriblClient();

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      logTypes: [DATASET, "THREAT"],
    });

    expect(cribl.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("no field to tell them apart");
  });

  it("still filters when a field IS given - the unfiltered query is not the default", async () => {
    const cribl = client(...jobRun("j-1", ndjson([{ type: "TRAFFIC", _raw: "a" }])));

    await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "type",
      logTypes: ["TRAFFIC"],
    });

    expect(cribl.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | where tostring(type)=="TRAFFIC" | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
  });

  it("builds the same two shapes from the query builder itself", () => {
    expect(buildLogTypeEventQuery(DATASET, undefined, DATASET, 50)).toBe(
      `dataset="${DATASET}" | limit 50`,
    );
    expect(buildLogTypeEventQuery(DATASET, "", DATASET, 50)).toBe(
      `dataset="${DATASET}" | limit 50`,
    );
    expect(buildLogTypeEventQuery(DATASET, "type", "TRAFFIC", 50)).toBe(
      `dataset="${DATASET}" | where tostring(type)=="TRAFFIC" | limit 50`,
    );
  });

  it("round-trips the name the QUERY offered, with no re-typing in between", async () => {
    // The whole path in one test: the dataset is counted, named after itself,
    // and that exact name plus its absent field address the fetch.
    const counting = client(
      ...jobRun("j-1", ndjson([{ _raw: "1,2026,fw,TRAFFIC,end" }])),
      ...jobRun("j-2", ndjson([{ [COUNT_COLUMN]: 1216 }])),
    );

    const listed = await run(counting);

    expect(listed.datasetAsLogType).toBe(true);
    // `1,2026,fw,TRAFFIC,end` is 21 characters, and it is the whole sample.
    expect(listed.logTypes).toEqual([
      { logType: DATASET, eventCount: 1216, meanEventBytes: 21 },
    ]);

    const fetching = client(...jobRun("j-3", ndjson([{ _raw: "an event" }])));
    const fetched = await fetchLakeLogTypeEvents(fetching, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: listed.discriminatorField,
      logTypes: listed.logTypes.map((entry) => entry.logType),
    });

    expect(jobsCreated(fetching)).toBe(1);
    expect(fetching.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.events).toEqual([
      { logType: DATASET, rawEvents: ["an event"] },
    ]);
  });
});

/**
 * Anything step two can LIST, step three must be able to FETCH.
 *
 * The defect these pin (2026-08-20): a discriminator value is legitimately
 * numeric, readGroupValue keeps it as text, and the fetch then compared a long
 * column to a quoted string. Kusto answered 400 or matched nothing, and nothing
 * surfaced as "\"4624\" returned no events in this window" - an empty-vs-failed
 * collapse about a log type the app itself had just reported holding seven.
 *
 * Which is why every case here asserts the QUERY TEXT as well as the outcome: a
 * fake that answers whatever it is asked would let the broken query pass.
 */
describe("a NUMERIC log type round-trips - listed by step two, FETCHED by step three", () => {
  it("carries 4624 out of the count query and into a query the engine answers", async () => {
    const counting = client(
      ...jobRun("j-1", ndjson([{ eventType: 4624 }, { eventType: 4625 }])),
      ...jobRun("j-2", ndjson([{ eventType: 4624, [COUNT_COLUMN]: 7 }])),
    );

    const listed = await run(counting);

    expect(listed.discriminatorField).toBe("eventType");
    expect(listed.logTypes).toEqual([
      { logType: "4624", eventCount: 7, meanEventBytes: 18 },
    ]);

    // Step three is handed exactly what step two produced, with no re-typing in
    // between - that hand-off IS the round trip, and it is where the value's
    // number-ness was lost.
    const fetching = client(
      ...jobRun(
        "j-3",
        ndjson([{ eventType: 4624, _raw: "An account was successfully logged on." }]),
      ),
    );

    const fetched = await fetchLakeLogTypeEvents(fetching, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: listed.discriminatorField ?? "",
      logTypes: listed.logTypes.map((entry) => entry.logType),
    });

    expect(jobsCreated(fetching)).toBe(1);
    expect(fetching.calls[0].body).toEqual({
      query:
        `dataset="${DATASET}" | where tostring(eventType)=="4624"` +
        ` | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.events).toEqual([
      { logType: "4624", rawEvents: ["An account was successfully logged on."] },
    ]);
  });

  it("fetches a value that merely LOOKS numeric but arrived as a string", async () => {
    // `type` is a string column whose values happen to be digits. The cast is a
    // no-op on it, which is what lets one code path serve both columns.
    const cribl = client(...jobRun("j-1", ndjson([{ type: "4624", _raw: "x" }])));

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "type",
      logTypes: ["4624"],
    });

    expect(cribl.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | where tostring(type)=="4624" | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([{ logType: "4624", rawEvents: ["x"] }]);
  });

  it("keeps a BOOLEAN group value too, and the same cast covers it", async () => {
    // readGroupValue accepts booleans - some vendors emit allow/deny that way -
    // and a bool column refuses a string comparison exactly as a long does.
    const cribl = client(
      ...jobRun("j-1", ndjson([{ action: true }, { action: false }])),
      ...jobRun(
        "j-2",
        ndjson([
          { action: true, [COUNT_COLUMN]: 31 },
          { action: false, [COUNT_COLUMN]: 4 },
        ]),
      ),
    );

    const result = await run(cribl);

    expect(result.discriminatorField).toBe("action");
    // `{"action":true}` is 15 characters; `{"action":false}` is 16.
    expect(result.logTypes).toEqual([
      { logType: "true", eventCount: 31, meanEventBytes: 15 },
      { logType: "false", eventCount: 4, meanEventBytes: 16 },
    ]);
    expect(
      buildLogTypeEventQuery(DATASET, "action", result.logTypes[0].logType, 50),
    ).toBe(`dataset="${DATASET}" | where tostring(action)=="true" | limit 50`);
  });

  it("names the numeric log type in the note when its fetch DOES fail", async () => {
    // A per-log-type failure is only actionable if the operator can tell which
    // one was lost, and a bare code like 4624 is the easiest kind to lose.
    const cribl = client({ status: 400, body: "bad query" });

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "eventType",
      logTypes: ["4624"],
    });

    expect(result.ok).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('"4624" could not be fetched');
    // FAILED, not empty. The two must not render as the same sentence.
    expect(result.notes[0]).not.toContain("no events in this window");
  });
});

/**
 * THE GROUP WITH NO VALUE IS OFFERED, NOT MERELY REPORTED (user report
 * 2026-08-25).
 *
 * Observed live: querying the Lake dataset "PaloAlto" reported 13 log types and
 * then "1 group carried no msgid value and was left out". Reported beats
 * silent, but those events had no route to becoming a sample at all - nothing
 * could shape them, and the generated pack would take them unshaped.
 *
 * FOUR THINGS EVERY CASE HERE DEFENDS, and they pull against each other, which
 * is why they are pinned together:
 *
 *   OFFERED      the row exists, is takeable, and is fetchable.
 *   NOT NAMED    its label reads as a description of what these events LACK.
 *                The app must never claim a vendor log type it did not observe,
 *                and this row is the easiest place to break that rule: it sits
 *                in a list of twelve real ones.
 *   COUNTED      the count on it is the platform's `summarize` count, never a
 *                zero and never the size of our own sample.
 *   PROVABLE     the fetch filter is composed only of forms the vendored spec
 *                attests, and what it returns is CHECKED rather than trusted.
 */
describe("the group whose discriminator value is ABSENT", () => {
  /** Step one's sample: two named events and one carrying no `type` at all. */
  const MIXED_SAMPLE = [
    { type: "TRAFFIC", _raw: "1,2026/08/13,fw01,TRAFFIC,end" },
    { type: "THREAT", _raw: "1,2026/08/13,fw01,THREAT,vuln" },
    { _raw: "nameless" },
  ];

  it("offers it as a row of its own, carrying the PLATFORM's count", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(MIXED_SAMPLE)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 890000 },
          { type: null, [COUNT_COLUMN]: 4211 },
        ]),
      ),
    );

    const result = await run(cribl);

    // TWO rows, not one: the value-less group is no longer dropped.
    expect(result.logTypes).toHaveLength(2);
    // `nameless` is 8 characters and is the only sampled event with no type, so
    // it is this row's whole mean.
    expect(result.logTypes[1]).toEqual({
      logType: "(no type)",
      eventCount: 4211,
      meanEventBytes: 8,
      unnamed: true,
    });
    // The count is the ENGINE's number, not the size of step one's sample.
    expect(result.logTypes[1].eventCount).toBe(4211);
    expect(result.logTypes[1].eventCount).not.toBe(MIXED_SAMPLE.length);
  });

  it("names it after the FIELD and flags it, so no caller can read it as a vendor log type", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(MIXED_SAMPLE)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 3 },
          { type: "", [COUNT_COLUMN]: 9 },
        ]),
      ),
    );

    const result = await run(cribl);

    const unnamed = result.logTypes.filter((t) => t.unnamed === true);
    expect(unnamed).toHaveLength(1);
    // The label states what these events LACK. Not "unknown", not "other", not
    // the bare field name - each of those reads as a further vendor log type
    // beside the real ones.
    expect(unnamed[0].logType).toBe("(no type)");
    // And the flag is on that row ALONE - every other name here came out of a
    // `summarize by` and must carry no such caveat.
    expect(result.logTypes.filter((t) => t.unnamed === undefined)).toHaveLength(
      1,
    );
    // The note says the same thing in the operator's words.
    const notes = result.notes.join(" ");
    expect(notes).toContain('1 group carried no "type" value');
    expect(notes).toContain('offered as "(no type)"');
    expect(notes).toContain("not a log type found in the data");
    // It is NOT reported as something left out any more.
    expect(notes).not.toContain("left out");
  });

  it("offers NOTHING extra when every group has a value", async () => {
    const result = await run(countingClient());

    // The unchanged shape, entry for entry: no minted row, no flag, no note.
    expect(result.logTypes).toEqual([
      { logType: "TRAFFIC", eventCount: 890000, meanEventBytes: SAMPLED_MEAN },
      { logType: "THREAT", eventCount: 12, meanEventBytes: SAMPLED_MEAN },
    ]);
    expect(result.logTypes.some((t) => t.unnamed !== undefined)).toBe(false);
    expect(result.notes.join(" ")).not.toContain("(no ");
  });

  it("folds SEVERAL value-less groups into one row and sums their counts", async () => {
    // An engine can return a null group and an empty-string group separately.
    // Both are "these events carry no value", and both are exactly what the
    // fetch filter selects - so two identically labelled rows would be the same
    // query offered twice.
    const cribl = client(
      ...jobRun("j-1", ndjson(MIXED_SAMPLE)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 5 },
          { type: null, [COUNT_COLUMN]: 40 },
          { type: "", [COUNT_COLUMN]: 2 },
        ]),
      ),
    );

    const result = await run(cribl);

    expect(result.logTypes).toHaveLength(2);
    expect(result.logTypes[0]).toEqual({
      logType: "(no type)",
      eventCount: 42,
      meanEventBytes: 8,
      unnamed: true,
    });
    expect(result.notes.join(" ")).toContain('2 groups carried no "type" value');
  });

  it("leaves the folded count ABSENT when any part of it was unreadable - never a partial sum", async () => {
    // merge.ts states the same rule for summed bytes: a partial total is a
    // number smaller than the events it claims to speak for, and understating a
    // volume is the expensive direction to be wrong in.
    const cribl = client(
      ...jobRun("j-1", ndjson(MIXED_SAMPLE)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 5 },
          { type: null, [COUNT_COLUMN]: 40 },
          { type: null, tally: 9 },
        ]),
      ),
    );

    const result = await run(cribl);

    const unnamed = result.logTypes.find((t) => t.unnamed === true);
    expect(unnamed).toBeDefined();
    expect(unnamed?.eventCount).toBeUndefined();
    // A mean with no count to multiply yields no byte estimate, and the row is
    // still takeable.
    expect(unnamed?.meanEventBytes).toBe(8);
    expect(result.notes.join(" ")).toContain("unknown rather than zero");
  });

  it("leaves its byte estimate absent when the sample held none of these events", async () => {
    // The standing meanEventBytes rule, unchanged: a mean measured over OTHER
    // log types' events would price these using bytes that are not theirs.
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 3 },
          { type: null, [COUNT_COLUMN]: 9 },
        ]),
      ),
    );

    const result = await run(cribl);

    const unnamed = result.logTypes.find((t) => t.unnamed === true);
    expect(unnamed).toEqual({
      logType: "(no type)",
      eventCount: 9,
      unnamed: true,
    });
    expect(unnamed?.meanEventBytes).toBeUndefined();
  });

  it("DECLINES to offer it when a real log type already answers to that label", async () => {
    // Two rows sharing one name would send the fetch - which recognises the
    // pick BY its name - after the wrong events. Refused, and said plainly.
    const cribl = client(
      ...jobRun("j-1", ndjson(MIXED_SAMPLE)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "(no type)", [COUNT_COLUMN]: 7 },
          { type: null, [COUNT_COLUMN]: 9 },
        ]),
      ),
    );

    const result = await run(cribl);

    expect(result.logTypes).toHaveLength(1);
    expect(result.logTypes[0].logType).toBe("(no type)");
    // The row that survives is the OBSERVED one, and it carries no flag.
    expect(result.logTypes[0].unnamed).toBeUndefined();
    expect(result.logTypes[0].eventCount).toBe(7);
    const notes = result.notes.join(" ");
    expect(notes).toContain("already called that");
    expect(notes).toContain("left out");
  });
});

/**
 * FETCHING the value-less row, which is the half that had to be grounded rather
 * than guessed.
 *
 * `where tostring(field)=="value"` cannot express "there is no value": every
 * literal IS a value. The vendored spec
 * (packages/core/assets/cribl-openapi.json) attests exactly one null-ish Kusto
 * predicate for Cribl Search - `isnotempty(vendor)` as a dataset ruleset's
 * `kustoExpression` - together with `| where <expr>`, `field == "literal"`, and
 * the bare literal `false`. It attests no `isempty`, no `isnull`, no `not()`.
 *
 * So the filter is `isnotempty(field)==false`, built from those forms alone -
 * and because a composition of attested atoms is still a query no one here has
 * run, what comes back is CHECKED against what was asked for.
 */
describe("fetching the value-less row - a filter built from what the spec attests", () => {
  const UNNAMED = "(no type)";

  it("builds isnotempty(field)==false, and reaches for no unattested function", () => {
    const query = buildLogTypeEventQuery(DATASET, "type", UNNAMED, 50);

    expect(query).toBe(
      `dataset="${DATASET}" | where isnotempty(type)==false | limit 50`,
    );
    // The three the spec never writes down. A future edit reaching for one of
    // them is a guess about an engine no test here can question.
    expect(query).not.toContain("isempty(");
    expect(query).not.toContain("isnull(");
    expect(query).not.toContain("not(");
    // And it is NOT the value comparison, which would look for a literal
    // "(no type)" that no event carries and return nothing while looking right.
    expect(query).not.toContain("tostring(");
  });

  it("leaves every OTHER log type on the value comparison", () => {
    expect(buildLogTypeEventQuery(DATASET, "type", "TRAFFIC", 50)).toBe(
      `dataset="${DATASET}" | where tostring(type)=="TRAFFIC" | limit 50`,
    );
    // The label only means "no value" for the field it was minted from. Against
    // a different field it is just text, and is compared as such.
    expect(buildLogTypeEventQuery(DATASET, "msgid", UNNAMED, 50)).toBe(
      `dataset="${DATASET}" | where tostring(msgid)=="${UNNAMED}" | limit 50`,
    );
  });

  it("round-trips: the row step two OFFERED is the row step three FETCHES", async () => {
    const counting = client(
      ...jobRun("j-1", ndjson([{ type: "TRAFFIC" }, { _raw: "nameless" }])),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 12 },
          { type: null, [COUNT_COLUMN]: 4211 },
        ]),
      ),
    );

    const listed = await run(counting);
    const offered = listed.logTypes.find((t) => t.unnamed === true);
    expect(offered?.logType).toBe(UNNAMED);

    // Handed over with NO re-typing - the name the query produced, exactly.
    const fetching = client(
      ...jobRun("j-3", ndjson([{ _raw: "a nameless event" }])),
    );
    const fetched = await fetchLakeLogTypeEvents(fetching, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: listed.discriminatorField,
      logTypes: [offered?.logType ?? ""],
    });

    expect(jobsCreated(fetching)).toBe(1);
    expect(fetching.calls[0].body).toEqual({
      query: `dataset="${DATASET}" | where isnotempty(type)==false | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.events).toEqual([
      { logType: UNNAMED, rawEvents: ["a nameless event"] },
    ]);
  });

  it("REFUSES the haul when a returned event does carry a value - the filter is checked, not trusted", async () => {
    // The failure this exists to catch: Cribl accepts the filter but reads it
    // as something else. Storing the haul would put events WITH a type into a
    // sample whose name says they have none - written into the store that
    // drives route and pipeline generation.
    const cribl = client(
      ...jobRun(
        "j-1",
        ndjson([
          { _raw: "nameless" },
          { type: "TRAFFIC", _raw: "1,2026,fw,TRAFFIC,end" },
        ]),
      ),
    );

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "type",
      logTypes: [UNNAMED],
    });

    expect(result.events).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("1 of the 2 events it returned DO carry");
    // Refused WHOLE, not quietly filtered down to the row that qualified.
    expect(result.notes[0]).toContain("was not added");
  });

  it("calls an empty answer AMBIGUOUS for this row, where for any other it is just empty", async () => {
    // Every other log type comes back empty because the window holds none of
    // it. This one may ALSO come back empty because Search does not read the
    // filter the way this app composed it, and the operator has the count on
    // screen to tell the two apart.
    const cribl = client(...jobRun("j-1", ndjson([])));

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "type",
      logTypes: [UNNAMED],
    });

    expect(result.events).toEqual([]);
    // Not a FAILURE - the search ran and answered.
    expect(result.ok).toBe(true);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("isnotempty(type)==false");
    expect(result.notes[0]).toContain("did not read that filter");
  });

  it("says nothing about filters when an ordinary log type comes back empty", async () => {
    const cribl = client(...jobRun("j-1", ndjson([])));

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "type",
      logTypes: ["TRAFFIC"],
    });

    expect(result.notes).toEqual([
      '"TRAFFIC" returned no events in this window, so it was not added.',
    ]);
  });
});
