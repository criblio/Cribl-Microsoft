// @vitest-environment happy-dom
/**
 * AZR-141: removing the Data Receiver assignment the app granted, from the
 * teardown panel, against a ROUTING AzureManagement fake that records every
 * request.
 *
 * What these pins protect:
 *   - mount spends no Azure call; a row per record; Remove is two clicks and
 *     the confirm quotes the exact DELETE, the scope, the role and the
 *     principal; the confirm sends GET, DELETE, GET - by name - and reports
 *     `removed` so the screen forgets the record;
 *   - a recorded Cribl Event Hubs source refuses the removal after the GET
 *     alone; "Remove anyway" arms a SECOND, differently worded confirm that
 *     names the sources, and only its confirm sends the DELETE;
 *   - an unreadable GET sends no DELETE and says the record is kept;
 *   - a running grant turns Remove off; a running Remove is reported.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FakeLogger, RECEIVER_GRANT_ROLE, receiverGrantAssignmentName, receiverGrantDescription } from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  PortHttpResponse,
  ReceiverGrantRecord,
  ReceiverGrantRemoveOutcome,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { ReceiverGrantRemovePanel } from "./receiver-grant-remove-panel";

afterEach(cleanup);

const SUB = "sub-eh";
const NS_ID = `/subscriptions/${SUB}/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1`;
const HUB_ID = `${NS_ID}/eventhubs/hub1`;
const P = "0f1e2d3c-4b5a-4968-8776-655443322110";
const NAME = receiverGrantAssignmentName(HUB_ID, P);
const PATH = `${HUB_ID}/providers/Microsoft.Authorization/roleAssignments/${NAME}`;
const RECORD: ReceiverGrantRecord = { scopeId: HUB_ID, principalId: P, assignmentName: NAME };
const TITLE = `Azure Event Hubs Data Receiver for object ID ${P} on hub hub1 in namespace ns1 (Azure)`;

const CONFIG = { tenantId: "t", clientId: "app-client", subscriptionId: "sub-config" } as unknown as AzureConfig;

const ASSIGNMENT = {
  id: PATH,
  name: NAME,
  properties: {
    scope: HUB_ID,
    roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${RECEIVER_GRANT_ROLE.guid}`,
    principalId: P,
    description: receiverGrantDescription(),
  },
};

class RoutingAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];
  present = true;
  readStatus = 200;
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    if (r.path !== PATH) throw new Error(`RoutingAzure: unrouted ${r.method} ${r.path}`);
    if (r.method === "GET") {
      if (this.readStatus !== 200) return { status: this.readStatus, body: { error: { code: "AuthorizationFailed", message: "no" } } } as unknown as PortHttpResponse;
      return (this.present ? { status: 200, body: ASSIGNMENT } : { status: 404, body: {} }) as unknown as PortHttpResponse;
    }
    if (r.method === "DELETE") {
      this.present = false;
      return { status: 200, body: {} } as unknown as PortHttpResponse;
    }
    throw new Error(`RoutingAzure: unrouted ${r.method} ${r.path}`);
  }
}

function mount(azure: RoutingAzure, opts: { inUseBy?: string[]; granting?: boolean } = {}) {
  const ports = { azure, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  const outcomes: ReceiverGrantRemoveOutcome[] = [];
  const running: boolean[] = [];
  render(
    <PortsProvider ports={ports} config={CONFIG}>
      <ReceiverGrantRemovePanel
        records={[RECORD]}
        inUseBy={opts.inUseBy ?? []}
        granting={opts.granting ?? false}
        onRunningChange={(r) => running.push(r)}
        onRemoved={(o) => outcomes.push(o)}
      />
    </PortsProvider>,
  );
  return { outcomes, running, row: screen.getByLabelText(TITLE) };
}

describe("ReceiverGrantRemovePanel (AZR-141)", () => {
  it("removes by name after two clicks, quoting the DELETE, scope, role and principal", async () => {
    const azure = new RoutingAzure();
    const { outcomes, running, row } = mount(azure);
    expect(azure.calls).toHaveLength(0);
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    expect(azure.calls).toHaveLength(0);
    const confirm = within(row).getByRole("group", { name: `Confirm removal of ${TITLE}` });
    expect(confirm.textContent).toContain(
      `Remove the role Azure Event Hubs Data Receiver (role definition ${RECEIVER_GRANT_ROLE.guid}) from the service principal ` +
        `with object ID ${P}, at scope ${HUB_ID}? Remove sends DELETE ${PATH}?api-version=2022-04-01 - `,
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(outcomes).toHaveLength(1));
    expect(azure.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${PATH}`, `DELETE ${PATH}`, `GET ${PATH}`]);
    expect(outcomes[0]).toEqual({ kind: "removed", record: RECORD });
    expect(running).toEqual([true, false]);
    expect(screen.getByText(new RegExp(`assignment ${NAME} was removed, and Azure no longer returns it`))).toBeTruthy();
  });

  it("refuses while a recorded source may read with it; only the second confirm sends the DELETE", async () => {
    const azure = new RoutingAzure();
    const { outcomes, row } = mount(azure, { inUseBy: ["in_eh_tenant_ns1_hub1"] });
    expect(within(row).queryByRole("button", { name: "Remove anyway" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]?.kind).toBe("in-use");
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);

    fireEvent.click(within(row).getByRole("button", { name: "Remove anyway" }));
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
    const second = within(row).getByRole("group", { name: `Confirm removal of ${TITLE} while in use` });
    expect(second.textContent).toContain(
      `Remove it anyway? The Cribl source in_eh_tenant_ns1_hub1 this app created is still recorded and may sign in with Entra ID as object ID ${P}. ` +
        `Once the assignment is gone, Azure refuses its reads at ${HUB_ID} and it stops receiving events.`,
    );
    fireEvent.click(within(second).getByRole("button", { name: "Confirm: remove although in use" }));
    await waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toEqual({ kind: "removed", record: RECORD });
    expect(azure.calls.map((c) => c.method)).toEqual(["GET", "GET", "DELETE", "GET"]);
  });

  it("an unreadable assignment sends no DELETE and says the record is kept", async () => {
    const azure = new RoutingAzure();
    azure.readStatus = 403;
    const { outcomes, row } = mount(azure);
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]?.kind).toBe("denied");
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(screen.getByText(/The record is kept, so Remove stays offered\./)).toBeTruthy();
  });

  it("is off while a grant runs, with the reason, and sends nothing", () => {
    const azure = new RoutingAzure();
    const { row } = mount(azure, { granting: true });
    const remove = within(row).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(within(row).getByText("A Data Receiver grant is running. Remove is off until it finishes.")).toBeTruthy();
    fireEvent.click(remove);
    expect(within(row).queryByRole("group")).toBeNull();
    expect(azure.calls).toHaveLength(0);
  });

  it("shows the unmeasured delete permission as a note, never a block", () => {
    const { row } = mount(new RoutingAzure());
    expect(
      within(row).getByText(
        "Needs Microsoft.Authorization/roleAssignments/delete on the hub or namespace, not yet measured; RBAC Administrator holds it. " +
          "If it is missing, Azure's refusal is shown here.",
      ),
    ).toBeTruthy();
    expect((within(row).getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
