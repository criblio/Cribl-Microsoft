/**
 * Pins for the drop-savings estimator (user request 2026-07-12: show the
 * byte-drop percentage of the reviewer's drop decisions in the GUI).
 */

import { describe, expect, it } from "vitest";
import {
  dropSavingsLine,
  dropSavingsPercent,
  estimateDropSavings,
  meanEventBytes,
  mergeDropSavings,
} from "./drop-savings";

describe("estimateDropSavings", () => {
  it("charges JSON events the serialized pair cost, case-insensitively", () => {
    const events = [
      '{"act":"blocked","Noise":"aaaaaaaaaa","keep":1}',
      '{"act":"allowed","keep":2}',
    ];
    const savings = estimateDropSavings(events, ["noise"]);
    expect(savings.events).toBe(2);
    expect(savings.originalBytes).toBe(events[0].length + events[1].length);
    // "Noise":"aaaaaaaaaa" -> 7 + 1 + 12 + 1 = 21; absent in event 2 -> 0.
    expect(savings.droppedBytes).toBe(21);
  });

  it("charges non-JSON events the key=value token", () => {
    const events = [
      "CEF:0|Zscaler|NSSWeblog|dept=engineering dst=1.2.3.4",
    ];
    const savings = estimateDropSavings(events, ["dept"]);
    // "dept" + "=" + "engineering" + separator = 4 + 1 + 11 + 1 = 17.
    expect(savings.droppedBytes).toBe(17);
  });

  it("costs nothing for absent fields and empty inputs", () => {
    expect(estimateDropSavings([], ["x"]).events).toBe(0);
    const savings = estimateDropSavings(['{"a":1}'], ["missing"]);
    expect(savings.droppedBytes).toBe(0);
  });
});

describe("aggregation and formatting", () => {
  it("merges parts and computes the whole-percent reduction", () => {
    const merged = mergeDropSavings([
      { events: 2, originalBytes: 300, droppedBytes: 60 },
      { events: 1, originalBytes: 100, droppedBytes: 40 },
    ]);
    expect(merged).toEqual({ events: 3, originalBytes: 400, droppedBytes: 100 });
    expect(dropSavingsPercent(merged)).toBe(25);
  });

  it("renders the human line and stays empty with nothing dropped", () => {
    expect(
      dropSavingsLine({ events: 2, originalBytes: 2480, droppedBytes: 850 }),
    ).toBe(
      "estimated 34% smaller (avg event 1,240 B -> 815 B across 2 sampled event(s))",
    );
    expect(dropSavingsLine({ events: 2, originalBytes: 100, droppedBytes: 0 })).toBe("");
    expect(dropSavingsLine({ events: 0, originalBytes: 0, droppedBytes: 0 })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// meanEventBytes - the events-to-bytes piece (sample-acquisition plan Phase 5)
// ---------------------------------------------------------------------------
//
// This mean is multiplied by a Lake event count to estimate a log type's ingest
// volume, so a wrong or invented value here is a wrong COST figure on screen -
// scaled by up to a million. The refusals matter more than the arithmetic.

describe("meanEventBytes", () => {
  it("is the measured bytes divided by the measured events", () => {
    expect(
      meanEventBytes({ events: 4, originalBytes: 2480, droppedBytes: 0 }),
    ).toBe(620);
  });

  it("measures real events end to end, unrounded", () => {
    // Two events of 10 and 15 bytes: the mean is 12.5, and it stays 12.5.
    // Rounding an intermediate that a million-event count later multiplies
    // would bias the estimate by up to half a byte per event - half a megabyte.
    const events = ["0123456789", "012345678901234"];
    const mean = meanEventBytes(estimateDropSavings(events, []));
    expect(mean).toBe(12.5);
  });

  it("is UNDEFINED with no events measured, never 0", () => {
    // 0/0. A mean of "0 B" for a log type nobody sampled is a claim about the
    // operator's data that nobody made.
    const mean = meanEventBytes(estimateDropSavings([], []));
    expect(mean).toBeUndefined();
    expect(mean).not.toBe(0);
  });

  it("is UNDEFINED when the sampled events measured zero bytes, never 0", () => {
    // The degenerate sample (empty lines). A mean of 0 would multiply a
    // 890,123-event count into a confident "~0 B" - the worst shape this
    // estimate can take, because it reads as measured.
    const savings = estimateDropSavings(["", ""], []);
    expect(savings.events).toBe(2);
    expect(savings.originalBytes).toBe(0);
    expect(meanEventBytes(savings)).toBeUndefined();
  });
});
