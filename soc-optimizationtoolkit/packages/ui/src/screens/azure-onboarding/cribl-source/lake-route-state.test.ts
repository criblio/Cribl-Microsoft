/**
 * Pins for the Lake route confirm (AZR-35): the arm key disarms on every
 * change the confirm names, the confirm says everything the apply does (and
 * nothing it does not), and the position picker offers the table it read.
 */

import { describe, expect, it } from "vitest";
import { LAKE_ROUTE_SOURCES } from "@soc/core";
import type { PlanLakeRouteResult } from "@soc/core";
import {
  LAKE_CONFIRM_IDLE,
  LAKE_PLAN_REFUSAL_COPY,
  isLakeArmed,
  lakeArmKey,
  lakeClick,
  lakeConfirmReducer,
  lakeConfirmText,
  lakeOutcomeView,
  lakePlanResultView,
  positionFromValue,
  positionOptions,
  positionValue,
} from "./lake-route-state";
import { DEPLOYED, TABLE, readyLake } from "./lake-route.test-util";

const KEY_INPUTS = { groupId: "g1", sourceId: "defenderExport" as const, inputId: "in_def", position: { kind: "top" as const }, readSeq: 1 };

describe("position picker", () => {
  it("offers top, before each route in table order, and end", () => {
    const opts = positionOptions(TABLE);
    expect(opts.map((o) => o.value)).toEqual(["top", "before:r_fw", "before:r_okta", "before:r_complex", "before:default", "end"]);
    expect(opts[1]!.label).toContain("Firewall");
    expect(opts[1]!.label).toContain("__inputId.startsWith('syslog:in_fw:')");
  });

  it("round-trips every position through the picker value", () => {
    for (const p of [{ kind: "top" }, { kind: "end" }, { kind: "before", routeId: "r_okta" }] as const) {
      expect(positionFromValue(positionValue(p))).toEqual(p);
    }
    expect(positionFromValue("before:")).toEqual({ kind: "top" });
  });
});

describe("arm key and confirm machine", () => {
  it("every input the confirm names changes the key", () => {
    const base = lakeArmKey(KEY_INPUTS);
    expect(lakeArmKey({ ...KEY_INPUTS, groupId: "g2" })).not.toBe(base);
    expect(lakeArmKey({ ...KEY_INPUTS, inputId: "other" })).not.toBe(base);
    expect(lakeArmKey({ ...KEY_INPUTS, position: { kind: "end" } })).not.toBe(base);
    expect(lakeArmKey({ ...KEY_INPUTS, position: { kind: "before", routeId: "r_fw" } })).not.toBe(base);
    expect(lakeArmKey({ ...KEY_INPUTS, readSeq: 2 })).not.toBe(base);
    expect(lakeArmKey({ ...KEY_INPUTS })).toBe(base);
  });

  it("first click plans, the second (same key) applies; a changed key disarms for good", () => {
    const key = lakeArmKey(KEY_INPUTS);
    expect(lakeClick(LAKE_CONFIRM_IDLE, key)).toBe("plan");
    let s = lakeConfirmReducer(LAKE_CONFIRM_IDLE, { type: "plan-start", key });
    const result: PlanLakeRouteResult = { kind: "ready", ready: readyLake() };
    s = lakeConfirmReducer(s, { type: "plan-result", key, result });
    expect(isLakeArmed(s, key)).toBe(true);
    expect(lakeClick(s, key)).toBe("apply");
    const other = lakeArmKey({ ...KEY_INPUTS, position: { kind: "end" } });
    expect(lakeClick(s, other)).toBe("plan");
    s = lakeConfirmReducer(s, { type: "inputs", key: other });
    expect(s).toEqual(LAKE_CONFIRM_IDLE);
    // Going back to the old key does not re-arm.
    s = lakeConfirmReducer(s, { type: "inputs", key });
    expect(isLakeArmed(s, key)).toBe(false);
  });

  it("a plan answer for an older key is dropped", () => {
    const key = lakeArmKey(KEY_INPUTS);
    const s = lakeConfirmReducer(
      { phase: "planning", key: "newer" },
      { type: "plan-result", key, result: { kind: "ready", ready: readyLake() } },
    );
    expect(s).toEqual({ phase: "planning", key: "newer" });
  });

  it("an apply in flight is not disarmed or reset", () => {
    const applying = { phase: "applying" as const, key: "k" };
    expect(lakeConfirmReducer(applying, { type: "inputs", key: "other" })).toBe(applying);
    expect(lakeConfirmReducer(applying, { type: "reset" })).toBe(applying);
    expect(lakeClick(applying, "k")).toBe("none");
  });
});

describe("lakeConfirmText", () => {
  it("names the dataset and pipeline creates, the route, its position, the commit and the restart", () => {
    const text = lakeConfirmText(readyLake()).join("\n");
    expect(text).toContain("Create Cribl Lake dataset azure_defender_alerts");
    expect(text).toContain("Create pipeline azure_onb_unroll_records in worker group g1");
    expect(text).toContain("records[]");
    expect(text).toContain("Insert route azure_onb_defender_alerts_lake at the top of the routing table (position 1 of 5)");
    expect(text).toContain("filter __inputId=='eventhub:in_def'");
    expect(text).toContain("output cribl_lake:azure_defender_alerts");
    expect(text).toContain("No other route is changed.");
    expect(text).toContain("groups/g1/local/cribl/pipelines/azure_onb_unroll_records/");
    expect(text).toContain("groups/g1/local/cribl/pipelines/route.yml");
    expect(text).toContain("Then deploy worker group g1, which restarts its workers.");
    // The unreadable filter is "could not check", never silence.
    expect(text).toContain("Could not check these routes for a clash");
    expect(text).toContain("Complex (r_complex)");
    expect(text).not.toContain("Warning:");
  });

  it("says a dataset and pipeline that already exist are used as they are", () => {
    const r = readyLake();
    const text = lakeConfirmText({ ...r, dataset: { ...r.dataset, action: "reuse" }, pipeline: { ...r.pipeline, action: "reuse" } }).join("\n");
    expect(text).toContain("Cribl Lake dataset azure_defender_alerts already exists; it will be used as it is, not changed.");
    expect(text).toContain("already created by this app and unchanged, will be used as it is");
    expect(text).not.toContain("Create Cribl Lake dataset");
  });

  it("warns about a final catch-all above the position, and names others' pending work", () => {
    const text = lakeConfirmText(readyLake({ index: 4, shadowed: true, dirty: ["groups/g1/local/cribl/pipelines/route.yml"] })).join("\n");
    expect(text).toContain("at the end of the routing table (position 5 of 5)");
    expect(text).toContain("Warning: route default (default) above this position is final and matches every event");
    expect(text).toContain("someone else's uncommitted changes, which the commit will carry too: groups/g1/local/cribl/pipelines/route.yml");
  });
});

describe("results in words", () => {
  it("every plan refusal reason has its own sentence", () => {
    const copies = Object.values(LAKE_PLAN_REFUSAL_COPY);
    expect(new Set(copies).size).toBe(copies.length);
    expect(LAKE_PLAN_REFUSAL_COPY["not-cloud"]).toContain("Cribl.Cloud only");
    expect(LAKE_PLAN_REFUSAL_COPY.conflicts).toContain("never edits a route it did not create");
  });

  it("a conflict shows core's detail (the existing route and where it sends)", () => {
    const v = lakePlanResultView({ kind: "refused", reason: "conflicts", detail: "Existing route theirs (filter x, output s3_archive, pipeline main) already selects this source." });
    expect(v.tone).toBe("error");
    expect(v.detail).toContain("s3_archive");
  });

  it("deployed, void and stopped read differently; a void says to check again", () => {
    expect(lakeOutcomeView(DEPLOYED).headline).toContain("committed and deployed");
    const voided = lakeOutcomeView({ ...DEPLOYED, kind: "void", stage: "route", record: null });
    expect(voided.headline).toContain("Check again");
    const stopped = lakeOutcomeView({ ...DEPLOYED, kind: "stopped", stage: "pipeline", pipeline: "failed" });
    expect(stopped.headline).toBe("Stopped at the pipeline.");
    expect(stopped.inCribl).toContain("check the objects named above");
  });

  it("the native-connector sentence exists for both sources and offers no Sentinel path", () => {
    for (const s of Object.values(LAKE_ROUTE_SOURCES)) {
      expect(s.nativeConnectorCopy).toMatch(/Sentinel gets .* through Microsoft's/);
    }
  });
});
