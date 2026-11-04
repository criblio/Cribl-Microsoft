// @vitest-environment happy-dom
/**
 * DBT-248: a failure inside the resources section reaches the operator even
 * when the section is folded. Two paths set no failure flag before: the
 * "Re-check and validate permissions" run and the dependent workspace /
 * resource-group listing that follows picking a subscription. Both now report
 * through useSectionRunState, so a false -> true edge reopens a folded section.
 * (The Discover run itself already did, via the runner status.)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AzureConfig, ChangeRequestContext } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { SectionFoldScope } from "../../components/section-folding/section-fold-scope";
import { useFoldScopeFolding } from "../../components/section-folding/use-fold-scope-folding";
import { AzureResourcesSection } from "./azure-resources-section";

afterEach(cleanup);

const CONFIG: AzureConfig = {
  clientId: "00000000-0000-0000-0000-000000000000",
  tenantId: "11111111-1111-1111-1111-111111111111",
  subscriptionId: "22222222-2222-2222-2222-222222222222",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
  connectivity: "full",
  allowedPermissions: ["Reader"],
};
const CTX: ChangeRequestContext = { appName: "test", config: CONFIG };

function Page() {
  const { folding, setBusy } = useFoldScopeFolding({
    ids: ["azure-resources"],
    currentId: undefined,
    pinPrefix: "test-pins",
  });
  return (
    <SectionFoldScope folding={folding} setBusy={setBusy}>
      <AzureResourcesSection
        clientId={CONFIG.clientId}
        tenantId={CONFIG.tenantId}
        setupPath="existing"
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
    </SectionFoldScope>
  );
}

function mount(ports: Partial<UiPorts>) {
  return render(
    <PortsProvider ports={ports as UiPorts} config={CONFIG}>
      <Page />
    </PortsProvider>,
  );
}

const section = () =>
  screen
    .getByRole("heading", { name: "Select resources and grant permissions" })
    .closest("section") as HTMLElement;
const folded = () => section().classList.contains("numbered-section-collapsed");

describe("resources section failures reopen it", () => {
  it("a failed Re-check and validate permissions run", async () => {
    // No secrets port: building the stored-credentials report throws.
    mount({ azure: { request: () => new Promise(() => undefined) } } as unknown as Partial<UiPorts>);
    await waitFor(() => expect(folded()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Re-check and validate permissions", hidden: true }));
    await waitFor(() => expect(folded()).toBe(false));
  });

  it("a failed workspace and resource-group listing after Discover", async () => {
    const request = vi.fn(async ({ path }: { path: string }) =>
      path === "/subscriptions"
        ? {
            status: 200,
            body: { value: [{ subscriptionId: CONFIG.subscriptionId, displayName: "Prod" }] },
          }
        : { status: 403, body: {} },
    );
    mount({
      azure: { request },
      secrets: { list: async () => [] },
    } as unknown as Partial<UiPorts>);
    await waitFor(() => expect(folded()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Discover / refresh from Azure", hidden: true }));
    await waitFor(() => expect(folded()).toBe(false));
  });

  it("a discovery failure reopens the section after an earlier Re-check failure left its flag set", async () => {
    // No secrets port: Re-check fails and its flag stays true. A later,
    // different failure (Discover rejects) must still be a failure edge.
    mount({ azure: { request: () => Promise.reject(new Error("boom")) } } as unknown as Partial<UiPorts>);
    await waitFor(() => expect(folded()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Re-check and validate permissions", hidden: true }));
    await waitFor(() => expect(folded()).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Select resources and grant permissions" }));
    await waitFor(() => expect(folded()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Discover / refresh from Azure", hidden: true }));
    await waitFor(() => expect(folded()).toBe(false));
  });

  it("stays folded when the listing succeeds", async () => {
    const request = vi.fn(async ({ path }: { path: string }) =>
      path === "/subscriptions"
        ? {
            status: 200,
            body: { value: [{ subscriptionId: CONFIG.subscriptionId, displayName: "Prod" }] },
          }
        : { status: 200, body: { value: [] } },
    );
    mount({
      azure: { request },
      secrets: { list: async () => [] },
    } as unknown as Partial<UiPorts>);
    await waitFor(() => expect(folded()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Discover / refresh from Azure", hidden: true }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(folded()).toBe(true);
  });
});

describe("resources section change-request descriptions (DBT-248 live check)", () => {
  const TIPS: ReadonlyArray<[string, RegExp]> = [
    ["Cannot assign roles yourself? Generate a change request", /human-readable companion to the az CLI script/],
    ["Need a resource group or Event Hub created? Generate a change request", /paste-ready ticket asking for the Azure resources/],
  ];
  it.each(TIPS)("%s: the paragraph is behind its InfoTip, the heading and button stay", async (title, text) => {
    mount({ azure: { request: () => new Promise(() => undefined) } } as unknown as Partial<UiPorts>);
    await waitFor(() => expect(folded()).toBe(true));
    expect(screen.queryAllByText(text, { selector: "p" })).toHaveLength(0);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Generate change request", hidden: true }).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: `About ${title}`, hidden: true }));
    expect(
      screen.getAllByRole("tooltip", { hidden: true }).some((t) => text.test(t.textContent ?? "")),
    ).toBe(true);
  });
});
