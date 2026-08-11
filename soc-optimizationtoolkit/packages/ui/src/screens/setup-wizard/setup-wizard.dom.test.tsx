// @vitest-environment happy-dom
/**
 * DOM pin for the wizard's Connect Azure step.
 *
 * ADDED BY ARCHITECTURE AUDIT 2026-08-11, retroactively. The 1.5.2 fix shipped
 * with no test at all: `azureConnectSection` appeared in exactly two source
 * files and nowhere else, so deleting either the prop or the line that renders
 * it left all 665 UI tests green - and restored the reported defect, a step
 * titled "Connect Azure" that was the one place you could not connect Azure.
 *
 * That is the audit's named failure mode (new behaviour arriving with no pin),
 * and it is worse here than usual because the defect is INVISIBLE to the suite:
 * nothing errors, the step still renders, it just quietly stops offering the
 * form. Only a rendered wizard can catch it.
 *
 * The pins are deliberately about PLACEMENT rather than the form's contents -
 * the section is a shell-owned node, so what matters here is that the step
 * renders whatever it is handed, in the step named for it, alongside (not
 * instead of) the change-request guidance the step already carried.
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AzureConfig, WizardCapabilities } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { SetupWizard } from "./setup-wizard";

afterEach(cleanup);

/**
 * Ports stub. Steps before the Azure one (the GitHub content step) read ports on
 * render, so the wizard cannot mount without a provider - but nothing these
 * pins assert reaches a port, so an empty bundle is honest rather than a
 * shortcut. If a future step calls one on mount, this fails loudly with the
 * missing method rather than silently passing.
 */
const PORTS = {} as UiPorts;
/**
 * Connection PRESENCE, which is what this prop means - not a permission verdict.
 * Both true so the wizard shows the full step list and the Azure step is
 * reachable; these pins are about that step's contents, not about step gating.
 */
const CAPABILITIES: WizardCapabilities = { hasCribl: true, hasAzure: true };
const CONFIG = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
} as AzureConfig;

/**
 * Render the wizard already on the Azure step. `installedInLeader` skips the
 * target and upload steps, and `initialTarget: "cribl-hosted"` matches the
 * cloud shell - the only shell that wires the section.
 */
function renderOnAzureStep(section?: ReactNode) {
  return render(
    <PortsProvider ports={PORTS} config={CONFIG}>
      <SetupWizard
        capabilities={CAPABILITIES}
        criblShellMode="cloud"
        contentPlatform="cloud"
        initialTarget="cribl-hosted"
        lockTarget
        installedInLeader
        onGetStarted={() => {}}
        {...(section !== undefined ? { azureConnectSection: section } : {})}
      />
    </PortsProvider>,
  );
}

/**
 * Click Next until the Connect Azure step is on screen, identified by its own
 * HEADING rather than by the injected node - so the helper works identically in
 * the wired and unwired cases, and a test asserting the node is absent still
 * proves it reached the right step.
 *
 * Matched as a heading, not as text: the wizard subtitle also contains the words
 * "connect Azure", so a plain text match reports success on step one and every
 * assertion after it fails somewhere unrelated.
 */
function advanceToAzureStep(): void {
  for (let i = 0; i < 6; i += 1) {
    if (
      screen.queryByRole("heading", { name: /^connect azure$/i }) !== null
    ) {
      return;
    }
    const next = screen.queryByRole("button", { name: /^next$/i });
    if (next === null) {
      break;
    }
    fireEvent.click(next);
  }
  throw new Error(
    "never reached the Connect Azure step: " +
      screen
        .queryAllByRole("heading")
        .map((h) => h.textContent)
        .join(" | "),
  );
}

describe("SetupWizard - Connect Azure step", () => {
  it("RENDERS the section the shell hands it, so the step can actually connect", () => {
    // The whole point of 1.5.2. If this fails, the operator is back to a step
    // that explains how to get credentials and gives them nowhere to go.
    renderOnAzureStep(<div data-testid="azure-connect-slot">connect form</div>);
    advanceToAzureStep();
    expect(screen.getByText("connect form")).toBeTruthy();
  });

  it("keeps the step's own guidance BESIDE the form, not replaced by it", () => {
    // The change-request path was not a workaround to retire - most operators
    // genuinely have to ask another team for credentials. The form was added
    // alongside it, and a future edit that swaps one for the other would be a
    // regression for whichever half it dropped.
    renderOnAzureStep(<div data-testid="azure-connect-slot">connect form</div>);
    advanceToAzureStep();
    expect(screen.getByText("connect form")).toBeTruthy();
    expect(screen.getByText(/change request/i)).toBeTruthy();
  });

  it("is OPTIONAL - an unwired shell renders the step unchanged", () => {
    // The local shell has no in-app identity surface (its credentials live in
    // config/local-config.json) and deliberately passes nothing. Absent must
    // stay a working guidance-only step, never an empty one or a crash.
    renderOnAzureStep();
    advanceToAzureStep();
    expect(screen.queryByTestId("azure-connect-slot")).toBeNull();
    // Reached the step and it still has its content - not a blank panel.
    expect(screen.getByText(/change request/i)).toBeTruthy();
  });
});
