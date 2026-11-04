// @vitest-environment happy-dom
/**
 * DBT-246, DBT-238, DBT-240, DBT-242, DBT-243: the wizard and Setup page trim.
 *
 * Pins, on a REAL AzureConnectSection and AzureResourcesSection inside the
 * wizard (not stubs), that:
 *  - the cloud GitHub step is not labelled optional (the token is required),
 *  - Next on that step still works with a token already stored,
 *  - the Connect Azure step renders exactly one change-request generator,
 *  - the connectivity choice sits above the connect section,
 *  - no rendered text points at a "section on Setup" or a "connection bar
 *    above" that is not there,
 *  - the storage, write-only and discovery explanations render only inside an
 *    InfoTip.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AzureConfig, ChangeRequestContext } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureConnectSection } from "./azure-connect-section";
import { AzureResourcesSection } from "./azure-resources-section";
import { SetupWizard } from "./setup-wizard";

afterEach(cleanup);

const CONFIG = {
  clientId: "00000000-0000-0000-0000-000000000000",
  tenantId: "11111111-1111-1111-1111-111111111111",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
  connectivity: "full",
  allowedPermissions: [],
} as unknown as AzureConfig;
const CTX: ChangeRequestContext = { appName: "test", config: CONFIG };

const STORAGE_NOTE =
  "Save and connect combines the client secret with the client ID and writes it to the " +
  "encrypted, write-only KV entry azureBasic. The client ID is non-secret configuration.";

function ports(hasPat: boolean): UiPorts {
  return {
    azure: { request: () => new Promise(() => undefined) },
    githubPat: {
      status: vi.fn(async () => ({ hasPat })),
      validateAndStore: vi.fn(),
      clear: vi.fn(),
    },
    content: { getCommitSha: vi.fn(), listSolutions: vi.fn(async () => []) },
  } as unknown as UiPorts;
}

async function renderWizard(hasPat = false) {
  await act(async () => {
    render(
      <PortsProvider ports={ports(hasPat)} config={CONFIG}>
        <SetupWizard
          capabilities={{ hasCribl: true, hasAzure: true }}
          contentPlatform="cloud"
          initialTarget="cribl-hosted"
          lockTarget
          installedInLeader
          onGetStarted={() => {}}
          azureConnectivitySection={<div data-testid="connectivity-slot">connectivity</div>}
          azureConnectSection={
            <AzureConnectSection
              tenantId={CONFIG.tenantId}
              onTenantIdChange={() => {}}
              clientId={CONFIG.clientId}
              onClientIdChange={() => {}}
              setupPath="existing"
              onSetupPathChange={() => {}}
              secretLive={false}
              ctx={CTX}
              onConnect={async () => ({ ok: true, secretStored: true, message: "ok" })}
              storageNote={STORAGE_NOTE}
            />
          }
          azureResourcesSection={
            <AzureResourcesSection
              clientId={CONFIG.clientId}
              tenantId={CONFIG.tenantId}
              setupPath="existing"
              subscriptionId=""
              onSubscriptionIdChange={() => {}}
              rgName=""
              onRgNameChange={() => {}}
              workspaceName=""
              onWorkspaceNameChange={() => {}}
              connectNonce={0}
              ctx={CTX}
              storageContextLabel="test"
            />
          }
        />
      </PortsProvider>,
    );
  });
}

function next() {
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
}

describe("wizard GitHub step on the cloud shell (DBT-238)", () => {
  it("is not labelled optional, because the cloud token is required", async () => {
    await renderWizard();
    expect(screen.getByRole("heading", { name: "Connect GitHub content" })).toBeTruthy();
    expect(screen.queryByText(/this step is optional/i)).toBeNull();
  });

  it("still advances with Next when a token is already stored", async () => {
    await renderWizard(true);
    await act(async () => {
      next();
    });
    expect(screen.getByRole("heading", { name: /^connect azure$/i })).toBeTruthy();
  });

  it("goes straight from Azure to Get Started (no Check permissions step)", async () => {
    await renderWizard();
    next();
    expect(screen.queryByRole("heading", { name: /check permissions/i })).toBeNull();
    expect(screen.getByRole("button", { name: /get started/i })).toBeTruthy();
  });
});

describe("wizard Connect Azure step (DBT-240, DBT-242, DBT-243)", () => {
  it("renders exactly one APP-REGISTRATION change request (the wizard's own is gone)", async () => {
    await renderWizard();
    next();
    // The resources section's role-assignment and resource-creation tickets are
    // different tickets and stay; the duplicate was the wizard's own copy of
    // the app-registration one.
    const titles = screen
      .getAllByText(/generate a change request/i)
      .map((t) => t.textContent ?? "");
    expect(titles.filter((t) => /app registration/i.test(t))).toHaveLength(1);
    expect(titles).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /generate change request/i })).toHaveLength(3);
  });

  it("puts the connectivity choice above the connect section", async () => {
    await renderWizard();
    next();
    const connectivity = screen.getByTestId("connectivity-slot");
    const connect = screen.getByRole("heading", { name: /app registration and connect/i });
    expect(
      connectivity.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("points at no section on Setup and no connection bar above", async () => {
    await renderWizard();
    next();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/section on Setup/i);
    expect(text).not.toMatch(/connection bar above/i);
  });

  it("shows the storage, write-only and discovery explanations only inside an InfoTip", async () => {
    await renderWizard();
    next();
    for (const phrase of [
      /encrypted, write-only KV entry/,
      /write-only/,
      /Discovery runs automatically/,
    ]) {
      const hits = Array.from(document.querySelectorAll("p, span, pre, div")).filter(
        (el) =>
          Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && phrase.test(n.textContent ?? ""),
          ),
      );
      expect(hits.length, String(phrase)).toBeGreaterThan(0);
      for (const el of hits) {
        expect(el.closest('[role="tooltip"]'), String(phrase)).not.toBeNull();
      }
    }
  });
});

describe("connect section under other connectivity choices (review fixes)", () => {
  function renderConnect(connectivity: string, allowedPermissions: string[] = []) {
    const config = { ...CONFIG, connectivity, allowedPermissions } as unknown as AzureConfig;
    return render(
      <PortsProvider ports={ports(false)} config={config}>
        <AzureConnectSection
          tenantId=""
          onTenantIdChange={() => {}}
          clientId=""
          onClientIdChange={() => {}}
          setupPath="existing"
          onSetupPathChange={() => {}}
          secretLive={false}
          ctx={{ appName: "test", config }}
          onConnect={async () => ({ ok: true, secretStored: false, message: "" })}
          storageNote="note"
        />
      </PortsProvider>,
    );
  }

  it("ticket line says nothing selected for Partial with nothing ticked", () => {
    renderConnect("partial");
    expect(screen.getByText(/asking for the app registration and a client secret\./)).toBeTruthy();
  });

  it("ticket line names the requested role for Partial with Reader", () => {
    renderConnect("partial", ["Reader"]);
    expect(screen.getByText(/plus .*Reader/)).toBeTruthy();
  });

  it("shows the setup-path notes under Full only", () => {
    const { unmount } = renderConnect("full");
    expect(screen.queryByLabelText("About this setup path")).not.toBeNull();
    unmount();
    renderConnect("partial");
    expect(screen.queryByLabelText("About this setup path")).toBeNull();
    expect(document.querySelector(".path-options")).toBeNull();
  });
});
