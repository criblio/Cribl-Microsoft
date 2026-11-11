// @vitest-environment happy-dom
/**
 * Pins for "Route to Cribl Lake" (AZR-35). The failures these exist to catch:
 *   - one click writing (the confirm must come first);
 *   - a confirm that stays armed after the operator picked another position,
 *     so the second click writes at a place the confirm did not name;
 *   - the action hidden instead of disabled with its reason (not Cribl.Cloud,
 *     no Cribl source yet);
 *   - the native-connector sentence missing, or a Sentinel path offered;
 *   - a native <select> instead of the house SearchableSelect;
 *   - the action offered on a lane it does not apply to.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LAKE_ROUTE_SOURCES, defaultPlanValues, streamWorkerGroups, toListing } from "@soc/core";
import type { ApplyLakeRouteOutcome, PlanLakeRouteResult, ReadyLakeRoute, RoutePosition } from "@soc/core";
import { LakeRoutePanel } from "./lake-route-panel";
import type { LakeRouteHooks } from "./lake-route-panel";
import { CriblSourcePanel } from "./cribl-source-panel";
import { sourceRows } from "./cribl-source-state";
import { DEPLOYED, SOURCE, TABLE, readyLake } from "./lake-route.test-util";

afterEach(cleanup);

function hooks(over: Partial<LakeRouteHooks> = {}): LakeRouteHooks {
  return {
    deploymentType: "cloud",
    records: {},
    onPlan: vi.fn(async (_s, position: RoutePosition): Promise<PlanLakeRouteResult> => {
      const r = readyLake();
      return { kind: "ready", ready: { ...r, insert: { ...r.insert, position } } };
    }),
    onApply: vi.fn(async (): Promise<ApplyLakeRouteOutcome> => DEPLOYED),
    ...over,
  };
}

function actionButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Route to Cribl Lake$|^Confirm: create the route to Cribl Lake$/ }) as HTMLButtonElement;
}

async function arm(h: LakeRouteHooks): Promise<void> {
  fireEvent.click(actionButton());
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm: create the route to Cribl Lake" })).toBeTruthy());
  expect(h.onPlan).toHaveBeenCalled();
}

function choosePosition(label: RegExp): void {
  fireEvent.click(screen.getByRole("button", { name: /Route position for/ }));
  const option = Array.from(document.querySelectorAll(".searchable-select-option")).find((o) =>
    label.test(o.querySelector(".searchable-select-option-label")?.textContent ?? ""),
  );
  if (option === undefined) throw new Error(`no position option ${label}`);
  fireEvent.click(option);
}

describe("LakeRoutePanel", () => {
  it("says Sentinel gets the data through the native connector, for each source", () => {
    for (const sourceId of ["defenderExport", "activityLog"] as const) {
      render(<LakeRoutePanel sourceId={sourceId} criblSource={SOURCE} readSeq={1} hooks={hooks()} />);
      expect(screen.getByText(LAKE_ROUTE_SOURCES[sourceId].nativeConnectorCopy, { exact: false })).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/_CL\b|Send to Sentinel/);
      cleanup();
    }
  });

  it("on a non-cloud leader the action is VISIBLE, disabled, and says why; no plan is made", () => {
    const h = hooks({ deploymentType: "onprem" });
    render(<LakeRoutePanel sourceId="activityLog" criblSource={SOURCE} readSeq={1} hooks={h} />);
    expect(actionButton().disabled).toBe(true);
    expect(screen.getByText(/Cribl.Cloud only/)).toBeTruthy();
    fireEvent.click(actionButton());
    expect(h.onPlan).not.toHaveBeenCalled();
  });

  it("without the Cribl source the action is disabled with 'create the Cribl source first'", () => {
    render(<LakeRoutePanel sourceId="activityLog" criblSource={null} readSeq={1} hooks={hooks()} />);
    expect(actionButton().disabled).toBe(true);
    expect(screen.getByText(/Create the Cribl source first/)).toBeTruthy();
  });

  it("first click plans (top) and shows the confirm; only the second click applies", async () => {
    const h = hooks();
    render(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={1} hooks={h} />);
    await arm(h);
    expect(vi.mocked(h.onPlan).mock.calls[0]).toEqual(["defenderExport", { kind: "top" }]);
    expect(h.onApply).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alert").textContent ?? "";
    expect(confirm).toContain("Create Cribl Lake dataset azure_defender_alerts");
    expect(confirm).toContain("Create pipeline azure_onb_unroll_records");
    expect(confirm).toContain("Insert route azure_onb_defender_alerts_lake at the top");
    expect(confirm).toContain("restarts its workers");
    fireEvent.click(actionButton());
    await waitFor(() => expect(h.onApply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Routed to Cribl Lake: committed and deployed.")).toBeTruthy());
  });

  it("the position picker is a SearchableSelect over the table the plan read; changing it DISARMS", async () => {
    const h = hooks();
    render(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={1} hooks={h} />);
    // Before any read there is no table to pick from.
    expect(screen.queryByRole("button", { name: /Route position for/ })).toBeNull();
    await arm(h);
    expect(document.querySelector("select")).toBeNull();
    choosePosition(/^Before Complex/);
    // Disarmed: the confirm is gone and the next click plans again, never applies.
    expect(screen.queryByRole("button", { name: "Confirm: create the route to Cribl Lake" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(actionButton());
    await waitFor(() => expect(h.onPlan).toHaveBeenCalledTimes(2));
    expect(vi.mocked(h.onPlan).mock.calls[1]![1]).toEqual({ kind: "before", routeId: "r_complex" });
    expect(h.onApply).not.toHaveBeenCalled();
  });

  it("changing the position and changing it BACK does not re-arm the old confirm", async () => {
    const h = hooks();
    render(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={1} hooks={h} />);
    await arm(h);
    choosePosition(/^Before Complex/);
    choosePosition(/^Top of the routing table/);
    expect(screen.queryByRole("button", { name: "Confirm: create the route to Cribl Lake" })).toBeNull();
    fireEvent.click(actionButton());
    await waitFor(() => expect(h.onPlan).toHaveBeenCalledTimes(2));
    expect(h.onApply).not.toHaveBeenCalled();
  });

  it("a newer read (readSeq) disarms an armed confirm", async () => {
    const h = hooks();
    const { rerender } = render(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={1} hooks={h} />);
    await arm(h);
    rerender(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={2} hooks={h} />);
    expect(screen.queryByRole("button", { name: "Confirm: create the route to Cribl Lake" })).toBeNull();
  });

  it("a refused plan shows its sentence and core's detail, and keeps the table for the picker", async () => {
    const h = hooks({
      onPlan: vi.fn(async (): Promise<PlanLakeRouteResult> => ({
        kind: "refused",
        reason: "conflicts",
        detail: "Existing route theirs (filter __inputId=='eventhub:in_def', output s3_archive, pipeline main) already selects this source.",
        table: TABLE,
      })),
    });
    render(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={1} hooks={h} />);
    fireEvent.click(actionButton());
    await waitFor(() => expect(screen.getByText(/never edits a route it did not create/)).toBeTruthy());
    expect(screen.getByText(/output s3_archive/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Route position for/ })).toBeTruthy();
    expect(h.onApply).not.toHaveBeenCalled();
  });

  it("a void apply says to check again, and the next click plans (never retries the apply)", async () => {
    const voided: ApplyLakeRouteOutcome = { ...DEPLOYED, kind: "void", stage: "route", detail: "Routing table default changed since the confirm.", record: null };
    const h = hooks({ onApply: vi.fn(async () => voided) });
    render(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={1} hooks={h} />);
    await arm(h);
    fireEvent.click(actionButton());
    await waitFor(() => expect(screen.getByText(/Check again and confirm the new plan/)).toBeTruthy());
    fireEvent.click(actionButton());
    await waitFor(() => expect(h.onPlan).toHaveBeenCalledTimes(2));
    expect(h.onApply).toHaveBeenCalledTimes(1);
  });

  it("names the route the app recorded creating", () => {
    const h = hooks({ records: { defenderExport: DEPLOYED.record! } });
    render(<LakeRoutePanel sourceId="defenderExport" criblSource={SOURCE} readSeq={1} hooks={h} />);
    expect(screen.getByText(/This app created route azure_onb_defender_alerts_lake to Cribl Lake dataset azure_defender_alerts/)).toBeTruthy();
  });
});

describe("in the Cribl source panel", () => {
  it("appears under the Defender export and Activity Log rows only", () => {
    const ready: ReadyLakeRoute = readyLake();
    render(
      <CriblSourcePanel
        rows={sourceRows(["defenderExport", "activityLog", "vnetFlowLogs"], { criblSources: { defenderExport: SOURCE } })}
        modes={{}}
        values={defaultPlanValues(null)}
        readSeq={1}
        workerGroups={{ kind: "loaded", groups: streamWorkerGroups(toListing([{ id: "g1", product: "stream" }])) }}
        onLoadGroups={vi.fn()}
        groupId="g1"
        onGroupChange={vi.fn()}
        rules={null}
        topicsFor={() => null}
        principal={null}
        onPlan={vi.fn()}
        onApply={vi.fn()}
        lakeRoute={hooks({ onPlan: vi.fn(async () => ({ kind: "ready" as const, ready })) })}
      />,
    );
    const sections = screen.getAllByRole("region", { name: /to Cribl Lake$/ });
    expect(sections.map((s) => s.getAttribute("aria-label")).sort()).toEqual(
      [`Route ${LAKE_ROUTE_SOURCES.activityLog.label} to Cribl Lake`, `Route ${LAKE_ROUTE_SOURCES.defenderExport.label} to Cribl Lake`].sort(),
    );
  });
});
