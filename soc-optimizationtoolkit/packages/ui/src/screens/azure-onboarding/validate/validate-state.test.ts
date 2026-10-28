// Pins for the Validate panel's pure state (AZR-32, unit S2).
//
// The failure these exist to catch is an unknown rendered as a fact: a denied
// read shown as "not found", or an unreadable arrival metric shown as a zero.

import { describe, expect, it } from "vitest";
import { otherNameAlsoFound } from "@soc/core";
import type { CheckKind, PlanValues, StepVerdict, UnknownReason, ValidationResult } from "@soc/core";
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

  // DBT-178: every other-name verdict said "which targets the plan's hub",
  // false for the policy checks, which target no hub. The words are per kind.
  it("words an other-name verdict true for each check kind that can return one", () => {
    const other = (name: string, alsoFound?: number): StepVerdict =>
      alsoFound === undefined
        ? { kind: "present-other-name", name, diffs: [] }
        : { kind: "present-other-name", name, diffs: [], alsoFound };
    const detail = (kind: CheckKind, v: StepVerdict) => verdictView(v, kind).detail;
    expect(detail("defender-export", other("PortalExport"))).toBe(
      "Found as PortalExport, a continuous export that sends to the plan's Event Hub namespace.",
    );
    expect(detail("entra-setting", other("Portal"))).toBe(
      "Found as Portal, a diagnostic setting that sends to the plan's Event Hub namespace.",
    );
    expect(detail("policy-assignment", other("Cribl-AU-Old"))).toBe(
      "Found as Cribl-AU-Old, a policy assignment that uses the plan's initiative or is named like its assignments.",
    );
    expect(detail("policy-remediation", other("Cribl-AU-Old"))).toBe(
      "Found remediations of Cribl-AU-Old, an assignment named like the plan's but not the one the steps name.",
    );
    // A kind with no wording of its own claims nothing beyond the name.
    expect(detail("eh-hub", other("x"))).toBe("Found as x, a name the plan does not use.");
    for (const kind of ["policy-assignment", "policy-remediation"] as const) {
      expect(detail(kind, other("x")).toLowerCase(), kind).not.toContain("hub");
    }
  });

  it("says how many others besides the one named", () => {
    const v = (alsoFound: number): StepVerdict => ({ kind: "present-other-name", name: "A", diffs: [], alsoFound });
    expect(verdictView(v(1), "policy-assignment").detail).toBe(
      "Found as A, a policy assignment that uses the plan's initiative or is named like its assignments. " +
        "1 other policy assignment like it was also found.",
    );
    // DBT-189: the remediation count is of ASSIGNMENTS, and now says so.
    expect(verdictView(v(3), "policy-remediation").detail).toBe(
      "Found remediations of A, an assignment named like the plan's but not the one the steps name. " +
        "3 other assignments like it with remediations were also found.",
    );
    expect(verdictView(v(2), "entra-setting").detail).toBe(
      "Found as A, a diagnostic setting that sends to the plan's Event Hub namespace. " +
        "2 other diagnostic settings like it were also found.",
    );
    expect(verdictView(v(0), "defender-export").detail).toBe(
      "Found as A, a continuous export that sends to the plan's Event Hub namespace.",
    );
  });

  it("verdictGroups words each row by its own check kind", () => {
    const verdict: StepVerdict = { kind: "present-other-name", name: "N", diffs: [] };
    const check = (kind: CheckKind) => ({
      key: kind,
      sourceId: "diagnosticSettingsInitiative" as const,
      stepId: "s1",
      kind,
      verdict,
    });
    const groups = verdictGroups({ checks: [check("policy-assignment"), check("policy-remediation")] });
    expect(groups.length).toBe(1);
    const [group] = groups;
    expect(group?.rows.map((r) => r.view.detail)).toEqual([
      "Found as N, a policy assignment that uses the plan's initiative or is named like its assignments.",
      "Found remediations of N, an assignment named like the plan's but not the one the steps name.",
    ]);
  });

  it("a row's other-name count is core's shared wording, in the row's kind (DBT-189)", () => {
    const verdict: StepVerdict = { kind: "present-other-name", name: "N", diffs: [], alsoFound: 2 };
    const groups = verdictGroups({
      checks: [{ key: "k", sourceId: "diagnosticSettingsInitiative", stepId: "s1", kind: "policy-remediation", verdict }],
    });
    const also = otherNameAlsoFound(2, "policy-remediation");
    expect(also).toBe("2 other assignments like it with remediations were also found");
    expect(groups[0]?.rows[0]?.view.detail).toBe(
      `Found remediations of N, an assignment named like the plan's but not the one the steps name. ${also}.`,
    );
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

  it("a hub the complete listing lacks says it does not exist; the quiet hub keeps its zero (AZR-47)", () => {
    const missing = arrivalView("insights-logs-auditlogs", { kind: "no-hub" });
    expect(missing).toEqual({
      text: "insights-logs-auditlogs: the hub does not exist yet, so nothing has been sent to it",
      tone: "error",
      measured: true,
    });
    const quiet = arrivalView("t2", { kind: "measured", messages: 0, window: "PT1H" });
    expect(quiet).toEqual({ text: "t2: no messages in the window", tone: "warning", measured: true });
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
    s = validateRunReducer(s, { type: "finish", runId: 1, result: RESULT, asOf: "10:00", values: {} as PlanValues });
    expect(s.kind).toBe("done");
    expect(runStatusText(s)).toBe("Checked as of 10:00.");
  });

  it("ignores a late callback once the run is no longer running", () => {
    const done = validateRunReducer(
      validateRunReducer(VALIDATE_IDLE, { type: "start", runId: 1, total: 1 }),
      { type: "finish", runId: 1, result: RESULT, asOf: "10:00", values: {} as PlanValues },
    );
    expect(validateRunReducer(done, { type: "progress", runId: 1, done: 1, total: 1 })).toBe(done);
    expect(validateRunReducer(VALIDATE_IDLE, { type: "finish", runId: 1, result: RESULT, asOf: "x", values: {} as PlanValues })).toBe(
      VALIDATE_IDLE,
    );
  });

  it("ignores a replaced run's late progress, finish and fail", () => {
    let s = validateRunReducer(VALIDATE_IDLE, { type: "start", runId: 1, total: 3 });
    s = validateRunReducer(s, { type: "reset" });
    const second = validateRunReducer(s, { type: "start", runId: 2, total: 7 });
    expect(second).toEqual({ kind: "running", runId: 2, done: 0, total: 7 });
    expect(validateRunReducer(second, { type: "finish", runId: 1, result: RESULT, asOf: "09:00", values: {} as PlanValues })).toBe(second);
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
      { type: "finish", runId: 1, result: { ...RESULT, cancelled: true }, asOf: "10:00", values: {} as PlanValues },
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
