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
function armStub(usage: Answer, usage2?: Answer, sourceRows?: unknown[][]) {
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
      // No benefit applied. A row without a readable amount is counted as
      // unreadable (MIG-21), so the benefit read gets its own, empty, answer.
      if (query.startsWith("Operation")) {
        return { status: 200, body: table(["Day", "BenefitType", "BenefitUsedGB"], []) };
      }
      return {
        status: 200,
        body: table(
          ["SourceTable", "Source", "Attribution", "Collector", "Bytes", "BillableBytes", "Events", "Sources"],
          sourceRows ?? [["Syslog", "fw-01", "computer", "", 3_000_000, 3_000_000, 1200, 1]],
        ),
      };
    }
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
}

function renderPanel(
  request: ReturnType<typeof armStub>,
  extra: { graph?: unknown; onOpenChangeRequest?: () => void } = {},
) {
  const ports = {
    azure: { request },
    artifacts: { save: vi.fn().mockResolvedValue(undefined) },
    ...(extra.graph === undefined ? {} : { graph: extra.graph }),
  } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={CONFIG}>
      <WorkspaceInventoryPanel onOpenChangeRequest={extra.onOpenChangeRequest} />
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
    expect(screen.getByText(/fw-01 \(Computer\) - 100\.0 KB\/day \(billed 100\.0 KB, free 0 MB\), 1,200 events/)).toBeTruthy();
    // Heartbeat billed but its breakdown returned no rows: volume stays, failure is said.
    expect(screen.getByText("Heartbeat")).toBeTruthy();
    expect(screen.getByText(/Breakdown failed: .*although Usage billed it/)).toBeTruthy();
    expect(screen.getByText(/1 table\(s\) have no source breakdown/)).toBeTruthy();
    // MIG-29: the per-table reconciliation line, from that table's own sources.
    expect(
      screen.getByText(/Sources \(measured from the rows\) total 100\.0 KB\/day of the 3\.0 MB\/day Usage reports/),
    ).toBeTruthy();
    // Explanations are InfoTips, never native title hover text.
    expect(document.querySelector("[title]")).toBeNull();
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
    expect(String(data)).toContain("Syslog,3.000,90.000,30,,fw-01,Computer,0.100,1200,read")
    expect(String(data)).toContain(",fw-01,,0.100,0.000");
  });
});

describe("WorkspaceInventoryPanel - MIG-29", () => {
  it("names a product via its collector, with billed and free, and flags a billed figure over total", async () => {
    const MB = 1_000_000;
    const request = armStub(
      { status: 200, body: table(USAGE_COLS, [["CommonSecurityLog", 1500, 1500, 30, "[]"]]) },
      undefined,
      [
        ["CommonSecurityLog", "Cisco ASA", "product", "localhost", 1356 * MB, 1356 * MB, 100, 1],
        ["CommonSecurityLog", "Palo Alto", "product", "edge-1", 90 * MB, 120 * MB, 50, 1],
      ],
    );
    renderPanel(request);
    await discoverAndInventory();
    await screen.findByText(/Cisco ASA via localhost - 45\.2 MB\/day \(billed 45\.2 MB, free 0 MB\)/);
    // Billed above total: free is not knowable, so it reads not known (the CSV's empty cell), never 0.
    expect(screen.getByText(/Palo Alto via edge-1 - 3\.0 MB\/day \(billed 4\.0 MB, free not known\)/)).toBeTruthy();
    expect(screen.getAllByText("billed figure exceeds total - see tip")).toHaveLength(1);
    expect(screen.getByText(/Sources \(measured from the rows\) total 48\.2 MB\/day of the 50\.0 MB\/day Usage reports/)).toBeTruthy();
    expect(document.querySelector("[title]")).toBeNull();
  });
});

describe("WorkspaceInventoryPanel - MIG-32", () => {
  it("quotes a punctuation-only collector, and flags a Billable table measured all free", async () => {
    const MB = 1_000_000;
    const request = armStub(
      {
        status: 200,
        body: table(USAGE_COLS, [
          ["CommonSecurityLog", 1500, 1500, 30, "[]"],
          ["SecurityCaseEvent", 30, 0, 30, "[]"],
          ["Heartbeat", 30, 0, 30, "[]"],
        ]),
      },
      undefined,
      [
        ["CommonSecurityLog", "Cisco ASA", "product", ":", 1356 * MB, 1356 * MB, 100, 1],
        ["SecurityCaseEvent", "Case Mgmt", "product", "", 30 * MB, 0, 5, 1],
        ["Heartbeat", "vm-1", "computer", "", 30 * MB, 0, 5, 1],
      ],
    );
    renderPanel(request);
    await discoverAndInventory();
    await screen.findByText(/Cisco ASA via ":" - 45\.2 MB\/day/);
    expect(
      screen.getByText("measured free; not in the catalog's free list (SecurityCaseEvent)"),
    ).toBeTruthy();
    // Heartbeat is measured free too, but it is on the catalog's free list: no flag.
    expect(screen.getAllByText(/measured free/)).toHaveLength(1);
  });
});

describe("WorkspaceInventoryPanel - MIG-30", () => {
  it("opens on By table and switches to By source over the same inventory", async () => {
    const MB = 1_000_000;
    const request = armStub(
      { status: 200, body: table(USAGE_COLS, [["CommonSecurityLog", 1500, 1500, 30, "[]"]]) },
      undefined,
      [
        ["CommonSecurityLog", "Cisco ASA", "product", "fw-a", 900 * MB, 900 * MB, 100, 1],
        ["CommonSecurityLog", "Cisco ASA", "product", "fw-b", 450 * MB, 450 * MB, 50, 1],
      ],
    );
    renderPanel(request);
    await discoverAndInventory();
    await screen.findByText(/Cisco ASA via fw-a/);
    expect(screen.getByRole("tab", { name: "By table" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "By source" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByText("2 collectors")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "By source" }));
    expect(screen.getByRole("tab", { name: "By source" }).getAttribute("aria-selected")).toBe("true");
    // One row for the product across both collectors; the By table drill-down is gone.
    expect(screen.getAllByText("Cisco ASA")).toHaveLength(1);
    expect(screen.getByText("2 collectors")).toBeTruthy();
    expect(screen.queryByText(/Cisco ASA via fw-a/)).toBeNull();
    expect(screen.getByText(/they agree within 10\.0%/)).toBeTruthy();
    expect(document.querySelector("[title]")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "By table" }));
    expect(screen.getByText(/Cisco ASA via fw-a/)).toBeTruthy();
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

  it("the after-allowances tile is billable minus the benefit Microsoft applied", async () => {
    const base = armStub({ status: 200, body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]) });
    const request = vi.fn(async (req: AzureManagementRequest) => {
      const query = (req.body as { query?: string } | undefined)?.query ?? "";
      // 0.03 GB = 30 MB applied in the window = 1.0 MB a day.
      if (query.startsWith("Operation")) {
        return {
          status: 200,
          body: table(["Day", "BenefitType", "BenefitUsedGB"], [["2026-10-20", "M365 E5", 0.03]]),
        };
      }
      return base(req);
    });
    renderPanel(request as unknown as ReturnType<typeof armStub>);
    await discoverAndInventory();
    const tiles = () => [...document.querySelectorAll(".match-stat-value")].map((e) => e.textContent);
    await waitFor(() => expect(tiles()[2]).toMatch(/MB$/));
    // Billable 90 MB / 30 = 3.0 MB a day; minus 1.0 MB applied.
    expect(tiles()[1]).toBe("3.0 MB");
    expect(tiles()[2]).toBe("2.0 MB");
  });

  it("adds the Allowance and Over columns once the allowances are read", async () => {
    // Total 120 MB but billable 90 MB, so Daily avg (4.0 MB) differs from Over (3.0 MB).
    renderPanel(armStub({ status: 200, body: table(USAGE_COLS, [["Syslog", 120, 90, 30, "[]"]]) }));
    await discoverAndInventory();
    await waitFor(() => expect(document.body.textContent).toContain("Over allowance / day"));
    const row = screen.getByText("Syslog").closest("tr")!;
    await waitFor(() => expect(row.textContent).toContain("Billable"));
    const headers = [...document.querySelectorAll("th")].map((th) => th.textContent ?? "");
    const cell = (header: string) =>
      row.querySelectorAll("td")[headers.findIndex((h) => h.startsWith(header))]!.textContent;
    expect(cell("Daily avg")).toBe("4.0 MB");
    // A billable table's overage is its own billable daily average: 90 / 30.
    expect(cell("Over allowance")).toBe("3.0 MB");
    await waitFor(() => expect(document.body.textContent).toContain("Operation"));
  });
});

describe("WorkspaceInventoryPanel - an unreadable benefit row (MIG-22)", () => {
  it("shows the gap line and reads Used as a floor, never as an exact figure", async () => {
    const base = armStub({ status: 200, body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]) });
    const request = vi.fn(async (req: AzureManagementRequest) => {
      const query = (req.body as { query?: string } | undefined)?.query ?? "";
      if (query.includes("Benefit amount used")) {
        // One readable day (1 GB) and one whose amount did not extract.
        return {
          status: 200,
          body: table(
            ["Day", "BenefitType", "BenefitUsedGB"],
            [
              ["2026-10-20", "M365 E5", 1],
              ["2026-10-21", "M365 E5", null],
            ],
          ),
        };
      }
      if (query.includes("EligibleMB")) {
        return { status: 200, body: table(["Day", "DataType", "EligibleMB"], [["2026-10-20", "SigninLogs", 2000]]) };
      }
      return base(req);
    });
    renderPanel(request as unknown as ReturnType<typeof armStub>);
    await discoverAndInventory();
    await screen.findByText(/1 benefit amount\(s\) could not be read \(no day or no readable amount\), so Used is a lower bound\./);
    const card = document.querySelector(".allowance-card")!.textContent!;
    // 1 GB readable / 30 days = 33.3 MB a day, and only a floor.
    expect(card).toContain("used at least 33.3 MB/day");
    expect(card).toContain("over not known (partial benefit read)");
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
    const request = tenantStub(USAGE_OK, gate);
    fireEvent.click(await inventoryLaw1(request));
    // Only the other workspace is read again; the shown inventory is reused.
    await screen.findByText(/law-2 \(1 of 1\)/);
    release();
    await screen.findByText("Compared across 2 Sentinel workspaces, 2 read.");

    expect(compareTenant).toHaveBeenCalledTimes(1);
    const [, , ids, inventories] = vi.mocked(compareTenant).mock.calls[0]!;
    expect(ids).toEqual([WS_ID, WS2_ID]);
    expect([...inventories.keys()].sort()).toEqual([WS_ID, WS2_ID]);
    expect(document.querySelector(".allowance-not-read")).toBeNull();
    // Usage totals only for the other workspace: no per-table source breakdown.
    const law2Queries = request.mock.calls
      .map(([req]) => req as AzureManagementRequest)
      .filter((req) => req.path === `${WS2_ID}/query`)
      .map((req) => (req.body as { query: string }).query);
    expect(law2Queries.some((q) => q.startsWith("Usage"))).toBe(true);
    expect(law2Queries.filter((q) => q.startsWith("union isfuzzy=true withsource=SourceTable"))).toEqual([]);

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
  it("reads the sums as at least when discovery could not list every subscription (MIG-18)", async () => {
    const base = tenantStub(USAGE_OK);
    const request = vi.fn(async (req: AzureManagementRequest) => {
      if (req.path === "/subscriptions") {
        return {
          status: 200,
          body: {
            value: [
              { subscriptionId: "sub-1", displayName: "Prod", state: "Enabled" },
              { subscriptionId: "sub-2", displayName: "Denied", state: "Enabled" },
            ],
          },
        };
      }
      if (req.path.startsWith("/subscriptions/sub-2/")) {
        return { status: 403, body: { error: { code: "AuthorizationFailed" } } };
      }
      const query = (req.body as { query?: string } | undefined)?.query ?? "";
      // An E5 benefit answer and eligible volume, so a grant card is rendered.
      if (query.includes("Benefit amount used")) {
        return {
          status: 200,
          body: table(["Day", "BenefitType", "BenefitUsedGB"], [["2026-10-20", "M365 E5", 1]]),
        };
      }
      if (query.includes("EligibleMB")) {
        return { status: 200, body: table(["Day", "DataType", "EligibleMB"], [["2026-10-20", "SigninLogs", 2000]]) };
      }
      return base(req);
    });
    renderPanel(request as unknown as ReturnType<typeof armStub>);
    fireEvent.click(screen.getByText("Discover workspaces"));
    await screen.findByText(/Found 2 workspace\(s\)/);
    fireEvent.click(screen.getByText("Inventory this workspace"));
    fireEvent.click(await screen.findByText(COMPARE));
    await screen.findByText("Compared across 2 Sentinel workspaces, 2 read.");

    expect(vi.mocked(compareTenant).mock.calls[0]![4]).toMatchObject({ discoveryIncomplete: true });
    expect(document.querySelector(".allowance-not-read")).toBeNull();
    const cards = document.querySelector(".allowance-cards")!.textContent!;
    expect(cards).toContain("at least");
    expect(cards).toMatch(/may be missing workspaces discovery could not see/);
  });
});

describe("WorkspaceInventoryPanel - change request pass-through (MIG-25)", () => {
  const USAGE_OK: Answer = { status: 200, body: table(USAGE_COLS, [["Syslog", 90, 90, 30, "[]"]]) };
  const COMPARE = "Compare against the whole tenant";
  const CHANGE_REQUEST = { name: "Open the app permissions change request on Setup" };

  /** An E5 benefit and eligible volume on top of `base`, so the E5 card renders. */
  function withE5Card(base: ReturnType<typeof vi.fn>) {
    return vi.fn(async (req: AzureManagementRequest) => {
      const query = (req.body as { query?: string } | undefined)?.query ?? "";
      if (query.includes("Benefit amount used")) {
        return { status: 200, body: table(["Day", "BenefitType", "BenefitUsedGB"], [["2026-10-20", "M365 E5", 1]]) };
      }
      if (query.includes("EligibleMB")) {
        return { status: 200, body: table(["Day", "DataType", "EligibleMB"], [["2026-10-20", "SigninLogs", 2000]]) };
      }
      return base(req);
    });
  }

  /** A Graph port whose licence read is refused with a 403. */
  const graph403 = () => ({
    readSubscribedSkus: vi.fn().mockResolvedValue({ kind: "denied", detail: "Graph subscribedSkus: HTTP 403 - consent needed" }),
  });

  it("hands the shell's callback to the single-workspace cards", async () => {
    const open = vi.fn();
    renderPanel(withE5Card(armStub(USAGE_OK)) as unknown as ReturnType<typeof armStub>, {
      graph: graph403(),
      onOpenChangeRequest: open,
    });
    await discoverAndInventory();
    fireEvent.click(await screen.findByRole("button", CHANGE_REQUEST));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("hands the shell's callback to the tenant comparison cards", async () => {
    const open = vi.fn();
    const base = armStub(USAGE_OK, USAGE_OK);
    const request = withE5Card(
      vi.fn(async (req: AzureManagementRequest) => {
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
        return base(req);
      }),
    );
    renderPanel(request as unknown as ReturnType<typeof armStub>, { graph: graph403(), onOpenChangeRequest: open });
    fireEvent.click(screen.getByText("Discover workspaces"));
    await screen.findByText(/Found 2 workspace\(s\) across 1 subscription\(s\), 2 with Sentinel/);
    fireEvent.click(screen.getByText("Inventory this workspace"));
    fireEvent.click(await screen.findByText(COMPARE));
    await screen.findByText("Compared across 2 Sentinel workspaces, 2 read.");
    fireEvent.click(await screen.findByRole("button", CHANGE_REQUEST));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
