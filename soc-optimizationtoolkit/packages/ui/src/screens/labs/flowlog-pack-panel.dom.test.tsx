// @vitest-environment happy-dom
/**
 * DBT-134 WIRING for the Labs flow-log pack panel's worker-group picker.
 *
 * An empty listing used to leave the panel with a Reload button and nothing
 * else - no select, no sentence. And unlike every other picker it offered
 * Edge fleets, which cannot host the pack's collector.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toListing } from "@soc/core";
import type { AzureConfig } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { FlowLogPackPanel } from "./flowlog-pack-panel";

afterEach(cleanup);

const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
};

function renderWith(listGroups: ReturnType<typeof vi.fn>) {
  const ports = {
    cribl: { request: vi.fn(), listGroups },
    packInstall: { listDeployed: vi.fn(), install: vi.fn() },
  } as unknown as UiPorts;
  return render(
    <PortsProvider ports={ports} config={CONFIG}>
      <FlowLogPackPanel defaultStorageAccount="stlab" />
    </PortsProvider>,
  );
}

describe("FlowLogPackPanel - worker-group listing states (DBT-134)", () => {
  it("lists nothing until asked, then hedges an EMPTY listing", async () => {
    const listGroups = vi.fn().mockResolvedValue(toListing([]));
    renderWith(listGroups);
    expect(listGroups).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load worker groups" }));
    await waitFor(() =>
      expect(screen.getByText(/Cribl returned no worker groups this account can see/)).toBeTruthy(),
    );
  });

  it("offers only Stream worker groups", async () => {
    const { container } = renderWith(
      vi.fn().mockResolvedValue(
        toListing([
          { id: "default_fleet", product: "edge" },
          { id: "prod", product: "stream" },
        ]),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load worker groups" }));
    await waitFor(() =>
      expect(container.querySelector<HTMLSelectElement>("label.field select")?.value).toBe("prod"),
    );
    expect(
      [...container.querySelectorAll("label.field select option")].map((o) => o.textContent),
    ).toEqual(["prod"]);
  });
});
