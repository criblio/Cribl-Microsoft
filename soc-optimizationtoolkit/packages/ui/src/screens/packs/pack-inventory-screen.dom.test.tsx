// @vitest-environment happy-dom
/**
 * DBT-134: Pack Inventory's worker-group picker.
 *
 * The first DOM test this screen has had, and the defects it pins are all in
 * the component, where pack-inventory-state.test.ts cannot see them:
 *
 *  - the "Deploy target" picker was simply ABSENT when the listing was empty
 *    or had failed (groups began as `[]`, so not-loaded, failed and empty were
 *    one state, and the JSX rendered nothing for it);
 *  - a refused groups listing was reported as "Deployed status unavailable",
 *    blaming a call that never ran;
 *  - `selectedGroups` sat in the load's deps, so every pick re-listed the
 *    groups and every group's packs against the shared request budget.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toListing } from "@soc/core";
import type { AzureConfig } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { StoredPack, UiPorts } from "../../ports-context";
import { PackInventoryScreen } from "./pack-inventory-screen";

afterEach(cleanup);

const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
};

function renderWith(
  listGroups: ReturnType<typeof vi.fn>,
  listDeployed: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([]),
  stored: StoredPack[] = [],
) {
  const ports = {
    cribl: { request: vi.fn(), listGroups },
    packs: {
      list: vi.fn().mockResolvedValue(stored),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    packInstall: { listDeployed, install: vi.fn() },
    artifacts: { save: vi.fn() },
  } as unknown as UiPorts;
  const utils = render(
    <PortsProvider ports={ports} config={CONFIG}>
      <PackInventoryScreen />
    </PortsProvider>,
  );
  return { ...utils, listGroups, listDeployed };
}

/** The "Deploy target" field, which must exist in EVERY listing state. */
function deployTarget(container: HTMLElement): HTMLElement {
  const field = [...container.querySelectorAll<HTMLElement>("label.field")].find(
    (el) => el.querySelector(".field-label")?.textContent === "Deploy target",
  );
  expect(field).toBeTruthy();
  return field!;
}

describe("PackInventoryScreen - worker-group listing states (DBT-134)", () => {
  it("keeps the Deploy target field and hedges an EMPTY listing", async () => {
    const { container } = renderWith(vi.fn().mockResolvedValue(toListing([])));
    await waitFor(() =>
      expect(deployTarget(container).textContent).toMatch(
        /Cribl returned no worker groups this account can see/,
      ),
    );
    expect(deployTarget(container).textContent).not.toMatch(/No matches/);
    expect(screen.getByRole("button", { name: "Retry loading groups" })).toBeTruthy();
  });

  it("names the groups when none of them is a Stream worker group", async () => {
    const { container } = renderWith(
      vi.fn().mockResolvedValue(toListing([{ id: "default_fleet", product: "edge" }])),
    );
    await waitFor(() =>
      expect(deployTarget(container).textContent).toMatch(
        /none is a Stream worker group: default_fleet \(edge\)/,
      ),
    );
  });

  it("attributes a refused listing to the worker groups, with Retry - not to deployed status", async () => {
    const { container, listDeployed } = renderWith(
      vi.fn().mockRejectedValue(new Error("GET /master/groups: HTTP 403")),
    );
    await waitFor(() =>
      expect(deployTarget(container).textContent).toMatch(
        /Could not list worker groups: Error: GET \/master\/groups: HTTP 403/,
      ),
    );
    expect(screen.getByRole("button", { name: "Retry loading groups" })).toBeTruthy();
    // A negative claim needs the effects the failure triggers to have run.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).not.toMatch(/Deployed status unavailable/);
    // With no groups there is nothing to ask the packs API about.
    expect(listDeployed).not.toHaveBeenCalled();
  });

  it("still reports a failed DEPLOYED read as deployed status, once groups are listed", async () => {
    const { container } = renderWith(
      vi.fn().mockResolvedValue(toListing([{ id: "prod", product: "stream" }])),
      vi.fn().mockRejectedValue(new Error("GET /m/prod/packs: HTTP 500")),
    );
    await waitFor(() =>
      expect(container.textContent).toMatch(/Deployed status unavailable: Error: GET \/m\/prod\/packs/),
    );
    expect(deployTarget(container).querySelector(".searchable-select")).not.toBeNull();
  });

  it("does not re-list the groups or the deployed packs when the operator picks a group", async () => {
    const { container, listGroups, listDeployed } = renderWith(
      vi.fn().mockResolvedValue(
        toListing([
          { id: "prod", product: "stream" },
          { id: "dr", product: "stream" },
        ]),
      ),
    );
    // The first group is preselected once the listing lands.
    const control = await waitFor(() => {
      const c = deployTarget(container).querySelector<HTMLElement>(".searchable-select-control");
      expect(c?.textContent).toBe("prod");
      return c!;
    });
    await waitFor(() => expect(listDeployed).toHaveBeenCalledTimes(1));
    expect(listDeployed).toHaveBeenCalledWith(["prod", "dr"]);

    fireEvent.click(control);
    const dr = [...container.querySelectorAll<HTMLElement>(".searchable-select-option")].find(
      (li) => li.textContent?.includes("dr"),
    );
    fireEvent.click(dr!);
    await waitFor(() => expect(control.textContent).toBe("2 selected"));

    // Give any effect the pick would have triggered a chance to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(listGroups).toHaveBeenCalledTimes(1);
    expect(listDeployed).toHaveBeenCalledTimes(1);
  });
});

/** One stored build record, so the screen renders a badge to read. */
const STORED: StoredPack = {
  record: {
    id: "cribl-palo-alto_1.0.0",
    packName: "cribl-palo-alto",
    displayName: "Palo Alto Sentinel",
    version: "1.0.0",
    solutionName: "Palo Alto Networks",
    builtAtMs: 1_700_000_000_000,
    tables: ["CommonSecurityLog"],
    crblFileName: "cribl-palo-alto_1.0.0.crbl",
    crblSizeBytes: 2048,
  },
  definition: {
    plan: {
      solutionName: "Palo Alto Networks",
      packName: "cribl-palo-alto",
      version: "1.0.0",
      vendorPrefix: "palo_alto",
      tables: [],
    },
    builtAtMs: 1_700_000_000_000,
  },
};

/** The deployed badge on the one stored pack's card. */
function badgeText(container: HTMLElement): string | null {
  return container.querySelector(".mapping-review-card .gap-badge")?.textContent ?? null;
}

describe("PackInventoryScreen - a badge cites only a deployed read that ran (DBT-134 review)", () => {
  it("does not call a pack 'Not deployed' when the groups listing was refused", async () => {
    const { container, listDeployed } = renderWith(
      vi.fn().mockRejectedValue(new Error("GET /master/groups: HTTP 403")),
      undefined,
      [STORED],
    );
    await waitFor(() =>
      expect(deployTarget(container).textContent).toMatch(/Could not list worker groups/),
    );
    await waitFor(() => expect(badgeText(container)).not.toBeNull());
    expect(badgeText(container)).toBe("Deployed status not read - worker groups unavailable");
    expect(container.textContent).not.toMatch(/Not deployed/);
    expect(listDeployed).not.toHaveBeenCalled();
  });

  it("does not call a pack 'Not deployed' when the groups listing was empty", async () => {
    const { container } = renderWith(vi.fn().mockResolvedValue(toListing([])), undefined, [
      STORED,
    ]);
    await waitFor(() =>
      expect(deployTarget(container).textContent).toMatch(/no worker groups/),
    );
    await waitFor(() => expect(badgeText(container)).not.toBeNull());
    expect(badgeText(container)).toBe("Deployed status not read - no Stream worker group listed");
    expect(container.textContent).not.toMatch(/Not deployed/);
  });

  it("says 'Not deployed' once the packs read succeeds and lists the pack nowhere", async () => {
    // The control for the two pins above: the same fixture CAN say it.
    const { container } = renderWith(
      vi.fn().mockResolvedValue(toListing([{ id: "prod", product: "stream" }])),
      vi.fn().mockResolvedValue([{ group: "prod", packs: [] }]),
      [STORED],
    );
    await waitFor(() => expect(badgeText(container)).toBe("Not deployed"));
  });

  it("drops the previous snapshot when a Refresh re-list fails", async () => {
    const listGroups = vi
      .fn()
      .mockResolvedValueOnce(toListing([{ id: "prod", product: "stream" }]))
      .mockRejectedValue(new Error("GET /master/groups: HTTP 503"));
    const { container } = renderWith(
      listGroups,
      vi.fn().mockResolvedValue([
        { group: "prod", packs: [{ id: "cribl-palo-alto", displayName: "p", version: "1.0.0" }] },
      ]),
      [STORED],
    );
    await waitFor(() => expect(badgeText(container)).toBe("Deployed on 1 group: prod"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(deployTarget(container).textContent).toMatch(/HTTP 503/));
    expect(badgeText(container)).toBe("Deployed status not read - worker groups unavailable");
    expect(container.textContent).not.toMatch(/Deployed on 1 group/);
  });
});
