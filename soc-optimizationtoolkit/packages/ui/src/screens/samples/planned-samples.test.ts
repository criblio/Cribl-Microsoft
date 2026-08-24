/**
 * Pins for the one acquired-events -> tagged-samples conversion (2026-08-20
 * audit consolidation).
 *
 * Each panel's own suite already pins what its commit produces. Two failures are
 * invisible from there, and both are what this module exists to stop:
 *
 * 1. THE TWO PATHS DRIFTING APART AGAIN. This module exists because the capture
 *    and Lake copies were kept identical by intent - a comment - rather than by
 *    mechanism, which is the arrangement domain/log-type-catalog/merge.ts was
 *    rewritten to reject. The pin for that cannot be another comment: it is the
 *    assertion that both entry points hand back the SAME sample for the same
 *    events.
 *
 * 2. THE LABEL FOLD WIDENING. sampleStoreKey folds case and surrounding
 *    whitespace and NOTHING else, because it decides what the tagged-sample
 *    store is keyed by. Swapping in core's normalizeLogTypeName reads like a
 *    tidy-up - both "compare log-type names" - and silently stores two different
 *    log types as one sample, costing the pack a route pair.
 */

import { describe, expect, it } from "vitest";
import { plannedCaptureSamples } from "./capture-panel-state";
import { plannedLakeSamples } from "./lake-panel-state";
import { plannedSamplesFrom, sampleStoreKey } from "./planned-samples";

/** A CEF line, so the re-tag has a format to detect that no caller declared. */
const CEF = "CEF:0|Palo Alto|PAN-OS|10.2|end|TRAFFIC|3|src=10.0.0.1";

describe("sampleStoreKey", () => {
  it("folds case and surrounding whitespace, and NOTHING else", () => {
    expect(sampleStoreKey("  TRAFFIC ")).toBe("traffic");
    // Separators survive. normalizeLogTypeName would strip them, which is right
    // for asking whether content NAMES a log type and wrong for deciding what
    // the store is keyed by.
    expect(sampleStoreKey("pan-os traffic")).toBe("pan-os traffic");
    expect(sampleStoreKey("panos_traffic")).toBe("panos_traffic");
    expect(sampleStoreKey("pan-os traffic")).not.toBe(
      sampleStoreKey("panos_traffic"),
    );
  });
});

describe("plannedSamplesFrom", () => {
  it("adopts the operator's label when only the CASE differs", () => {
    const samples = plannedSamplesFrom(
      [{ logType: "TRAFFIC", rawEvents: ['{"a":1}'] }],
      "acquired",
      ["traffic"],
    );
    expect(samples.map((s) => s.logType)).toEqual(["traffic"]);
  });

  it("keeps two log types APART when they differ by more than case", () => {
    // The failure a wider fold would cause, and it is silent: both picks would
    // adopt "PAN-OS Traffic", the second would overwrite the first, and one
    // vendor feed would leave with no sample and therefore no route pair. The
    // records are asserted, not just the count - a fold that kept two samples
    // but crossed their contents would be the same loss.
    const samples = plannedSamplesFrom(
      [
        { logType: "pan-os traffic", rawEvents: ['{"n":"dashed"}'] },
        { logType: "panos_traffic", rawEvents: ['{"n":"underscored"}'] },
      ],
      "acquired",
      ["PAN-OS Traffic"],
    );
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.logType)).toEqual([
      "PAN-OS Traffic",
      "panos_traffic",
    ]);
    expect(samples[0].parsed.records[0].n).toBe("dashed");
    expect(samples[1].parsed.records[0].n).toBe("underscored");
  });
});

describe("the capture and Lake paths share ONE conversion", () => {
  it("produces the SAME sample from the same events, label adoption included", () => {
    // The mechanism that replaces "kept identical on purpose". A re-forked copy
    // passes both panels' suites right up until the day one of them is fixed.
    const rawEvents = [CEF];
    const fromCapture = plannedCaptureSamples(
      [{ logType: "TRAFFIC", rawEvents, format: "unknown", eventCount: 1 }],
      "acquired",
      ["traffic"],
    );
    const fromLake = plannedLakeSamples(
      [{ logType: "TRAFFIC", rawEvents }],
      "acquired",
      ["traffic"],
    );

    // Named first, so two empty results cannot pass as agreement.
    expect(fromCapture.map((s) => s.logType)).toEqual(["traffic"]);
    // Detected from the content, not the "unknown" the split declared.
    expect(fromCapture[0].format).toBe("cef");
    expect(fromCapture).toEqual(fromLake);
  });

  it("agrees about the husk it refuses to store", () => {
    // The other half: both paths drop a log type whose lines parse to no
    // records, rather than storing a name with zero fields that counts as
    // coverage while giving the mapping nothing.
    const rawEvents = ["   "];
    const fromCapture = plannedCaptureSamples(
      [{ logType: "JUNK", rawEvents, format: "unknown", eventCount: 1 }],
      "acquired",
    );
    const fromLake = plannedLakeSamples([{ logType: "JUNK", rawEvents }], "acquired");
    expect(fromCapture).toEqual([]);
    expect(fromLake).toEqual([]);
  });
});
