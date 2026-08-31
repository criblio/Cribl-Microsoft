// @vitest-environment happy-dom
/**
 * Surface pins for the ingestion-role step (DBT-46).
 *
 * The rule being pinned is WHEN the Entra directory is read. The cloud shell
 * always binds ports.graph and numbered-section keeps every section body
 * mounted behind `hidden`, so an effect keyed only on the port read the
 * directory on every Integrate render - and, when the read was denied, painted
 * "Could not read the directory (...)" onto a page an operator had opened with
 * no credentials and asked nothing of.
 *
 * Two halves, and BOTH matter: the automatic read must not happen before a
 * deploy has produced something to grant on, and the operator-driven read must
 * still work when it does not (gating an unasked-for read is correct; removing
 * the affordance would not be).
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AzureConfig, DcrRoleTarget, ServicePrincipalRef } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { RoleAssignmentSection } from "./role-assignment-section";

afterEach(cleanup);

const CONFIG = {
  tenantId: "t",
  clientId: "11111111-1111-1111-1111-111111111111",
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
  setupPath: "existing",
} as unknown as AzureConfig;

const TARGET: DcrRoleTarget = {
  dcrResourceId:
    "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Insights/dataCollectionRules/dcr-SecurityEvent",
  table: "SecurityEvent",
};

const SPS: ServicePrincipalRef[] = [
  {
    id: "22222222-2222-2222-2222-222222222222",
    appId: "11111111-1111-1111-1111-111111111111",
    displayName: "soc-toolkit",
  },
];

/** Counts directory reads so a pin can assert the read did NOT happen. */
function makePorts(opts: { denied?: boolean } = {}) {
  let reads = 0;
  const ports = {
    graph: {
      async listServicePrincipals(): Promise<ServicePrincipalRef[]> {
        reads += 1;
        if (opts.denied === true) {
          throw new Error("Authorization_RequestDenied");
        }
        return SPS;
      },
    },
  } as unknown as UiPorts;
  return { ports, reads: () => reads };
}

function renderSection(ports: UiPorts, targets: readonly DcrRoleTarget[]) {
  return render(
    <PortsProvider ports={ports} config={CONFIG}>
      <RoleAssignmentSection targets={targets} clientId={CONFIG.clientId} />
    </PortsProvider>,
  );
}

/** Let a rejected/resolved directory read settle inside act(). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("RoleAssignmentSection directory read (DBT-46)", () => {
  it("does NOT read the directory when there is no DCR to grant on", async () => {
    const { ports, reads } = makePorts();
    renderSection(ports, []);
    await settle();
    expect(reads()).toBe(0);
  });

  it("does not paint a directory failure onto an untouched page", async () => {
    // The visible half of DBT-46: with the port bound and the read denied, the
    // ungated effect wrote "Could not read the directory (...)" under the
    // object-id field before the operator did anything at all.
    const { ports, reads } = makePorts({ denied: true });
    renderSection(ports, []);
    await settle();
    expect(reads()).toBe(0);
    expect(screen.queryByText(/Could not read the directory/)).toBeNull();
    // And the empty state is what actually shows instead.
    expect(screen.getByText(/No deployed DCRs yet/)).toBeTruthy();
  });

  it("shows no directory error - asserted with NOTHING ahead of it", async () => {
    // Review finding, 2026-08-31: the pin above asserts `reads()` BEFORE the
    // text, so vitest stops at the read count and the text assertion never
    // executes. Against the reintroduced bug it fails on the count and the
    // operator-visible symptom - the thing the card actually cites - is never
    // checked. This is the same assertion with no precondition in front of it,
    // so the rendered words are pinned on their own merits.
    const { ports } = makePorts({ denied: true });
    renderSection(ports, []);
    await settle();
    expect(screen.queryByText(/Could not read the directory/)).toBeNull();
  });

  it("reads the directory once a deploy has produced a target", async () => {
    const { ports, reads } = makePorts();
    const { container } = renderSection(ports, [TARGET]);
    await waitFor(() => {
      expect(reads()).toBe(1);
    });
    // And the read's result reaches the field: the app's own SP is preselected,
    // so the picker shows its display name rather than a placeholder.
    await waitFor(() => {
      expect(
        container.querySelector(".searchable-select-control")?.textContent,
      ).toBe("soc-toolkit");
    });
  });

  it("still reads on operator request with no targets - Reload is not removed", async () => {
    // Gating the UNASKED-FOR read must not take the affordance away: the
    // picker is still reachable before a deploy, it just waits to be asked.
    const { ports, reads } = makePorts();
    renderSection(ports, []);
    await settle();
    expect(reads()).toBe(0);
    // Located by its own text: the controls sit inside the field's <label>, so
    // every one of them inherits that label as its accessible name.
    fireEvent.click(screen.getByText("Reload"));
    await waitFor(() => {
      expect(reads()).toBe(1);
    });
  });

  it("says the directory is unread rather than inviting a selection from it", async () => {
    // An empty dropdown that says "Select a service principal..." claims the
    // tenant has none; the read simply has not happened yet.
    const { ports } = makePorts();
    const { container } = renderSection(ports, []);
    await settle();
    expect(
      container.querySelector(".searchable-select-control")?.textContent,
    ).toMatch(/not read yet/i);
  });
});
