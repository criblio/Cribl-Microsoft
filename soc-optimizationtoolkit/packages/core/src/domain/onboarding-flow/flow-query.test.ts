import { describe, expect, it } from "vitest";
import {
  FLOW_LOOKBACK,
  FLOW_LOOKBACK_SECONDS,
  LOOKBACK_RETRY_EVERY,
  describeFlowRequest,
  flowQueryBody,
  nextFlowQuery,
} from "./index";

describe("nextFlowQuery", () => {
  it("sends the lookback while it is pending", () => {
    expect(nextFlowQuery({ lookback: "pending", runsSinceLookbackAttempt: 0 })).toBe("lookback");
    expect(nextFlowQuery({ lookback: "pending", runsSinceLookbackAttempt: 7 })).toBe("lookback");
  });

  it("after a failed lookback, runs 1-4 send the window and run 5 retries the lookback", () => {
    expect(LOOKBACK_RETRY_EVERY).toBe(5);
    const kinds = [1, 2, 3, 4, 5].map((n) =>
      nextFlowQuery({ lookback: "failed", runsSinceLookbackAttempt: n }),
    );
    expect(kinds).toEqual(["window", "window", "window", "window", "lookback"]);
  });

  it("once the lookback answered, sends the window forever", () => {
    for (const n of [0, 1, 5, 10, 500]) {
      expect(nextFlowQuery({ lookback: "answered", runsSinceLookbackAttempt: n })).toBe("window");
    }
  });
});

describe("flowQueryBody", () => {
  it("window: intake events and bytes split by input, cumulative over 300s, where = the group scope only", () => {
    expect(flowQueryBody("window", "g1")).toEqual({
      aggs: {
        aggregations: ['sum("total.in_events").as(in_events)', 'sum("total.in_bytes").as(in_bytes)'],
        splitBys: ["input"],
        cumulative: true,
      },
      earliest: "300s",
      latest: "now",
      where: '__worker_group=="g1" && __dist_mode=="worker"',
    });
  });

  it("lookback covers FLOW_LOOKBACK", () => {
    expect(FLOW_LOOKBACK).toBe("-24h");
    // AZR-95 (measured 2026-11-10): "-24h" sent as earliest answered 200 with zero rows and hid 158
    // events; "86400s" returned them. The display token and the sent span must stay the same span.
    expect(FLOW_LOOKBACK_SECONDS).toBe(Number(/^-(\d+)h$/.exec(FLOW_LOOKBACK)![1]) * 3600);
    const body = flowQueryBody("lookback", "g1");
    expect(body.earliest).toBe("86400s");
    expect(body.latest).toBe("now");
    expect(body.where).toBe('__worker_group=="g1" && __dist_mode=="worker"');
  });

  it("counts total.in_events, never pipe.in_events", () => {
    for (const kind of ["window", "lookback"] as const) {
      const aggs = (flowQueryBody(kind, "g1").aggs as { aggregations: string[] }).aggregations;
      expect(aggs).toContain('sum("total.in_events").as(in_events)');
      expect(aggs.join(" ")).not.toContain("pipe.in_events");
    }
  });
});

describe("describeFlowRequest", () => {
  it("names the method, the LEADER path and the literal body, which scopes the group (AZR-95)", () => {
    const d = describeFlowRequest("g1", "window");
    expect(d).not.toBeNull();
    expect(d!.method).toBe("POST");
    expect(d!.path).toBe("/system/metrics/query");
    expect(JSON.parse(d!.body)).toEqual(flowQueryBody("window", "g1"));
    expect(JSON.parse(d!.body).where).toBe('__worker_group=="g1" && __dist_mode=="worker"');
  });

  it("is null without a worker group (nothing is sent)", () => {
    expect(describeFlowRequest("", "window")).toBeNull();
  });
});
