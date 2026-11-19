// @vitest-environment happy-dom
/**
 * AZR-147 review round 1: a switch from All tenants is REFUSED while a change
 * on the page below is running, for that change's whole run - including the
 * stretch between two of its requests, which the shell's credential slot
 * cannot see (it counts a write only while its request is in flight).
 *
 * The onboarding screen is replaced by a stub that reports a running change
 * through the same hook every real write flow uses (operation-busy.ts); that
 * the real flows report themselves is pinned in activity-log-section's tests.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CREDENTIAL_LEASE_KEY, FakeKvDocumentStore, FakeLogger, GAP_SOURCES } from "@soc/core";
import type { AzureConfig, BatchPacing } from "@soc/core";
import { PortsProvider } from "../../../ports-context";
import type { UiPorts } from "../../../ports-context";
import { TenantGapCache } from "../../tenant-gap/tenant-gap-state";
import { AzureOnboardingPage } from "./azure-onboarding-page";
import { switchRefusedOperation } from "./tenant-switch";

vi.mock("../azure-onboarding-screen", async () => {
  const { useReportBusy } = await import("../operation-busy");
  function StubScreen() {
    const [running, setRunning] = useState(false);
    useReportBusy("an Activity Log diagnostic setting deploy", running);
    return (
      <button type="button" onClick={() => setRunning((r) => !r)}>
        {running ? "Finish the stub deploy" : "Start the stub deploy"}
      </button>
    );
  }
  return { AzureOnboardingScreen: StubScreen };
});

afterEach(cleanup);

const TA = "aaaaaaaa-0000-0000-0000-000000000001";
const TB = "bbbbbbbb-0000-0000-0000-000000000002";
const PROFILES = [
  { id: "pa", name: "Contoso", config: { tenantId: TA, clientId: "ca", subscriptionId: "sub-a", resourceGroup: "rg" } },
  { id: "pb", name: "Fabrikam", config: { tenantId: TB, clientId: "cb", subscriptionId: "sub-b", resourceGroup: "rg" } },
];
const PACING: BatchPacing = { now: () => 0, sleep: () => Promise.resolve() };
const SOURCE = GAP_SOURCES[0]!;

function mount() {
  const store = new FakeKvDocumentStore();
  const switched: string[] = [];
  const ports = { kvDocuments: store, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={{ tenantId: TA } as unknown as AzureConfig}>
      <AzureOnboardingPage
        profiles={PROFILES}
        activeProfileId="pa"
        tenantGapCache={new TenantGapCache()}
        onSwitchConnection={(id) => switched.push(id)}
        slotBusyReason={() => null}
        leaseHolderId="this-tab"
        pacing={PACING}
        now={() => 0}
      />
    </PortsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show all tenants" }));
  return { store, switched };
}

describe("a change running on the page refuses the switch (review round 1)", () => {
  it("refuses with the change's own words while the slot reports idle, and switches once it has finished", async () => {
    const { store, switched } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Start the stub deploy" }));
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${SOURCE.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Not switched: an Activity Log diagnostic setting deploy is running on this page, and switching now would cut it off part-way. Wait for it to finish, then try again.",
        ).getAttribute("role"),
      ).toBe("alert"),
    );
    expect(switchRefusedOperation("x")).toBe(
      "Not switched: x is running on this page, and switching now would cut it off part-way. Wait for it to finish, then try again.",
    );
    expect(switched).toEqual([]);
    // Refused before the lease was read.
    expect(store.loads.filter((k) => k === CREDENTIAL_LEASE_KEY)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Finish the stub deploy" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() => expect(switched).toEqual(["pb"]));
  });
});
