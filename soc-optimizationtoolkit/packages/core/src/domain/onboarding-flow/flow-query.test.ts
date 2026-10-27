import { describe, expect, it } from "vitest";
import {
  FLOW_LOOKBACK,
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
  it("window: intake events and bytes split by input, cumulative over 300s, no where", () => {
    expect(flowQueryBody("window")).toEqual({
      aggs: {
        aggregations: ['sum("total.in_events").as(in_events)', 'sum("total.in_bytes").as(in_bytes)'],
        splitBys: ["input"],
        cumulative: true,
      },
      earliest: "-300s",
      latest: "now",
    });
  });

  it("lookback covers FLOW_LOOKBACK", () => {
    expect(FLOW_LOOKBACK).toBe("-24h");
    const body = flowQueryBody("lookback");
    expect(body.earliest).toBe("-24h");
    expect(body.latest).toBe("now");
    expect(body).not.toHaveProperty("where");
  });

  it("counts total.in_events, never pipe.in_events", () => {
    for (const kind of ["window", "lookback"] as const) {
      const aggs = (flowQueryBody(kind).aggs as { aggregations: string[] }).aggregations;
      expect(aggs).toContain('sum("total.in_events").as(in_events)');
      expect(aggs.join(" ")).not.toContain("pipe.in_events");
    }
  });
});

describe("describeFlowRequest", () => {
  it("names the method, the group-scoped path and the literal body", () => {
    const d = describeFlowRequest("g1", "window");
    expect(d).not.toBeNull();
    expect(d!.method).toBe("POST");
    expect(d!.path).toBe("/m/g1/system/metrics/query");
    expect(JSON.parse(d!.body)).toEqual(flowQueryBody("window"));
  });

  it("is null without a worker group (nothing is sent)", () => {
    expect(describeFlowRequest("", "window")).toBeNull();
  });
});
