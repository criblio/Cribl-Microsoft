// @vitest-environment happy-dom
/**
 * DOM pins for the DEPLOYMENT TARGET pickers on the Setup page.
 *
 * THE DEFECT THESE EXIST FOR, reported live 2026-09-04 after installing 1.12.4
 * into a fresh Cribl org: "there are 4 options in the drop down and none of
 * them allow you to select a specific Log Analytics workspace or resource
 * group". The four options were the setup-path chooser. The workspace picker
 * was gated on `setupPath === "existing"` and the resource-group picker on
 * `setupPath === "lab-byo-rg"` - mutually exclusive values, so NO PATH EVER
 * SHOWED BOTH, and `lab-new-rg` showed neither.
 *
 * The whole suite was green with that gate in place, which is why these pins
 * are per-path and structural rather than a single happy-path render: a pin
 * that only ever mounts the `existing` path would have passed before the fix
 * and would pass again if the gate came back for either of the other two.
 *
 * WHY IT MATTERS BEYOND THE MISSING FIELD. The target is not a setup-path
 * question. Choosing a shape happens once; repointing an install at a different
 * Log Analytics workspace happens for the life of the install, and both pickers
 * write straight to the shared config that every other screen reads. Gating
 * them behind a first-run choice made a permanent operation reachable only from
 * one of three starting states.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AzureConfig, AzureSetupPath, ChangeRequestContext } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureResourcesSection } from "./azure-resources-section";

afterEach(cleanup);

/**
 * Ports whose ARM calls never resolve. Deliberate: these pins are about which
 * fields EXIST, and a pending request leaves the pickers in their disabled
 * placeholder state, which is exactly the state a fresh install renders before
 * anyone clicks Discover. A resolving stub would test the loaded case and miss
 * the reported one.
 */
const PENDING_PORTS = {
  azure: { request: () => new Promise(() => undefined) },
} as unknown as UiPorts;

const CONFIG = {
  clientId: "00000000-0000-0000-0000-000000000000",
  tenantId: "11111111-1111-1111-1111-111111111111",
  subscriptionId: "22222222-2222-2222-2222-222222222222",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
} as AzureConfig;

const CTX: ChangeRequestContext = { appName: "test", config: CONFIG };

function renderAt(setupPath: AzureSetupPath) {
  return render(
    <PortsProvider ports={PENDING_PORTS} config={{ ...CONFIG, setupPath }}>
      <AzureResourcesSection
        clientId={CONFIG.clientId}
        tenantId={CONFIG.tenantId}
        setupPath={setupPath}
        subscriptionId={CONFIG.subscriptionId}
        onSubscriptionIdChange={vi.fn()}
        rgName=""
        onRgNameChange={vi.fn()}
        workspaceName=""
        onWorkspaceNameChange={vi.fn()}
        connectNonce={0}
        ctx={CTX}
        storageContextLabel="test"
      />
    </PortsProvider>,
  );
}

const ALL_PATHS: readonly AzureSetupPath[] = ["existing", "lab-new-rg", "lab-byo-rg"];

// Queried by the FIELD LABEL rather than the combobox's aria-label: that
// aria-label lives on the popover's filter input, which exists only while the
// popover is OPEN, so asserting on it would pin the open state rather than the
// field's existence - and the reported defect is that the field is not there at
// all. The label text is also what the operator scans for.
const WORKSPACE_LABEL = /workspace \(deployment target\)/i;
const RESOURCE_GROUP_LABEL = /resource group \(deployment target\)/i;

describe("the deployment target is reachable from every setup path", () => {
  it.each(ALL_PATHS)("offers a workspace picker on %s", (path) => {
    renderAt(path);
    expect(screen.getByText(WORKSPACE_LABEL)).toBeTruthy();
  });

  it.each(ALL_PATHS)("offers a resource-group picker on %s", (path) => {
    renderAt(path);
    expect(screen.getByText(RESOURCE_GROUP_LABEL)).toBeTruthy();
  });

  it("shows BOTH on one path, which no path could do before", () => {
    // The sharpest statement of the defect. `existing` and `lab-byo-rg` are
    // different values, so the old gates could not both be true - this
    // assertion was unsatisfiable on EVERY path, and it is the one that breaks
    // if either picker is re-gated.
    renderAt("existing");
    expect(screen.getByText(WORKSPACE_LABEL)).toBeTruthy();
    expect(screen.getByText(RESOURCE_GROUP_LABEL)).toBeTruthy();
  });

  it("says the workspace drives every screen, so it reads as a target and not a first-run field", () => {
    renderAt("lab-new-rg");
    expect(
      screen.getByText(/every screen that names a workspace uses this one/i),
    ).toBeTruthy();
  });
});
