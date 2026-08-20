/**
 * Pins for query-lake-samples (plan Phase 4, ADR 0003).
 *
 * FOUR CLASSES OF FAILURE guarded here, and the first two are asserted on the
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
 *   THE ROUTES   sync first (spec-only), the proven job lifecycle second.
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
  JOB_POLL_ATTEMPTS,
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

/** The happy path: both queries answered by the sync route. */
function syncClient(): FakeCriblClient {
  return client(ok(ndjson(SAMPLE_ROWS)), ok(ndjson(COUNT_ROWS)));
}

const run = (cribl: FakeCriblClient, extra = {}) =>
  queryLakeSamples(cribl, { searchGroupId: GROUP, datasetId: DATASET, ...extra });

describe("addressing - /search/* is GROUP-scoped under the SEARCH group", () => {
  it("GETs /search/query in the search group's context", async () => {
    const cribl = syncClient();

    await run(cribl);

    const call = cribl.calls[0];
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/search/query");
    // The adapter renders this as /m/default_search/search/query. A leader-level
    // call (groupId undefined) is the failure this pin exists for.
    expect(call.groupId).toBe(GROUP);
  });

  it("passes the query, the window and the page bounds as query params", async () => {
    const cribl = syncClient();

    await run(cribl);

    expect(cribl.calls[0].query).toEqual({
      query: `dataset="${DATASET}" | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
      offset: "0",
      limit: String(DEFAULT_SAMPLE_LIMIT),
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
    const cribl = syncClient();

    const result = await queryLakeSamples(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
    });

    expect(cribl.calls).toHaveLength(2);
    expect(cribl.calls[0].query?.query).toBe(
      `dataset="${DATASET}" | limit ${DEFAULT_SAMPLE_LIMIT}`,
    );
    expect(cribl.calls[1].query?.query).toBe(
      `dataset="${DATASET}" | summarize ${COUNT_COLUMN}=count() by type` +
        ` | sort by ${COUNT_COLUMN} desc | limit ${DEFAULT_MAX_LOG_TYPES}`,
    );
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
    const cribl = syncClient();

    const result = await run(cribl, { sampleLimit: 999999 });

    expect(cribl.calls[0].query?.limit).toBe(String(MAX_SAMPLE_LIMIT));
    expect(cribl.calls[0].query?.query).toContain(`limit ${MAX_SAMPLE_LIMIT}`);
    expect(result.notes.join(" ")).toContain(String(MAX_SAMPLE_LIMIT));
  });
});

describe("the discriminator must be a field SEARCH can group by", () => {
  it("stops after the sample when the log type is buried in _raw", async () => {
    // Selecting over a LOCALLY parsed _raw would hand step two a field the
    // engine cannot see; the summarize would return nothing, which reads as
    // "this dataset holds no log types".
    const cribl = client(ok(ndjson([{ _raw: "1,2026,fw,TRAFFIC,end" }])));

    const result = await run(cribl);

    expect(cribl.calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.noDiscriminator).toBe(true);
    expect(result.discriminatorField).toBeUndefined();
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("capture a sample");
  });
});

describe("the result", () => {
  it("returns per-log-type names AND volumes, biggest first", async () => {
    const result = await run(syncClient());

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
    expect(result.path).toBe("sync");
    expect(result.truncated).toBe(false);
  });

  it("keeps a NUMERIC discriminator value instead of dropping the log type", async () => {
    const cribl = client(
      ok(ndjson([{ eventType: 4624 }, { eventType: 4625 }])),
      ok(ndjson([{ eventType: 4624, [COUNT_COLUMN]: 7 }])),
    );

    const result = await run(cribl);

    expect(result.discriminatorField).toBe("eventType");
    expect(result.logTypes).toEqual([{ logType: "4624", eventCount: 7 }]);
  });

  it("reports an unreadable volume as UNKNOWN, never as zero", async () => {
    // Zero is a claim about the data. We would be making it up.
    const cribl = client(
      ok(ndjson(SAMPLE_ROWS)),
      ok(ndjson([{ type: "TRAFFIC", total: 5 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes).toEqual([{ logType: "TRAFFIC" }]);
    expect(result.logTypes[0].eventCount).toBeUndefined();
    expect(result.notes.join(" ")).toContain("unknown rather than zero");
  });

  it("reads the engine's own count_ column when the alias is ignored", async () => {
    const cribl = client(
      ok(ndjson(SAMPLE_ROWS)),
      ok(ndjson([{ type: "TRAFFIC", count_: 42 }])),
    );

    const result = await run(cribl);

    expect(result.logTypes).toEqual([{ logType: "TRAFFIC", eventCount: 42 }]);
  });

  it("leaves out groups with no discriminator value and counts them in a note", async () => {
    const cribl = client(
      ok(ndjson(SAMPLE_ROWS)),
      ok(
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
      ok(ndjson(SAMPLE_ROWS)),
      ok(
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
  it("names the empty WINDOW when the dataset answers with no events", async () => {
    // The sync route is spec-only, so an empty sync answer is confirmed by the
    // proven job path before it is reported as emptiness (see below).
    const cribl = client(
      ok(""),
      ok({ count: 1, items: [{ id: "j-1" }] }),
      ok({ status: "completed" }),
      ok(""),
    );

    const result = await run(cribl);

    expect(result.ok).toBe(true);
    expect(result.logTypes).toEqual([]);
    expect(result.noDiscriminator).toBe(false);
    expect(result.notes.join(" ")).toContain("holds no events between -24h and now");
  });

  it("reports a FAILED read when neither route could establish anything", async () => {
    // The only evidence for "empty" came from the route we do not trust yet, so
    // this must not render like the case above.
    const cribl = client(ok(""), { status: 403, body: "forbidden" });

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.logTypes).toEqual([]);
    expect(result.notes.join(" ")).toContain("search permission");
    expect(result.notes.join(" ")).toContain("did not run");
    expect(result.notes.join(" ")).not.toContain("holds no events");
  });

  it("distinguishes 'the field exists but counts nothing' from a failure", async () => {
    const cribl = client(
      ok(ndjson(SAMPLE_ROWS)),
      ok(ndjson([])),
      ok({ count: 1, items: [{ id: "j-2" }] }),
      ok({ status: "completed" }),
      ok(ndjson([])),
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
      ok(ndjson(SAMPLE_ROWS)),
      { status: 500, body: "boom" },
      { status: 500, body: "boom" },
    );

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.discriminatorField).toBe("type");
    expect(result.notes.join(" ")).toContain("could not be counted");
  });
});

describe("the async job lifecycle - the route that was PROVEN live", () => {
  it("runs create, status?advanced=true, results?offset&limit, all group-scoped", async () => {
    const cribl = client(
      { status: 404, body: "no such route" }, // the spec-only sync route
      ok({ count: 1, items: [{ id: "j-1", status: "new" }] }),
      ok({ status: "running" }),
      ok({ status: "completed" }),
      ok(ndjson(SAMPLE_ROWS)),
      // Step two: the sync verdict is remembered, so it goes straight to a job.
      ok({ count: 1, items: [{ id: "j-2" }] }),
      ok({ status: "completed" }),
      ok(ndjson(COUNT_ROWS)),
    );
    const sleeps: number[] = [];

    const result = await run(cribl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(cribl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /search/query",
      "POST /search/jobs",
      "GET /search/jobs/j-1/status",
      "GET /search/jobs/j-1/status",
      "GET /search/jobs/j-1/results",
      "POST /search/jobs",
      "GET /search/jobs/j-2/status",
      "GET /search/jobs/j-2/results",
    ]);
    expect(cribl.calls.every((c) => c.groupId === GROUP)).toBe(true);
    expect(cribl.calls[1].body).toEqual({
      query: `dataset="${DATASET}" | limit ${DEFAULT_SAMPLE_LIMIT}`,
      earliest: DEFAULT_EARLIEST,
      latest: DEFAULT_LATEST,
    });
    expect(cribl.calls[2].query).toEqual({ advanced: "true" });
    expect(cribl.calls[4].query).toEqual({
      offset: "0",
      limit: String(DEFAULT_SAMPLE_LIMIT),
    });
    // Core reads no clock and starts no timer: the delay is the shell's, and it
    // is asked for only between polls that are still pending.
    expect(sleeps).toEqual([500]);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("async");
    expect(result.logTypes).toHaveLength(2);
  });

  it("percent-encodes a job id rather than growing a path segment", async () => {
    const cribl = client(
      { status: 404, body: "" },
      ok({ count: 1, items: [{ id: "job/1" }] }),
      ok({ status: "completed" }),
      ok(ndjson([{ _raw: "no discriminator here" }])),
    );

    await run(cribl);

    expect(cribl.calls[2].path).toBe("/search/jobs/job%2F1/status");
  });

  it("uses the job's rows when the sync route wrongly reported nothing", async () => {
    const cribl = client(
      ok(""), // 200, no rows - spec-only route, so not believed on its own
      ok({ count: 1, items: [{ id: "j-1" }] }),
      ok({ status: "completed" }),
      ok(ndjson(SAMPLE_ROWS)),
      // Sync is now known-bad for this workspace: step two skips it entirely.
      ok({ count: 1, items: [{ id: "j-2" }] }),
      ok({ status: "completed" }),
      ok(ndjson(COUNT_ROWS)),
    );

    const result = await run(cribl);

    expect(cribl.calls).toHaveLength(7);
    expect(cribl.calls.filter((c) => c.path === "/search/query")).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.logTypes).toHaveLength(2);
    expect(result.notes.join(" ")).toContain("reported no events where a search job found 2");
  });

  it("treats a job that never finishes as FAILED, not as an empty dataset", async () => {
    const cribl = client(
      { status: 404, body: "" },
      ok({ count: 1, items: [{ id: "j-1" }] }),
      ...Array.from({ length: JOB_POLL_ATTEMPTS }, () => ok({ status: "running" })),
    );
    const sleeps: number[] = [];

    const result = await run(cribl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    // Bounded: create + exactly JOB_POLL_ATTEMPTS status reads, then it stops.
    expect(cribl.calls).toHaveLength(2 + JOB_POLL_ATTEMPTS);
    expect(sleeps).toHaveLength(JOB_POLL_ATTEMPTS - 1);
    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).toContain(`${JOB_POLL_ATTEMPTS} status checks`);
  });

  it("reports a job Cribl itself failed", async () => {
    const cribl = client(
      { status: 404, body: "" },
      ok({ count: 1, items: [{ id: "j-1" }] }),
      ok({ status: "failed" }),
    );

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).toContain("as failed");
  });

  it("reports a created job that carried no id", async () => {
    const cribl = client({ status: 404, body: "" }, ok({ count: 0, items: [] }));

    const result = await run(cribl);

    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).toContain("no job id");
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
      ok(ndjson([{ type: "TRAFFIC", _raw: "1,2026/08/13,fw01,TRAFFIC,end" }])),
    );

    const result = await fetchRun(cribl);

    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].logType).toBe("TRAFFIC");
    expect(result.events[0].rawEvents).toEqual(["1,2026/08/13,fw01,TRAFFIC,end"]);
  });

  it("serializes a row with NO _raw rather than dropping the event", async () => {
    const cribl = client(ok(ndjson([{ type: "TRAFFIC", a: 1 }])));

    const result = await fetchRun(cribl);

    expect(result.events[0].rawEvents).toEqual(['{"type":"TRAFFIC","a":1}']);
  });

  it("runs ONE query per chosen log type - each becomes its own sample", async () => {
    const cribl = client(
      ok(ndjson([{ type: "TRAFFIC", _raw: "a" }])),
      ok(ndjson([{ type: "THREAT", _raw: "b" }])),
    );

    const result = await fetchRun(cribl, { logTypes: ["TRAFFIC", "THREAT"] });

    expect(cribl.calls).toHaveLength(2);
    expect(result.events.map((e) => e.logType)).toEqual(["TRAFFIC", "THREAT"]);
  });

  it("PARTIAL SUCCESS is success - one failure does not cost the others", async () => {
    // The operator picked several. Returning nothing because the second 400'd
    // would throw away a good sample they can use.
    const cribl = client(
      ok(ndjson([{ type: "TRAFFIC", _raw: "a" }])),
      { status: 400, body: "bad query" },
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
    // An empty SYNC answer is inconclusive by design, so the job path has to
    // confirm the emptiness before it is reported as such - four responses, not
    // one. Scripting it fully is what makes this pin about the EMPTY outcome
    // rather than about a half-scripted fake.
    const cribl = client(
      ok(""),
      ok({ count: 1, items: [{ id: "j-1" }] }),
      ok({ status: "completed" }),
      ok(""),
    );

    const result = await fetchRun(cribl);

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
    const cribl = client(ok(ndjson([{ type: "TRAFFIC", _raw: "a" }])));

    await fetchRun(cribl);

    expect(cribl.calls[0].groupId).toBe(GROUP);
    expect(cribl.calls[0].path).toContain("/search/");
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
      ok(ndjson([{ eventType: 4624 }, { eventType: 4625 }])),
      ok(ndjson([{ eventType: 4624, [COUNT_COLUMN]: 7 }])),
    );

    const listed = await run(counting);

    expect(listed.discriminatorField).toBe("eventType");
    expect(listed.logTypes).toEqual([{ logType: "4624", eventCount: 7 }]);

    // Step three is handed exactly what step two produced, with no re-typing in
    // between - that hand-off IS the round trip, and it is where the value's
    // number-ness was lost.
    const fetching = client(
      ok(ndjson([{ eventType: 4624, _raw: "An account was successfully logged on." }])),
    );

    const fetched = await fetchLakeLogTypeEvents(fetching, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: listed.discriminatorField ?? "",
      logTypes: listed.logTypes.map((entry) => entry.logType),
    });

    expect(fetching.calls).toHaveLength(1);
    expect(fetching.calls[0].query?.query).toBe(
      `dataset="${DATASET}" | where tostring(eventType)=="4624"` +
        ` | limit ${DEFAULT_SAMPLE_LIMIT}`,
    );
    expect(fetched.ok).toBe(true);
    expect(fetched.events).toEqual([
      { logType: "4624", rawEvents: ["An account was successfully logged on."] },
    ]);
  });

  it("fetches a value that merely LOOKS numeric but arrived as a string", async () => {
    // `type` is a string column whose values happen to be digits. The cast is a
    // no-op on it, which is what lets one code path serve both columns.
    const cribl = client(ok(ndjson([{ type: "4624", _raw: "x" }])));

    const result = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: GROUP,
      datasetId: DATASET,
      discriminatorField: "type",
      logTypes: ["4624"],
    });

    expect(cribl.calls[0].query?.query).toBe(
      `dataset="${DATASET}" | where tostring(type)=="4624" | limit ${DEFAULT_SAMPLE_LIMIT}`,
    );
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([{ logType: "4624", rawEvents: ["x"] }]);
  });

  it("keeps a BOOLEAN group value too, and the same cast covers it", async () => {
    // readGroupValue accepts booleans - some vendors emit allow/deny that way -
    // and a bool column refuses a string comparison exactly as a long does.
    const cribl = client(
      ok(ndjson([{ action: true }, { action: false }])),
      ok(
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
    const cribl = client(
      { status: 400, body: "bad query" },
      { status: 400, body: "bad query" },
    );

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
