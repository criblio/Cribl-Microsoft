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
 */

import { describe, expect, it } from "vitest";

import { FakeCriblClient } from "../../testing/fake-cribl-client";
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
  it("stops after the sample when the log type is buried in _raw", async () => {
    // Selecting over a LOCALLY parsed _raw would hand step two a field the
    // engine cannot see; the summarize would return nothing, which reads as
    // "this dataset holds no log types".
    const cribl = client(...jobRun("j-1", ndjson([{ _raw: "1,2026,fw,TRAFFIC,end" }])));

    const result = await run(cribl);

    // One job, then a full stop: the summarize is never created.
    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      lifecycleOf("j-1"),
    );
    expect(jobsCreated(cribl)).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.noDiscriminator).toBe(true);
    expect(result.discriminatorField).toBeUndefined();
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("capture a sample");
  });
});

describe("the result", () => {
  it("returns per-log-type names AND volumes, biggest first", async () => {
    const result = await run(countingClient());

    expect(result.ok).toBe(true);
    expect(result.logTypes).toEqual([
      { logType: "TRAFFIC", eventCount: 890000 },
      { logType: "THREAT", eventCount: 12 },
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
    expect(result.logTypes).toEqual([{ logType: "4624", eventCount: 7 }]);
  });

  it("reports an unreadable volume as UNKNOWN, never as zero", async () => {
    // Zero is a claim about the data. We would be making it up.
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun("j-2", ndjson([{ type: "TRAFFIC", total: 5 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes).toEqual([{ logType: "TRAFFIC" }]);
    expect(result.logTypes[0].eventCount).toBeUndefined();
    expect(result.notes.join(" ")).toContain("unknown rather than zero");
  });

  it("reads the engine's own count_ column when the alias is ignored", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun("j-2", ndjson([{ type: "TRAFFIC", count_: 42 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes).toEqual([{ logType: "TRAFFIC", eventCount: 42 }]);
  });

  it("leaves out groups with no discriminator value and counts them in a note", async () => {
    const cribl = client(
      ...jobRun("j-1", ndjson(SAMPLE_ROWS)),
      ...jobRun(
        "j-2",
        ndjson([
          { type: "TRAFFIC", [COUNT_COLUMN]: 3 },
          { type: "", [COUNT_COLUMN]: 9 },
        ]),
      ),
    );

    const result = await run(cribl);

    expect(result.logTypes).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("1 group carried no");
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
      { logType: "TRAFFIC", eventCount: 890000 },
      { logType: "THREAT", eventCount: 12 },
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
      { logType: "TRAFFIC", eventCount: 890000 },
      { logType: "THREAT", eventCount: 12 },
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
    for (const bad of [
      { searchGroupId: "" },
      { datasetId: "" },
      { discriminatorField: "" },
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
    expect(listed.logTypes).toEqual([{ logType: "4624", eventCount: 7 }]);

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
    expect(result.logTypes).toEqual([
      { logType: "true", eventCount: 31 },
      { logType: "false", eventCount: 4 },
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
