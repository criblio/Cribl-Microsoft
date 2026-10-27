import { describe, expect, it } from "vitest";
import {
  FLOW_STATE_LABEL,
  classifyLaneFlow,
  describeLaneFlow,
  matchInputLabel,
  shouldAnimate,
  unmatchedInputLabels,
  windowSawInput,
  type FlowAnswer,
  type FlowInput,
  type LaneFlowState,
  type LookbackStatus,
} from "./index";

const input: FlowInput = { type: "eventhub", id: "azure_onb_eh_ns_hub" };
const label = "eventhub:azure_onb_eh_ns_hub";

const rows = (...r: Array<[string, number]>): FlowAnswer => ({
  kind: "rows",
  rows: r.map(([input, in_events]) => ({ input, in_events, in_bytes: in_events * 10 })),
});
const empty: FlowAnswer = { kind: "empty" };
const forbidden: FlowAnswer = { kind: "error", status: 403, reason: "http", detail: "forbidden" };
const serverError: FlowAnswer = { kind: "error", status: 500, reason: "http", detail: "boom" };
const badShape: FlowAnswer = { kind: "error", status: 200, reason: "unexpected-shape", detail: "expected {results}" };
const refused: FlowAnswer = { kind: "refused", status: 403, detail: "forbidden" };
const failed: FlowAnswer = { kind: "failed", detail: "network down" };

function cls(
  windowAnswer: FlowAnswer | null,
  lookbackAnswer: FlowAnswer | null,
  lookbackStatus: LookbackStatus,
  i: FlowInput | null = input,
): LaneFlowState {
  return classifyLaneFlow({ input: i, windowAnswer, lookbackAnswer, lookbackStatus });
}

describe("classifyLaneFlow", () => {
  type Case = [string, FlowAnswer | null, FlowAnswer | null, LookbackStatus, LaneFlowState];
  const cases: Case[] = [
    ["window row > 0", rows([label, 12]), rows([label, 40]), "answered", { kind: "flowing", events: 12 }],
    ["window row > 0, lookback failed", rows([label, 3]), failed, "failed", { kind: "flowing", events: 3 }],
    ["window row = 0, seen in lookback", rows([label, 0]), rows([label, 40]), "answered", { kind: "idle", seenInLookback: true }],
    ["window row = 0, lookback failed", rows([label, 0]), failed, "failed", { kind: "idle", seenInLookback: false }],
    ["no window row, lookback row > 0", rows(["eventhub:other", 5]), rows([label, 40]), "answered", { kind: "idle", seenInLookback: true }],
    ["window empty, lookback row > 0", empty, rows([label, 40]), "answered", { kind: "idle", seenInLookback: true }],
    ["no window yet, lookback row > 0", null, rows([label, 40]), "answered", { kind: "idle", seenInLookback: true }],
    ["no window row, lookback no row", empty, empty, "answered", { kind: "never-seen", lookback: "-24h" }],
    ["no window yet, lookback no row", null, rows(["eventhub:other", 9]), "answered", { kind: "never-seen", lookback: "-24h" }],
    ["no window row, lookback row 0", empty, rows([label, 0]), "answered", { kind: "never-seen", lookback: "-24h" }],
    ["window 403", forbidden, rows([label, 40]), "answered", { kind: "not-measured", reason: "no-permission", detail: "HTTP 403: forbidden" }],
    ["window refused", refused, null, "pending", { kind: "not-measured", reason: "no-permission", detail: "HTTP 403: forbidden" }],
    ["window 500", serverError, rows([label, 40]), "answered", { kind: "not-measured", reason: "http-error", detail: "HTTP 500: boom" }],
    ["window rejected", failed, null, "failed", { kind: "not-measured", reason: "http-error", detail: "network down" }],
    ["window bad shape", badShape, null, "answered", { kind: "not-measured", reason: "unexpected-shape", detail: "expected {results}" }],
    ["no window row, lookback failed", empty, serverError, "failed", { kind: "not-measured", reason: "lookback-failed", detail: "HTTP 500: boom" }],
    ["no window yet, lookback failed", null, failed, "failed", { kind: "not-measured", reason: "lookback-failed", detail: "network down" }],
    ["no window yet, lookback 403", null, forbidden, "failed", { kind: "not-measured", reason: "no-permission", detail: "HTTP 403: forbidden" }],
    ["nothing yet", null, null, "pending", { kind: "not-measured", reason: "waiting", detail: "no metrics answer yet" }],
  ];

  it.each(cases)("%s", (_name, w, l, status, expected) => {
    expect(cls(w, l, status)).toEqual(expected);
  });

  it("no input is no-source, whatever the answers", () => {
    expect(cls(rows([label, 12]), null, "answered", null)).toMatchObject({ kind: "not-measured", reason: "no-source" });
  });

  it("a 403 is never idle and never zero", () => {
    for (const status of ["pending", "answered", "failed"] as const) {
      const s = cls(forbidden, rows([label, 40]), status);
      expect(s.kind).toBe("not-measured");
    }
  });

  it("a missing row is never idle unless the lookback measured the input", () => {
    for (const status of ["pending", "answered", "failed"] as const) {
      expect(cls(empty, empty, status).kind).not.toBe("idle");
      expect(cls(empty, null, status).kind).not.toBe("idle");
    }
  });

  it("a failed lookback with no window row is lookback-failed, not waiting and not never-seen", () => {
    const s = cls(null, serverError, "failed");
    expect(s).toMatchObject({ kind: "not-measured", reason: "lookback-failed" });
    expect(describeLaneFlow(s)).toBe("not measured: lookback failed");
  });

  it("a window that answered plus a 403 lookback is lookback-failed, not no-permission", () => {
    for (const w of [empty, rows(["eventhub:other", 5])]) {
      expect(cls(w, forbidden, "failed")).toEqual({
        kind: "not-measured",
        reason: "lookback-failed",
        detail: "HTTP 403: forbidden",
      });
      expect(cls(w, refused, "failed")).toMatchObject({ reason: "lookback-failed" });
    }
  });

  it("once a window measured the input, a later missing row is idle seen earlier, never never-seen", () => {
    // Session sequence: lookback empty at mount, window 5, then window with no row.
    let seen = false;
    const lookback = empty;
    const first = classifyLaneFlow({ input, windowAnswer: rows([label, 5]), lookbackAnswer: lookback, lookbackStatus: "answered", seenInSession: seen });
    expect(first).toEqual({ kind: "flowing", events: 5 });
    seen = seen || windowSawInput(rows([label, 5]), input);
    expect(seen).toBe(true);
    const later = classifyLaneFlow({ input, windowAnswer: empty, lookbackAnswer: lookback, lookbackStatus: "answered", seenInSession: seen });
    expect(later).toEqual({ kind: "idle", seenInLookback: false, seenInSession: true });
    expect(describeLaneFlow(later)).toBe("idle: no events in the window, seen earlier");
    // A failed lookback does not erase the session evidence either.
    expect(classifyLaneFlow({ input, windowAnswer: empty, lookbackAnswer: failed, lookbackStatus: "failed", seenInSession: true }).kind).toBe("idle");
    // A measured zero window row after flowing still says seen earlier.
    expect(classifyLaneFlow({ input, windowAnswer: rows([label, 0]), lookbackAnswer: lookback, lookbackStatus: "answered", seenInSession: true })).toEqual({ kind: "idle", seenInLookback: false, seenInSession: true });
  });

  it("windowSawInput is true only for a measured row above zero for this input", () => {
    expect(windowSawInput(rows([label, 1]), input)).toBe(true);
    expect(windowSawInput(rows([label, 0]), input)).toBe(false);
    expect(windowSawInput(rows(["eventhub:other", 9]), input)).toBe(false);
    expect(windowSawInput(empty, input)).toBe(false);
    expect(windowSawInput(forbidden, input)).toBe(false);
    expect(windowSawInput(null, input)).toBe(false);
    expect(windowSawInput(rows([label, 1]), null)).toBe(false);
  });

  it("never-seen carries the caller's lookback time when given", () => {
    const s = classifyLaneFlow({ input, windowAnswer: empty, lookbackAnswer: empty, lookbackStatus: "answered", lookbackAsOf: "10:02" });
    expect(s).toEqual({ kind: "never-seen", lookback: "-24h", asOf: "10:02" });
    expect(describeLaneFlow(s)).toBe("never seen in the last 24 hours (lookback taken 10:02)");
  });

  it("sums every row naming the input (extra segments)", () => {
    expect(cls(rows([label, 2], [`${label}:p0`, 3]), null, "pending")).toEqual({ kind: "flowing", events: 5 });
  });
});

describe("matchInputLabel", () => {
  it.each([
    ["eventhub:azure_onb_eh_ns_hub", true],
    ["eventhub:azure_onb_eh_ns_hub:p1", true],
    ["azure_blob:azure_onb_eh_ns_hub", false],
    ["eventhub:azure_onb_eh_ns_hub2", false],
    ["eventhub:pk.azure_onb_eh_ns_hub", false],
    ["eventhub", false],
    ["", false],
  ])("%s -> %s", (l, ok) => {
    expect(matchInputLabel(l, input)).toBe(ok);
  });

  it("reads a pack prefix only for an input inside that pack", () => {
    const packed: FlowInput = { ...input, packId: "pk" };
    expect(matchInputLabel("eventhub:pk.azure_onb_eh_ns_hub", packed)).toBe(true);
    expect(matchInputLabel("eventhub:azure_onb_eh_ns_hub", packed)).toBe(false);
    expect(matchInputLabel("eventhub:pk.azure_onb_eh_ns_hub", input, new Set(["pk"]))).toBe(false);
  });
});

describe("shouldAnimate", () => {
  it("is true only for flowing", () => {
    const states: LaneFlowState[] = [
      { kind: "flowing", events: 1 },
      { kind: "idle", seenInLookback: true },
      { kind: "idle", seenInLookback: false },
      { kind: "never-seen", lookback: "-24h" },
      { kind: "not-measured", reason: "waiting", detail: "" },
      { kind: "not-measured", reason: "no-permission", detail: "" },
      { kind: "blocked" },
    ];
    expect(states.map(shouldAnimate)).toEqual([true, false, false, false, false, false, false]);
  });
});

describe("labels", () => {
  it("every state kind has a distinct word", () => {
    const words = Object.values(FLOW_STATE_LABEL);
    expect(new Set(words).size).toBe(words.length);
    expect(Object.keys(FLOW_STATE_LABEL).sort()).toEqual(["blocked", "flowing", "idle", "never-seen", "not-measured"]);
  });

  it("describes never-seen with the lookback actually queried", () => {
    expect(describeLaneFlow({ kind: "never-seen", lookback: "-24h" })).toBe("never seen in the last 24 hours");
    expect(describeLaneFlow({ kind: "not-measured", reason: "no-permission", detail: "" })).toBe("not measured: no permission");
  });
});

describe("unmatchedInputLabels", () => {
  it("lists labels that name no lane input, sorted and deduped", () => {
    const a = rows([label, 1], ["syslog:in_syslog:udp", 2], ["eventhub:x", 3], ["eventhub:x", 4]);
    expect(unmatchedInputLabels(a, [input])).toEqual(["eventhub:x", "syslog:in_syslog:udp"]);
    expect(unmatchedInputLabels(forbidden, [input])).toEqual([]);
  });
});
