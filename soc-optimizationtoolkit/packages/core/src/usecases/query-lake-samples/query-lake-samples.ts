/**
 * query-lake-samples - ask Cribl Search which log types a Lake dataset holds,
 * and how many events of each (sample-acquisition plan Phase 4, ADR 0003).
 *
 * THE SEARCH HALF of Phase 4; capture-samples is the other one. Capture pulls
 * bytes off a live source for a few seconds. This reads data that already
 * exists, which is the whole reason the plan calls it the best evidence: it can
 * report the COMPLETE log-type list and per-type volumes rather than whatever
 * happened to flow during a ten-second window.
 *
 * TWO QUERIES, and the split is the plan's own sentence - "Capture answers
 * which field; Search answers what values":
 *
 *   1. dataset="X" | limit 50
 *      a small sample, run through selectDiscriminatorField      -> WHICH FIELD
 *   2. dataset="X" | summarize eventCount=count() by <field> ...
 *      the same field enumerated at dataset scale                -> WHAT VALUES
 *
 * The field is chosen over the rows SEARCH RETURNED, never over a locally
 * parsed _raw. That is not a shortcut, it is the correctness condition: step 2
 * asks the engine to group by that field, so it has to be a field the engine can
 * see. A discriminator recovered by parsing _raw here - the PAN-OS type at CSV
 * column 3, say - would summarize to nothing, and nothing reads to an operator
 * as "this dataset holds no log types".
 *
 * KQL, NOT SPL. Cribl Search speaks Kusto: `summarize`, `where`, `limit`.
 *
 * GROUP-SCOPED, and this is the fact most easily got wrong: /search/* is
 * addressed under the SEARCH group - /m/{searchGroupId}/search/... - even though
 * the OpenAPI spec declares those paths bare. Verified live 2026-08-19 by
 * reading Cribl's own Search UI traffic. The id is resolved from listGroups via
 * isSearchGroup (discover-sample-sources stage one); `default_search` is one
 * workspace's id, not a constant.
 *
 * ONE ROUTE - THE JOB LIFECYCLE (settled live 2026-08-25). This module used to
 * try `GET /search/query` FIRST, on the spec's word that it returns results
 * inline for a single round trip, and fall through to `POST /search/jobs` the
 * moment it "disappointed". Probing the live workspace settled what that route
 * actually does, and the premise was wrong in the expensive direction:
 *
 *   GET /search/query?query=<kql>                    -> 400  (no window given)
 *   GET /search/query?query=<kql>&earliest=-24h&latest=now&offset=0&limit=5
 *       -> 200 {"isFinished":false,"totalEventCount":0,
 *               "job":{"id":"...","status":"queued"}}
 *   GET /search/query?jobId=<that id>&offset=0&limit=5
 *       -> 200 NDJSON: the metadata line, then the rows, once the job finished
 *
 * It CREATES A JOB and hands back the handle. It is the same lifecycle through a
 * different door, not a synchronous route - so there was never a round trip to
 * save, and its "200 with no rows" was never an answer about the data: it was
 * the job sitting in `queued`, on every single call.
 *
 * WHAT THAT COST, and why it is worth this much comment. The fallback fired
 * every time, ran `POST /search/jobs`, and created a SECOND job - so every Lake
 * query ORPHANED one. The "sync is unusable" verdict was memoized per runner and
 * there is one runner per usecase call, so a full operator flow
 * (queryLakeSamples, then fetchLakeLogTypeEvents) orphaned two. And the first
 * route's failure note was unshifted to the FRONT of `notes`, which the Lake
 * panel renders under a SUCCESS headline - raw platform error text shown to an
 * operator whose query had in fact worked.
 *
 * WHY THE ROUTE WAS DELETED RATHER THAN POLLED. Its `job.id` could have been
 * polled instead, which would have been one job per query too. Both doors cost
 * create + poll + read - identical round trips - so keeping the GET buys nothing
 * and costs a second create route, a second job-id envelope to read (`job.id`,
 * not the `items[].id` the POST answers with), and a second thing to keep
 * working. It is also the door Cribl's own UI does NOT use. So it is gone, along
 * with its `/m/:gid/search/query` grant in policies.yml, and what remains is the
 * lifecycle the UI was observed running: POST /search/jobs, poll status, GET
 * results. One job per query, always.
 *
 * AN EMPTY ANSWER IS NOW BELIEVED, which is the behaviour change that follows.
 * The old code refused to call a dataset empty on the spec-only route's word and
 * spent a job confirming it. Only the proven route is left, so "the job
 * completed and returned no rows" IS an empty window and is reported as one -
 * still as `ok` with a note, never as a failure.
 *
 * NDJSON, NOT JSON, on the results route. The port hands the body over as a
 * STRING and it is split by line here; JSON.parsing it whole is the documented
 * mistake.
 *
 * Never throws for a query that fails or returns nothing. An EMPTY dataset and
 * a FAILED read are different answers to the operator and are kept apart all the
 * way out - `ok` plus a note that names what was lost.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import {
  criblEnvelopeItems,
  readNumber,
  readProp,
  readString,
} from "../../domain/cribl-api/envelope";
import { selectDiscriminatorField } from "../../domain/sample-parsing/discriminators";
import { is2xx } from "../arm-http";

/**
 * The job lifecycle's root, in a SEARCH-group context. The ONLY query route
 * this module uses; `GET /search/query` was removed 2026-08-25 (see the header).
 */
export const SEARCH_JOBS_PATH = "/search/jobs";
/** `?advanced=true` is what Cribl's own UI asks for; matched deliberately. */
export const searchJobStatusPath = (jobId: string): string =>
  `${SEARCH_JOBS_PATH}/${encodeURIComponent(jobId)}/status`;
export const searchJobResultsPath = (jobId: string): string =>
  `${SEARCH_JOBS_PATH}/${encodeURIComponent(jobId)}/results`;

/** Query window. A day is long enough to see every log type a source emits. */
export const DEFAULT_EARLIEST = "-24h";
export const DEFAULT_LATEST = "now";

/** How many events a log-type fetch returns per type. Small on purpose. */
export const DEFAULT_SAMPLE_LIMIT = 50;
export const MAX_SAMPLE_LIMIT = 500;

/**
 * How many events step one reads to decide WHICH FIELD - and it is NOT small,
 * because "small on purpose" made log-type detection a coin flip.
 *
 * Step one picks the discriminator by looking for a field with >= 2 distinct
 * values in the sample. Real datasets are SKEWED, so a sample can miss the
 * minority value entirely and the whole dataset then reports "no field
 * distinguishes one log type from another" - the app telling an operator their
 * data has no log types when it has two.
 *
 * Measured live 2026-08-25 on `winevt_plwindows`: 766,570 DNS events to 22,792
 * Security, i.e. 97.1% one value. At the old limit of 50 the chance of drawing
 * no Security event at all is 0.971^50 = 23%, and it was observed both ways on
 * the same dataset within one session - two runs found both channels, two found
 * one. At 500 the same figure is 0.971^500, about three in ten million.
 *
 * This costs one larger response on a query that already runs a job; it does
 * NOT change how many events a log-type FETCH returns (DEFAULT_SAMPLE_LIMIT
 * above), which is a different question with a different answer.
 */
export const DISCRIMINATOR_SAMPLE_LIMIT = 500;
/** How many distinct log types step two will return. */
export const DEFAULT_MAX_LOG_TYPES = 200;
export const MAX_LOG_TYPES_LIMIT = 1000;

/**
 * The name given to the aggregate, so the count column is OURS rather than
 * whatever the engine would have called a bare `count()` (Kusto says `count_`).
 */
export const COUNT_COLUMN = "eventCount";

/** Attempt bound on the job poll, and the delay the SHELL is asked for. */
export const JOB_POLL_ATTEMPTS = 20;
export const JOB_POLL_INTERVAL_MS = 500;

// A `SearchPath` type ("sync" | "async") and a `path` field on the result used
// to say WHICH ROUTE ANSWERED. With one route left they answer "async" forever,
// which is a constant dressed as a diagnostic, so both were removed with the
// sync route. Nothing outside this usecase's own tests ever read them.

/** One log type the dataset holds, with its volume over the queried window. */
export interface LakeLogTypeVolume {
  /** The discriminator value exactly as Search grouped it. */
  logType: string;
  /**
   * Events over the window, or UNDEFINED when the count came back in a column
   * this app does not recognize. Deliberately not defaulted to 0 - a volume of
   * zero is a claim about the data, and we would be making it up.
   */
  eventCount?: number;
}

/** Options for {@link queryLakeSamples}. */
export interface QueryLakeSamplesOptions {
  /**
   * The SEARCH group's id - NOT a Stream worker group. Resolve it with
   * isSearchGroup over listGroups(); a Stream group answers 404 here.
   */
  searchGroupId: string;
  /** The Lake dataset to query, as the dataset listing reported its id. */
  datasetId: string;
  /** Relative time bounds; default a day back to now. */
  earliest?: string;
  latest?: string;
  /** Events step one reads; clamped to 1..{@link MAX_SAMPLE_LIMIT}. */
  sampleLimit?: number;
  /** Distinct log types step two returns; clamped to 1..{@link MAX_LOG_TYPES_LIMIT}. */
  maxLogTypes?: number;
  /**
   * Delay hook for the job poll, injected by the SHELL. Core reads no clock and
   * starts no timer (the onboard-batch pacing rule); when this is absent the
   * poll simply runs back to back and stays attempt-bounded, which is the
   * ensure-tables precedent.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** What one dataset query established. */
export interface QueryLakeSamplesResult {
  /** Echoed so a result can be attributed after the fact. */
  datasetId: string;
  /** The field the counts are grouped by; undefined when none qualified. */
  discriminatorField?: string;
  /** Log types with volumes, biggest first. EMPTY is a result, not a failure. */
  logTypes: LakeLogTypeVolume[];
  /** The window the volumes cover - a count means nothing without it. */
  window: { earliest: string; latest: string };
  /**
   * True when the sample carried NO field distinguishing one log type from
   * another. Surfaced exactly as capture-samples surfaces it: the operator is
   * far better placed to name the log type than any later step is.
   */
  noDiscriminator: boolean;
  /** True when the list hit the row cap and there may be more log types. */
  truncated: boolean;
  /** Operator-facing notes: an empty window, a fallback, an HTTP error. */
  notes: string[];
  /** False when a request failed - `notes` says which and what was lost. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/**
 * Quote a dataset id into the query string. The id comes from Cribl's own
 * listing, but the query is a STRING: one unescaped quote would silently change
 * which dataset is read rather than fail, and a silent wrong dataset is
 * indistinguishable from a wrong answer about the right one.
 */
function quoteDataset(datasetId: string): string {
  return datasetId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Step one: the small sample that decides WHICH FIELD discriminates. */
export function buildDiscriminatorSampleQuery(
  datasetId: string,
  limit: number,
): string {
  return `dataset="${quoteDataset(datasetId)}" | limit ${limit}`;
}

/**
 * Step two: WHAT VALUES that field takes, and how often.
 *
 * SORTED BEFORE THE LIMIT, which is the part worth keeping. Without the sort,
 * `limit` truncates arbitrarily and the log types most worth onboarding - the
 * high-volume ones - are exactly as likely to be cut as the rare ones.
 *
 * The field needs no quoting: it comes from DISCRIMINATOR_FIELDS, which is a
 * frozen list of plain identifiers.
 */
export function buildLogTypeCountQuery(
  datasetId: string,
  discriminatorField: string,
  limit: number,
): string {
  return (
    `dataset="${quoteDataset(datasetId)}"` +
    ` | summarize ${COUNT_COLUMN}=count() by ${discriminatorField}` +
    ` | sort by ${COUNT_COLUMN} desc` +
    ` | limit ${limit}`
  );
}

// ---------------------------------------------------------------------------
// Reading an NDJSON result set
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The SearchJobResults envelope line, which both result routes emit alongside
 * the rows. It describes the RESULT SET - isFinished, totalEventCount, the job -
 * not an event, and counting it as a row would invent a log type out of
 * metadata.
 */
function isResultMetadata(record: Record<string, unknown>): boolean {
  return (
    "isFinished" in record || ("job" in record && "totalEventCount" in record)
  );
}

/**
 * The result rows of a Search response, or `null` when the body is not a result
 * shape at all.
 *
 * `null` and `[]` mean different things and every caller here keeps them apart
 * (envelope.ts states the doctrine): `[]` is "Search answered, and there is
 * nothing"; `null` is "this is not a response we understand", which must never
 * reach an operator as an empty dataset.
 */
export function searchResultRows(
  body: unknown,
): Array<Record<string, unknown>> | null {
  const keepRows = (items: unknown[]): Array<Record<string, unknown>> =>
    items.filter(isRecord).filter((row) => !isResultMetadata(row));

  // The port documents null/undefined as the EMPTY body, so it is emptiness.
  if (body === null || body === undefined) return [];

  if (typeof body === "string") {
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0) return [];
    const parsed: unknown[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Not a result line. Skipped rather than fatal - Search has been seen
        // to prefix diagnostics - but see the guard below.
      }
    }
    // Content that decoded to nothing at all is a body we do not understand,
    // not an empty dataset.
    if (parsed.length === 0) return null;
    return keepRows(parsed);
  }

  const items = criblEnvelopeItems(body);
  if (items !== null) return keepRows(items);
  // A single decoded object: one row, or the metadata line on its own.
  if (isRecord(body)) return keepRows([body]);
  return null;
}

/** Render a failure body for a note the way capture-samples does. */
function detailOf(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body) ?? "";
  } catch {
    return String(body);
  }
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** One attempt at one query. */
interface SearchRun {
  ok: boolean;
  rows: Array<Record<string, unknown>>;
  /**
   * OPERATOR-FACING, and EMPTY ON SUCCESS. A note here is rendered by the Lake
   * panel beneath whatever headline the run earned, so anything pushed on a
   * successful run is error text under a success banner - which is exactly what
   * the deleted sync route did every time it "disappointed".
   */
  notes: string[];
}

/** What the route needs to address the workspace. */
interface RunnerConfig {
  searchGroupId: string;
  earliest: string;
  latest: string;
  sleep?: (ms: number) => Promise<void>;
}

/** Read the created job's id out of whichever envelope it arrived in. */
function readJobId(body: unknown): string | undefined {
  const items = criblEnvelopeItems(body);
  if (items !== null) {
    for (const item of items) {
      const id = readString(item, "id");
      if (id !== undefined) return id;
    }
  }
  return readString(body, "id");
}

/**
 * The job's status, from either shape of status response.
 *
 * `GET /search/jobs/{id}/status` answers in the SAME `{items:[...], count}`
 * envelope the create call uses - there is no top-level `status` key, only
 * `items[0].status`. Reading the top level alone therefore found nothing on
 * every poll, left the status as the empty string, and made the loop run its
 * full attempt budget before reporting the job "still pending" - for a job that
 * was in fact `completed` on the FIRST poll. Every Lake query failed that way,
 * on every dataset, while the suite stayed green because every status response
 * it scripted was the spec's flattened `{status}` - the pins agreeing with the
 * code about a shape neither had checked. They now script the envelope by
 * default; see `jobStatus` in query-lake-samples.test.ts.
 *
 * Confirmed live 2026-08-24: status body keys are exactly `["items","count"]`.
 * The bare read is kept as the fallback rather than replaced, because it is what
 * the OpenAPI spec's own status example returns and both shapes are cheap to
 * accept.
 */
function readJobStatus(body: unknown): string | undefined {
  const items = criblEnvelopeItems(body);
  if (items !== null) {
    for (const item of items) {
      const status = readString(item, "status");
      if (status !== undefined) return status;
    }
  }
  return readString(body, "status");
}

/**
 * The lifecycle Cribl's own UI runs, and since 2026-08-25 the only one this
 * module runs: create, poll status, read a results page.
 *
 * EXACTLY ONE JOB PER CALL. There is no second create anywhere in this file, and
 * that is the property to preserve - the deleted sync route created one job of
 * its own before this function created another, so every query left one behind
 * to expire on Cribl's clock rather than ours.
 */
async function runSearchJob(
  cribl: CriblClient,
  config: RunnerConfig,
  query: string,
  limit: number,
  logger?: Logger,
): Promise<SearchRun> {
  const notes: string[] = [];
  const failed = (note: string): SearchRun => {
    notes.push(note);
    return { ok: false, rows: [], notes };
  };

  let created: { status: number; body: unknown };
  try {
    created = await cribl.request({
      method: "POST",
      path: SEARCH_JOBS_PATH,
      groupId: config.searchGroupId,
      body: {
        query,
        earliest: config.earliest,
        latest: config.latest,
      },
    });
  } catch (err) {
    logger?.warn("query-lake-samples: job create failed", {
      error: String(err),
    });
    return failed(
      `The search job could not be created (${String(err)}), so this dataset's log types are unknown. Capturing from a live source or uploading a sample still works.`,
    );
  }
  if (!is2xx(created.status)) {
    const hint =
      created.status === 401 || created.status === 403
        ? " - the app's credentials may not carry search permission on this group"
        : created.status === 400
          ? " - Cribl rejected the query; its message is above"
          : "";
    return failed(
      `Creating the search job returned HTTP ${created.status}${hint}. ${detailOf(created.body)}`.trim(),
    );
  }

  const jobId = readJobId(created.body);
  if (jobId === undefined) {
    return failed(
      "Cribl accepted the search job but reported no job id, so its results cannot be read.",
    );
  }

  let status = "";
  for (let attempt = 0; attempt < JOB_POLL_ATTEMPTS; attempt += 1) {
    let poll: { status: number; body: unknown };
    try {
      poll = await cribl.request({
        method: "GET",
        path: searchJobStatusPath(jobId),
        groupId: config.searchGroupId,
        query: { advanced: "true" },
      });
    } catch (err) {
      return failed(`Reading the search job's status failed: ${String(err)}.`);
    }
    if (!is2xx(poll.status)) {
      return failed(
        `Reading the search job's status returned HTTP ${poll.status}. ${detailOf(poll.body)}`.trim(),
      );
    }
    status = readJobStatus(poll.body) ?? "";
    if (status === "completed") break;
    if (status === "failed" || status === "canceled") {
      return failed(
        `Cribl reported the search job as ${status}, so this dataset's log types are unknown.`,
      );
    }
    // new | queued | running, or a status this app has not seen: keep waiting.
    // The delay belongs to the shell (see QueryLakeSamplesOptions.sleep); the
    // loop is bounded either way.
    if (attempt < JOB_POLL_ATTEMPTS - 1) {
      await config.sleep?.(JOB_POLL_INTERVAL_MS);
    }
  }
  if (status !== "completed") {
    // NOT an empty dataset. The job may still finish; we simply stopped asking.
    return failed(
      `The search job was still ${status === "" ? "pending" : status} after ${JOB_POLL_ATTEMPTS} status checks, so no log types could be read. A narrower time window is the cheapest next try.`,
    );
  }

  let results: { status: number; body: unknown };
  try {
    results = await cribl.request({
      method: "GET",
      path: searchJobResultsPath(jobId),
      groupId: config.searchGroupId,
      query: { offset: "0", limit: String(limit) },
    });
  } catch (err) {
    return failed(`Reading the search job's results failed: ${String(err)}.`);
  }
  if (!is2xx(results.status)) {
    return failed(
      `Reading the search job's results returned HTTP ${results.status}. ${detailOf(results.body)}`.trim(),
    );
  }
  const rows = searchResultRows(results.body);
  if (rows === null) {
    return failed(
      "The search job's results came back in a shape this app does not recognize.",
    );
  }
  return { ok: true, rows, notes };
}

/**
 * Bind the addressing so a usecase can ask for a query and nothing else.
 *
 * A FACTORY THAT REMEMBERS NOTHING, deliberately. It used to carry a per-runner
 * verdict - whether the sync route had proved usable in this workspace - and
 * that memo is what made the orphaned-job count depend on how many runners a
 * flow built: two, because queryLakeSamples and fetchLakeLogTypeEvents each
 * build their own and each re-learned the same lesson. With one route there is
 * no verdict to hold, so this is now partial application and nothing more. Keep
 * it that way: state here is state that cannot be seen from a call site.
 */
function createSearchRunner(
  cribl: CriblClient,
  config: RunnerConfig,
  logger?: Logger,
): (query: string, limit: number) => Promise<SearchRun> {
  return (query: string, limit: number): Promise<SearchRun> =>
    runSearchJob(cribl, config, query, limit, logger);
}

// ---------------------------------------------------------------------------
// Reading the counts
// ---------------------------------------------------------------------------

/**
 * A group key as text. Not readString: a discriminator value is legitimately
 * numeric (a Windows EventID, say), and dropping those would hide whole log
 * types.
 *
 * The NUMBER-NESS IS LOST HERE, deliberately - a log type is a name by the time
 * an operator picks it. {@link buildLogTypeEventQuery} is what makes that safe
 * on the way back in; read its note before changing either.
 */
function readGroupValue(
  row: Record<string, unknown>,
  field: string,
): string | undefined {
  const raw = readProp(row, field);
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    const text = String(raw).trim();
    return text === "" ? undefined : text;
  }
  return undefined;
}

/**
 * Read the aggregate. {@link COUNT_COLUMN} is the alias the query asks for; the
 * rest are what engines call a bare `count()` and cost one line each, so a
 * workspace that ignores the alias degrades to a right answer rather than a
 * volume-less one.
 */
function readCount(row: Record<string, unknown>): number | undefined {
  return (
    readNumber(row, COUNT_COLUMN) ??
    readNumber(row, "count_") ??
    readNumber(row, "count") ??
    readNumber(row, "count()")
  );
}

interface CountReadout {
  logTypes: LakeLogTypeVolume[];
  /** Rows whose group key was empty - events carrying no log type at all. */
  skipped: number;
  /** Rows whose volume could not be read from any known column. */
  unknownCounts: number;
}

/**
 * Fold the summarize rows into log types, biggest first.
 *
 * Sorted here as well as in the query, and deliberately: the local order is
 * total and deterministic (count descending, then name ascending) whatever
 * order the engine chose, so the same dataset renders the same way twice.
 */
function readCountRows(
  rows: Array<Record<string, unknown>>,
  field: string,
): CountReadout {
  const logTypes: LakeLogTypeVolume[] = [];
  let skipped = 0;
  let unknownCounts = 0;

  for (const row of rows) {
    const logType = readGroupValue(row, field);
    if (logType === undefined) {
      skipped += 1;
      continue;
    }
    const eventCount = readCount(row);
    if (eventCount === undefined) unknownCounts += 1;
    logTypes.push(
      eventCount === undefined ? { logType } : { logType, eventCount },
    );
  }

  logTypes.sort((a, b) => {
    const left = a.eventCount ?? -1;
    const right = b.eventCount ?? -1;
    if (left !== right) return right - left;
    return a.logType.localeCompare(b.logType);
  });
  return { logTypes, skipped, unknownCounts };
}

/** Clamp a caller-supplied bound, and say so when it moved. */
function clampLimit(
  requested: number | undefined,
  fallback: number,
  ceiling: number,
  label: string,
): { value: number; note?: string } {
  if (requested === undefined || !Number.isFinite(requested)) {
    return { value: fallback };
  }
  const value = Math.min(Math.max(Math.floor(requested), 1), ceiling);
  if (value !== requested) {
    return {
      value,
      note: `${label} adjusted to ${value} - this query accepts 1 to ${ceiling}.`,
    };
  }
  return { value };
}

// ---------------------------------------------------------------------------
// The usecase
// ---------------------------------------------------------------------------

/**
 * Query one Lake dataset for its log types and their volumes.
 *
 * TWO QUERIES in the happy case - so two search jobs, and the second one only
 * happens because the first told us what to group by. Two is the floor, not a
 * budget: it was four until 2026-08-25, half of them orphaned by the sync route
 * that turned out to create a job of its own (see the header).
 *
 * Everything that can go wrong folds into `notes` with `ok` false; nothing
 * throws, because a dataset that cannot be queried must still leave capture and
 * manual upload standing.
 */
export async function queryLakeSamples(
  cribl: CriblClient,
  options: QueryLakeSamplesOptions,
  logger?: Logger,
): Promise<QueryLakeSamplesResult> {
  const notes: string[] = [];
  const earliest = options.earliest ?? DEFAULT_EARLIEST;
  const latest = options.latest ?? DEFAULT_LATEST;
  const sample = clampLimit(
    options.sampleLimit,
    DISCRIMINATOR_SAMPLE_LIMIT,
    MAX_SAMPLE_LIMIT,
    "Sample size",
  );
  if (sample.note !== undefined) notes.push(sample.note);
  const cap = clampLimit(
    options.maxLogTypes,
    DEFAULT_MAX_LOG_TYPES,
    MAX_LOG_TYPES_LIMIT,
    "Log-type limit",
  );
  if (cap.note !== undefined) notes.push(cap.note);

  const datasetId = options.datasetId.trim();
  const searchGroupId = options.searchGroupId.trim();

  const base = (
    ok: boolean,
    extra?: Partial<QueryLakeSamplesResult>,
  ): QueryLakeSamplesResult => ({
    datasetId,
    logTypes: [],
    window: { earliest, latest },
    noDiscriminator: false,
    truncated: false,
    notes,
    ok,
    ...extra,
  });

  // Both guards fail as a 404 that reads like an empty dataset, which is the
  // one wrong answer this feature must never give.
  if (searchGroupId === "") {
    notes.push(
      "No Cribl Search group was found in this workspace, so a Lake dataset cannot be queried. Capturing from a live source or uploading a sample still works.",
    );
    return base(false);
  }
  if (datasetId === "") {
    notes.push("No Lake dataset was selected, so there was nothing to query.");
    return base(false);
  }

  const runSearch = createSearchRunner(
    cribl,
    {
      searchGroupId,
      earliest,
      latest,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    },
    logger,
  );

  // STEP ONE - which field discriminates.
  const sampleRun = await runSearch(
    buildDiscriminatorSampleQuery(datasetId, sample.value),
    sample.value,
  );
  notes.push(...sampleRun.notes);
  if (!sampleRun.ok) {
    notes.push(
      `The dataset "${datasetId}" could not be read, so its log types are unknown.`,
    );
    return base(false);
  }
  if (sampleRun.rows.length === 0) {
    // A RESULT. The dataset exists and answered; the window is what is empty.
    // Believed on the JOB's word, which is the proven route - the old code paid
    // a second job to confirm this because the route that said it was spec-only.
    notes.push(
      `The dataset "${datasetId}" holds no events between ${earliest} and ${latest}. Widen the window, or pick a dataset that is still receiving data.`,
    );
    return base(true);
  }

  const discriminatorField = selectDiscriminatorField(sampleRun.rows);
  if (discriminatorField === undefined) {
    notes.push(
      "No field on these events distinguishes one log type from another, so Search has nothing to count by. When the log type is buried in the raw message, Search cannot group on it without a parser - capture a sample and name the log type yourself instead.",
    );
    logger?.info("query-lake-samples: no discriminator", {
      dataset: datasetId,
      sampled: sampleRun.rows.length,
    });
    return base(true, { noDiscriminator: true });
  }

  // STEP TWO - what values that field takes, at dataset scale.
  const countRun = await runSearch(
    buildLogTypeCountQuery(datasetId, discriminatorField, cap.value),
    cap.value,
  );
  notes.push(...countRun.notes);
  if (!countRun.ok) {
    notes.push(
      `The log types in "${datasetId}" could not be counted. The events do carry a "${discriminatorField}" field, so a retry is worth it before falling back to a capture.`,
    );
    return base(false, { discriminatorField });
  }

  const readout = readCountRows(countRun.rows, discriminatorField);
  if (readout.skipped > 0) {
    notes.push(
      `${readout.skipped} group${readout.skipped === 1 ? "" : "s"} carried no "${discriminatorField}" value and ${readout.skipped === 1 ? "was" : "were"} left out.`,
    );
  }
  if (readout.unknownCounts > 0) {
    notes.push(
      `${readout.unknownCounts} log type${readout.unknownCounts === 1 ? "" : "s"} came back without a volume this app could read, so ${readout.unknownCounts === 1 ? "its count is" : "their counts are"} shown as unknown rather than zero.`,
    );
  }
  if (readout.logTypes.length === 0) {
    notes.push(
      `Events in "${datasetId}" carry a "${discriminatorField}" field, but counting it returned no groups. The window may be too narrow, or every event may leave the field empty.`,
    );
    return base(true, { discriminatorField });
  }

  const truncated = countRun.rows.length >= cap.value;
  if (truncated) {
    notes.push(
      `Showing the ${cap.value} highest-volume log types; the dataset may hold more.`,
    );
  }

  logger?.info("query-lake-samples: log types counted", {
    dataset: datasetId,
    discriminator: discriminatorField,
    logTypes: readout.logTypes.length,
    truncated,
  });
  return {
    datasetId,
    discriminatorField,
    logTypes: readout.logTypes,
    window: { earliest, latest },
    noDiscriminator: false,
    truncated,
    notes,
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// Step three: the actual EVENTS for a chosen log type
// ---------------------------------------------------------------------------

/**
 * Fetch real events for ONE log type, so a Lake dataset can become a sample.
 *
 * WHY THIS IS A SEPARATE STEP. `queryLakeSamples` answers "which log types, and
 * how much of each" with a `summarize count()`, which returns COUNTS - one row
 * per log type, no event bodies. Counts are what the operator needs to CHOOSE;
 * they are useless as a sample, because there is nothing to discover fields
 * from. So committing a Lake selection needs this third query, run per chosen
 * log type rather than once, because each becomes its own tagged sample.
 *
 * Deliberately NOT folded into queryLakeSamples: the operator picks which log
 * types are worth taking after seeing the volumes, and fetching events for
 * every log type up front would pull bodies for the ones they discard - on the
 * biggest datasets, which is exactly where it hurts most.
 *
 * `tostring(field)` IS THE LOAD-BEARING PART (2026-08-20 bug-hunt). A
 * discriminator value is legitimately numeric - a Windows EventID is a log type,
 * which is why readGroupValue keeps numbers rather than dropping them - but it
 * reaches this query as TEXT, and a bare `eventType=="4624"` asks Kusto to
 * compare a long against a string. That answers HTTP 400, or worse, nothing at
 * all: the app then tells the operator that "4624" returned no events in this
 * window, about a log type IT had just listed with seven. Empty collapsed into
 * failed, in the one shape where the app contradicts itself to their face.
 * Converting engine-side is a single code path that is right whether the column
 * is a string or a long, or a bool.
 *
 * The alternative was to carry each value's original type on LakeLogTypeVolume
 * and emit an unquoted literal for the numeric ones. Truer to what the column
 * is, and rejected: the type would have to survive the operator's SELECTION -
 * volumes, to checkboxes, to the list they ticked - so the flag has to be kept
 * in step through the panel state and FetchLakeEventsOptions.logTypes, which is
 * a `string[]` precisely because a chosen log type is a NAME. Three layers of
 * state kept in step to spare one cast. The cast costs index usage on that
 * column, which a `| limit 50` behind a single-value filter was never going to
 * feel.
 */
export function buildLogTypeEventQuery(
  datasetId: string,
  field: string,
  logType: string,
  limit: number,
): string {
  // The value is compared with `==` against a quoted literal, so a value
  // carrying a quote would break the query. Cribl's own dataset ids and
  // discriminator values are tame, but the value here came from data rather
  // than from configuration, so it is escaped the same way the dataset id is.
  const value = logType.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `dataset="${quoteDataset(datasetId)}" | where tostring(${field})=="${value}" | limit ${limit}`;
}

/** Options for {@link fetchLakeLogTypeEvents}. */
export interface FetchLakeEventsOptions extends QueryLakeSamplesOptions {
  /** The field the log types were grouped by (from the query result). */
  discriminatorField: string;
  /** The log-type values the operator chose to take. */
  logTypes: readonly string[];
  /** Events per log type; clamped to 1..{@link MAX_SAMPLE_LIMIT}. */
  eventsPerLogType?: number;
}

/** Raw events for one log type, ready to tag. */
export interface LakeLogTypeEvents {
  logType: string;
  /** Event lines as the search returned them, `_raw` preferred. */
  rawEvents: string[];
}

/** What {@link fetchLakeLogTypeEvents} produced. */
export interface FetchLakeEventsResult {
  events: LakeLogTypeEvents[];
  notes: string[];
  /** False when EVERY requested log type failed; a partial haul is ok. */
  ok: boolean;
}

/**
 * Fetch events for each chosen log type.
 *
 * PARTIAL SUCCESS IS SUCCESS. One log type failing must not cost the operator
 * the others - they picked several, and returning nothing because the third of
 * five 400'd would throw away four good samples. Each failure becomes a note
 * naming which log type was lost.
 */
export async function fetchLakeLogTypeEvents(
  cribl: CriblClient,
  options: FetchLakeEventsOptions,
  logger?: Logger,
): Promise<FetchLakeEventsResult> {
  const notes: string[] = [];
  const datasetId = options.datasetId.trim();
  const searchGroupId = options.searchGroupId.trim();
  const field = options.discriminatorField.trim();
  const wanted = options.logTypes.map((t) => t.trim()).filter((t) => t !== "");

  if (searchGroupId === "" || datasetId === "" || field === "" || wanted.length === 0) {
    // Nothing addressable. Reported rather than requested - a blank group id
    // would otherwise 404 at the leader and read as a Cribl fault.
    notes.push(
      "No dataset, search group, discriminator field or log-type selection was given, so no events were requested.",
    );
    return { events: [], notes, ok: false };
  }

  const limit = clampLimit(
    options.eventsPerLogType,
    DEFAULT_SAMPLE_LIMIT,
    MAX_SAMPLE_LIMIT,
    "Events per log type",
  );
  if (limit.note !== undefined) notes.push(limit.note);

  const runSearch = createSearchRunner(
    cribl,
    {
      searchGroupId,
      earliest: options.earliest ?? DEFAULT_EARLIEST,
      latest: options.latest ?? DEFAULT_LATEST,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    },
    logger,
  );

  const events: LakeLogTypeEvents[] = [];
  // Tracked apart from emptiness (2026-08-20 bug-hunt). `ok` was
  // `events.length > 0`, which reported a completely SUCCESSFUL fetch over an
  // empty window as a failure - the empty-vs-failed collapse this codebase
  // treats as its worst shape, in the direction that cries wolf.
  let failed = 0;
  for (const logType of wanted) {
    const run = await runSearch(
      buildLogTypeEventQuery(datasetId, field, logType, limit.value),
      limit.value,
    );
    if (!run.ok) {
      failed += 1;
      notes.push(`"${logType}" could not be fetched: ${run.notes.join(" ")}`);
      continue;
    }
    // `_raw` is the vendor's own bytes and the whole reason a Lake sample is
    // worth having; a row without one is serialized, the same fallback the
    // capture path uses.
    const rawEvents = run.rows.map((row) => {
      const raw = readString(row, "_raw");
      return raw !== undefined ? raw : JSON.stringify(row);
    });
    if (rawEvents.length === 0) {
      notes.push(
        `"${logType}" returned no events in this window, so it was not added.`,
      );
      continue;
    }
    events.push({ logType, rawEvents });
  }

  logger?.info("query-lake-samples: events fetched", {
    dataset: datasetId,
    requested: wanted.length,
    got: events.length,
  });
  // ok = "nothing FAILED", not "something came back". A window that genuinely
  // holds none of the chosen log types is a true answer, and the per-log-type
  // notes already say which returned nothing.
  return { events, notes, ok: failed === 0 };
}
