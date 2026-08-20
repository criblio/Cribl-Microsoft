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
  fetchLakeLogTypeEvents,
  queryLakeSamples,
} from "../usecases/query-lake-samples/query-lake-samples";
import type {
  CriblClient,
  CriblGroupSummary,
  CriblRequest,
} from "../ports/cribl-client";
import { deriveGroupProduct, isSearchGroup } from "../ports/cribl-client";
import type { PortHttpResponse } from "../ports/http";

const BASE = process.env.CRIBL_LIVE_BASE ?? "";
const TOKEN = process.env.CRIBL_LIVE_TOKEN ?? "";
const LIVE = BASE !== "" && TOKEN !== "";

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

describe.skipIf(!LIVE)("live verification against a real workspace", () => {
  const cribl = liveClient();

  /** Resolved once and shared: the group and source everything else uses. */
  let groupId = "";
  let inputs: LiveInputSummary[] = [];

  it("row 7 - the credentials can list groups and inputs", async () => {
    const groups = await cribl.listGroups();
    expect(groups.length).toBeGreaterThan(0);

    // A Stream group, which is where /system/inputs and /system/capture live.
    const stream = groups.filter((g) => !isSearchGroup(g));
    expect(stream.length).toBeGreaterThan(0);
    groupId = stream[0].id;

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
      body: { filter: "true", maxEvents: 20, duration: 10, level: 0 },
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
    const rawBodies = Array.isArray(control.body)
      ? (control.body as Record<string, unknown>[])
      : decoded;
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
      // The suffix clause must select the value the platform really sends.
      const known = inputs.find((i) => observed.endsWith(`:${i.id}`) || observed === i.id);
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
    const sample = rawBodies[0] ?? {};
    const structured = ["sourcetype", "type", "subtype", "eventType"].filter(
      (f) => sample[f] !== undefined,
    );
    report(
      "row 2 (level-0 fields)",
      structured.length > 0 ? "CONFIRMED present" : "only _raw on this source",
      `keys: ${Object.keys(sample).slice(0, 12).join(", ")}`,
    );
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

    // Row 6: the dataset listing the Lake mode offers.
    const list = await cribl.request({
      method: "GET",
      path: "/search/datasets",
      groupId: search.id,
    });
    report(
      "row 6 (dataset listing)",
      list.status === 200 ? "CONFIRMED" : `HTTP ${list.status}`,
      `/m/${search.id}/search/datasets`,
    );
    expect(list.status).toBe(200);

    const datasets = ((list.body as { items?: unknown[] })?.items ?? []) as Record<
      string,
      unknown
    >[];
    if (datasets.length === 0) {
      report("row 3 (tostring)", "SKIPPED", "no datasets to query");
      return;
    }

    // THE SHIPPED FUNCTIONS, not a hand-rolled approximation of them. The app
    // tries the sync route before the job lifecycle and owns its own query
    // text; a probe that posted its own search would confirm a client we do not
    // ship, which is the failure mode this whole suite is a reaction to.
    const datasetId = String(datasets[0].id);
    const counted = await queryLakeSamples(cribl, {
      searchGroupId: search.id,
      datasetId,
    });
    report(
      "row 6 (queryLakeSamples)",
      counted.ok ? "CONFIRMED" : "FAILED",
      `${counted.logTypes.length} log types by ${counted.discriminatorField ?? "(none)"}; ${counted.notes.join(" | ") || "no notes"}`,
    );
    expect(counted.ok).toBe(true);

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
  });
});
