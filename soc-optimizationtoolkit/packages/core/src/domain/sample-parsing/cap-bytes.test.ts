/**
 * Tagged-sample byte-cap pins. The event-count cap was not enough - a KV entry
 * is bounded by BYTES, so a log type with large events serialized past the
 * leader's body limit and PUT 413'd. capTaggedSampleBytes trims the per-event
 * arrays to fit while keeping the field schema and at least one event.
 */

import { describe, expect, it } from "vitest";

import type { TaggedSample } from "./models";
import { TAGGED_SAMPLE_MAX_BYTES, capTaggedSampleBytes } from "./cap-bytes";

function sampleWith(events: string[], record: Record<string, unknown>): TaggedSample {
  return {
    logType: "THREAT",
    format: "json",
    rawEvents: [...events],
    parsed: {
      format: "json",
      records: events.map(() => ({ ...record })),
      eventCount: events.length,
      fields: [
        {
          name: "msg",
          type: "string",
          types: ["string"],
          examples: ["x"],
          occurrence: 1,
          required: true,
        },
      ],
      rawEvents: [...events],
      sourceName: "browse",
      errors: [],
    },
  };
}

const byteLen = (s: TaggedSample) => new TextEncoder().encode(JSON.stringify(s)).length;

describe("capTaggedSampleBytes", () => {
  it("leaves a small sample untouched", () => {
    const s = sampleWith(["a", "b", "c"], { msg: "hi" });
    const out = capTaggedSampleBytes(s);
    expect(out.trimmed).toBe(false);
    expect(out.droppedEvents).toBe(0);
    expect(out.sample).toBe(s);
    expect(out.keptEvents).toBe(3);
  });

  it("trims a large sample to fit the byte budget", () => {
    // 400 events, each ~2 KiB, blows a small budget; the count cap alone would
    // not have saved it.
    const big = "X".repeat(2048);
    const s = sampleWith(
      Array.from({ length: 400 }, (_, i) => `${i}:${big}`),
      { msg: big },
    );
    const budget = 64 * 1024;
    const out = capTaggedSampleBytes(s, budget);
    expect(out.trimmed).toBe(true);
    expect(byteLen(out.sample)).toBeLessThanOrEqual(budget);
    expect(out.keptEvents).toBeGreaterThanOrEqual(1);
    expect(out.keptEvents).toBeLessThan(400);
    expect(out.droppedEvents).toBe(400 - out.keptEvents);
  });

  it("trims all three per-event arrays in lockstep and updates eventCount", () => {
    const big = "Y".repeat(4096);
    const s = sampleWith(
      Array.from({ length: 200 }, (_, i) => `${i}:${big}`),
      { msg: big },
    );
    const out = capTaggedSampleBytes(s, 64 * 1024);
    expect(out.sample.rawEvents).toHaveLength(out.keptEvents);
    expect(out.sample.parsed.rawEvents).toHaveLength(out.keptEvents);
    expect(out.sample.parsed.records).toHaveLength(out.keptEvents);
    expect(out.sample.parsed.eventCount).toBe(out.keptEvents);
  });

  it("preserves the discovered-field schema when trimming", () => {
    const big = "Z".repeat(4096);
    const s = sampleWith(
      Array.from({ length: 100 }, () => big),
      { msg: big },
    );
    const out = capTaggedSampleBytes(s, 32 * 1024);
    expect(out.sample.parsed.fields).toEqual(s.parsed.fields);
  });

  it("keeps at least one event even when a single event exceeds the budget", () => {
    const huge = "Q".repeat(100 * 1024);
    const s = sampleWith([huge, huge], { msg: huge });
    const out = capTaggedSampleBytes(s, 8 * 1024);
    expect(out.keptEvents).toBe(1);
    expect(out.sample.rawEvents).toHaveLength(1);
    expect(out.trimmed).toBe(true);
  });

  it("handles an empty sample without trimming", () => {
    const s = sampleWith([], {});
    const out = capTaggedSampleBytes(s, 1024);
    expect(out.trimmed).toBe(false);
    expect(out.keptEvents).toBe(0);
  });

  it("defaults to the 512 KiB budget", () => {
    expect(TAGGED_SAMPLE_MAX_BYTES).toBe(512 * 1024);
  });
});
