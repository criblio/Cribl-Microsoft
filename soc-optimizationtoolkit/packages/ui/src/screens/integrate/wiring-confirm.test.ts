/**
 * The Wiring section's two-click confirm and outcome wording (DBT-301), pure.
 * The write's correctness is pinned in @soc/core (route-insert, wire-source);
 * these pin what the operator is told and when the confirm holds.
 */
import { describe, expect, it } from "vitest";
import type { ApplyRouteInsertOutcome, ApplyWireSourceResult, PlanWireSourceResult, ReadyWireSource } from "@soc/core";
import {
  WIRE_CONFIRM_IDLE,
  insertOutcomeHeadline,
  isWireArmed,
  wireArmKey,
  wireClick,
  wireConfirmLines,
  wireConfirmReducer,
  wireOutcomeView,
  wirePlanRefusalView,
} from "./wiring-state";

const ROUTE = {
  id: "pan-sentinel",
  name: "pan to Sentinel",
  filter: "__inputId.startsWith('syslog:in_pan:')",
  pipeline: "pack:pan",
  output: "default",
  final: true,
};

const READY: ReadyWireSource = {
  input: { type: "syslog", id: "in_pan" },
  filter: ROUTE.filter,
  routes: [{ ...ROUTE, disabled: false, description: "d" }],
  createDataset: null,
  insert: {
    groupId: "g1",
    tableId: "default",
    input: { type: "syslog", id: "in_pan" },
    position: { kind: "top" },
    index: 0,
    newRoutes: [ROUTE],
    routes: [ROUTE],
    diff: [],
    table: { tableId: "default", routeCount: 37, rows: [] },
    uncheckable: [{ id: "r_x", name: "r_x", filter: "a && b", final: true, disabled: false }],
    shadowedBy: [],
    scope: { alreadyDirty: ["groups/g1/local/cribl/pipelines/route.yml"], elsewhere: [], unplaced: [], unknown: false },
    commitFiles: ["groups/g1/local/cribl/pipelines/route.yml"],
    commitMessage: "m",
  },
};

const KEY = wireArmKey({ workerGroup: "g1", sourceId: "in_pan", packName: "pan", lakeEffective: false, lakeDataset: "" });

function armed() {
  const planning = wireConfirmReducer(WIRE_CONFIRM_IDLE, { type: "plan-start", key: KEY });
  return wireConfirmReducer(planning, { type: "plan-result", key: KEY, result: { kind: "ready", ready: READY } });
}

describe("wire confirm machine", () => {
  it("first click plans, a ready plan arms, a click while armed for the same key applies", () => {
    expect(wireClick(WIRE_CONFIRM_IDLE, KEY)).toBe("plan");
    const s = armed();
    expect(isWireArmed(s, KEY)).toBe(true);
    expect(wireClick(s, KEY)).toBe("apply");
  });

  it("any change to what the confirm names disarms, and a revert does not re-arm", () => {
    const other = wireArmKey({ workerGroup: "g1", sourceId: "in_other", packName: "pan", lakeEffective: false, lakeDataset: "" });
    const disarmed = wireConfirmReducer(armed(), { type: "inputs", key: other });
    expect(disarmed).toEqual(WIRE_CONFIRM_IDLE);
    expect(wireConfirmReducer(disarmed, { type: "inputs", key: KEY })).toEqual(WIRE_CONFIRM_IDLE);
    expect(wireClick(disarmed, KEY)).toBe("plan");
  });

  it("the dataset is part of the key only when Lake is effective", () => {
    const a = wireArmKey({ workerGroup: "g", sourceId: "s", packName: "p", lakeEffective: false, lakeDataset: "x" });
    const b = wireArmKey({ workerGroup: "g", sourceId: "s", packName: "p", lakeEffective: false, lakeDataset: "y" });
    const c = wireArmKey({ workerGroup: "g", sourceId: "s", packName: "p", lakeEffective: true, lakeDataset: "y" });
    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });

  it("after an outcome - a void included - the next click plans again, never re-applies", () => {
    const applying = wireConfirmReducer(armed(), { type: "apply-start", key: KEY });
    const done = wireConfirmReducer(applying, {
      type: "apply-result",
      result: { dataset: { kind: "not-needed" }, insert: { kind: "void", cause: "table-moved", detail: "moved" } },
    });
    expect(done.phase).toBe("done");
    expect(wireClick(done, KEY)).toBe("plan");
  });
});

describe("wireConfirmLines names everything the write does", () => {
  const text = wireConfirmLines(READY).join("\n");

  it("the group, the table, the top position and that no other route changes", () => {
    expect(text).toContain("Worker group g1: add 1 route at the top of routing table default, above its 37 existing routes. No other route is changed or moved.");
  });

  it("each route with filter, pipeline, output and finality, and the source with where its type came from", () => {
    expect(text).toContain("1. pan-sentinel: filter __inputId.startsWith('syslog:in_pan:'); pipeline pack:pan; output default; final");
    expect(text).toContain("Source: syslog:in_pan. Its type was read from the worker group's sources.");
  });

  it("what could not be checked, the commit file with others' pending work, and the restart", () => {
    expect(text).toContain("Could not check 1 existing route");
    expect(text).toContain("r_x");
    expect(text).toContain("Then commits at most groups/g1/local/cribl/pipelines/route.yml");
    expect(text).toContain("uncommitted changes someone else made");
    expect(text).toContain("Then deploys that commit to worker group g1, which restarts its workers.");
  });

  it("names the Lake dataset when one is created", () => {
    expect(wireConfirmLines({ ...READY, createDataset: "raw" }).join("\n")).toContain("First creates Cribl Lake dataset raw");
  });
});

describe("outcome wording", () => {
  const ALL: ApplyRouteInsertOutcome["kind"][] = [
    "deployed", "already-applied", "void", "scope-refused", "unreadable", "refused-before-write", "refused",
    "transport-failed", "written-not-verified", "nothing-to-commit", "status-unknown", "scope-unknown",
    "committed-unknown-hash", "commit-failed", "newer-commit", "head-unknown", "incomplete", "unverified",
    "deploy-failed", "commit-sequence-failed",
  ];

  it("every outcome has a headline, and only the deployed and already-wired ones read as ok", () => {
    for (const kind of ALL) {
      const v = insertOutcomeHeadline({ kind, detail: "d", cause: "table-moved", writeSent: true } as unknown as ApplyRouteInsertOutcome);
      expect(v.headline, kind).not.toBe("");
      expect(v.tone === "ok", kind).toBe(kind === "deployed" || kind === "already-applied");
    }
  });

  it("a written-not-verified outcome says it was not committed", () => {
    expect(insertOutcomeHeadline({ kind: "written-not-verified", check: "mismatch", detail: "d" }).headline).toMatch(/not committed/);
  });

  it("a void says to check again; the detail is core's", () => {
    const result: ApplyWireSourceResult = { dataset: { kind: "not-needed" }, insert: { kind: "void", cause: "table-moved", detail: "core words" } };
    const v = wireOutcomeView(result);
    expect(v.headline).toMatch(/Check again/);
    expect(v.detail).toBe("core words");
  });

  it("a failed Lake dataset is named beside the routes outcome", () => {
    const v = wireOutcomeView({
      dataset: { kind: "failed", dataset: "raw", detail: "Creating Cribl Lake dataset raw was refused (HTTP 403)." },
      insert: { kind: "deployed", hash: "abc1234", files: [], detail: "d" },
    });
    expect(v.notes.join(" ")).toContain("raw was refused (HTTP 403)");
  });

  it("a conflict refusal says the table already routes the source, and lists what was not checked", () => {
    const refused: Exclude<PlanWireSourceResult, { kind: "ready" }> = {
      kind: "insert-refused",
      result: {
        kind: "refused",
        reason: "conflicts",
        detail: "Existing route r_fw (...) already selects this source.",
        conflicts: [],
        uncheckable: [{ id: "r_x", name: "r_x", filter: "a", final: true, disabled: false }],
      },
    };
    const v = wirePlanRefusalView(refused);
    expect(v.headline).toMatch(/already routes this source/);
    expect(v.detail).toContain("r_fw");
    expect(v.notes.join(" ")).toContain("r_x");
  });
});
