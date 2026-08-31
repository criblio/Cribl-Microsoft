// @vitest-environment happy-dom
/**
 * Surface pins for Enable Sentinel Content (DBT-47).
 *
 * The gate being pinned is what ARMS an install. `scopeCommitted` is nothing
 * but three non-empty Azure config strings an operator can type with no
 * connection at all, so a gate built from it alone offered every install action
 * on a build with no identity to install with - and the only feedback was the
 * eventual auth failure.
 *
 * The correction has TWO halves, and a pin that only checks the first would
 * license the wrong fix: the action must be blocked, AND it must still be
 * there. The capability model's rule is that a denied verdict ANNOTATES and
 * never removes the attempt, so the button stays rendered and reachable with
 * the reason on it - never hidden.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AzureConfig,
  PortHttpResponse,
  SentinelContent,
  SolutionFileRef,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { ContentInstallSection } from "./content-install-section";

afterEach(cleanup);

const SOLUTION = "CrowdStrike Falcon Endpoint Protection";
const WORKBOOK = "FalconOverview";

/** A committed scope WITH an Azure identity - the connected case. */
const CONNECTED = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
  setupPath: "existing",
} as unknown as AzureConfig;

/**
 * The DBT-47 shape: the same three scope strings, typed with no connection.
 * This is reachable today - the targeting form does not require an identity to
 * commit a scope - which is why it is the case that needed the pin.
 */
const NO_IDENTITY = {
  ...CONNECTED,
  tenantId: "",
  clientId: "",
} as unknown as AzureConfig;

const armOk: PortHttpResponse = {
  ok: true,
  status: 200,
  body: { value: [] },
} as unknown as PortHttpResponse;

/**
 * Content with exactly one workbook and nothing else. Workbooks are the group
 * used here because every one of them is selectable - a rule can be an
 * unsupported managed type, which would disable the install button for a reason
 * that has nothing to do with the gate under test.
 */
const content: SentinelContent = {
  async listSolutionFiles(
    _solution: string,
    subDir: string,
  ): Promise<SolutionFileRef[]> {
    return subDir === "Workbooks"
      ? [
          {
            name: `${WORKBOOK}.json`,
            path: `Solutions/${SOLUTION}/Workbooks/${WORKBOOK}.json`,
            size: 12,
          },
        ]
      : [];
  },
  async readFile(): Promise<string | null> {
    return '{"version":"Notebook/1.0","items":[]}';
  },
} as unknown as SentinelContent;

function makePorts(): UiPorts {
  return {
    azure: {
      async request(): Promise<PortHttpResponse> {
        return armOk;
      },
    },
    content,
    mintAssignmentName: () => "33333333-3333-3333-3333-333333333333",
  } as unknown as UiPorts;
}

/** Render, load the solution content, and select the one workbook. */
async function renderAndSelect(config: AzureConfig) {
  const view = render(
    <PortsProvider ports={makePorts()} config={config}>
      <ContentInstallSection solutionName={SOLUTION} scopeCommitted={true} />
    </PortsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load solution content" }));
  await waitFor(() => {
    expect(screen.getByText(WORKBOOK)).toBeTruthy();
  });
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  // Guard the pin itself: an unselected list disables the button for its own
  // reason, which would make the assertions below pass against the bug.
  const install = screen.getByRole("button", {
    name: "Install selected (1)",
  }) as HTMLButtonElement;
  return { ...view, install };
}

describe("ContentInstallSection install gate (DBT-47)", () => {
  it("does NOT arm the install when the scope was typed with no Azure identity", async () => {
    const { install } = await renderAndSelect(NO_IDENTITY);
    expect(install.disabled).toBe(true);
  });

  it("keeps the blocked install REACHABLE and says why - never hidden", async () => {
    // The capability rule: a denied verdict annotates, it never removes the
    // attempt. A fix that hid the button would satisfy the test above and
    // break the model, so the button's presence is pinned too.
    const { install } = await renderAndSelect(NO_IDENTITY);
    expect(install.isConnected).toBe(true);
    expect(install.title).toMatch(/No Azure identity is connected/);
    // And the reason is readable without hovering - beside the button, and in
    // the section notice.
    expect(
      screen.getAllByText(/No Azure identity is connected/).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("arms the install once the config names an identity", async () => {
    const { install } = await renderAndSelect(CONNECTED);
    expect(install.disabled).toBe(false);
    expect(install.title).toBe("");
    expect(screen.queryByText(/No Azure identity is connected/)).toBeNull();
  });

  it("still previews the solution's content with no identity", async () => {
    // The gate is about INSTALLING. Reading the repo needs no Azure at all, so
    // gating the load too would have been the over-correction.
    await renderAndSelect(NO_IDENTITY);
    expect(screen.getByText(WORKBOOK)).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Load solution content",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
