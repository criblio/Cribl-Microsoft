import { describe, expect, it } from "vitest";
import type { ApplyTeardownOutcome, CriblSourceRecord, LakeRouteRecord } from "@soc/core";
import { pauseArmKey, removeArmKey, teardownOutcomeView, teardownRows, twoClick, twoClickReducer, type TwoClickState } from "./teardown-state";

const SOURCE: CriblSourceRecord = { groupId: "g1", inputId: "azure_onb_eh_t_ns_x", inputType: "eventhub", secretId: "azure_onb_eh_t_ns_x_secret" };
const LAKE: LakeRouteRecord = { groupId: "g1", datasetId: "azure_activity_log", pipelineId: null, routeId: "azure_onb_activity_log_lake" };

function outcome(over: Partial<ApplyTeardownOutcome>): ApplyTeardownOutcome {
  return { kind: "stopped", steps: [], commit: { kind: "not-needed" }, records: { criblSource: null, lakeRoute: null }, detail: "d", ...over };
}

describe("teardownRows", () => {
  it("lists every source with any record, once, sorted - a Lake record alone counts", () => {
    const rows = teardownRows({ vnetFlowLogs: SOURCE, activityLog: SOURCE }, { activityLog: LAKE, defenderExport: LAKE });
    expect(rows.map((r) => r.sourceId)).toEqual(["activityLog", "defenderExport", "vnetFlowLogs"]);
    expect(rows[1]).toEqual({ sourceId: "defenderExport", criblSource: null, lakeRoute: LAKE });
  });
});

describe("arm keys", () => {
  it("change with the opt-in, the records and the read, and differ between pause and resume", () => {
    const row = { sourceId: "activityLog" as const, criblSource: SOURCE, lakeRoute: LAKE };
    expect(removeArmKey(row, false, 0)).not.toBe(removeArmKey(row, true, 0));
    expect(removeArmKey(row, false, 0)).not.toBe(removeArmKey(row, false, 1));
    expect(removeArmKey(row, false, 0)).not.toBe(removeArmKey({ ...row, lakeRoute: null }, false, 0));
    expect(pauseArmKey(row, true, 0)).not.toBe(pauseArmKey(row, false, 0));
  });
});

describe("twoClickReducer", () => {
  type S = TwoClickState<string, string, string>;
  it("arms only for the key it planned, and a new key disarms for good", () => {
    let s: S = { phase: "idle" };
    s = twoClickReducer(s, { type: "plan-start", key: "a" });
    s = twoClickReducer(s, { type: "plan-result", key: "a", ready: "R", result: null });
    expect(twoClick(s, "a")).toBe("apply");
    expect(twoClick(s, "b")).toBe("plan");
    s = twoClickReducer(s, { type: "inputs", key: "b" });
    expect(s).toEqual({ phase: "idle" });
    s = twoClickReducer(s, { type: "inputs", key: "a" });
    expect(s).toEqual({ phase: "idle" });
  });

  it("an apply in flight runs to its outcome, whatever the inputs do", () => {
    let s: S = { phase: "armed", key: "a", ready: "R" };
    s = twoClickReducer(s, { type: "apply-start", key: "a" });
    s = twoClickReducer(s, { type: "inputs", key: "b" });
    s = twoClickReducer(s, { type: "reset" });
    expect(s).toEqual({ phase: "applying", key: "a" });
    expect(twoClickReducer(s, { type: "apply-result", outcome: "O" })).toEqual({ phase: "done", outcome: "O" });
  });
});

describe("teardownOutcomeView", () => {
  it("names a permission refusal as one, and a void as a change since the confirm", () => {
    const denied = teardownOutcomeView(
      outcome({ steps: [{ kind: "input", id: SOURCE.inputId, result: "failed", detail: "x", denied: true }] }),
    );
    expect(denied.headline).toBe("Stopped: Cribl refused a removal (permission).");
    expect(denied.tone).toBe("error");
    expect(teardownOutcomeView(outcome({ kind: "void" })).headline).toBe(
      "Not removed: Cribl changed since the confirm, so it no longer describes what would go. Check again.",
    );
    expect(teardownOutcomeView(outcome({ kind: "removed" })).tone).toBe("ok");
  });
});
