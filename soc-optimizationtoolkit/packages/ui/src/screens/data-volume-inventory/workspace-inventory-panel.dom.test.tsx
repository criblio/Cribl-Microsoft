// @vitest-environment happy-dom
/**
 * MIG-3: the workspace inventory panel, rendered end to end over a stubbed ARM
 * port routed by path - discover, pick, inventory - and the two honesty states
 * that fail silently if they regress: a refused Usage read must not render as
 * an empty workspace, and a table whose breakdown failed must keep its volume.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { compareTenant } from "@soc/core";
import type { AzureConfig, AzureManagementRequest } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { WorkspaceInventoryPanel } from "./workspace-inventory-panel";

// MIG-16: a pass-through spy, so the tenant comparison runs for real and the
// test can still see which workspaces it was asked to compare.
vi.mock("@soc/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@soc/core")>();
  return { ...actual, compareTenant: vi.fn(actual.compareTenant) };
});

afterEach(() => {
  cleanup();
  vi.mocked(compareTenant).mockClear();
});

const CONFIG = { subscriptionId: "", resourceGroup: "", workspaceName: "" } as unknown as AzureConfig;
const WS_ID =
  "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.OperationalInsights/workspaces/law-1";

function table(columns: string[], rows: unknown[][]) {
  return { tables: [{ name: "PrimaryResult", columns: columns.map((name) => ({ name })), rows }] };
}

const WS2_ID = WS_ID.replace(/law-1$/, "law-2");

type Answer = { status: number; body: unknown };

/**
 * Route ARM calls by path. `usage` decides the Usage query's answer; a second
 * workspace (law-2, answered by `usage2`) is listed only when `usage2` is given.
 */
function armStub(usage: Answer, usage2?: Answer) {
  return vi.fn(async (req: AzureManagementRequest) => {
    if (req.path === "/subscriptions") {
      return { status: 200, body: { value: [{ subscriptionId: "sub-1", displayName: "Prod", state: "Enabled" }] } };
    }
    if (req.path.endsWith("/Microsoft.OperationalInsights/workspaces")) {
      const value = [{ name: "law-1", id: WS_ID, location: "eastus" }];
      if (usage2 !== undefined) value.push({ name: "law-2", id: WS2_ID, location: "eastus" });
      return { status: 200, body: { value } };
    }
    if (req.path.endsWith("/Microsoft.OperationsManagement/solutions")) {
      return {
        status: 200,
        body: { value: [{ name: "SecurityInsights(law-1)", properties: { workspaceResourceId: WS_ID } }] },
      };
    }
    if (req.path === `${WS_ID}/query` || req.path === `${WS2_ID}/query`) {
      const query = (req.body as { query: string }).query;
      if (query.startsWith("Usage")) return req.path.startsWith(WS2_ID) ? usage2! : usage;
      return {
        status: 200,
        body: table(
          ["SourceTable", "Source", "Attribution", "Bytes", "Events", "Sources"],
          [["Syslog", "fw-01", "computer", 3_000_000, 1200, 1]],
        ),
      };
    }
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
}

function renderPanel(request: ReturnType<typeof armStub>) {
  const ports = {
    azure: { request },
    artifacts: { save: vi.fn().mockResolvedValue(undefined) },
  } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={CONFIG}>
      <WorkspaceInventoryPanel />
    </PortsProvider>,
  );
  return ports;
}

/**
 * MIG-8: pick a workspace through the filter box - open the picker, type, click
 * the one remaining option. Throws unless the filter narrowed to exactly one.
 */
function pickWorkspace(filter: string) {
  fireEvent.click(document.querySelector(".searchable-select-control")!);
  fireEvent.change(screen.getByLabelText("Filter workspaces"), { target: { value: filter } });
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(1);
  fireEvent.click(options[0]!);
}

async function discoverAndInventory() {
  fireEvent.click(screen.getByText("Discover workspaces"));
  await screen.findByText(/Found 1 workspace\(s\) across 1 subscription\(s\), 1 with Sentinel/);
  // The first workspace is preselected, and the control shows its name.
  expect(document.querySelector(".searchable-select-control")!.textContent).toBe("law-1");
  fireEvent.click(screen.getByText("Inventory this workspace"));
}

const USAGE_COLS = ["DataType", "TotalMB", "BillableMB", "DaysWithData", "Solutions"];

describe("WorkspaceInventoryPanel", () => {
  it("makes no Azure call until the operator asks", () => {
    const request = armStub({ status: 200, body: table(USAGE_COLS, []) });
    renderPanel(request);
    expect(request).not.toHaveBeenCalled();
  });

  it("discovers, inventories, and shows the daily average with each table's sources", async () => {
    const request = armStub({
      status: 200,
      body: table(USAGE_COLS, [
        ["Syslog", 90, 90, 30, '["SecurityInsights"]'],
        ["Heartbeat", 30, 0, 30, '["LogManagement"]'],
      ]),
    });
    renderPanel(request);
    await discoverAndInventory();
    // (90 + 30) / 30 days = 4 MB a day; billable 90 / 30 = 3.
    await screen.findByText("4.0 MB");
    // MIG-15: the after-allowances tile waits for the allowance read; no benefit
    // was applied in this stub, so it equals billable.
    await waitFor(() =>
      expect([...document.querySelectorAll(".match-stat-value")].map((e) => e.textContent)).toEqual([
        "4.0 MB", "3.0 MB", "3.0 MB", "120.0 MB", "2",
      ]),
    );
    expect(screen.getByText("Syslog")).toBeTruthy();
    expect(screen.getByText(/fw-01 \(Computer\) - 100\.0 KB\/day, 1,200 events/)).toBeTruthy();
    // Heartbeat billed but its breakdown returned no rows: volume stays, failure is said.
    expect(screen.getByText("Heartbeat")).toBeTruthy();
    expect(screen.getByText(/Breakdown failed: .*although Usage billed it/)).toBeTruthy();
    expect(screen.getByText(/1 table\(s\) have no source breakdown/)).toBeTruthy();
  });

  it("says a REFUSED Usage read is a refusal, not an empty workspace", async () => {
    const request = armStub({ status: 403, body: { error: { code: "InsufficientAccessError" } } });
    renderPanel(request);
    await discoverAndInventory();
    await screen.findByText(/Could not read the Usage table.*law-1: read Usage: HTTP 403/);
    expect(screen.queryByText(/no ingested data/)).toBeNull();
    expect(screen.queryByText("tables with data")).toBeNull();
  });

  it("calls an answered, empty Usage a measured zero", async () => {
    renderPanel(armStub({ status: 200, body: table(USAGE_COLS, []) }));
    await discoverAndInventory();
    await screen.findByText(/Usage table answered and reports no ingested data/);
  });

  it("downloads the inventory as CSV", async () => {
    const ports = renderPanel(
      armStub({ status: 200, body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]) }),
    );
    await discoverAndInventory();
    fireEvent.click(await screen.findByText("Download inventory CSV"));
    await waitFor(() => expect(ports.artifacts.save).toHaveBeenCalledTimes(1));
    const [name, mime, data] = vi.mocked(ports.artifacts.save).mock.calls[0]!;
    expect([name, mime]).toEqual(["law-1-inventory.csv", "text/csv"]);
    expect(String(data)).toContain("Syslog,3.000,90.000,30,,fw-01,Computer,0.100,1200,read");
  });
});

describe("WorkspaceInventoryPanel - MIG-7", () => {
  const USAGE_OK: Answer = {
    status: 200,
    body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]),
  };

  it("names the saved file beside the button, and a failed save too", async () => {
    const ports = renderPanel(armStub(USAGE_OK));
    await discoverAndInventory();
    fireEvent.click(await screen.findByText("Download inventory CSV"));
    await screen.findByText("Saved law-1-inventory.csv.");

    vi.mocked(ports.artifacts.save).mockRejectedValueOnce(new Error("blocked by policy"));
    fireEvent.click(screen.getByText("Download inventory CSV"));
    await screen.findByText("Could not save law-1-inventory.csv: blocked by policy");
  });

  async function inventoryFirstThenPickSecond(usage2: Answer) {
    renderPanel(armStub(USAGE_OK, usage2));
    fireEvent.click(screen.getByText("Discover workspaces"));
    await screen.findByText(/Found 2 workspace\(s\)/);
    pickWorkspace("law-1");
    fireEvent.click(screen.getByText("Inventory this workspace"));
    await screen.findByText("Syslog");
    pickWorkspace("law-2");
  }

  it("keeps the shown inventory on a workspace change and says it is NOT the selected one", async () => {
    await inventoryFirstThenPickSecond(USAGE_OK);
    expect(screen.getByText("Syslog")).toBeTruthy();
    expect(
      screen.getByText(/Showing the inventory of law-1, not the selected workspace.*read law-2/),
    ).toBeTruthy();
  });

  it("drops the note, and the old rows, once the selected workspace has been read", async () => {
    await inventoryFirstThenPickSecond({
      status: 200,
      body: table(USAGE_COLS, [["AzureActivity", 30, 30, 30, "[]"]]),
    });
    fireEvent.click(screen.getByText("Inventory this workspace"));
    await screen.findByText("AzureActivity");
    expect(screen.queryByText(/Showing the inventory of/)).toBeNull();
    expect(screen.queryByText("Syslog")).toBeNull();
  });

  it("clears the old numbers when the next read is REFUSED - a refusal never sits beside another workspace's data", async () => {
    await inventoryFirstThenPickSecond({ status: 403, body: { error: { code: "AuthorizationFailed" } } });
    fireEvent.click(screen.getByText("Inventory this workspace"));
    await screen.findByText(/law-2: read Usage: HTTP 403/);
    expect(screen.queryByText("Syslog")).toBeNull();
    expect(screen.queryByText("tables with data")).toBeNull();
  });
});

describe("WorkspaceInventoryPanel - the workspace filter (MIG-8)", () => {
  it("narrows by name, resource group, subscription and Sentinel state, and says when nothing matches", async () => {
    renderPanel(armStub({ status: 200, body: table(USAGE_COLS, []) }, { status: 200, body: table(USAGE_COLS, []) }));
    fireEvent.click(screen.getByText("Discover workspaces"));
    await screen.findByText(/Found 2 workspace\(s\)/);
    fireEvent.click(document.querySelector(".searchable-select-control")!);
    const filter = screen.getByLabelText("Filter workspaces");
    const shown = () => screen.queryAllByRole("option").map((o) => o.textContent);

    expect(shown()).toHaveLength(2);
    // Each option carries subscription, resource group and Sentinel state.
    expect(shown()[0]).toContain("Prod / rg-1 - Sentinel");
    fireEvent.change(filter, { target: { value: "law-2" } });
    expect(shown()).toEqual([expect.stringContaining("law-2")]);
    // Resource group and subscription match too: both workspaces share them.
    fireEvent.change(filter, { target: { value: "rg-1" } });
    expect(shown()).toHaveLength(2);
    fireEvent.change(filter, { target: { value: "prod" } });
    expect(shown()).toHaveLength(2);
    fireEvent.change(filter, { target: { value: "no-such-workspace" } });
    expect(shown()).toEqual([]);
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});

describe("WorkspaceInventoryPanel - data allowances (MIG-15)", () => {
  it("keeps the inventory table on screen and shows the error line when the allowance read fails", async () => {
    const base = armStub({ status: 200, body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]) });
    const request = vi.fn(async (req: AzureManagementRequest) => {
      const query = (req.body as { query?: string } | undefined)?.query ?? "";
      if (query.startsWith("Operation")) return { status: 403, body: { error: { code: "Forbidden" } } };
      return base(req);
    });
    renderPanel(request as unknown as ReturnType<typeof armStub>);
    await discoverAndInventory();
    await screen.findByText(/Could not read the data allowance benefit, so no allowance is shown/);
    expect(screen.getByText("Syslog")).toBeTruthy();
    expect(screen.getByText("Download inventory CSV")).toBeTruthy();
    expect(document.querySelector(".allowance-card")).toBeNull();
    const tiles = [...document.querySelectorAll(".match-stat-value")].map((e) => e.textContent);
    expect(tiles[2]).toBe("not read");
  });

  it("adds the Allowance and Over columns once the allowances are read", async () => {
    renderPanel(armStub({ status: 200, body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]) }));
    await discoverAndInventory();
    await waitFor(() => expect(document.body.textContent).toContain("Over allowance / day"));
    const row = screen.getByText("Syslog").closest("tr")!;
    await waitFor(() => expect(row.textContent).toContain("Billable"));
    // A billable table's overage is its own billable daily average: 90 / 30.
    expect(row.textContent).toContain("3.0 MB");
    await waitFor(() => expect(document.body.textContent).toContain("Operation"));
  });
});

describe("WorkspaceInventoryPanel - tenant comparison (MIG-16)", () => {
  const USAGE_OK: Answer = { status: 200, body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]) };
  const COMPARE = "Compare against the whole tenant";

  /** Both workspaces Sentinel-enabled; law-2's Usage answer waits on `gate` when given. */
  function tenantStub(usage2: Answer, gate?: Promise<void>) {
    const base = armStub(USAGE_OK, usage2);
    return vi.fn(async (req: AzureManagementRequest) => {
      if (req.path.endsWith("/Microsoft.OperationsManagement/solutions")) {
        return {
          status: 200,
          body: {
            value: [
              { name: "SecurityInsights(law-1)", properties: { workspaceResourceId: WS_ID } },
              { name: "SecurityInsights(law-2)", properties: { workspaceResourceId: WS2_ID } },
            ],
          },
        };
      }
      const query = (req.body as { query?: string } | undefined)?.query ?? "";
      if (gate !== undefined && req.path === `${WS2_ID}/query` && query.startsWith("Usage")) await gate;
      return base(req);
    });
  }

  async function inventoryLaw1(request: ReturnType<typeof vi.fn>) {
    renderPanel(request as unknown as ReturnType<typeof armStub>);
    fireEvent.click(screen.getByText("Discover workspaces"));
    await screen.findByText(/Found 2 workspace\(s\) across 1 subscription\(s\), 2 with Sentinel/);
    fireEvent.click(screen.getByText("Inventory this workspace"));
    return screen.findByText(COMPARE);
  }

  it("offers no tenant comparison when discovery found one Sentinel workspace", async () => {
    renderPanel(armStub(USAGE_OK, USAGE_OK));
    fireEvent.click(screen.getByText("Discover workspaces"));
    await screen.findByText(/Found 2 workspace\(s\).*1 with Sentinel/);
    fireEvent.click(screen.getByText("Inventory this workspace"));
    await screen.findByText(/no data allowance benefit applied to this workspace/);
    expect(screen.queryByText(COMPARE)).toBeNull();
  });

  it("compares every Sentinel workspace, naming the one being read, then offers the way back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fireEvent.click(await inventoryLaw1(tenantStub(USAGE_OK, gate)));
    // Only the other workspace is read again; the shown inventory is reused.
    await screen.findByText(/law-2 \(1 of 1\)/);
    release();
    await screen.findByText("Compared across 2 Sentinel workspaces, 2 read.");

    expect(compareTenant).toHaveBeenCalledTimes(1);
    const [, , ids, inventories] = vi.mocked(compareTenant).mock.calls[0]!;
    expect(ids).toEqual([WS_ID, WS2_ID]);
    expect([...inventories.keys()].sort()).toEqual([WS_ID, WS2_ID]);
    expect(document.querySelector(".allowance-not-read")).toBeNull();

    fireEvent.click(screen.getByText("Back to this workspace"));
    expect(screen.queryByText(/Compared across/)).toBeNull();
    expect(screen.getByText(COMPARE)).toBeTruthy();
    expect(screen.getByText(/no data allowance benefit applied to this workspace/)).toBeTruthy();
  });

  it("lists a workspace whose Usage read was refused by name as not read, never as a zero", async () => {
    fireEvent.click(await inventoryLaw1(tenantStub({ status: 403, body: { error: { code: "AuthorizationFailed" } } })));
    await screen.findByText("Compared across 2 Sentinel workspaces, 1 read.");
    const [, , ids, inventories] = vi.mocked(compareTenant).mock.calls[0]!;
    expect(ids).toEqual([WS_ID, WS2_ID]);
    expect([...inventories.keys()]).toEqual([WS_ID]);
    const unread = [...document.querySelectorAll(".allowance-not-read")].map((e) => e.textContent);
    expect(unread).toEqual([expect.stringMatching(/^law-2: not read - .*read Usage: HTTP 403/)]);
  });
});
