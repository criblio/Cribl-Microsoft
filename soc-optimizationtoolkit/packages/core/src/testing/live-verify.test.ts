/**
 * LIVE verification of the platform beliefs Phases 3-4 rest on (ADR 0003).
 *
 * SKIPPED unless CRIBL_LIVE_TOKEN and CRIBL_LIVE_BASE are set, so `npm test`
 * stays hermetic. Nothing here is part of the normal gate; this is the suite you
 * run against a real workspace, and the only one that can fail for a reason no
 * fake could produce.
 *
 * WHY IT EXISTS. Everything else in Phases 3-4 is pinned against
 * FakeCriblClient, which verifies our logic and structurally cannot verify a
 * belief about Cribl. On 2026-08-20 one of those beliefs was wrong: `__inputId`
 * is `<type>:<id>`, not the bare id `/system/inputs` returns, so the source
 * clause matched nothing and every capture would have come back empty - and been
 * reported to the operator as an idle source. Sixty-odd green tests sat over it.
 * It was caught by reading the vendored spec, which is luck, not method.
 *
 * IT OBSERVES RATHER THAN INFERS, and that is the whole design. The decisive
 * check does not ask "does our filter match?" - a no would be ambiguous between
 * a wrong filter and an idle source, which is exactly the confusion this product
 * exists to end. It captures with `filter: "true"` and READS `__inputId` off the
 * returned events. That is a fact, not an inference, and it settles the belief in
 * one call whichever way it goes.
 *
 * Every check is READ-ONLY. A capture observes data already flowing; it changes
 * no configuration and writes nothing.
 *
 * Run:
 *   CRIBL_LIVE_BASE=https://<workspace>.cribl.cloud/api/v1 \
 *   CRIBL_LIVE_TOKEN=<bearer> \
 *   npx vitest run --root packages/core src/testing/live-verify.test.ts
 */

import { describe, expect, it } from "vitest";

import { buildCaptureFilter } from "../domain/capture-filter/capture-filter";
import { extractCapturedEvents } from "../usecases/capture-samples/capture-samples";
import {
  DEFAULT_LAKE_ID,
  lakeDatasetsPath,
  loadSampleSources,
} from "../usecases/discover-sample-sources/discover-sample-sources";
import {
  fetchLakeLogTypeEvents,
  queryLakeSamples,
} from "../usecases/query-lake-samples/query-lake-samples";
import type {
  CriblClient,
  CriblGroupSummary,
  CriblRequest,
} from "../ports/cribl-client";
import {
  deriveGroupProduct,
  isSearchGroup,
  isStreamWorkerGroup,
} from "../ports/cribl-client";
import type { PortHttpResponse } from "../ports/http";

const BASE = process.env.CRIBL_LIVE_BASE ?? "";
const TOKEN = process.env.CRIBL_LIVE_TOKEN ?? "";
const LIVE = BASE !== "" && TOKEN !== "";

/**
 * Pin the capture group. Optional - without it the suite resolves one that has
 * CONNECTED WORKERS, which is the part that matters (see below).
 */
const GROUP = process.env.CRIBL_LIVE_GROUP ?? "";

/**
 * A REAL delay, because the whole point of this suite is to run what ships.
 *
 * Core takes an injected `sleep` and calls it as `await config.sleep?.(ms)`, so
 * omitting it is a silent no-op: the poll loop still runs and simply never
 * waits. Passing none here fired all twenty status polls inside a millisecond
 * and reported a job "still running" that completed a second later - measuring
 * this suite's own impatience rather than the platform.
 */
const liveSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pin the Lake dataset. Optional - without it the suite walks the listing. */
const DATASET = process.env.CRIBL_LIVE_DATASET ?? "";
/** How many datasets to try before giving up. An empty one costs ~1.4s. */
const MAX_DATASET_ATTEMPTS = 12;

/** What queryLakeSamples hands back, named so the walk can hold one. */
type LakeCount = Awaited<ReturnType<typeof queryLakeSamples>>;

/**
 * The cloud adapter's body handling, reproduced deliberately.
 *
 * It JSON.parses the WHOLE body and falls back to raw text - which is why a
 * ONE-LINE NDJSON capture arrives as an OBJECT rather than a string, the shape
 * no fixture built from `lines.join("\n")` can ever produce. Reproducing it here
 * rather than simplifying is the point: a probe that parsed more sensibly than
 * the shipping adapter would verify a client we do not ship.
 */
function readPortBody(text: string): unknown {
  if (text === "") return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function liveClient(): CriblClient {
  const call = async (opts: CriblRequest): Promise<PortHttpResponse> => {
    const prefix = opts.groupId === undefined ? "" : `/m/${opts.groupId}`;
    const qs =
      opts.query === undefined ? "" : `?${new URLSearchParams(opts.query)}`;
    const res = await fetch(`${BASE}${prefix}${opts.path}${qs}`, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    return { status: res.status, body: readPortBody(await res.text()) };
  };

  return {
    request: call,
    listGroups: async (): Promise<CriblGroupSummary[]> => {
      const res = await call({ method: "GET", path: "/master/groups" });
      const items = (res.body as { items?: unknown[] })?.items ?? [];
      return items.map((raw) => {
        const g = raw as Record<string, unknown>;
        const product = deriveGroupProduct(g.product, g.type, g.isFleet, g.isSearch);
        return {
          id: String(g.id),
          ...(product === undefined ? {} : { product }),
        };
      });
    },
  };
}

/** One input as /system/inputs reports it. */
interface LiveInputSummary {
  id: string;
  type: string;
}

/** Report a finding so a run reads as evidence rather than a pass/fail wall. */
function report(row: string, verdict: string, detail: string): void {
  // eslint-disable-next-line no-console
  console.log(`[live-verify] ${row}: ${verdict}\n              ${detail}`);
}

/**
 * The ids of worker groups that currently have at least one worker CONNECTED,
 * read from the leader's own worker listing.
 *
 * Group membership is a config fact and says nothing about whether anything is
 * running: `/master/groups` lists a group whether or not a worker ever joined
 * it. Capture executes on a worker, so this is the difference between a capture
 * that can answer and a guaranteed 400.
 */
async function groupsWithWorkers(client: CriblClient): Promise<Set<string>> {
  const res = await client.request({ method: "GET", path: "/master/workers" });
  const items = ((res.body as { items?: unknown[] })?.items ?? []) as Record<
    string,
    unknown
  >[];
  const staffed = new Set<string>();
  for (const w of items) {
    const info = (w.info ?? {}) as Record<string, unknown>;
    const group = w.group ?? w.workerGroup ?? info.workerGroup;
    if (typeof group === "string" && group !== "") staffed.add(group);
  }
  return staffed;
}

describe.skipIf(!LIVE)("live verification against a real workspace", () => {
  const cribl = liveClient();

  /** Resolved once and shared: the group and source everything else uses. */
  let groupId = "";
  let inputs: LiveInputSummary[] = [];

  it("row 7 - the credentials can list groups and inputs", async () => {
    const groups = await cribl.listGroups();
    expect(groups.length).toBeGreaterThan(0);

    // A Stream group, which is where /system/inputs and /system/capture live.
    //
    // IT MUST HAVE CONNECTED WORKERS. Capture runs ON a worker, so a group with
    // none answers `400 {"message":"No worker nodes are connected to this worker
    // group."}` no matter what the filter says. This used to take stream[0],
    // which in the lab is `default` and has no workers - so rows 1, 2, 4 and 5
    // failed on a platform precondition and row 8 read the same 400 as "Cribl
    // rejected the undeclared field", a verdict about the evaluator drawn from a
    // request that never reached one. Found on the 2026-08-24 live run.
    //
    // Note this filters on the `stream` TYPE rather than "not search": the
    // groups listing also carries edge fleets and outposts, and capturing on an
    // edge fleet is a different thing from the Stream capture under test.
    const stream = groups.filter(isStreamWorkerGroup);
    expect(stream.length).toBeGreaterThan(0);

    const staffed = await groupsWithWorkers(cribl);
    const candidates =
      GROUP === "" ? stream.filter((g) => staffed.has(g.id)) : stream.filter((g) => g.id === GROUP);

    if (candidates.length === 0) {
      const why =
        GROUP === ""
          ? `no Stream group has connected workers (staffed: ${[...staffed].join(", ") || "none"})`
          : `CRIBL_LIVE_GROUP=${GROUP} is not a Stream group in this workspace`;
      report("row 7 (permission)", "CANNOT RUN", why);
      expect.fail(`${why} - capture rows cannot be settled against this workspace`);
    }
    groupId = candidates[0].id;

    const res = await cribl.request({
      method: "GET",
      path: "/system/inputs",
      groupId,
    });
    expect(res.status).toBe(200);
    const items = ((res.body as { items?: unknown[] })?.items ?? []) as Record<
      string,
      unknown
    >[];
    inputs = items
      .filter((i) => i.disabled !== true)
      .map((i) => ({ id: String(i.id), type: String(i.type ?? "unknown") }));

    report(
      "row 7 (permission)",
      "CONFIRMED",
      `group ${groupId}, ${inputs.length} enabled inputs`,
    );
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("rows 1+2+4+5 - what a real capture returns, and what __inputId holds", async () => {
    expect(groupId).not.toBe("");
    expect(inputs.length).toBeGreaterThan(0);

    // THE CONTROL. Unfiltered, so a later zero cannot be blamed on our filter.
    // Without this the whole run would reproduce the ambiguity it exists to
    // resolve: no events from a filter is not evidence the filter is wrong.
    const control = await cribl.request({
      method: "POST",
      path: "/system/capture",
      groupId,
      // 50 rather than 20, and the reason is row 1. A busy worker emits its own
      // internal stats events constantly, and NOT ALL of those carry
      // __inputId - so a small unfiltered grab can come back entirely internal
      // and row 1 reports "no captured event carried __inputId" about a field
      // that is present on every SOURCE event. Observed 2026-08-25: 20 events
      // caught none, 40 caught five distinct input ids. Duration stays 10s
      // because row 5 pins the clamp on it.
      body: { filter: "true", maxEvents: 50, duration: 10, level: 0 },
    });

    // Row 5: a 10s capture must survive the transport at all.
    expect(control.status).toBe(200);
    report("row 5 (12s clamp)", "CONFIRMED", "a 10s capture completed over the bridge");

    const events = extractCapturedEvents(control.body);
    if (events.lines.length === 0) {
      report(
        "rows 1/2/4",
        "INCONCLUSIVE",
        "every source was idle for 10s - rerun when traffic is flowing",
      );
      return;
    }

    // ROW 1, OBSERVED. Decode one event and read __inputId off it, rather than
    // asking whether our filter matched.
    const decoded = events.lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
    // THE ENVELOPE, not the payload. extractCapturedEvents returns the `_raw`
    // STRINGS - the inner event - so `decoded` above is the vendor payload with
    // its own fields (Id, ProviderName, ... for Windows). `__inputId` is a
    // field of the CAPTURE ENVELOPE, sitting beside `_raw`, so it is gone by
    // then. Rows 1 and 2 both ask about the envelope, and reading them off the
    // payload is why row 1 reported "no captured event carried __inputId" on
    // every run since this suite was written - a structural blind spot, not an
    // idle source. Confirmed 2026-08-25 by parsing the same capture by hand:
    // 40 of 40 events carried __inputId (cribl_tcp:in_cribl_tcp_WinEvt_plwindows,
    // syslog:PaloAlto:tcp, datagen:paloaltorfc5424, ...).
    const envelopes: Record<string, unknown>[] = Array.isArray(control.body)
      ? (control.body as Record<string, unknown>[])
      : typeof control.body === "string"
        ? control.body
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== "")
            .map((l) => {
              try {
                return JSON.parse(l) as Record<string, unknown>;
              } catch {
                return null;
              }
            })
            .filter((e): e is Record<string, unknown> => e !== null)
        : [];
    const rawBodies = envelopes.length > 0 ? envelopes : decoded;
    const withInputId = rawBodies.filter(
      (e) => typeof e.__inputId === "string",
    );

    if (withInputId.length > 0) {
      const observed = String(withInputId[0].__inputId);
      const qualified = observed.includes(":");
      report(
        "row 1 (__inputId)",
        qualified ? "CONFIRMED type-qualified" : "BARE id - fix is wrong",
        `observed __inputId = ${observed}`,
      );
      // THE SHIPPED RULE, not a restatement of it. inputPredicate compares the
      // SECOND COLON SEGMENT (capture-filter.ts), and this line used to use the
      // `.endsWith(":" + id)` form that predicate deliberately REPLACED on
      // 2026-08-21 - because `"syslog:pfsense:10.0.0.1".endsWith(":pfsense")`
      // is false. So on any three-segment syslog id the harness would have
      // failed and blamed the platform for a defect the product had already
      // fixed. Observed live 2026-08-25: `syslog:PaloAlto:tcp` against an input
      // whose id is `PaloAlto`.
      //
      // Restating a shipped rule in the probe is the same sin as hand-rolling a
      // client: it verifies something we do not ship.
      const segmentOf = (v: string): string | undefined => v.split(":")[1];
      const known = inputs.find(
        (i) => observed === i.id || segmentOf(observed) === i.id,
      );
      expect(
        known,
        `no /system/inputs id matches observed __inputId ${observed}`,
      ).toBeDefined();
      if (known !== undefined) {
        const filter = buildCaptureFilter({ inputId: known.id });
        // eslint-disable-next-line no-new-func
        const selects = new Function("__inputId", `return ${filter};`)(
          observed,
        ) as boolean;
        expect(selects, `${filter} did not select ${observed}`).toBe(true);
      }
    } else {
      report("row 1 (__inputId)", "INCONCLUSIVE", "no captured event carried __inputId");
    }

    // ROW 2: are structured fields present at LEVEL 0, or only _raw?
    //
    // THE QUESTION IS "ANY BROKEN-OUT FIELD", NOT FOUR PARTICULAR NAMES. This
    // used to look for sourcetype/type/subtype/eventType and report "only _raw
    // on this source" when it found none - which it duly did against a Windows
    // Event source whose events carry Id, ProviderName, LogName, MachineName,
    // RecordId and seven more. Every one of those is a broken-out field, so the
    // belief was CONFIRMED while the row said the opposite, and the detail line
    // printed the very keys that refuted it. Fixed 2026-08-25, same class of
    // error as row 8's.
    //
    // `_raw`, `_time` and the `__`-prefixed control fields are excluded because
    // they are the envelope every event has; what row 2 asks is whether the
    // source ALSO parsed a payload.
    const sample = rawBodies[0] ?? {};
    const structured = Object.keys(sample).filter(
      (k) => k !== "_raw" && k !== "_time" && !k.startsWith("__"),
    );
    report(
      "row 2 (level-0 fields)",
      structured.length > 0
        ? `CONFIRMED present (${structured.length} broken-out fields)`
        : "only _raw on this source",
      `keys: ${Object.keys(sample).slice(0, 12).join(", ")}`,
    );
  });

  it("row 8 - does Cribl THROW on an undeclared field, or tolerate it?", async () => {
    // The premise the whole predicate design rests on, and it has never been
    // tested against the real evaluator. capture-filter.ts asserts that a Cribl
    // filter is JavaScript, so referencing a name the event does not carry is a
    // ReferenceError that drops the event - which is why every field access is
    // typeof-guarded and why an unguarded `_raw` was a real defect.
    //
    // But Cribl's own documented examples reference bare fields (`status >= 400`)
    // that plainly do not exist on every event. If the evaluator tolerates
    // undeclared names, the guards are harmless insurance rather than load
    // bearing. Either answer is worth having written down; what is NOT worth
    // having is the guess.
    //
    // Asked two ways, because they fail differently: a bare reference to a name
    // no event carries, and the guarded form of the same thing. If the bare one
    // errors or returns nothing while the guarded one behaves, the ReferenceError
    // model is right.
    const bare = await cribl.request({
      method: "POST",
      path: "/system/capture",
      groupId,
      body: {
        filter: "__soc_no_such_field__ === undefined",
        maxEvents: 5,
        duration: 8,
        level: 0,
      },
    });
    const guarded = await cribl.request({
      method: "POST",
      path: "/system/capture",
      groupId,
      body: {
        filter: 'typeof __soc_no_such_field__ === "undefined"',
        maxEvents: 5,
        duration: 8,
        level: 0,
      },
    });

    const bareCount = extractCapturedEvents(bare.body).lines.length;
    const guardedCount = extractCapturedEvents(guarded.body).lines.length;
    // THE GUARDED REQUEST IS THE CONTROL. It references the same undeclared
    // name in the form the evaluator must accept, so if IT fails the failure is
    // environmental and says nothing about undeclared fields.
    //
    // This ordering is the fix for a false verdict this row produced on
    // 2026-08-24: run against a group with no connected workers, both requests
    // came back `400 No worker nodes are connected`, and `bare.status >= 400`
    // reported "REJECTED outright - guards are load-bearing" - a conclusion
    // about the JavaScript evaluator drawn from a request that never reached
    // one. A non-2xx control now yields no verdict at all, which is the only
    // honest reading of it.
    report(
      "row 8 (undeclared field)",
      guarded.status >= 400
        ? "CANNOT RUN - the control request itself failed"
        : bare.status >= 400
          ? "REJECTED outright - guards are load-bearing"
          : bareCount === 0 && guardedCount > 0
            ? "DROPS events - guards are load-bearing"
            : bareCount > 0
              ? "TOLERATED - guards are insurance, not load-bearing"
              : "INCONCLUSIVE - both returned nothing, source may be idle",
      `bare HTTP ${bare.status} / ${bareCount} events; guarded HTTP ${guarded.status} / ${guardedCount} events`,
    );

    // Deliberately NOT asserted either way. This test exists to record which
    // world we are in, and both worlds are acceptable - the guards are correct
    // in one and merely redundant in the other. Failing the run over a fact we
    // went looking for would be asserting the conclusion.
    expect(guarded.status).toBeLessThan(500);
  });

  it("row 4 - a capture of exactly ONE event is not read as empty", async () => {
    expect(groupId).not.toBe("");
    const res = await cribl.request({
      method: "POST",
      path: "/system/capture",
      groupId,
      body: { filter: "true", maxEvents: 1, duration: 10, level: 0 },
    });
    expect(res.status).toBe(200);

    const got = extractCapturedEvents(res.body);
    const bodyIsObject =
      res.body !== null && typeof res.body === "object" && !Array.isArray(res.body);
    report(
      "row 4 (single event)",
      got.lines.length === 1 ? "CONFIRMED" : `read ${got.lines.length} lines`,
      `body arrived as ${bodyIsObject ? "an OBJECT (the decode path that used to return [])" : typeof res.body}`,
    );
    // Zero is the failure this row exists to catch. One is the fix working.
    // More than one means the worker ignored maxEvents, which is not our bug.
    expect(got.lines.length).toBeGreaterThan(0);
  });

  it("rows 3+6 - Lake datasets list, and the SHIPPED tostring() query runs", async () => {
    const groups = await cribl.listGroups();
    const search = groups.find(isSearchGroup);
    if (search === undefined) {
      report("rows 3/6 (Lake)", "SKIPPED", "this workspace has no Search group");
      return;
    }

    // Row 6: the dataset listing THE APP ACTUALLY CALLS.
    //
    // This probed `/m/{gid}/search/datasets` until 2026-08-23, which is a
    // different route from the one loadSampleSources uses - so a green run
    // confirmed a listing the app never asks for while the app's own leader
    // route went untested. That is precisely the failure this file exists to
    // prevent, committed inside the file itself. It now drives the shipped
    // function, for the same reason the query below drives queryLakeSamples.
    //
    // Row 6 ALSO carried a wrong belief: "lakeId is discoverable". It is not.
    // Every lake path in the vendored spec requires a {lakeId} and there is no
    // route that lists lakes, so `default` is a constant we assert rather than
    // resolve. What this run settles is whether that constant is RIGHT.
    const inventory = await loadSampleSources(cribl, { mode: "lake-query" });
    const lakeSection = inventory.sections.find((s) => s.kind === "lake-dataset");
    const entries = lakeSection?.entries ?? [];
    report(
      "row 6 (dataset listing, leader route)",
      lakeSection?.status === "ok"
        ? entries.length > 0
          ? "CONFIRMED"
          : "ANSWERED, but the lake is empty"
        : `NOT ANSWERED (${lakeSection?.status ?? "no section"})`,
      `GET ${lakeDatasetsPath(DEFAULT_LAKE_ID)} -> ${entries.length} datasets` +
        (lakeSection?.note === undefined ? "" : ` | ${lakeSection.note}`),
    );

    // The diagnostic runs BEFORE the assertion, deliberately: it is most
    // valuable exactly when the leader route did not answer, and asserting
    // first would abort the run before printing the thing that explains why.
    // Not a second attempt at passing - if the group-scoped route answers
    // where ours did not, the app is calling the wrong one and this says so.
    // `/search/datasets` stays undeclared in policies.yml on purpose: we do
    // not grant a route until we mean to use it.
    if (lakeSection?.status !== "ok" || entries.length === 0) {
      const alt = await cribl.request({
        method: "GET",
        path: "/search/datasets",
        groupId: search.id,
      });
      const altCount = ((alt.body as { items?: unknown[] })?.items ?? []).length;
      report(
        "row 6 (fallback probe)",
        altCount > 0 ? "APP CALLS THE WRONG ROUTE" : `HTTP ${alt.status}`,
        `/m/${search.id}/search/datasets -> ${altCount} datasets. ` +
          (altCount > 0
            ? "Repoint discoverSampleSources at the group-scoped route and declare it."
            : "Neither route lists datasets; the lake may be empty."),
      );
    }

    // THE ROUTE MUST ANSWER. An empty lake is a real answer and must not fail
    // the run; a 403/404 is not, and must. `status` is what separates them -
    // loadSampleSources catches its own errors and reports `failed` rather
    // than throwing, so without this assertion the row degraded to a console
    // line and the suite went green on an unconfirmed belief. That is the
    // exact false-green this file exists to prevent, and it was introduced
    // HERE on 2026-08-23 while fixing the wrong-route bug above. Found by the
    // architecture audit's test-pin check the same day.
    expect(lakeSection).toBeDefined();
    expect(lakeSection?.status).toBe("ok");

    if (entries.length === 0) {
      report("row 3 (tostring)", "SKIPPED", "no datasets to query");
      return;
    }

    // NOT entries[0]. The listing is sorted by label, so entries[0] is whichever
    // dataset id sorts first alphabetically - uncorrelated with holding data or
    // a discriminator. In the lab that is `azure_alerts_validation`: populated
    // and fast, but single-log-type, so row 3 was skipped on EVERY run and
    // tostring() went permanently untested behind a green row 6. Walk instead,
    // and say what was walked.
    const candidates =
      DATASET === ""
        ? entries.slice(0, MAX_DATASET_ATTEMPTS)
        : entries.filter((e) => e.id === DATASET);
    if (candidates.length === 0) {
      expect.fail(`CRIBL_LIVE_DATASET=${DATASET} is not in this lake listing`);
    }

    const tried: string[] = [];
    let chosen: { id: string; counted: LakeCount } | undefined;
    let sawEvents = false;

    for (const entry of candidates) {
      // THE SHIPPED FUNCTION, not a hand-rolled approximation of it - it owns
      // its own query text and route choice, which is the whole reason this
      // suite exists.
      const counted = await queryLakeSamples(cribl, {
        searchGroupId: search.id,
        datasetId: entry.id,
        sleep: liveSleep,
      });

      // A FAILED READ IS ROW 6'S FAILURE and must not be walked past: skipping
      // it would let a 403 or a poll timeout hide behind the next dataset that
      // happened to work, collapsing "could not read" into "nothing to see".
      expect(
        counted.ok,
        `dataset "${entry.id}" could not be read: ${counted.notes.join(" | ")}`,
      ).toBe(true);

      if (!counted.noDiscriminator) sawEvents = true;
      // The NOTES matter as much as the count. "0 log types" alone cannot tell
      // an empty dataset from one whose rows never arrived, and those need
      // different fixes.
      tried.push(
        `${entry.id}: ${counted.logTypes.length} log types` +
          (counted.noDiscriminator ? " (no discriminator)" : "") +
          (counted.notes.length > 0 ? ` [${counted.notes.join(" ; ")}]` : ""),
      );
      if (counted.discriminatorField !== undefined && counted.logTypes.length > 0) {
        chosen = { id: entry.id, counted };
        break;
      }
    }

    report(
      "row 6 (queryLakeSamples)",
      chosen === undefined ? "NO USABLE DATASET" : "CONFIRMED",
      chosen === undefined
        ? `tried ${tried.length}: ${tried.join(" | ")}`
        : `${chosen.id} -> ${chosen.counted.logTypes.length} log types by ${chosen.counted.discriminatorField}`,
    );

    if (chosen === undefined) {
      // NOT a failure. A lake holding nothing groupable is a real state the app
      // must handle, and failing here would assert a conclusion about someone's
      // data. It IS reported loudly, because it means tostring() went untested.
      report(
        "row 3 (tostring)",
        sawEvents ? "UNTESTED - data present, no discriminator" : "INCONCLUSIVE - every dataset idle",
        `tried ${tried.join(" | ")}`,
      );
      return;
    }
    const counted = chosen.counted;
    const datasetId = chosen.id;

    if (counted.discriminatorField === undefined || counted.logTypes.length === 0) {
      report("row 3 (tostring)", "SKIPPED", "dataset yielded no log types to fetch");
      return;
    }

    // Row 3: buildLogTypeEventQuery emits `where tostring(field)=="value"`. This
    // runs that exact query. A dataset that legitimately holds nothing for the
    // value is still a pass - what is being asked is whether Cribl ACCEPTS
    // tostring(), so the failure being watched for is a rejection, not a zero.
    const fetched = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: search.id,
      datasetId,
      discriminatorField: counted.discriminatorField,
      logTypes: [counted.logTypes[0].logType],
      eventsPerLogType: 1,
      sleep: liveSleep,
    });
    const rejected = fetched.notes.some((n) => /\b(4\d\d|5\d\d)\b/.test(n));
    report(
      "row 3 (tostring)",
      fetched.ok && !rejected ? "CONFIRMED accepted" : "REJECTED",
      `${fetched.events.length} log types returned; ${fetched.notes.join(" | ") || "no notes"}`,
    );
    expect(rejected, `tostring() was rejected: ${fetched.notes.join(" | ")}`).toBe(
      false,
    );
    expect(fetched.ok).toBe(true);
    // A REAL wait budget. Three search jobs, each allowed 19 x 500ms of polling,
    // is far past vitest's 5s default - and a timeout here would read as "the
    // Lake route failed" when it in fact means "we stopped waiting". Raise this
    // in step with JOB_POLL_INTERVAL_MS.
  }, 120_000);
});
