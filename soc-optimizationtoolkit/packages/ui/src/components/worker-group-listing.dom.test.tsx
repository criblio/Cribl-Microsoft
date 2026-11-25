// @vitest-environment happy-dom
/**
 * useInitialWorkerGroup: which group a screen preselects, and when a later
 * answer may replace it (DBT-180 review).
 *
 * The saved default group (appOptions.cribl.workerGroup) can arrive AFTER the
 * listing: the options read is still loading, or was unreadable and a Retry
 * answered. The listing has by then auto-picked its first row, and keeping
 * that pick meant a Run unlocked by the Retry deployed to rows[0] instead of
 * the operator's saved group. An AUTOMATIC pick therefore yields to a
 * preferred group that arrives later and is listed; a group the operator chose
 * by hand never does.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { streamWorkerGroups, toListing } from "@soc/core";
import { useInitialWorkerGroup } from "./worker-group-listing";
import type { WorkerGroupsState } from "./worker-group-listing";

afterEach(cleanup);

function loaded(...ids: string[]): WorkerGroupsState {
  return {
    kind: "loaded",
    groups: streamWorkerGroups(toListing(ids.map((id) => ({ id, product: "stream" })))),
  };
}

function useHarness(props: { state: WorkerGroupsState; preferred: string }) {
  const [groupId, setGroupId] = useState("");
  const chooseGroup = useInitialWorkerGroup(props.state, props.preferred, setGroupId);
  return { groupId, chooseGroup, setGroupId };
}

describe("useInitialWorkerGroup", () => {
  it("picks the preferred group when it is listed at load", () => {
    const { result } = renderHook(useHarness, {
      initialProps: { state: loaded("a", "b"), preferred: "b" },
    });
    expect(result.current.groupId).toBe("b");
  });

  it("picks the first listed group when there is no preferred group", () => {
    const { result } = renderHook(useHarness, {
      initialProps: { state: loaded("a", "b"), preferred: "" },
    });
    expect(result.current.groupId).toBe("a");
  });

  it("an AUTOMATIC pick yields to a preferred group that arrives later", () => {
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { state: loaded("a", "b"), preferred: "" },
    });
    expect(result.current.groupId).toBe("a");
    rerender({ state: loaded("a", "b"), preferred: "b" });
    expect(result.current.groupId).toBe("b");
  });

  it("a later preferred group that is NOT listed leaves the automatic pick", () => {
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { state: loaded("a", "b"), preferred: "" },
    });
    rerender({ state: loaded("a", "b"), preferred: "gone" });
    expect(result.current.groupId).toBe("a");
  });

  it("a group chosen by hand is never overridden - even when it equals the automatic pick", () => {
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { state: loaded("a", "b"), preferred: "" },
    });
    act(() => result.current.chooseGroup("a"));
    rerender({ state: loaded("a", "b"), preferred: "b" });
    expect(result.current.groupId).toBe("a");
  });

  it("a different group chosen by hand is kept too", () => {
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { state: loaded("a", "b", "c"), preferred: "" },
    });
    act(() => result.current.chooseGroup("c"));
    rerender({ state: loaded("a", "b", "c"), preferred: "b" });
    expect(result.current.groupId).toBe("c");
  });

  it("a group set by the screen itself (not the automatic pick) is kept", () => {
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { state: loaded("a", "b", "c"), preferred: "" },
    });
    act(() => result.current.setGroupId(() => "c"));
    rerender({ state: loaded("a", "b", "c"), preferred: "b" });
    expect(result.current.groupId).toBe("c");
  });
});
