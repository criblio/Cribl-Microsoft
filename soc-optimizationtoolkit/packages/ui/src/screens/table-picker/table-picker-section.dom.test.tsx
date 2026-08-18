// @vitest-environment happy-dom
/**
 * DOM pins for the workspace table picker.
 *
 * The state module is thoroughly unit-tested and was never the risk. What no
 * pure test can see is whether the CONTROLS obey the capability rules - and
 * those rules are all about what is rendered, enabled, and offered:
 *
 *   1. A denied verdict ANNOTATES; it never hides or disables the load.
 *   2. Reads have no fallback artifact, so the annotation stands alone.
 *   3. An empty listing is only a zero once the read was verified.
 *
 * Rule 1 in particular can only fail visually: a `disabled` attribute added in
 * good faith would satisfy every state test while taking away the attempt the
 * model deliberately preserves.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyCapabilitySet } from "@soc/core";
import type { AzureConfig, CapabilitySet } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { TablePickerSection } from "./table-picker-section";

afterEach(cleanup);

const TARGET = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law-test",
};

const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law-test",
  setupPath: "existing",
};

/** ARM list response shaped as the parser expects. */
function tablesResponse(names: string[]) {
  return {
    status: 200,
    body: {
      value: names.map((name) => ({
        name,
        properties: { plan: "Analytics", retentionInDays: 90 },
      })),
    },
  };
}

function renderPicker(opts: {
  capabilities?: CapabilitySet;
  request?: ReturnType<typeof vi.fn>;
  onSelected?: ReturnType<typeof vi.fn>;
}) {
  const request = opts.request ?? vi.fn().mockResolvedValue(tablesResponse([]));
  const ports = {
    azure: { request },
    jobs: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={CONFIG}>
      <TablePickerSection
        target={TARGET}
        capabilities={opts.capabilities ?? emptyCapabilitySet()}
        capabilityContext={{ azureIdentityPresent: true, criblReachable: true }}
        selectedTable={null}
        onTableSelected={opts.onSelected ?? vi.fn()}
      />
    </PortsProvider>,
  );
  return request;
}

describe("TablePickerSection - the capability rules are visible, not implied", () => {
  it("keeps Load pressable when the audit says table.read is denied", () => {
    // RULE 1, and the one that can only fail here. An empty capability set is
    // the worst verdict available, and the button must still be usable -
    // Azure's 403 is the real gate, not our audit.
    renderPicker({});
    const load = screen.getByRole("button", { name: /Load tables/ });
    expect(load).toHaveProperty("disabled", false);
  });

  it("actually attempts the listing on a denied verdict", () => {
    // Stronger than the enabled check: proves the click reaches ARM rather
    // than being swallowed by a guard somewhere between button and port.
    const request = renderPicker({});
    fireEvent.click(screen.getByRole("button", { name: /Load tables/ }));
    expect(request).toHaveBeenCalled();
  });

  it("says nothing has been loaded BEFORE any load", () => {
    // Rule 3's near-miss: pre-load emptiness is not a finding about the
    // workspace, and must not be reported as one.
    renderPicker({});
    expect(screen.getByText("No tables loaded yet.")).toBeTruthy();
  });

  it("does not call an unverified empty listing a zero", async () => {
    // Rule 3. ARM returns 200 + [] both when the workspace is empty and when
    // RBAC filtered us out; with table.read unmeasured the copy must not
    // settle it. Anything asserting a bare "no tables" here would be the
    // confident wrong answer inventory-standard.md was written against.
    renderPicker({});
    fireEvent.click(screen.getByRole("button", { name: /Load tables/ }));
    await waitFor(() => {
      expect(screen.queryByText("No tables loaded yet.")).toBeNull();
    });
    expect(screen.queryByText(/^No tables\.?$/)).toBeNull();
  });

  it("surfaces a failed listing verbatim instead of as an empty result", async () => {
    // A 403 is the meaningful answer. Folding it into the empty state would
    // hide the one thing the operator can act on.
    const request = vi.fn().mockRejectedValue(new Error("403 Forbidden: denied"));
    renderPicker({ request });
    fireEvent.click(screen.getByRole("button", { name: /Load tables/ }));
    await waitFor(() => {
      expect(screen.getByText(/403 Forbidden/)).toBeTruthy();
    });
  });
});

describe("TablePickerSection - listing and selection", () => {
  it("lists the tables it loaded and counts them", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["SecurityEvent", "App_CL"]));
    renderPicker({ request });
    fireEvent.click(screen.getByRole("button", { name: /Load tables/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "SecurityEvent" })).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "App_CL" })).toBeTruthy();
    expect(screen.getByText("2 tables")).toBeTruthy();
  });

  it("filters by name and says so in the count", async () => {
    // The count states the filter rather than hiding it - a bare "1 table"
    // would read as the workspace holding one.
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["SecurityEvent", "App_CL"]));
    renderPicker({ request });
    fireEvent.click(screen.getByRole("button", { name: /Load tables/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "App_CL" })).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Filter tables"), {
      target: { value: "_cl" },
    });
    expect(screen.getByText("1 of 2 tables")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "SecurityEvent" })).toBeNull();
  });

  it("hands the caller the table AND its live schema on selection", async () => {
    // The selection is only useful if the schema travels with it - that is
    // what replaces the derived destSchema and re-runs the analysis.
    const request = vi.fn().mockImplementation((req: { path: string }) =>
      req.path.endsWith("/SecurityEvent")
        ? Promise.resolve({
            status: 200,
            body: {
              properties: {
                schema: { columns: [{ name: "TimeGenerated", type: "datetime" }] },
              },
            },
          })
        : Promise.resolve(tablesResponse(["SecurityEvent"])),
    );
    const onSelected = vi.fn();
    renderPicker({ request, onSelected });
    fireEvent.click(screen.getByRole("button", { name: /Load tables/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "SecurityEvent" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "SecurityEvent" }));
    await waitFor(() => {
      expect(onSelected).toHaveBeenCalled();
    });
    const [table, schema] = onSelected.mock.calls[0] as [string, unknown];
    expect(table).toBe("SecurityEvent");
    expect(schema).toEqual([{ name: "TimeGenerated", type: "datetime" }]);
  });
});
