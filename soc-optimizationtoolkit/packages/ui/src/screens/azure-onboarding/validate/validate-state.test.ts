// Pins for the Validate panel's pure state (AZR-32, unit S2).
//
// The failure these exist to catch is an unknown rendered as a fact: a denied
// read shown as "not found", or an unreadable arrival metric shown as a zero.

import { describe, expect, it } from "vitest";
import type { StepVerdict, UnknownReason, ValidationResult } from "@soc/core";
import { findHistoryInCopy } from "../../../components/copy-rules";
import {
  VALIDATE_IDLE,
  arrivalView,
  runStatusText,
  validateDisabledReason,
  validateIntro,
  validateRunReducer,
  verdictGroups,
  verdictView,
} from "./validate-state";

const REASONS: readonly UnknownReason[] = [
  "denied",
  "failed",
  "truncated",
  "unregistered",
  "unmeasurable",
  "missing-value",
];

const unknown = (reason: UnknownReason): StepVerdict => ({ kind: "unknown", reason, detail: "" });

describe("verdictView", () => {
  it("never says 'not found' or 'absent' for an unknown verdict", () => {
    for (const reason of REASONS) {
      const v = verdictView(unknown(reason));
      const text = `${v.word} ${v.detail}`.toLowerCase();
      expect(text, reason).not.toContain("not found");
      expect(text, reason).not.toContain("absent");
      expect(v.tone).toBe("unknown");
    }
    expect(verdictView(unknown("denied")).word).toBe("could not be read");
  });

  it("only core's absent says 'not found'", () => {
    expect(verdictView({ kind: "absent" }).word).toBe("not found");
    expect(verdictView({ kind: "as-expected" }).word).toBe("as expected");
  });

  it("keeps the differences and names the other name", () => {
    const diffs = [{ field: "sku", expected: "Standard", actual: "Basic" }];
    const differs = verdictView({ kind: "present-differs", diffs });
    expect(differs.word).toBe("present but different");
    expect(differs.diffs).toEqual(diffs);
    const other = verdictView({ kind: "present-other-name", name: "MyExport", diffs: [] });
    expect(other.word).toBe("present under another name");
    expect(other.detail).toContain("MyExport");
  });

  it("gives every verdict kind a distinct word", () => {
    const words = new Set(
      [
        verdictView({ kind: "as-expected" }),
        verdictView({ kind: "present-differs", diffs: [] }),
        verdictView({ kind: "present-other-name", name: "x", diffs: [] }),
        verdictView({ kind: "absent" }),
        verdictView(unknown("denied")),
      ].map((v) => v.word),
    );
    expect(words.size).toBe(5);
  });
});

describe("arrivalView", () => {
  it("keeps a measured zero apart from an unreadable metric", () => {
    const zero = arrivalView("h1", { kind: "measured", messages: 0, window: "PT1H" });
    const denied = arrivalView("h1", { kind: "unknown", reason: "denied", detail: "" });
    expect(zero.text).toBe("h1: no messages in the window");
    expect(zero.measured).toBe(true);
    expect(denied.measured).toBe(false);
    expect(denied.text).toContain("could not be read");
    expect(denied.text).not.toContain("no messages");
    expect(zero.text).not.toBe(denied.text);
  });

  it("counts messages", () => {
    expect(arrivalView("h1", { kind: "measured", messages: 3, window: "PT1H" }).text).toBe(
      "h1: 3 messages in the window",
    );
    expect(arrivalView("h1", { kind: "measured", messages: 1, window: "PT1H" }).text).toBe(
      "h1: 1 message in the window",
    );
  });
});

describe("validateIntro and gating", () => {
  it("states the read count, the pace, and that nothing changes", () => {
    expect(validateIntro({ firstPageReads: 7, listReads: 0, maxReads: 7, missing: [] })).toBe(
      "Validate reads 7 Azure resources at most 40 a minute. Nothing is changed.",
    );
  });

  it("states the paged bound and the missing values", () => {
    const text = validateIntro({ firstPageReads: 4, listReads: 2, maxReads: 42, missing: ["namespace"] });
    expect(text).toContain("Validate reads 4 Azure resources");
    expect(text).toContain("never more than 42 requests");
    expect(text).toContain("namespace");
  });

  it("never runs unpaced", () => {
    const plan = { firstPageReads: 3, listReads: 0, maxReads: 3, missing: [] };
    expect(validateDisabledReason({ hasPacing: false, running: false, plan })).toContain("pacing unavailable");
    expect(validateDisabledReason({ hasPacing: true, running: false, plan })).toBeNull();
    expect(validateDisabledReason({ hasPacing: true, running: true, plan })).not.toBeNull();
    expect(
      validateDisabledReason({ hasPacing: true, running: false, plan: { ...plan, firstPageReads: 0 } }),
    ).not.toBeNull();
  });
});

const RESULT: ValidationResult = {
  verdicts: {},
  checks: [
    { key: "defenderExport/P1/eh-namespace", sourceId: "defenderExport", stepId: "P1", kind: "eh-namespace", verdict: { kind: "as-expected" } },
    { key: "entraId/E1/entra-setting", sourceId: "entraId", stepId: "E1", kind: "entra-setting", verdict: unknown("denied") },
    { key: "defenderExport/D1/defender-export", sourceId: "defenderExport", stepId: "D1", kind: "defender-export", verdict: { kind: "absent" } },
  ],
  measuredHubs: [],
  arrival: {},
  cancelled: false,
};

describe("verdictGroups", () => {
  it("groups by source in first-seen order", () => {
    const groups = verdictGroups(RESULT);
    expect(groups.map((g) => g.sourceId)).toEqual(["defenderExport", "entraId"]);
    expect(groups[0]!.rows.map((r) => r.stepId)).toEqual(["P1", "D1"]);
    expect(groups[1]!.rows[0]!.view.word).toBe("could not be read");
  });
});

describe("validateRunReducer", () => {
  it("runs, progresses and finishes", () => {
    let s = validateRunReducer(VALIDATE_IDLE, { type: "start", runId: 1, total: 5 });
    s = validateRunReducer(s, { type: "progress", runId: 1, done: 2, total: 5 });
    expect(runStatusText(s)).toBe("Reading 2 of 5...");
    s = validateRunReducer(s, { type: "finish", runId: 1, result: RESULT, asOf: "10:00" });
    expect(s.kind).toBe("done");
    expect(runStatusText(s)).toBe("Checked as of 10:00.");
  });

  it("ignores a late callback once the run is no longer running", () => {
    const done = validateRunReducer(
      validateRunReducer(VALIDATE_IDLE, { type: "start", runId: 1, total: 1 }),
      { type: "finish", runId: 1, result: RESULT, asOf: "10:00" },
    );
    expect(validateRunReducer(done, { type: "progress", runId: 1, done: 1, total: 1 })).toBe(done);
    expect(validateRunReducer(VALIDATE_IDLE, { type: "finish", runId: 1, result: RESULT, asOf: "x" })).toBe(
      VALIDATE_IDLE,
    );
  });

  it("ignores a replaced run's late progress, finish and fail", () => {
    let s = validateRunReducer(VALIDATE_IDLE, { type: "start", runId: 1, total: 3 });
    s = validateRunReducer(s, { type: "reset" });
    const second = validateRunReducer(s, { type: "start", runId: 2, total: 7 });
    expect(second).toEqual({ kind: "running", runId: 2, done: 0, total: 7 });
    expect(validateRunReducer(second, { type: "finish", runId: 1, result: RESULT, asOf: "09:00" })).toBe(second);
    expect(validateRunReducer(second, { type: "progress", runId: 1, done: 3, total: 3 })).toBe(second);
    expect(validateRunReducer(second, { type: "fail", runId: 1, message: "old" })).toBe(second);
    // The current run's own callbacks still land.
    expect(validateRunReducer(second, { type: "progress", runId: 2, done: 4, total: 7 })).toEqual({
      kind: "running",
      runId: 2,
      done: 4,
      total: 7,
    });
  });

  it("says a cancelled run left checks unread, not absent", () => {
    const s = validateRunReducer(
      validateRunReducer(VALIDATE_IDLE, { type: "start", runId: 1, total: 1 }),
      { type: "finish", runId: 1, result: { ...RESULT, cancelled: true }, asOf: "10:00" },
    );
    expect(runStatusText(s)).toContain("could not be read");
  });
});

describe("copy", () => {
  it("carries no project history", () => {
    const texts: string[] = [];
    for (const r of REASONS) {
      const v = verdictView(unknown(r));
      texts.push(v.word, v.detail);
      texts.push(arrivalView("h", { kind: "unknown", reason: r, detail: "" }).text);
    }
    texts.push(validateIntro({ firstPageReads: 4, listReads: 2, maxReads: 42, missing: ["namespace"] }));
    expect(findHistoryInCopy(texts.map((text, i) => ({ where: `validate#${i}`, text })))).toEqual([]);
  });
});
