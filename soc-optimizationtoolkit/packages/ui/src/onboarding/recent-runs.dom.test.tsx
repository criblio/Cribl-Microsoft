// @vitest-environment happy-dom
/**
 * DBT-125: the run log sat at the foot of Sentinel Integration as thirty
 * expandable rows, every one of them visible. The latest few answer "what
 * happened last time"; the rest are one click away, and the count says how
 * many there are so nothing reads as missing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AzureConfig, JobRecord } from "@soc/core";
import { PortsProvider } from "../ports-context";
import type { UiPorts } from "../ports-context";
import { RECENT_RUNS_SHOWN, RecentRuns } from "./recent-runs";

afterEach(cleanup);

function job(n: number): JobRecord {
  return {
    id: `job-${n}`,
    kind: "onboard-table",
    status: "succeeded",
    input: {},
    steps: [],
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  } as unknown as JobRecord;
}

function renderRuns(count: number) {
  const ports = {
    jobs: {
      list: vi.fn().mockResolvedValue(Array.from({ length: count }, (_, i) => job(i + 1))),
    },
  } as unknown as UiPorts;
  return render(
    <PortsProvider ports={ports} config={{} as AzureConfig}>
      <RecentRuns
        refreshToken={0}
        label={(j) => `run ${j.id}`}
        detail={(j) => `detail ${j.id}`}
      />
    </PortsProvider>,
  );
}

function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("details > summary")].map(
    (s) => s.textContent ?? "",
  );
}

describe("RecentRuns (DBT-125)", () => {
  it("shows the latest few and says how many there are in all", async () => {
    const { container, getByRole } = renderRuns(12);
    await waitFor(() => expect(rowLabels(container)).toHaveLength(RECENT_RUNS_SHOWN));
    expect(rowLabels(container)).toEqual([
      "run job-1",
      "run job-2",
      "run job-3",
      "run job-4",
      "run job-5",
    ]);
    expect(getByRole("button", { name: "Show all 12 runs" })).toBeTruthy();
  });

  it("shows every run once asked, and can fold them back", async () => {
    const { container, getByRole } = renderRuns(12);
    await waitFor(() => expect(rowLabels(container)).toHaveLength(RECENT_RUNS_SHOWN));
    fireEvent.click(getByRole("button", { name: "Show all 12 runs" }));
    expect(rowLabels(container)).toHaveLength(12);
    fireEvent.click(getByRole("button", { name: `Show the latest ${RECENT_RUNS_SHOWN}` }));
    expect(rowLabels(container)).toHaveLength(RECENT_RUNS_SHOWN);
  });

  it("offers no toggle when every run already fits", async () => {
    const { container, queryByRole } = renderRuns(RECENT_RUNS_SHOWN);
    await waitFor(() => expect(rowLabels(container)).toHaveLength(RECENT_RUNS_SHOWN));
    expect(queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
