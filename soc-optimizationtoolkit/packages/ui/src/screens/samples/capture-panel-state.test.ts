/**
 * Pins for the capture panel's pure decisions (plan Phase 4, ADR 0003).
 *
 * The two failures worth guarding: suggesting the wrong log types (which wastes
 * a capture and can return nothing), and letting a commit silently overwrite a
 * sample the operator already curated - the store is replace-by-logType, so
 * that loss is invisible without a warning.
 */

import { describe, expect, it } from "vitest";
import type { CaptureSamplesResult } from "@soc/core";
import {
  captureLogTypeChoices,
  composeFilter,
  deriveCaptureView,
  filterWarning,
  plannedCaptureSamples,
  selectedValues,
  toggleChoice,
} from "./capture-panel-state";
import type { RecommendedLogType } from "./sample-coverage-state";

const rec = (
  value: string,
  evidence: RecommendedLogType["evidence"],
  provided = false,
): RecommendedLogType => ({ value, evidence, provided });

const result = (over: Partial<CaptureSamplesResult> = {}): CaptureSamplesResult => ({
  splits: [],
  rawEvents: [],
  format: "csv",
  noDiscriminator: false,
  notes: [],
  ok: true,
  ...over,
});

describe("captureLogTypeChoices", () => {
  it("pre-ticks what the solution's CONTENT needs and nothing else", () => {
    const choices = captureLogTypeChoices([
      rec("TRAFFIC", "detection"),
      rec("CONFIG", "workbook"),
      rec("HIPMATCH", "vendor"),
    ]);
    expect(choices.map((c) => c.selected)).toEqual([true, true, false]);
    // Vendor entries are OFFERED, never assumed - the same rule the
    // vendor-identity product chips follow.
    expect(choices[2].note).toContain("documented by the vendor");
  });

  it("does NOT pre-tick a log type the operator already provided", () => {
    // Re-capturing it would replace a sample they already curated, and the
    // capture is the one intake path where the app chose the content.
    const choices = captureLogTypeChoices([
      rec("TRAFFIC", "detection", true),
      rec("THREAT", "detection", false),
    ]);
    expect(choices.map((c) => c.selected)).toEqual([false, true]);
    expect(choices[0].note).toContain("capturing again replaces");
  });

  it("keeps every entry visible, ticked or not", () => {
    const choices = captureLogTypeChoices([
      rec("A", "detection", true),
      rec("B", "vendor"),
    ]);
    expect(choices.map((c) => c.value)).toEqual(["A", "B"]);
  });
});

describe("toggle + compose", () => {
  const choices = captureLogTypeChoices([
    rec("TRAFFIC", "detection"),
    rec("HIPMATCH", "vendor"),
  ]);

  it("composes a filter from the ticked boxes and the source", () => {
    const filter = composeFilter("in_syslog", choices);
    expect(filter).toContain('__inputId === "in_syslog"');
    expect(filter).toContain("TRAFFIC");
    expect(filter).not.toContain("HIPMATCH");
  });

  it("ticking an offered type adds it to the filter", () => {
    const next = toggleChoice(choices, "HIPMATCH");
    expect(selectedValues(next)).toEqual(["TRAFFIC", "HIPMATCH"]);
    expect(composeFilter("in_syslog", next)).toContain("HIPMATCH");
  });

  it("unticking everything captures the whole source, not nothing", () => {
    // A legitimate choice: an operator who does not know what the source sends
    // should be able to look first.
    const none = toggleChoice(choices, "TRAFFIC");
    expect(selectedValues(none)).toEqual([]);
    expect(composeFilter("in_syslog", none)).toBe('__inputId === "in_syslog"');
  });

  it("surfaces the __inputId warning for an edited filter", () => {
    expect(filterWarning("/,TRAFFIC,/i.test(_raw)", "in_syslog")).toContain(
      "EVERY source",
    );
    expect(filterWarning(composeFilter("in_syslog", choices), "in_syslog")).toBeNull();
  });
});

describe("deriveCaptureView", () => {
  it("says nothing is added until confirmed, before a run", () => {
    const view = deriveCaptureView(null, false, []);
    expect(view.status).toBe("idle");
    expect(view.headline).toContain("Nothing is added until you confirm");
  });

  it("reports a failed capture separately from an empty one", () => {
    // They send the operator to different places: a permission or filter
    // problem, versus an idle source.
    const failed = deriveCaptureView(
      result({ ok: false, notes: ["HTTP 403"] }),
      false,
      [],
    );
    expect(failed.status).toBe("failed");
    expect(failed.notes).toEqual(["HTTP 403"]);

    const empty = deriveCaptureView(
      result({ ok: true, notes: ["matched no events"] }),
      false,
      [],
    );
    expect(empty.status).toBe("empty");
    expect(empty.headline).toContain("returned no events");
  });

  it("summarises the capture and previews each log type", () => {
    const view = deriveCaptureView(
      result({
        rawEvents: ["a", "b", "c"],
        splits: [
          { logType: "TRAFFIC", rawEvents: ["a", "b"], format: "csv", eventCount: 2 },
          { logType: "THREAT", rawEvents: ["c"], format: "csv", eventCount: 1 },
        ],
      }),
      false,
      [],
    );
    expect(view.status).toBe("ready");
    expect(view.headline).toBe("Captured 3 events in 2 log types (csv).");
    expect(view.logTypes.map((l) => l.eventCount)).toEqual([2, 1]);
    expect(view.logTypes[0].preview).toEqual(["a", "b"]);
  });

  it("WARNS which log types a commit would replace", () => {
    // The store is replace-by-logType, so this loss is otherwise invisible -
    // and it is the operator's own curated sample being overwritten.
    const view = deriveCaptureView(
      result({
        rawEvents: ["a", "b"],
        splits: [
          { logType: "TRAFFIC", rawEvents: ["a"], format: "csv", eventCount: 1 },
          { logType: "THREAT", rawEvents: ["b"], format: "csv", eventCount: 1 },
        ],
      }),
      false,
      ["traffic"],
    );
    // Case-insensitive: the store keys on the label the operator typed.
    expect(view.collisions).toEqual(["TRAFFIC"]);
    expect(view.logTypes[0].replacesExisting).toBe(true);
    expect(view.logTypes[1].replacesExisting).toBe(false);
  });

  it("carries the no-discriminator flag through", () => {
    const view = deriveCaptureView(
      result({
        rawEvents: ["x"],
        noDiscriminator: true,
        splits: [{ logType: "captured", rawEvents: ["x"], format: "unknown", eventCount: 1 }],
      }),
      false,
      [],
    );
    expect(view.noDiscriminator).toBe(true);
  });

  it("shows RUNNING even when a previous result is in hand", () => {
    const view = deriveCaptureView(result({ rawEvents: ["a"] }), true, []);
    expect(view.status).toBe("running");
  });
});

describe("plannedCaptureSamples", () => {
  it("re-tags through the SAME content-first parse an upload uses", () => {
    // What makes a captured sample and an uploaded one indistinguishable
    // downstream: the format is detected again from the raw lines rather than
    // carried over from the capture.
    const samples = plannedCaptureSamples(
      [
        {
          logType: "TRAFFIC",
          rawEvents: [
            "CEF:0|Palo Alto|PAN-OS|10.2|end|TRAFFIC|3|src=10.0.0.1",
          ],
          format: "unknown",
          eventCount: 1,
        },
      ],
      "capture:in_syslog",
    );
    expect(samples).toHaveLength(1);
    expect(samples[0].logType).toBe("TRAFFIC");
    // Detected from content, not the "unknown" the split carried.
    expect(samples[0].format).toBe("cef");
    // And the raw vendor line survives, as it does for an upload.
    expect(samples[0].rawEvents[0]).toContain("CEF:0|");
  });

  it("drops an empty split rather than storing a sample with no events", () => {
    const samples = plannedCaptureSamples(
      [{ logType: "EMPTY", rawEvents: [], format: "csv", eventCount: 0 }],
      "capture:x",
    );
    expect(samples).toEqual([]);
  });

  it("collapses duplicate log types, last wins, first position kept", () => {
    // Mirrors the store's own replace-by-logType semantics, so committing a
    // capture cannot produce two chips with the same name.
    const samples = plannedCaptureSamples(
      [
        { logType: "A", rawEvents: ['{"n":"first"}'], format: "ndjson", eventCount: 1 },
        { logType: "B", rawEvents: ['{"n":"other"}'], format: "ndjson", eventCount: 1 },
        { logType: "A", rawEvents: ['{"n":"second"}'], format: "ndjson", eventCount: 1 },
      ],
      "capture:x",
    );
    expect(samples.map((s) => s.logType)).toEqual(["A", "B"]);
    expect(samples[0].parsed.records[0].n).toBe("second");
  });

  it("drops a split whose lines parse to nothing, rather than storing a husk", () => {
    // A sample with zero events is worse than none: it satisfies the
    // "samples provided" check while carrying no fields to map.
    const samples = plannedCaptureSamples(
      [{ logType: "JUNK", rawEvents: ["   "], format: "unknown", eventCount: 1 }],
      "capture:x",
    );
    expect(samples.every((s) => s.parsed.records.length > 0)).toBe(true);
  });
});
