// @vitest-environment happy-dom
/**
 * Surface pins for the Tables tab (TBL-3).
 *
 * Two of these guard rules that used to hold BY CONSTRUCTION and no longer do.
 * The deleted TablePickerSection auto-loaded and had no button, so "a denied
 * capability never removes the attempt" and "no request storm" were both free.
 * This panel has a button, so both are now claims about code - which is
 * exactly when they need pins.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AzureConfig, PortHttpResponse } from "@soc/core";
import { emptyCapabilitySet } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { WorkspaceTablesPanel } from "./workspace-tables-panel";

afterEach(cleanup);

const SUB = "sub-1";
const RG = "rg-1";
const WS = "law-1";

const CONFIG = {
  tenantId: "t",
  clientId: "c",
  subscriptionId: SUB,
  resourceGroup: RG,
  workspaceName: WS,
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse =>
  ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;

const TABLES = {
  value: [
    {
      name: "SecurityEvent",
      properties: { retentionInDays: 30, plan: "Analytics" },
    },
    { name: "App_CL", properties: { plan: "Analytics" } },
  ],
};

const DCRS = {
  value: [
    {
      name: "dcr-SecurityEvent-eastus",
      location: "eastus",
      properties: {
        dataFlows: [{ outputStream: "Microsoft-SecurityEvent" }],
        streamDeclarations: {},
      },
    },
  ],
};

/** Records every path requested so a pin can assert the attempt was MADE. */
function makePorts(opts: { dcrFails?: boolean; tablesFail?: boolean } = {}) {
  const calls: string[] = [];
  const ports = {
    azure: {
      async request(o: { path: string }): Promise<PortHttpResponse> {
        calls.push(o.path);
        if (o.path.includes("/dataCollectionRules")) {
          if (opts.dcrFails === true) {
            return { ok: false, status: 403, body: {} } as unknown as PortHttpResponse;
          }
          return ok(DCRS);
        }
        if (o.path.endsWith("/tables")) {
          if (opts.tablesFail === true) {
            return {
              ok: false,
              status: 403,
              body: { error: { message: "denied by RBAC" } },
            } as unknown as PortHttpResponse;
          }
          return ok(TABLES);
        }
        return ok({ value: [] });
      },
    },
  } as unknown as UiPorts;
  return { ports, calls };
}

function renderPanel(
  ports: UiPorts,
  props: Record<string, unknown> = {},
) {
  return render(
    <PortsProvider ports={ports} config={CONFIG}>
      <WorkspaceTablesPanel {...props} />
    </PortsProvider>,
  );
}

describe("WorkspaceTablesPanel", () => {
  it("does NOT list until the button is pressed", async () => {
    // The deleted panel auto-loaded; one 403 against an ~842-row listing on
    // every mount is the request storm that lesson was about.
    const { ports, calls } = makePorts();
    renderPanel(ports);
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(screen.getByRole("button", { name: "Load tables" })).toBeTruthy();
  });

  it("lists tables and marks which one a DCR targets", async () => {
    const { ports } = makePorts();
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    expect(screen.getByText("dcr-SecurityEvent-eastus")).toBeTruthy();
    // The unmatched row names the SCOPE rather than claiming a flat no.
    expect(screen.getByText(`none in ${RG}`)).toBeTruthy();
  });

  it("keeps Load ENABLED when the capability audit says table.read is denied", async () => {
    // Capability rule 1: a denied verdict annotates, it never removes the
    // attempt. This held by construction until this panel grew a button.
    const { ports, calls } = makePorts();
    renderPanel(ports, {
      capabilities: emptyCapabilitySet(),
      capabilityContext: { azureIdentityPresent: true, criblReachable: true },
    });
    const button = screen.getByRole("button", { name: "Load tables" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    // And the attempt actually reaches the port - Azure's own answer is the gate.
    await waitFor(() => {
      expect(calls.some((p) => p.endsWith("/tables"))).toBe(true);
    });
  });

  it("renders the real failure rather than an empty listing", async () => {
    // Swallowing a 403 would leave an empty table that reads as an empty
    // workspace - the exact confusion listWorkspaceTables refuses to create.
    const { ports } = makePorts({ tablesFail: true });
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText(/denied by RBAC|403/)).toBeTruthy();
    });
  });

  it("degrades the DCR column, not the page, when the DCR listing fails", async () => {
    const { ports } = makePorts({ dcrFails: true });
    renderPanel(ports);
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    // "not checked" everywhere - never "none in rg-1", which would be a
    // measured zero we did not measure.
    expect(screen.getAllByText("not checked")).toHaveLength(2);
    expect(screen.queryByText(`none in ${RG}`)).toBeNull();
  });

  it("hides both actions when the host wires neither", () => {
    // A button that went nowhere would be worse than no button.
    const { ports } = makePorts();
    renderPanel(ports);
    expect(screen.queryByRole("button", { name: "Create table" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create DCR" })).toBeNull();
  });

  it("offers Create DCR per row, and passes THAT row's table", async () => {
    // Located by row content, not by index: listWorkspaceTables sorts its
    // results, so an index-based click silently tests a different row.
    const onCreateDcr = vi.fn();
    const { ports } = makePorts();
    const { container } = renderPanel(ports, { onCreateDcr });
    fireEvent.click(screen.getByRole("button", { name: "Load tables" }));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Create DCR" })).toHaveLength(2);
    });
    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
      (tr.textContent ?? "").includes("App_CL"),
    );
    expect(row, "no row rendered for App_CL").toBeTruthy();
    fireEvent.click(row!.querySelector("button")!);
    expect(onCreateDcr).toHaveBeenCalledWith("App_CL");
  });

  it("has NO filter box - filterTables was deleted with the old panel", () => {
    const { ports } = makePorts();
    const { container } = renderPanel(ports);
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });
});
