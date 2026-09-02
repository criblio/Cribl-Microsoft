// @vitest-environment happy-dom
/**
 * D-3 (backlog 18b): capabilities travel in PortsContext.
 *
 * WHAT THESE PIN, AND WHY EACH ONE IS NEEDED.
 *
 * 1. A REAL SCREEN reads the measured audit off the context. DcrInventoryPanel
 *    takes NO props at all now, so nothing but the context can reach the branch
 *    that decides whether an empty ARM listing may be called a zero
 *    (docs/inventory-standard.md). The pin drives two verdicts through the
 *    provider and reads two DIFFERENT sentences off the DOM - `granted` licenses
 *    "No data collection rules found", `denied` refuses to. A screen that
 *    ignored the context would render the `unknown` hedge in both, so one
 *    assertion is not passable by the other.
 *
 * 2. THE PROVIDER'S VALUE IS MEMOIZED. The two capability fields are in the
 *    dep list, so this is what makes a shell re-render cheap for every screen
 *    under the provider - and what makes `useCapabilityAudit`'s own memo
 *    load-bearing rather than decorative.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { EMPTY_AZURE_CONFIG } from "@soc/core";
import type {
  AzureConfig,
  Capability,
  CapabilityContext,
  CapabilitySet,
  CapabilityVerdict,
  PortHttpResponse,
} from "@soc/core";
import { PortsProvider, usePorts } from "./ports-context";
import type { PortsContextValue, UiPorts } from "./ports-context";
import { DcrInventoryPanel } from "./screens/dcr-automation/dcr-inventory-panel";

afterEach(cleanup);

const SUB = "sub-1";
const RG = "rg-1";

const CONFIG: AzureConfig = {
  ...EMPTY_AZURE_CONFIG,
  tenantId: "tenant-1",
  clientId: "client-1",
  subscriptionId: SUB,
  resourceGroup: RG,
  workspaceName: "law-1",
};

const CONNECTED: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};

/** An AUDITED set - the only kind that can carry a `granted` or `denied`. */
function measured(
  verdicts: Partial<Record<Capability, CapabilityVerdict>>,
): CapabilitySet {
  return {
    verdicts,
    auditedAt: "2026-08-31T00:00:00.000Z",
    connectionId: "conn-1",
  };
}

/**
 * ARM that answers the resource-group list and returns an EMPTY DCR listing.
 * Empty is the whole point: it is the response RBAC filtering and a genuinely
 * empty group both produce, so only the audit can tell them apart.
 */
function emptyInventoryPorts(): UiPorts {
  const ok = (body: unknown): PortHttpResponse =>
    ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;
  return {
    azure: {
      async request(opts: { path: string }): Promise<PortHttpResponse> {
        if (opts.path.endsWith("/resourcegroups")) {
          return ok({ value: [{ name: RG }] });
        }
        return ok({ value: [] });
      },
    },
  } as unknown as UiPorts;
}

/** Load the inventory and resolve once the empty-listing line is on screen. */
async function loadInventory(capabilities: CapabilitySet): Promise<string> {
  render(
    <PortsProvider
      ports={emptyInventoryPorts()}
      config={CONFIG}
      capabilities={capabilities}
      capabilityContext={CONNECTED}
    >
      {/* NO PROPS. Everything this panel knows about the audit arrives
          through the context above (D-3). */}
      <DcrInventoryPanel />
    </PortsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load DCR inventory" }));
  const line = await waitFor(() => {
    const p = document.querySelector(".discovery-result > .panel-desc");
    if (p === null) throw new Error("the empty-listing line has not rendered");
    return p.textContent ?? "";
  });
  return line;
}

describe("D-3 - a screen reads the measured audit off PortsContext", () => {
  it("calls an empty listing a ZERO when the context says dcr.read is granted", async () => {
    const line = await loadInventory(measured({ "dcr.read": "granted" }));
    expect(line).toBe("No data collection rules found");
  });

  it("REFUSES to call the same empty listing a zero when the context says denied", async () => {
    const line = await loadInventory(measured({ "dcr.read": "denied" }));
    expect(line).toBe(
      "Cannot list data collection rules - the connected identity does not have permission to read them",
    );
    // Named explicitly: the two cases above must not both collapse into the
    // unaudited hedge, which is what a panel ignoring the context would render.
    expect(line).not.toContain("run the permission check");
  });
});

describe("D-3 - PortsProvider memoizes the value it publishes", () => {
  it("hands consumers the SAME context object when nothing changed", () => {
    const seen: PortsContextValue[] = [];
    const ports = emptyInventoryPorts();
    const capabilities = measured({ "dcr.read": "granted" });

    function Probe() {
      seen.push(usePorts());
      return null;
    }
    function Host() {
      // Re-renders the provider without changing ANY of its four inputs, which
      // is exactly what a shell does on every unrelated state change.
      const [tick, setTick] = useState(0);
      return (
        <PortsProvider
          ports={ports}
          config={CONFIG}
          capabilities={capabilities}
          capabilityContext={CONNECTED}
        >
          <button onClick={() => setTick(tick + 1)}>re-render</button>
          <Probe />
        </PortsProvider>
      );
    }

    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "re-render" }));

    expect(seen.length).toBeGreaterThan(1);
    // Identity, not deep equality: a fresh-but-equal object still re-renders
    // every consumer, which is the cost this memo exists to avoid.
    expect(seen[seen.length - 1]).toBe(seen[0]);
    expect(seen[0]?.capabilities).toBe(capabilities);
    expect(seen[0]?.capabilityContext).toBe(CONNECTED);
  });
});
