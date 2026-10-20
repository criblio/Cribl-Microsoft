// @vitest-environment happy-dom
/**
 * DBT-134 WIRING: the onboard-table worker-group field renders through the
 * shared WorkerGroupField.
 *
 * The first DOM test this screen has had. It mounts the screen for one
 * reason: the defect was a screen-owned decision - `.filter()` on a bare
 * array, then `groups !== null` as the only gate - that no pure module could
 * see, so only a mount can prove the listing reaches the field intact. What
 * the field says in each state is pinned in worker-group-field.dom.test.tsx.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { toListing } from "@soc/core";
import type { AzureConfig } from "@soc/core";
import { PortsProvider } from "../ports-context";
import type { UiPorts } from "../ports-context";
import { OnboardTableScreen } from "./onboard-table-screen";

afterEach(cleanup);

const CONFIG: AzureConfig = {
  clientId: "client-1",
  tenantId: "tenant-1",
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
  setupPath: "existing",
};

function renderWith(listGroups: ReturnType<typeof vi.fn>) {
  const ports = {
    azure: { request: vi.fn().mockRejectedValue(new Error("offline")) },
    cribl: { request: vi.fn().mockRejectedValue(new Error("offline")), listGroups },
    artifacts: { save: vi.fn() },
    jobs: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as UiPorts;
  return render(
    <PortsProvider ports={ports} config={CONFIG}>
      <OnboardTableScreen />
    </PortsProvider>,
  );
}

/** The labelled field that holds the worker-group control. */
function groupField(container: HTMLElement): HTMLElement {
  const label = [...container.querySelectorAll<HTMLElement>("label.field")].find(
    (el) => el.querySelector(".field-label")?.textContent === "Cribl worker group",
  );
  expect(label).toBeTruthy();
  return label!;
}

describe("OnboardTableScreen - worker-group listing states (DBT-134)", () => {
  it("hedges an EMPTY listing instead of an empty select reading 'No matches'", async () => {
    const { container } = renderWith(vi.fn().mockResolvedValue(toListing([])));
    await waitFor(() =>
      expect(groupField(container).textContent).toMatch(
        /Cribl returned no worker groups this account can see/,
      ),
    );
    const field = groupField(container);
    expect(field.querySelector(".searchable-select")).toBeNull();
    expect(field.textContent).not.toMatch(/No matches/);
    expect(screen.getByRole("button", { name: "Retry loading groups" })).toBeTruthy();
  });

  it("names the Edge-only groups it found", async () => {
    const { container } = renderWith(
      vi.fn().mockResolvedValue(toListing([{ id: "default_fleet", product: "edge" }])),
    );
    await waitFor(() =>
      expect(groupField(container).textContent).toMatch(
        /none is a Stream worker group: default_fleet \(edge\)/,
      ),
    );
  });

  it("shows a refused listing as the error with Retry", async () => {
    const { container } = renderWith(
      vi.fn().mockRejectedValue(new Error("GET /master/groups: HTTP 403")),
    );
    await waitFor(() =>
      expect(groupField(container).textContent).toMatch(
        /Could not list worker groups: Error: GET \/master\/groups: HTTP 403/,
      ),
    );
    expect(screen.getByRole("button", { name: "Retry loading groups" })).toBeTruthy();
  });

  it("renders the picker, preselected, when Stream groups come back", async () => {
    const { container } = renderWith(
      vi.fn().mockResolvedValue(
        toListing([
          { id: "default_fleet", product: "edge" },
          { id: "prod", product: "stream" },
        ]),
      ),
    );
    await waitFor(() =>
      expect(groupField(container).querySelector(".searchable-select-control")?.textContent).toBe(
        "prod",
      ),
    );
  });
});
