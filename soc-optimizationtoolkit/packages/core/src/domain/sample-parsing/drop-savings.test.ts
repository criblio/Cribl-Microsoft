/**
 * Pins for the drop-savings estimator (user request 2026-07-12: show the
 * byte-drop percentage of the reviewer's drop decisions in the GUI).
 */

import { describe, expect, it } from "vitest";
import {
  dropSavingsLine,
  dropSavingsPercent,
  estimateDropSavings,
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
