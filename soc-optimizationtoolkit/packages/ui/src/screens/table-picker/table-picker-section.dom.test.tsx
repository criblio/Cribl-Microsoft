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
 *
 * RE-PINNED 2026-08-18 for auto-load. The listing now runs on mount, so the
 * pins that used to click "Load tables" wait for the automatic attempt instead.
 * Every rule above still has a pin; only the trigger moved. The in-flight
 * states (button reads "Loading...", nothing loaded yet) are pinned against a
 * request that never settles, so they stay deterministic rather than racing the
 * resolution.
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

/** A request that never settles - pins the in-flight render deterministically. */
function pendingRequest() {
  return vi.fn().mockReturnValue(new Promise(() => {}));
}

/**
 * Render the picker the way integrate-screen really does.
 *
 * THE TARGET IS A FRESH OBJECT LITERAL EVERY RENDER, deliberately. The screen
 * builds it inline from three config fields, so its identity changes on every
 * parent render and any effect keyed on the object itself re-fires constantly.
 * An earlier version of these pins held `target` constant, which made a broken
 * guard look correct - the mutation test passed. Matching production is what
 * gives the no-retry pin teeth.
 *
 * Returns `rerender` so a test can drive those parent re-renders.
 */
function renderPicker(opts: {
  capabilities?: CapabilitySet;
  request?: ReturnType<typeof vi.fn>;
  onLoaded?: ReturnType<typeof vi.fn>;
}) {
  const request = opts.request ?? vi.fn().mockResolvedValue(tablesResponse([]));
  const ports = {
    azure: { request },
    jobs: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as UiPorts;
  const onLoaded = opts.onLoaded ?? vi.fn();
  const tree = () => (
    <PortsProvider ports={ports} config={CONFIG}>
      <TablePickerSection
        target={{ ...TARGET }}
        capabilities={opts.capabilities ?? emptyCapabilitySet()}
        capabilityContext={{ azureIdentityPresent: true, criblReachable: true }}
        onTablesLoaded={onLoaded}
      />
    </PortsProvider>
  );
  const { rerender } = render(tree());
  return { request, rerender: () => rerender(tree()) };
}

describe("TablePickerSection - auto-load", () => {
  // The listing exists to fill the per-log-type Destination selectors. Behind a
  // click, those selectors offered four hardcoded natives and nothing said a
  // prerequisite existed - reported live 2026-08-18.
  it("lists the workspace tables without being asked", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["SecurityEvent", "App_CL"]));
    renderPicker({ request });
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("lists ONCE across parent re-renders", async () => {
    // The screen rebuilds `target` inline every render, so an effect keyed on
    // the object re-fires constantly. Listing 842 tables on every keystroke
    // elsewhere on the page is the failure mode; the ref key is the workspace
    // string, not the object.
    const request = vi.fn().mockResolvedValue(tablesResponse(["SecurityEvent"]));
    const picker = renderPicker({ request });
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    picker.rerender();
    picker.rerender();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hands them straight up to the selectors", async () => {
    const onLoaded = vi.fn();
    const request = vi.fn().mockResolvedValue(tablesResponse(["App_CL"]));
    renderPicker({ request, onLoaded });
    await waitFor(() => {
      expect(onLoaded).toHaveBeenCalled();
    });
    const handed = onLoaded.mock.calls[0]![0] as Array<{ name: string }>;
    expect(handed.map((t) => t.name)).toEqual(["App_CL"]);
  });

  it("does not re-attempt a FAILED listing", async () => {
    // `load` clears `loaded` on error, so a guard keyed on that state re-fires
    // as soon as anything re-renders the parent - turning one 403 into a
    // request storm. Driving real re-renders is what distinguishes the two
    // guards; without them the broken version passes.
    const request = vi.fn().mockRejectedValue(new Error("403 Forbidden: denied"));
    const picker = renderPicker({ request });
    await waitFor(() => {
      expect(screen.getByText(/403 Forbidden/)).toBeTruthy();
    });
    picker.rerender();
    picker.rerender();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("still allows a MANUAL retry after a failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("403 Forbidden: denied"));
    renderPicker({ request });
    await waitFor(() => {
      expect(screen.getByText(/403 Forbidden/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /tables/ }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
  });
});

describe("TablePickerSection - the capability rules are visible, not implied", () => {
  it("keeps the load pressable when the audit says table.read is denied", async () => {
    // RULE 1, and the one that can only fail here. An empty capability set is
    // the worst verdict available, and the control must still be usable -
    // Azure's 403 is the real gate, not our audit. Asserted once the automatic
    // attempt has settled, so what is being measured is the VERDICT's effect
    // and not the in-flight disable.
    renderPicker({});
    await waitFor(() => {
      const load = screen.getByRole("button", { name: /tables/ });
      expect(load).toHaveProperty("disabled", false);
    });
  });

  it("actually attempts the listing on a denied verdict", async () => {
    // Stronger than the enabled check: proves the attempt reaches ARM rather
    // than being swallowed by a guard somewhere between mount and port.
    const { request } = renderPicker({});
    await waitFor(() => {
      expect(request).toHaveBeenCalled();
    });
  });

  it("says nothing has been loaded WHILE the listing is in flight", () => {
    // Rule 3's near-miss: emptiness before a listing completes is not a finding
    // about the workspace, and must not be reported as one.
    renderPicker({ request: pendingRequest() });
    expect(screen.getByText("No tables loaded yet.")).toBeTruthy();
  });

  it("does not call an unverified empty listing a zero", async () => {
    // Rule 3. ARM returns 200 + [] both when the workspace is empty and when
    // RBAC filtered us out; with table.read unmeasured the copy must not
    // settle it. Anything asserting a bare "no tables" here would be the
    // confident wrong answer inventory-standard.md was written against.
    renderPicker({});
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
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    expect(screen.getByText("App_CL")).toBeTruthy();
    expect(screen.getByText("2 tables")).toBeTruthy();
  });

  it("filters by name and says so in the count", async () => {
    // The count states the filter rather than hiding it - a bare "1 table"
    // would read as the workspace holding one.
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["SecurityEvent", "App_CL"]));
    renderPicker({ request });
    await waitFor(() => {
      expect(screen.getByText("App_CL")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Filter tables"), {
      target: { value: "_cl" },
    });
    expect(screen.getByText("1 of 2 tables")).toBeTruthy();
    expect(screen.queryByText("SecurityEvent")).toBeNull();
  });

  it("hands the loaded tables UP, so each log type can offer them", async () => {
    // The panel loads; it does not select. Selection is per log type on the
    // mapping-review cards, because a solution's log types can land in
    // different tables - each its own DCR and Sentinel destination.
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["CrowdStrikeAlerts_CL", "SecurityEvent"]));
    const onLoaded = vi.fn();
    renderPicker({ request, onLoaded });
    await waitFor(() => {
      expect(onLoaded).toHaveBeenCalled();
    });
    const handed = onLoaded.mock.calls[0]![0] as Array<{ name: string }>;
    expect(handed.map((t) => t.name)).toEqual([
      "CrowdStrikeAlerts_CL",
      "SecurityEvent",
    ]);
  });

  it("reports an empty listing upward too, so stale options are dropped", async () => {
    const onLoaded = vi.fn();
    renderPicker({ onLoaded });
    await waitFor(() => {
      expect(onLoaded).toHaveBeenCalledWith([]);
    });
  });
});
