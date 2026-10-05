// @vitest-environment happy-dom
/**
 * DBT-125: the run log grew without bound at the foot of Sentinel
 * Integration - thirty expandable rows, every one visible. Operator direction
 * 2026-10-05: collapsed by default, with a dropdown to see a previous run. The
 * closed line still says how many runs there are and what the latest was, so
 * folding it hides nothing a glance needs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AzureConfig, JobRecord } from "@soc/core";
import { PortsProvider } from "../ports-context";
import type { UiPorts } from "../ports-context";
import { RecentRuns } from "./recent-runs";

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
      list: vi
        .fn()
        .mockResolvedValue(Array.from({ length: count }, (_, i) => job(i + 1))),
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

function summary(container: HTMLElement): string {
  return (
    container.querySelector(".recent-runs > summary")?.textContent ?? ""
  ).replace(/\s+/g, " ");
}

describe("RecentRuns (DBT-125)", () => {
  it("is collapsed by default, and its one line says how many and which was latest", async () => {
    const { container } = renderRuns(12);
    await waitFor(() => expect(summary(container)).toContain("(12)"));
    const details = container.querySelector<HTMLDetailsElement>(".recent-runs");
    expect(details?.open).toBe(false);
    expect(summary(container)).toContain("Recent runs (12) - latest: run job-1");
  });

  it("lists every run in a dropdown, newest first, and shows the latest", async () => {
    const { container } = renderRuns(12);
    await waitFor(() => expect(summary(container)).toContain("(12)"));
    const select = container.querySelector<HTMLSelectElement>(".recent-runs select")!;
    expect([...select.options].map((o) => o.textContent)).toEqual(
      Array.from({ length: 12 }, (_, i) => `run job-${i + 1}`),
    );
    expect(select.value).toBe("job-1");
    expect(container.querySelector(".recent-runs pre")?.textContent).toBe("detail job-1");
  });

  it("shows the run picked in the dropdown, and only that one", async () => {
    const { container } = renderRuns(12);
    await waitFor(() => expect(summary(container)).toContain("(12)"));
    const select = container.querySelector<HTMLSelectElement>(".recent-runs select")!;
    fireEvent.change(select, { target: { value: "job-7" } });
    const shown = [...container.querySelectorAll(".recent-runs pre")].map((p) => p.textContent);
    expect(shown).toEqual(["detail job-7"]);
  });

  it("says so when nothing has run, with no dropdown to open", async () => {
    const { container } = renderRuns(0);
    await waitFor(() => expect(summary(container)).toContain("none recorded yet"));
    expect(container.querySelector(".recent-runs select")).toBeNull();
  });
});
