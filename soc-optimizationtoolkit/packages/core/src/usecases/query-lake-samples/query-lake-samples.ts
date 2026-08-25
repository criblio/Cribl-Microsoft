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
 * WHEN NO FIELD SPLITS THEM, step two still runs - it simply drops the `by`
 * clause (2026-08-25). A dataset holding ONE log type is how people ORGANISE a
 * lake, not a dead end. Measured live on the lab workspace: of 31 datasets 24
 * were empty over -24h, and of the populated ones exactly one yielded a
 * discriminator - `winevt_dcronly` sat there with 1,216 events of a single
 * Windows channel and `azure_alerts_validation` with 265, each split per dataset
 * by design. The app answered all of them with "capture a sample and name the
 * log type yourself", sending the operator to a different acquisition mode for
 * data already in front of them.
 *
 * So the dataset is now OFFERED as one log type, counted by a bare
 * `summarize count()`, and NAMED AFTER THE DATASET. The name is the dataset's
 * own and is reported as exactly that (`datasetAsLogType`): this app does not
 * get to claim a vendor log type it never observed, which is the same reason
 * `data_source` sits in the low-confidence tail of DISCRIMINATOR_FIELDS.
 *
 * STEP ONE'S ROWS ARE READ TWICE (Phase 5's last item, 2026-08-25). Having been
 * fetched to answer WHICH FIELD, they are also grouped by that field and
 * measured, giving a mean bytes-per-event for each log type they contain. That
 * mean times step two's count is the byte ESTIMATE the operator needs to reason
 * about a Sentinel bill, which is charged by volume and not by event - and it
 * costs no extra search job, because the events were already in hand and their
 * bodies were previously thrown away. See LakeLogTypeVolume.meanEventBytes.
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
import {
  estimateDropSavings,
  meanEventBytes,
} from "../../domain/sample-parsing/drop-savings";
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
  /**
   * MEAN BYTES PER EVENT for this log type, measured over STEP ONE'S SAMPLE.
   * Undefined when that sample held none of this log type's events.
   *
   * A count is hard to reason about against a Sentinel bill, which is charged by
   * volume; this is what lets one become a byte estimate (`estimatedLogTypeBytes`
   * in log-type-catalog does the multiplication, and nothing else does).
   *
   * MEASURED, NOT ASSUMED - and free, which is why it is done here. Step one
   * already pulls up to DISCRIMINATOR_SAMPLE_LIMIT real events from this
   * dataset over this same window, and then reads nothing but their field NAMES
   * to pick a discriminator; their bodies were discarded. Grouping those same
   * rows by the same field the counts are grouped by yields a per-log-type mean
   * from that log type's own events, at the cost of no extra search job.
   *
   * WHY IT IS AN ESTIMATE and must be labelled one: the count covers every
   * event in the window, the mean covers at most a few hundred of them. A log
   * type whose event sizes vary widely will have a mean drawn from a sample that
   * may not represent them.
   *
   * ABSENT RATHER THAN SUBSTITUTED when this log type was not sampled. A mean
   * taken across the whole dataset would always be available and would always be
   * wrong - it would price THREAT records using TRAFFIC records' bytes. The
   * skewed datasets that make this happen are exactly the ones where the two
   * differ most.
   */
  meanEventBytes?: number;
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
   *
   * NOT A DEAD END on its own - see {@link datasetAsLogType}, which says what
   * was offered in spite of it.
   */
  noDiscriminator: boolean;
  /**
   * True when the single entry in {@link logTypes} is named after the DATASET
   * rather than after anything observed in the events.
   *
   * The honesty flag for the whole feature. When no field splits a populated
   * dataset it holds one log type, and the only name anyone has for it is the
   * dataset's - so it is offered under that name and this says so, loudly
   * enough that a caller cannot render it as a discovered vendor log type. It
   * is set only alongside `noDiscriminator`, and only when events were actually
   * seen: an EMPTY window leaves both false and offers nothing, because there
   * is nothing there to name.
   *
   * The volume on that entry is a real `summarize count()` over the window, not
   * the size of step one's sample - see {@link buildDatasetTotalQuery}.
   */
  datasetAsLogType: boolean;
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

/**
 * Step two WITHOUT a `by` clause: how many events the dataset holds, full stop.
 *
 * The volume of an UNDISCRIMINATED dataset, and the only honest number for one.
 * The cheaper answer that suggests itself - "step one's rows are already in
 * hand, count those" - is precisely what this exists to avoid: those rows are
 * capped at {@link DISCRIMINATOR_SAMPLE_LIMIT}, so their length measures OUR
 * bound rather than the operator's data. A 1,216-event dataset would report 500
 * and a 400-event one would report 400, and nothing on screen would say which
 * kind of number the operator was looking at. {@link LakeLogTypeVolume} states
 * the same rule from the other side: a bounded grab is not a volume.
 *
 * No sort and no limit, because an ungrouped summarize returns ONE row.
 */
export function buildDatasetTotalQuery(datasetId: string): string {
  return `dataset="${quoteDataset(datasetId)}" | summarize ${COUNT_COLUMN}=count()`;
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

/**
 * ONE result row as the bytes it represents: the vendor's own `_raw` when the
 * row carries one, the serialized row otherwise.
 *
 * ONE DEFINITION, used by both the sample-taking in `fetchLakeLogTypeEvents` and
 * the byte measurement below, because they must agree: the mean this measures is
 * meant to describe the events that path would take. Two rules would let the
 * estimate describe bytes the app never actually ships.
 *
 * `readString` TRIMS and treats "" as absent, so a whitespace-only `_raw` takes
 * the serialized-row fallback and a padded one is measured without its padding.
 * Both are inherited deliberately rather than worked around - the sample keeps
 * exactly these bytes, so the estimate describes exactly what would be kept.
 */
function rowRawText(row: Record<string, unknown>): string {
  const raw = readString(row, "_raw");
  return raw !== undefined ? raw : JSON.stringify(row);
}

/**
 * MEAN BYTES PER EVENT over a set of result rows, or undefined when there is
 * nothing measurable.
 *
 * `[]` dropped fields asks `estimateDropSavings` for `originalBytes` and nothing
 * else, which is exactly the "measure the real size of real events" it already
 * does for the drop reviewer - so there is one definition of what an event
 * weighs in this app, not two.
 */
function meanEventBytesOfRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): number | undefined {
  return meanEventBytes(estimateDropSavings(rows.map(rowRawText), []));
}

/**
 * MEAN BYTES PER EVENT per log type, measured over step one's sample rows.
 *
 * The events-to-bytes half of a Lake volume (sample-acquisition plan Phase 5).
 * Rows are grouped by the SAME field step two counts by - so a log type's mean
 * is drawn from that log type's own events.
 *
 * A log type absent from the sample gets NO ENTRY, and callers must leave its
 * estimate undefined rather than reach for a dataset-wide mean. Pure.
 *
 * The DATASET-AS-ONE-LOG-TYPE path does not call this - it has no field to group
 * by, and every sampled row belongs to its single log type, so it measures the
 * whole sample with {@link meanEventBytesOfRows}. That is the one case where a
 * dataset-wide mean is not a substitution: the dataset IS the log type.
 */
function meanEventBytesByLogType(
  rows: ReadonlyArray<Record<string, unknown>>,
  field: string,
): Map<string, number> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const logType = readGroupValue(row, field);
    if (logType === undefined) continue;
    const bucket = grouped.get(logType);
    if (bucket === undefined) grouped.set(logType, [row]);
    else bucket.push(row);
  }

  const means = new Map<string, number>();
  for (const [logType, group] of grouped) {
    const mean = meanEventBytesOfRows(group);
    if (mean !== undefined) means.set(logType, mean);
  }
  return means;
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
  means: ReadonlyMap<string, number>,
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
    const entry: LakeLogTypeVolume = { logType };
    if (eventCount !== undefined) entry.eventCount = eventCount;
    // Keyed on the value STEP TWO grouped by, matched against the value step one
    // grouped by - both from readGroupValue over the same field, so they are the
    // same strings. A log type the sample never held simply has no mean, and its
    // byte estimate stays absent.
    const mean = means.get(logType);
    if (mean !== undefined) entry.meanEventBytes = mean;
    logTypes.push(entry);
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
    // Both default FALSE, and the pair is what keeps an EMPTY window apart from
    // a single-log-type one. Every early return below - no search group, no
    // dataset, a failed read, an empty window - offers nothing and says nothing
    // about naming; only the branch that actually saw events sets them.
    datasetAsLogType: false,
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
    // ONE LOG TYPE, NAMED AFTER THE DATASET (2026-08-25). Events ARRIVED - the
    // empty-window branch above already returned - and nothing splits them, so
    // this dataset holds a single log type. That is the normal shape of a lake,
    // not a failure, and the old answer ("capture a sample and name the log
    // type yourself") sent the operator to a different acquisition mode for
    // data sitting right here.
    //
    // Step two STILL RUNS, ungrouped, so the row carries a measured volume
    // rather than none. It costs the same one job the `by` form costs, which is
    // why the two-jobs-per-query budget is unchanged.
    const totalRun = await runSearch(buildDatasetTotalQuery(datasetId), 1);
    const totalRow = totalRun.ok ? totalRun.rows[0] : undefined;
    const total = totalRow === undefined ? undefined : readCount(totalRow);

    notes.push(
      `No field on these events distinguishes one log type from another, so "${datasetId}" is offered as a single log type. When the log type is buried in the raw message, Search cannot group on it without a parser; a dataset that holds only one log type has nothing to group by in the first place.`,
    );
    notes.push(
      `That log type is named after the dataset, because the dataset's name is the only name these events came with - it is not a log type found in the data. Rename the sample on its chip once added if you know what these events are.`,
    );
    // The platform's own words, if the count failed. Pushed AFTER the two notes
    // that explain the offer, so an operator whose sample is still perfectly
    // takeable does not read an HTTP error first.
    notes.push(...totalRun.notes);
    if (total === undefined) {
      // NOT a failed query: the dataset was read and the sample is still there
      // to take. Only the volume was lost, and it stays unknown rather than
      // becoming a zero nobody measured.
      notes.push(
        `The events in "${datasetId}" could not be counted, so this log type's volume is shown as unknown rather than zero. The sample itself can still be taken.`,
      );
    }

    logger?.info("query-lake-samples: dataset offered as one log type", {
      dataset: datasetId,
      sampled: sampleRun.rows.length,
      // ABSENT rather than zero when the count could not be read, in the log as
      // on screen: a `counted` key nobody measured is a number a later reader
      // would quote.
      ...(total !== undefined ? { counted: total } : {}),
    });
    // The byte estimate reaches this row too (Phase 5). Every sampled event
    // belongs to this single log type - that is what having no discriminator
    // MEANS here - so the whole sample's mean is this log type's own mean, and
    // measuring it needs no grouping and no extra job. It is the one place a
    // dataset-wide mean is not a substitution for a per-log-type one.
    const mean = meanEventBytesOfRows(sampleRun.rows);
    return base(true, {
      noDiscriminator: true,
      datasetAsLogType: true,
      logTypes: [
        {
          logType: datasetId,
          // Both kept ABSENT rather than zeroed when unmeasured, and they fail
          // independently: an unreadable count leaves a measured mean with
          // nothing to multiply, which is a row that says "volume unknown" and
          // no bytes at all.
          ...(total !== undefined ? { eventCount: total } : {}),
          ...(mean !== undefined ? { meanEventBytes: mean } : {}),
        },
      ],
    });
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

  // The mean event size per log type, measured off STEP ONE'S rows - the ones
  // already in hand. Computed here rather than inside readCountRows because it
  // reads the SAMPLE while that reads the COUNTS, and those are two different
  // result sets from two different queries.
  const means = meanEventBytesByLogType(sampleRun.rows, discriminatorField);
  const readout = readCountRows(countRun.rows, discriminatorField, means);
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
    // A field grouped these, so every name here came OUT OF THE DATA.
    datasetAsLogType: false,
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
 *
 * NO FIELD MEANS NO FILTER (2026-08-25), not no query. When `queryLakeSamples`
 * found nothing to group by it offered the dataset itself as one log type, and
 * for that row every event in the window IS the log type - so the `where`
 * clause is dropped rather than composed against a field that does not exist.
 * A filter on a missing field returns nothing, which the app would then report
 * as "this log type returned no events in this window" about a dataset it had
 * just counted: the empty-versus-failed collapse this file keeps closing.
 */
export function buildLogTypeEventQuery(
  datasetId: string,
  field: string | undefined,
  logType: string,
  limit: number,
): string {
  if (field === undefined || field.trim() === "") {
    // `logType` is deliberately UNUSED here. It is the DATASET'S name, carried
    // so the events can be labelled once they arrive - not a value that exists
    // on any event, and so not something to compare against.
    return `dataset="${quoteDataset(datasetId)}" | limit ${limit}`;
  }
  // The value is compared with `==` against a quoted literal, so a value
  // carrying a quote would break the query. Cribl's own dataset ids and
  // discriminator values are tame, but the value here came from data rather
  // than from configuration, so it is escaped the same way the dataset id is.
  const value = logType.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `dataset="${quoteDataset(datasetId)}" | where tostring(${field})=="${value}" | limit ${limit}`;
}

/** Options for {@link fetchLakeLogTypeEvents}. */
export interface FetchLakeEventsOptions extends QueryLakeSamplesOptions {
  /**
   * The field the log types were grouped by (from the query result), or ABSENT
   * when the query found none and offered the dataset itself as one log type
   * ({@link QueryLakeSamplesResult.datasetAsLogType}).
   *
   * Without it exactly ONE log type may be requested and it is fetched
   * unfiltered - see the guard in {@link fetchLakeLogTypeEvents}.
   */
  discriminatorField?: string;
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
 *
 * TWO SHAPES OF SELECTION, and the guards below keep them apart. With a
 * discriminator field, any number of log types may be taken and each is
 * filtered to. WITHOUT one there is exactly one log type - the dataset's own
 * name - and its query is unfiltered; asking for several under those terms is
 * refused rather than served, because the unfiltered query answers the same for
 * all of them.
 */
export async function fetchLakeLogTypeEvents(
  cribl: CriblClient,
  options: FetchLakeEventsOptions,
  logger?: Logger,
): Promise<FetchLakeEventsResult> {
  const notes: string[] = [];
  const datasetId = options.datasetId.trim();
  const searchGroupId = options.searchGroupId.trim();
  const field = options.discriminatorField?.trim() ?? "";
  const wanted = options.logTypes.map((t) => t.trim()).filter((t) => t !== "");

  if (searchGroupId === "" || datasetId === "" || wanted.length === 0) {
    // Nothing addressable. Reported rather than requested - a blank group id
    // would otherwise 404 at the leader and read as a Cribl fault.
    notes.push(
      "No dataset, search group or log-type selection was given, so no events were requested.",
    );
    return { events: [], notes, ok: false };
  }
  if (field === "" && wanted.length > 1) {
    // WITHOUT A FIELD THERE IS EXACTLY ONE LOG TYPE, and the query that fetches
    // it is unfiltered. Running that once per requested name would hand the SAME
    // events back under several labels - the app claiming log types it never
    // observed, written into the store that drives route and pipeline
    // generation, where each label becomes its own route pair.
    //
    // Refused rather than silently narrowed to the first name: a caller that
    // asked for four is a caller working from a wrong belief, and quietly
    // serving one of them leaves that belief in place.
    notes.push(
      `${wanted.length} log types were requested with no field to tell them apart, so nothing was fetched. When nothing distinguishes a dataset's events it holds one log type, and only that one can be taken.`,
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
    const rawEvents = run.rows.map(rowRawText);
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
