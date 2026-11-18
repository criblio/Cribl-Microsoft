// @vitest-environment happy-dom
/**
 * AZR-105: the Remove / Pause panel. What these pins protect:
 *   - it lists every source with a record, and nothing else;
 *   - Remove is two clicks: the first only plans, the confirm quotes every
 *     object in order (and the kept ones with their reason), the second applies
 *     exactly the plan it showed;
 *   - ticking the dataset box is a new key: it disarms and plans again with
 *     the opt-in;
 *   - Pause and Resume are their own two-click actions, quoting the source.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ApplyTeardownOutcome,
  CriblSourceRecord,
  LakeRouteRecord,
  PlanPauseResult,
  PlanTeardownResult,
  ReadyPause,
  ReadyTeardown,
} from "@soc/core";
import { TeardownPanel, type TeardownHooks } from "./teardown-panel";

afterEach(cleanup);

const SOURCE: CriblSourceRecord = { groupId: "g1", inputId: "azure_onb_eh_t_ns_activityLog", inputType: "eventhub", secretId: "azure_onb_eh_t_ns_activityLog_secret" };
const LAKE: LakeRouteRecord = { groupId: "g1", datasetId: "azure_activity_log", pipelineId: "azure_onb_unroll_records", routeId: "azure_onb_activity_log_lake", datasetCreated: true };

function readyRemove(removeDataset: boolean): ReadyTeardown {
  return {
    input: { sourceId: "activityLog", criblSource: SOURCE, lakeRoute: LAKE, otherLakeRoutes: [], removeDataset },
    groupId: "g1",
    steps: [
      { kind: "route", id: LAKE.routeId!, verdict: { kind: "delete" } },
      { kind: "pipeline", id: LAKE.pipelineId!, verdict: { kind: "keep", reason: "in-use", detail: "Still used by route other, so it was kept." } },
      { kind: "input", id: SOURCE.inputId, verdict: { kind: "delete" } },
      { kind: "secret", id: SOURCE.secretId, verdict: { kind: "delete" } },
      removeDataset
        ? { kind: "dataset", id: LAKE.datasetId, verdict: { kind: "delete" } }
        : { kind: "dataset", id: LAKE.datasetId, verdict: { kind: "keep", reason: "opt-in-off", detail: "Kept: it holds the data already stored. Tick the option to delete it as well." } },
    ],
    routeWrite: { tableId: "default", routes: [], diff: [] },
    scope: { alreadyDirty: [], elsewhere: [], unplaced: [], unknown: false },
    markers: [],
    watchMarkers: [],
    commitFiles: ["groups/g1/local/cribl/pipelines/route.yml", "groups/g1/local/cribl/inputs.yml"],
  };
}

function hooks(over: Partial<TeardownHooks> = {}): TeardownHooks {
  return {
    criblSources: { activityLog: SOURCE },
    lakeRoutes: { activityLog: LAKE },
    readSeq: 0,
    onPlanRemove: vi.fn(async (_id, removeDataset: boolean): Promise<PlanTeardownResult> => ({ kind: "ready", ready: readyRemove(removeDataset) })),
    onApplyRemove: vi.fn(async (): Promise<ApplyTeardownOutcome> => ({
      kind: "removed",
      steps: [],
      commit: { kind: "not-needed" },
      records: { criblSource: null, lakeRoute: null },
      detail: "Route removed.",
    })),
    onPlanPause: vi.fn(async (_id, pause: boolean): Promise<PlanPauseResult> => ({
      kind: "ready",
      ready: { record: SOURCE, pause, diff: [], scope: { alreadyDirty: [], elsewhere: [], unplaced: [], unknown: false }, commitFiles: ["groups/g1/local/cribl/inputs.yml"] } as ReadyPause,
    })),
    onApplyPause: vi.fn(async () => ({ kind: "deployed" as const, detail: "paused" })),
    ...over,
  };
}

function row(): HTMLElement {
  return screen.getByLabelText("Remove or pause Azure Activity Log");
}

describe("TeardownPanel", () => {
  it("says so when nothing is recorded", () => {
    render(<TeardownPanel hooks={hooks({ criblSources: {}, lakeRoutes: {} })} />);
    expect(screen.getByText("This app has no record of creating anything in Cribl for these sources.")).toBeTruthy();
  });

  it("Remove: the first click only plans; the confirm quotes the order and the kept objects; the second applies that plan", async () => {
    const h = hooks();
    render(<TeardownPanel hooks={h} />);
    const r = row();
    expect(r.textContent).toContain(`Recorded in worker group g1: Cribl source ${SOURCE.inputId} and secret ${SOURCE.secretId}`);
    fireEvent.click(within(r).getByRole("button", { name: "Remove what this app created" }));
    await waitFor(() => expect(within(r).getByRole("button", { name: "Confirm: remove these objects" })).toBeTruthy());
    expect(h.onPlanRemove).toHaveBeenCalledWith("activityLog", false);
    expect(h.onApplyRemove).not.toHaveBeenCalled();
    const lines = [...within(r).getByRole("alert").querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual([
      "Remove, in this order, only what this app can prove it created:",
      `1. Remove route ${LAKE.routeId} from routing table default in worker group g1. No other route is changed.`,
      `2. Delete Cribl source ${SOURCE.inputId} in worker group g1. It stops reading from Azure. Checked every route filter in the worker group: none names it.`,
      `3. Delete secret ${SOURCE.secretId} in worker group g1, which holds that source's credential. Checked every source, destination and collector in the worker group: none names it.`,
      `Kept: pipeline ${LAKE.pipelineId} in worker group g1. Still used by route other, so it was kept.`,
      `Kept: Cribl Lake dataset ${LAKE.datasetId} and the data it holds. Kept: it holds the data already stored. Tick the option to delete it as well.`,
      "The commit can include at most these files, and only those still uncommitted after the removals: groups/g1/local/cribl/pipelines/route.yml, groups/g1/local/cribl/inputs.yml.",
      "Then deploy worker group g1, which restarts its workers.",
    ]);
    fireEvent.click(within(r).getByRole("button", { name: "Confirm: remove these objects" }));
    await waitFor(() => expect(h.onApplyRemove).toHaveBeenCalledTimes(1));
    expect((h.onApplyRemove as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual(readyRemove(false));
    await waitFor(() => expect(within(r).getByText("Removed: every object named was removed or already gone, and the change is deployed.")).toBeTruthy());
  });

  it("ticking the dataset box disarms, and the next check asks for the dataset", async () => {
    const h = hooks();
    render(<TeardownPanel hooks={h} />);
    const r = row();
    fireEvent.click(within(r).getByRole("button", { name: "Remove what this app created" }));
    await waitFor(() => expect(within(r).getByRole("button", { name: "Confirm: remove these objects" })).toBeTruthy());
    fireEvent.click(within(r).getByRole("checkbox"));
    await waitFor(() => expect(within(r).queryByRole("button", { name: "Confirm: remove these objects" })).toBeNull());
    fireEvent.click(within(r).getByRole("button", { name: "Remove what this app created" }));
    await waitFor(() => expect(within(r).getByText(`4. After the deploy, delete Cribl Lake dataset ${LAKE.datasetId} and every event it holds. This cannot be undone. Checked every route and Cribl Lake destination in every worker group this app can read: none sends to it.`)).toBeTruthy());
    expect(h.onPlanRemove).toHaveBeenLastCalledWith("activityLog", true);
    expect(h.onApplyRemove).not.toHaveBeenCalled();
  });

  it("Pause is its own two clicks, quoting the source and the hub retention caveat", async () => {
    const h = hooks();
    render(<TeardownPanel hooks={h} />);
    const r = row();
    fireEvent.click(within(r).getByRole("button", { name: "Pause the Cribl source" }));
    await waitFor(() => expect(within(r).getByRole("button", { name: "Confirm: pause the source" })).toBeTruthy());
    expect(h.onApplyPause).not.toHaveBeenCalled();
    const text = within(r).getByRole("alert").textContent ?? "";
    expect(text).toContain(`Pause Cribl source ${SOURCE.inputId} in worker group g1: set it disabled, so it stops reading from Azure.`);
    expect(text).toContain("Events wait in the Event Hub only for the hub's retention period");
    // Clicking Resume instead plans a resume; it never applies the armed pause.
    fireEvent.click(within(r).getByRole("button", { name: "Resume the Cribl source" }));
    await waitFor(() => expect(within(r).getByRole("button", { name: "Confirm: resume the source" })).toBeTruthy());
    expect(h.onApplyPause).not.toHaveBeenCalled();
    expect(h.onPlanPause).toHaveBeenLastCalledWith("activityLog", false);
    fireEvent.click(within(r).getByRole("button", { name: "Confirm: resume the source" }));
    await waitFor(() => expect(h.onApplyPause).toHaveBeenCalledTimes(1));
    expect((h.onApplyPause as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ pause: false });
  });
});
