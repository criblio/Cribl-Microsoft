// @vitest-environment happy-dom
/**
 * Screen pins for the Azure Logging Map (AZR-19): the read driven through the
 * ports, the words for what was not read, and the run token that stands in
 * for an abort the port does not have.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AzureConfig } from "@soc/core";

import { PortsProvider, type UiPorts } from "../../ports-context";
import { AzureLoggingMapScreen } from "./azure-logging-map-screen";
import { SUB_A, TENANT, makeFixtureAzure, type FixtureOptions } from "./logging-map-test-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CONFIG = {
  tenantId: TENANT,
  clientId: "client",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  location: "",
} as unknown as AzureConfig;

function mount(opts: FixtureOptions = {}, config: AzureConfig = CONFIG) {
  const azure = makeFixtureAzure(opts);
  const ports = { azure: azure.port } as unknown as UiPorts;
  const utils = render(
    <PortsProvider ports={ports} config={config}>
      <AzureLoggingMapScreen />
    </PortsProvider>,
  );
  return { azure, ...utils };
}

async function readMap(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Read the logging map" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Read again" })).toBeTruthy());
}

function count(id: string): string | null | undefined {
  return document.querySelector(`[data-lm-count="${id}"] .lm-count-value`)?.textContent;
}

describe("AzureLoggingMapScreen - what was not read", () => {
  it("a refused Tenant Root names it in the banner, with the role, and counts exactly 1 refusal", async () => {
    mount({ rootRefused: true });
    await readMap();
    const banner = document.querySelector("[data-lm-banner]");
    expect(banner?.textContent).toContain("The Tenant Root Group could not be read");
    expect(banner?.textContent).toContain("Management Group Reader at the Tenant Root Group");
    expect(count("could-not-read")).toBe("1");
  });

  it("a readable Tenant Root draws no banner and counts 0 refusals", async () => {
    mount();
    await readMap();
    expect(document.querySelector("[data-lm-banner]")).toBeNull();
    expect(count("could-not-read")).toBe("0");
  });

  it("a refused subscription renders the dashed card and never 'No assignments'", async () => {
    mount({ assignmentsRefused: [SUB_A] });
    await readMap();
    const card = document.querySelector(`[data-lm-card="${SUB_A}"]`);
    expect(card?.getAttribute("class")).toContain("is-unread");
    fireEvent.click(card as Element);
    expect(card?.getAttribute("aria-pressed")).toBe("true");
    const panel = document.querySelector(".lm-panel")?.textContent ?? "";
    expect(panel).toContain("Assignments could not be read.");
    expect(panel).not.toMatch(/No assignments|Nothing is assigned/);
    expect(count("could-not-read")).toBe("1");
  });

  it("a blank tenant id is stated in words before any read", () => {
    mount({}, { ...CONFIG, tenantId: "" });
    expect(document.querySelector("[data-lm-no-tenant]")?.textContent).toContain(
      "No tenant id is set for this connection",
    );
  });
});

describe("AzureLoggingMapScreen - the run token", () => {
  it("unmounting mid-read drops the result, logs nothing, and stops further requests", async () => {
    const errors = vi.spyOn(console, "error");
    const { azure, unmount } = mount({ hold: true });
    fireEvent.click(screen.getByRole("button", { name: "Read the logging map" }));
    await waitFor(() => expect(azure.calls.length).toBe(1));
    unmount();
    // Let the held request answer, and give the abandoned run every chance to continue.
    await act(async () => {
      azure.release();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    azure.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The retired run's later requests are refused locally: nothing more reaches the port.
    expect(azure.calls.length).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("shows progress as 'Read N of M' while reading", async () => {
    const { azure } = mount({ hold: true });
    fireEvent.click(screen.getByRole("button", { name: "Read the logging map" }));
    await waitFor(() => expect(azure.calls.length).toBe(1));
    await act(async () => {
      azure.release();
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Read \d+ of \d+: /));
    expect((screen.getByRole("button", { name: "Read the logging map" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a connection change retires the run in flight: its late progress and result never overwrite the new run", async () => {
    const oldAzure = makeFixtureAzure({ hold: true });
    const newAzure = makeFixtureAzure({ rootRefused: true });
    const tree = (azure: typeof oldAzure) => (
      <PortsProvider ports={{ azure: azure.port } as unknown as UiPorts} config={CONFIG}>
        <AzureLoggingMapScreen />
      </PortsProvider>
    );
    const { rerender } = render(tree(oldAzure));
    fireEvent.click(screen.getByRole("button", { name: "Read the logging map" }));
    await waitFor(() => expect(oldAzure.calls.length).toBe(1));
    // The connection changes mid-read: the screen returns to idle, ready for a new read.
    rerender(tree(newAzure));
    await readMap();
    expect(count("could-not-read")).toBe("1");
    // Now let the retired run answer and run to its end.
    await act(async () => {
      oldAzure.release();
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(/^Read \d+ of \d+: /)).toBeNull();
    expect(document.querySelector(".lm-progress")).toBeNull();
    expect((screen.getByRole("button", { name: "Read again" }) as HTMLButtonElement).disabled).toBe(false);
    expect(count("could-not-read")).toBe("1");
    expect(document.querySelector("[data-lm-banner]")?.textContent).toContain("The Tenant Root Group could not be read");
  });

  it("a connection change with no new read leaves the screen idle: the retired run never lands its old map", async () => {
    const oldAzure = makeFixtureAzure({ hold: true });
    const newAzure = makeFixtureAzure();
    const tree = (azure: typeof oldAzure) => (
      <PortsProvider ports={{ azure: azure.port } as unknown as UiPorts} config={CONFIG}>
        <AzureLoggingMapScreen />
      </PortsProvider>
    );
    const { rerender } = render(tree(oldAzure));
    fireEvent.click(screen.getByRole("button", { name: "Read the logging map" }));
    await waitFor(() => expect(oldAzure.calls.length).toBe(1));
    rerender(tree(newAzure));
    await act(async () => {
      oldAzure.release();
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(oldAzure.calls.length).toBe(1);
    expect(newAzure.calls.length).toBe(0);
    expect((screen.getByRole("button", { name: "Read the logging map" }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector("[data-lm-card]")).toBeNull();
    expect(document.querySelector(".lm-progress")).toBeNull();
  });
});
