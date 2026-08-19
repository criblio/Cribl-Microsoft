/**
 * Pins for capture-samples (plan Phase 4, ADR 0003).
 *
 * Two classes of failure guarded here. The REQUEST must be shaped the way the
 * spec says (level 0, bounded, group-scoped) or it captures the wrong thing;
 * and the RESPONSE must survive the three shapes the platform actually returns,
 * because reading it wrong produces "no events" - which the operator reads as a
 * fact about their source rather than a bug in us.
 */

import { describe, expect, it } from "vitest";

import { FakeCriblClient } from "../../testing/fake-cribl-client";
import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_MAX_EVENTS,
  MAX_EVENTS_LIMIT,
  captureSamples,
  extractCapturedEvents,
} from "./capture-samples";

const PANOS_A =
  "<14>Aug 13 10:49:03 fw01 1,2026/08/13 10:49:02,013201031064,TRAFFIC,end,2817,2026/08/13 10:48:54,10.0.0.5,8.8.8.8";
const PANOS_B =
  "<14>Aug 13 10:49:04 fw01 1,2026/08/13 10:49:03,013201031064,THREAT,vuln,2818,2026/08/13 10:48:55,10.0.0.6,9.9.9.9";

/** The documented shape: NDJSON, one capture envelope per line. */
const ndjson = (raws: string[]) =>
  raws.map((r) => JSON.stringify({ _raw: r, _time: 1 })).join("\n");

function client(response: { status: number; body: unknown }) {
  const cribl = new FakeCriblClient();
  cribl.respondWith(response);
  return cribl;
}

describe("the request", () => {
  it("POSTs to the group's capture endpoint at LEVEL 0", async () => {
    const cribl = client({ status: 200, body: ndjson([PANOS_A]) });

    await captureSamples(cribl, { groupId: "default", filter: '__inputId === "in_a"' });

    expect(cribl.calls).toHaveLength(1);
    const call = cribl.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/system/capture");
    expect(call.groupId).toBe("default");
    // Level 0 is captured AT THE SOURCE, before any pipeline. The samples drive
    // pipeline generation, so they must be what arrives - not what a pipeline
    // already shaped.
    expect((call.body as Record<string, unknown>).level).toBe(0);
    expect((call.body as Record<string, unknown>).filter).toBe('__inputId === "in_a"');
  });

  it("is BOUNDED by default, so the request cannot hang or pull a flood", async () => {
    const cribl = client({ status: 200, body: ndjson([PANOS_A]) });

    await captureSamples(cribl, { groupId: "g", filter: "true" });

    const body = cribl.calls[0].body as Record<string, unknown>;
    expect(body.maxEvents).toBe(DEFAULT_MAX_EVENTS);
    expect(body.duration).toBe(DEFAULT_DURATION_SECONDS);
  });

  it("clamps maxEvents into the API's range and SAYS it did", async () => {
    const cribl = client({ status: 200, body: ndjson([PANOS_A]) });

    const result = await captureSamples(cribl, {
      groupId: "g",
      filter: "true",
      maxEvents: 999999,
    });

    expect((cribl.calls[0].body as Record<string, unknown>).maxEvents).toBe(
      MAX_EVENTS_LIMIT,
    );
    // A silent clamp reads as "this is what I asked for".
    expect(result.notes.join(" ")).toContain(String(MAX_EVENTS_LIMIT));
  });
});

describe("extractCapturedEvents - the three shapes the platform returns", () => {
  it("reads the documented NDJSON string, keeping the vendor _raw", () => {
    // The cribl-api note this guards: "Search results are NDJSON - first line
    // is metadata, rest are rows. json.loads(body) fails."
    expect(extractCapturedEvents(ndjson([PANOS_A, PANOS_B]))).toEqual([
      PANOS_A,
      PANOS_B,
    ]);
  });

  it("reads an already-parsed array when the bridge decoded the body", () => {
    expect(
      extractCapturedEvents([
        { _raw: PANOS_A, _time: 1 },
        { _raw: PANOS_B, _time: 2 },
      ]),
    ).toEqual([PANOS_A, PANOS_B]);
  });

  it("reads a {count, items} envelope", () => {
    expect(
      extractCapturedEvents({ count: 1, items: [{ _raw: PANOS_A }] }),
    ).toEqual([PANOS_A]);
  });

  it("serializes an event that carries NO _raw rather than dropping it", () => {
    // A capture of an already-structured source has no _raw; losing those
    // events silently would look like an empty capture.
    expect(extractCapturedEvents([{ a: 1, b: "x" }])).toEqual(['{"a":1,"b":"x"}']);
  });

  it("keeps a plain-text line that is not JSON at all", () => {
    expect(extractCapturedEvents("just a line\nand another")).toEqual([
      "just a line",
      "and another",
    ]);
  });

  it("ignores blank lines and unrecognized bodies without throwing", () => {
    expect(extractCapturedEvents(`${ndjson([PANOS_A])}\n\n`)).toEqual([PANOS_A]);
    expect(extractCapturedEvents(null)).toEqual([]);
    expect(extractCapturedEvents(42)).toEqual([]);
  });
});

describe("the result", () => {
  it("splits captured events by log type, the same way an upload would", async () => {
    // The equivalence that made splitSamplesByLogType worth keeping through the
    // browser's removal: a capture and an upload of the same events must
    // produce the same log types.
    const cribl = client({ status: 200, body: ndjson([PANOS_A, PANOS_B]) });

    const result = await captureSamples(cribl, { groupId: "g", filter: "true" });

    expect(result.ok).toBe(true);
    expect(result.format).toBe("csv");
    expect(result.splits.map((s) => s.logType).sort()).toEqual(["THREAT", "TRAFFIC"]);
    expect(result.rawEvents).toEqual([PANOS_A, PANOS_B]);
    expect(result.noDiscriminator).toBe(false);
  });

  it("FLAGS a capture with no discriminator instead of inventing one log type", async () => {
    const cribl = client({
      status: 200,
      body: ndjson(["hello world", "goodbye world"]),
    });

    const result = await captureSamples(cribl, { groupId: "g", filter: "true" });

    expect(result.noDiscriminator).toBe(true);
    expect(result.notes.join(" ")).toContain("No field in these events distinguishes");
    // Still offered - the operator can name it themselves.
    expect(result.splits).toHaveLength(1);
  });

  it("treats an EMPTY capture as a result, and names the likely causes", async () => {
    // Not an error. The two explanations lead to different next actions, so
    // both are stated rather than leaving the operator with a blank panel.
    const cribl = client({ status: 200, body: "" });

    const result = await captureSamples(cribl, { groupId: "g", filter: "true" });

    expect(result.ok).toBe(true);
    expect(result.splits).toEqual([]);
    expect(result.notes.join(" ")).toContain("matched no events");
    expect(result.notes.join(" ")).toContain("source was idle");
  });
});

describe("failure", () => {
  it("reports a rejected FILTER with Cribl's own message", async () => {
    // Cribl evaluates the expression; when it refuses, its message is more
    // accurate than anything this app could infer.
    const cribl = client({ status: 400, body: "unexpected token )" });

    const result = await captureSamples(cribl, { groupId: "g", filter: "))" });

    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).toContain("400");
    expect(result.notes.join(" ")).toContain("unexpected token )");
  });

  it("hints at permission on a 403", async () => {
    const cribl = client({ status: 403, body: "forbidden" });
    const result = await captureSamples(cribl, { groupId: "g", filter: "true" });
    expect(result.notes.join(" ")).toContain("capture permission");
  });

  it("folds a TRANSPORT failure into a note, never throws", async () => {
    const cribl = new FakeCriblClient(); // no scripted response: the fake throws

    const result = await captureSamples(cribl, { groupId: "g", filter: "true" });

    expect(result.ok).toBe(false);
    expect(result.splits).toEqual([]);
    expect(result.notes.join(" ")).toContain("uploading a sample still works");
  });
});
