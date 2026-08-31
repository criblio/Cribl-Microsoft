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
import { GUID_LIKE_TYPES } from "../domain/schema-mapping";
import { extractCapturedEvents } from "../usecases/capture-samples/capture-samples";
import { criblEnvelopeItems } from "../domain/cribl-api/envelope";
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

// --- Azure gating, for the guid row (DBT-2) -------------------------------
// SEPARATE from the Cribl gate on purpose: the guid belief is about Azure and
// nothing else here needs ARM, so a workspace with no Azure credentials still
// runs every Cribl row rather than being turned away at the door.
//
// ONE TOKEN AUDIENCE, and it is `https://management.azure.com` - the same one
// the app's own Azure port uses. MEASURED 2026-08-31, because the obvious
// alternative silently does not work: a management token POSTed to
// `api.loganalytics.io/v1/workspaces/{guid}/query` answers 403, while the SAME
// token against the ARM passthrough below answers 200. Asking for an
// `api.loganalytics.io` token instead would mean this one row needed a second
// audience nobody else here needs, and `az account get-access-token` with no
// --resource hands you the management one.
const ARM_TOKEN = process.env.AZURE_LIVE_TOKEN ?? "";
/**
 * Full ARM id of the workspace whose table is read back. Addresses BOTH calls -
 * the query passthrough and the tables read - so the workspace GUID is not
 * needed at all.
 */
const ARM_WORKSPACE = process.env.AZURE_LIVE_WORKSPACE_ID ?? "";
/** Table and column the operator has already onboarded THROUGH this app. */
const GUID_TABLE = process.env.AZURE_LIVE_GUID_TABLE ?? "";
const GUID_COLUMN = process.env.AZURE_LIVE_GUID_COLUMN ?? "";
const GUID_LIVE =
  ARM_TOKEN !== "" &&
  ARM_WORKSPACE !== "" &&
  GUID_TABLE !== "" &&
  GUID_COLUMN !== "";

/**
 * Narrow the Lake query window. Optional; the usecase's own default is -24h.
 *
 * Worth having because a dataset accumulates: a run that wants to observe what
 * is arriving NOW competes with everything already in the window, and the
 * discriminator sample is drawn from the whole of it. Observed 2026-08-25 on a
 * dataset holding 5,212 unparsed events against 16 parsed ones - 0.3% - where
 * no sample of any practical size would have found the parsed field.
 *
 * NOTE, and it is a product gap rather than a harness one: the app's own
 * exhaustion note advises "a narrower time window is the cheapest next try",
 * but no UI control exposes earliest/latest, so an operator cannot take that
 * advice. This env var gives the SUITE the lever the product does not give the
 * operator.
 */
const WINDOW = process.env.CRIBL_LIVE_WINDOW ?? "";
/**
 * How many datasets to walk before giving up.
 *
 * THE WHOLE LISTING BY DEFAULT. This was 12, which is the alphabetically-first
 * twelve - the same uncorrelated ordering the walk exists to escape, just
 * wider. In the lab it could not reach `winevt_plwindows`, the one dataset the
 * `data_source` finding came from, because it sorts near the end of 31. An
 * empty dataset costs ~1.4s and the walk stops at the first usable one, so the
 * worst case is affordable and the common case is short.
 */
const MAX_DATASET_ATTEMPTS = Number(process.env.CRIBL_LIVE_MAX_DATASETS ?? "40");

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
  // READ THE STATUS. A 403 here yields no items, which becomes an empty set,
  // which surfaces as "no Stream group has connected workers" - a permission
  // failure reported as a fact about the workspace. Fail loudly instead.
  if (res.status !== 200) {
    report("worker listing", "CANNOT RUN", `GET /master/workers -> HTTP ${res.status}`);
    throw new Error(`/master/workers answered HTTP ${res.status}`);
  }
  const items = ((res.body as { items?: unknown[] })?.items ?? []) as Record<
    string,
    unknown
  >[];
  const staffed = new Set<string>();
  for (const w of items) {
    // CONNECTED, not merely listed - MasterWorkerEntry carries `disconnected`,
    // and a group whose only worker has dropped answers the capture 400 exactly
    // as an empty group does.
    if (w.disconnected === true) continue;
    const info = (w.info ?? {}) as Record<string, unknown>;
    // `group` is the documented field; the others are tolerated fallbacks for
    // shapes the vendored spec does not describe.
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
    // ALL FOUR SHAPES the shipped extractor handles, not just the NDJSON one.
    // capture-samples.ts documents a bare OBJECT (a one-line capture parses
    // cleanly and never reaches the string branch - row 4 exists to pin exactly
    // that) and the `{count, items}` envelope some leaders wrap it in. Handling
    // only the string shape meant those two fell through to `decoded` SILENTLY,
    // reproducing the payload-not-envelope false negative this block was written
    // to fix, with nothing in the output saying so.
    const wrapped = criblEnvelopeItems(control.body);
    const envelopes: Record<string, unknown>[] = Array.isArray(control.body)
      ? (control.body as Record<string, unknown>[])
      : wrapped !== null
      ? (wrapped as Record<string, unknown>[])
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
    const singleObject =
      envelopes.length === 0 &&
      control.body !== null &&
      typeof control.body === "object" &&
      !Array.isArray(control.body)
        ? [control.body as Record<string, unknown>]
        : [];
    const rawBodies =
      envelopes.length > 0 ? envelopes : singleObject.length > 0 ? singleObject : decoded;
    // SAY WHICH SOURCE WAS READ. A silent fallback to the payload is how row 1
    // reported "no __inputId" for months; if it ever happens again the run
    // should announce it rather than look like a finding about the platform.
    if (rawBodies === decoded) {
      report(
        "rows 1/2 (source)",
        "FELL BACK TO PAYLOAD",
        "no envelope shape matched; __inputId cannot be observed from _raw - treat rows 1/2 as unmeasured",
      );
    }
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
    let chosen: { id: string; counted: LakeCount; discriminatorField: string } | undefined;
    let sawEvents = false;

    for (const entry of candidates) {
      // THE SHIPPED FUNCTION, not a hand-rolled approximation of it - it owns
      // its own query text and route choice, which is the whole reason this
      // suite exists.
      const counted = await queryLakeSamples(cribl, {
        searchGroupId: search.id,
        datasetId: entry.id,
        sleep: liveSleep,
        ...(WINDOW === "" ? {} : { earliest: WINDOW }),
      });

      // A FAILED READ IS ROW 6'S FAILURE and must not be walked past: skipping
      // it would let a 403 or a poll timeout hide behind the next dataset that
      // happened to work, collapsing "could not read" into "nothing to see".
      expect(
        counted.ok,
        `dataset "${entry.id}" could not be read: ${counted.notes.join(" | ")}`,
      ).toBe(true);

      // BACKWARDS UNTIL 2026-08-25. `noDiscriminator` is false for an EMPTY
      // dataset (the base default) and true only when rows arrived and no field
      // qualified - so `!noDiscriminator` set this on exactly the datasets
      // where nothing was seen, and cleared it on the ones where data was. The
      // two reports below then pointed the reader at the wrong fix each time.
      if (counted.noDiscriminator || counted.logTypes.length > 0) sawEvents = true;
      // The NOTES matter as much as the count. "0 log types" alone cannot tell
      // an empty dataset from one whose rows never arrived, and those need
      // different fixes.
      tried.push(
        `${entry.id}: ${counted.logTypes.length} log types` +
          (counted.noDiscriminator ? " (no discriminator)" : "") +
          (counted.notes.length > 0 ? ` [${counted.notes.join(" ; ")}]` : ""),
      );
      if (counted.discriminatorField !== undefined && counted.logTypes.length > 0) {
        // Narrowed HERE, where the check happens, so the field stays a string
        // downstream without a re-check that can never fail.
        chosen = { id: entry.id, counted, discriminatorField: counted.discriminatorField };
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


    // Row 3: buildLogTypeEventQuery emits `where tostring(field)=="value"`. This
    // runs that exact query. A dataset that legitimately holds nothing for the
    // value is still a pass - what is being asked is whether Cribl ACCEPTS
    // tostring(), so the failure being watched for is a rejection, not a zero.
    const fetched = await fetchLakeLogTypeEvents(cribl, {
      searchGroupId: search.id,
      datasetId,
      ...(WINDOW === "" ? {} : { earliest: WINDOW }),
      discriminatorField: chosen.discriminatorField,
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

/**
 * ROW 9 - the guid cast (ADR 0004, DBT-2).
 *
 * THE BELIEF, shipped in 1.12.1 and never observed: declaring a guid column
 * `string` and promoting it with `toguid()` in transformKql delivers the value,
 * where the legacy drop left the destination column null forever while the
 * deployment reported success.
 *
 * WHY THIS ROW READS AN INGESTED VALUE RATHER THAN VALIDATING A TEMPLATE.
 * Two cheaper checks were tried against live Azure on 2026-08-31 and BOTH were
 * measured to have no teeth - recorded here so the next person does not spend
 * the same afternoon rediscovering it:
 *
 *   1. `az deployment group validate` on a DCR whose transform called
 *      `tuguid()` - a function that does not exist - returned
 *      provisioningState "Succeeded". ARM template validation does NOT parse
 *      transformKql, so a deploy-time check cannot fail and would be a pin
 *      that only looks like one.
 *   2. A real PUT does reject, but it rejects on the DESTINATION TABLE first
 *      (`InvalidOutputTable`) and never reaches the transform unless the table
 *      already exists. So even the PUT-based version needs a fully onboarded
 *      table, at which point reading the value back is both stronger and no
 *      more setup.
 *
 * And `toguid()` returns NULL SILENTLY on malformed input rather than erroring,
 * which is the whole reason a deploy-time answer would not settle anything: a
 * wrong cast fails exactly as quietly as the drop it replaced. Only the value
 * in the table is evidence. OBSERVED 2026-08-31 rather than taken from the
 * ADR - `toguid("not-a-guid")` came back null with no error, alongside
 * `toguid("")`, in one datatable() probe against a live workspace.
 *
 * THE OPERATOR IS `isnotempty`, and it was checked rather than assumed: on a
 * guid-typed column the same probe returned true for a real guid and false for
 * both null cases. `count()` alone would have counted the nulls and reported a
 * broken cast as working, which is the failure mode of the row itself.
 *
 * THE QUERY SHAPE WAS RUN LIVE 2026-08-31 through the ARM passthrough, so the
 * response parsing here is measured too: `tables[0].rows[0]` is
 * `[total, populated]` for the summarize.
 *
 * WHY THE TYPE CHECK READS ARM AND NOT `getschema`. Measured 2026-08-31: the
 * QUERY API does not report the guid family at all. `SecurityEvent | getschema`
 * on a workspace whose ARM schema declares SEVEN guid columns came back 220
 * string, 12 int, 2 datetime and ZERO guid. So a `getschema`-based type
 * assertion cannot pass on a correctly-typed table, and the earlier draft
 * quietly asserted only that the column EXISTS while its title promised a type.
 * The ARM tables API does report `"type": "guid"`, so that is what is read.
 *
 * READ-ONLY, like every other row: two GETs and one query against a table the
 * operator has ALREADY onboarded through this app and already sent data to. It
 * deploys nothing, creates no table, and ingests nothing.
 *
 * Run (the token is the DEFAULT audience of `az account get-access-token`):
 *   AZURE_LIVE_TOKEN=$(az account get-access-token --query accessToken -o tsv) \
 *   AZURE_LIVE_WORKSPACE_ID=/subscriptions/.../workspaces/<name> \
 *   AZURE_LIVE_GUID_TABLE=<Table_CL> AZURE_LIVE_GUID_COLUMN=<GuidColumn> \
 *   npx vitest run --root packages/core src/testing/live-verify.test.ts
 *
 * NOT IN GIT BASH ON WINDOWS, which is this repo's usual shell. MSYS rewrites
 * an env value that looks like an absolute POSIX path, so the workspace id
 * arrives as `C:/Program Files/Git/subscriptions/...` and the request goes to
 * the host `management.azure.comc` (ENOTFOUND). Hit 2026-08-31. Use PowerShell
 * (`$env:AZURE_LIVE_WORKSPACE_ID = "/subscriptions/..."`) or export
 * `MSYS2_ENV_CONV_EXCL=*`.
 */
describe.skipIf(!GUID_LIVE)("row 9 - the guid cast delivers a value (ADR 0004)", () => {
  /** One authenticated ARM GET/POST, returning the parsed body and status. */
  async function arm(
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${ARM_TOKEN}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /**
   * One Log Analytics query, through the ARM PASSTHROUGH so the management
   * token works (see the audience note at the top of this file - the direct
   * `api.loganalytics.io` endpoint answers 403 for it).
   */
  async function laQuery(query: string): Promise<Record<string, unknown>> {
    const res = await arm(
      `https://management.azure.com${ARM_WORKSPACE}/query?api-version=2017-10-01`,
      { query },
    );
    if (res.status !== 200) {
      report("row 9", "CANNOT RUN", `query -> HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      throw new Error(`Log Analytics query answered HTTP ${res.status}`);
    }
    return res.body;
  }

  it("declares the column guid in the TABLE, not string", async () => {
    // The DESTINATION column keeps its real type; only the STREAM declaration
    // says string. If this reads `string` the schema was created wrong and the
    // cast below would be promoting into a column that cannot hold a guid.
    //
    // Read from ARM, which is the only source that reports the guid family at
    // all - see the docblock. This asserts the TYPE, which is what the name
    // above promises; existence alone would pass on the broken case.
    const res = await arm(
      `https://management.azure.com${ARM_WORKSPACE}/tables/${GUID_TABLE}` +
        "?api-version=2022-10-01",
    );
    if (res.status !== 200) {
      report("row 9 schema", "CANNOT RUN", `tables GET -> HTTP ${res.status}`);
      throw new Error(`fetch schema for '${GUID_TABLE}': HTTP ${res.status}`);
    }
    const schema = (res.body.properties as { schema?: Record<string, unknown> } | undefined)
      ?.schema;
    const columns = [
      ...(((schema?.standardColumns as Array<{ name: string; type: string }>) ?? [])),
      ...(((schema?.columns as Array<{ name: string; type: string }>) ?? [])),
    ];
    const column = columns.find(
      (c) => c.name.toLowerCase() === GUID_COLUMN.toLowerCase(),
    );
    report(
      "row 9 schema",
      column === undefined ? "NO SUCH COLUMN" : `type ${column.type}`,
      `${GUID_TABLE}.${GUID_COLUMN}`,
    );
    expect(
      column,
      `${GUID_TABLE} has no column named ${GUID_COLUMN}`,
    ).toBeDefined();
    expect(
      GUID_LIKE_TYPES.includes(String(column?.type).toLowerCase()),
      `${GUID_TABLE}.${GUID_COLUMN} is '${column?.type}', not a guid type - the cast ` +
        "would be promoting into a column that cannot hold a guid",
    ).toBe(true);
  }, 60_000);

  it("DELIVERS the value - the column is not null for every row", async () => {
    // THE DECISIVE OBSERVATION, and it is a fact rather than an inference: a
    // populated column can only have come through the cast, because an
    // undeclared field is discarded at the DCR boundary. An all-null column is
    // precisely the failure ADR 0004 describes, and it is what the legacy drop
    // produced while reporting success.
    const body = await laQuery(
      `${GUID_TABLE} | where TimeGenerated > ago(24h) ` +
        `| summarize total = count(), populated = countif(isnotempty(${GUID_COLUMN}))`,
    );
    const row = ((body.tables as Array<{ rows: unknown[][] }>)[0]?.rows ?? [])[0] ?? [];
    const total = Number(row[0] ?? 0);
    const populated = Number(row[1] ?? 0);
    report(
      "row 9 values",
      populated > 0 ? "CAST WORKS" : total > 0 ? "ALL NULL - CAST FAILED" : "NO DATA",
      `${populated}/${total} rows carry ${GUID_COLUMN} in the last 24h`,
    );

    // NO DATA is not a pass. An empty table cannot distinguish a working cast
    // from a broken one, and reporting it as green is exactly the confident
    // wrong answer this suite exists to avoid.
    expect(
      total,
      `${GUID_TABLE} has no rows in the last 24h - send data through the DCR first; ` +
        "an empty table proves nothing either way",
    ).toBeGreaterThan(0);
    expect(
      populated,
      `every one of ${total} rows has a null ${GUID_COLUMN}: the guid cast is NOT working ` +
        "(toguid() returns null silently on malformed input - ADR 0004)",
    ).toBeGreaterThan(0);
  }, 60_000);
});
