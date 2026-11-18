// @vitest-environment happy-dom
/**
 * AZR-103: the Data Receiver grant panel against a ROUTING AzureManagement
 * fake that records every request.
 *
 * What these pins protect:
 *   - mount spends no Azure call; the permission banner says not measured;
 *   - the hub is the default scope; Grant is two clicks; the confirm quotes
 *     scope, role and principal; the confirm sends exactly ONE PUT, at the hub,
 *     with the deterministic name, the role GUID, the principal and the stamp;
 *     only then is the record handed to the screen;
 *   - the namespace scope writes at the namespace;
 *   - a covering grant reads "Already granted" and offers no Grant button;
 *   - a blank object id with no directory is refused and nothing is written;
 *   - a 403 at the PUT is reported with the role an administrator grants, and
 *     nothing is recorded.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  FakeLogger,
  RECEIVER_GRANT_ROLE,
  defaultPlanValues,
  receiverGrantAssignmentName,
  receiverGrantDescription,
} from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  PlanValues,
  PortHttpResponse,
  ReceiverGrantRecord,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { ReceiverGrantSection } from "./receiver-grant-section";

afterEach(cleanup);

const SUB = "sub-eh";
const NS_ID = `/subscriptions/${SUB}/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1`;
const HUB_ID = `${NS_ID}/eventhubs/hub1`;
const P = "0f1e2d3c-4b5a-4968-8776-655443322110";
const RECEIVER_DEF = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${RECEIVER_GRANT_ROLE.guid}`;

const CONFIG = {
  tenantId: "aaaaaaaa-1111-4111-8111-111111111111",
  clientId: "app-client",
  subscriptionId: "sub-config",
  resourceGroup: "rg-config",
  workspaceName: "law-1",
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse => ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;

function values(over: Partial<PlanValues> = {}): PlanValues {
  return {
    ...defaultPlanValues({ subscriptionId: SUB, resourceGroup: "rg-eh" }),
    namespace: "ns1",
    hubName: "hub1",
    criblPrincipalObjectId: P,
    ...over,
  };
}

class RoutingAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];
  private readonly existing: unknown[];
  private readonly putAnswer: PortHttpResponse | null;
  constructor(existing: unknown[] = [], putAnswer: PortHttpResponse | null = null) {
    this.existing = existing;
    this.putAnswer = putAnswer;
  }
  writes(): AzureManagementRequest[] {
    return this.calls.filter((c) => c.method !== "GET");
  }
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    if (r.method === "GET" && r.path.endsWith("/providers/Microsoft.Authorization/roleAssignments")) {
      return ok({ value: this.existing });
    }
    if (r.method === "PUT" && r.path.includes("/providers/Microsoft.Authorization/roleAssignments/")) {
      if (this.putAnswer !== null) return this.putAnswer;
      const name = r.path.split("/").pop() ?? "";
      const scope = r.path.slice(0, r.path.indexOf("/providers/Microsoft.Authorization/"));
      const props = (r.body as { properties: Record<string, unknown> }).properties;
      this.existing.push({ id: r.path, name, properties: { ...props, scope } });
      return { status: 201, body: {} } as unknown as PortHttpResponse;
    }
    if (r.method === "GET" && r.path.includes("/providers/Microsoft.Authorization/roleAssignments/")) {
      const found = this.existing.find((a) => (a as { id: string }).id === r.path);
      return found === undefined ? ({ status: 404, body: {} } as unknown as PortHttpResponse) : ok(found);
    }
    throw new Error(`RoutingAzure: unrouted ${r.method} ${r.path}`);
  }
}

function mount(azure: RoutingAzure, v: PlanValues = values()) {
  const ports = { azure, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  const recorded: ReceiverGrantRecord[] = [];
  render(
    <PortsProvider ports={ports} config={CONFIG}>
      <ReceiverGrantSection
        values={v}
        readSeq={0}
        records={[]}
        onGranted={(r) => {
          recorded.push(r);
          return true;
        }}
        howtoSection={2}
        onShowHowto={() => undefined}
      />
    </PortsProvider>,
  );
  return { recorded, block: screen.getByTestId("azo-receiver-grant") };
}

async function check(block: HTMLElement): Promise<void> {
  fireEvent.click(within(block).getByRole("button", { name: "Check the grant" }));
  await waitFor(() => expect(within(block).queryByRole("button", { name: "Checking the grant..." })).toBeNull());
}

describe("ReceiverGrantSection (AZR-103)", () => {
  it("grants at the hub by default, after two clicks, with exactly one PUT, and hands over the record", async () => {
    const azure = new RoutingAzure();
    const { recorded, block } = mount(azure);
    expect(azure.calls).toHaveLength(0);
    expect(within(block).getByTestId("azo-permission-banner").getAttribute("data-kind")).toBe("not-measured");
    const hubRadio = within(block).getByRole("radio", { name: /^The hub hub1/ }) as HTMLInputElement;
    expect(hubRadio.checked).toBe(true);

    await check(block);
    expect(azure.writes()).toHaveLength(0);
    const name = receiverGrantAssignmentName(HUB_ID, P);
    expect(within(block).getByText(`Scope: ${HUB_ID}`)).toBeTruthy();
    expect(within(block).getByText(`Assignment name: ${name}`)).toBeTruthy();

    fireEvent.click(within(block).getByRole("button", { name: "Grant Data Receiver" }));
    expect(azure.writes()).toHaveLength(0);
    const confirm = within(block).getByRole("group", { name: "Confirm the Data Receiver grant" });
    expect(confirm.textContent).toContain(`to the service principal object ID ${P}`);
    expect(confirm.textContent).toContain(`scope ${HUB_ID}?`);
    expect(confirm.textContent).toContain(`role definition ${RECEIVER_GRANT_ROLE.guid}`);

    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm grant" }));
    await waitFor(() => expect(within(block).getByText(/The role assignment was created and read back from Azure/)).toBeTruthy());
    const writes = azure.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`${HUB_ID}/providers/Microsoft.Authorization/roleAssignments/${name}`);
    expect(writes[0]?.body).toEqual({
      properties: {
        roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${RECEIVER_GRANT_ROLE.guid}`,
        principalId: P,
        principalType: "ServicePrincipal",
        description: receiverGrantDescription(),
      },
    });
    expect(recorded).toEqual([{ scopeId: HUB_ID, principalId: P, assignmentName: name }]);
  });

  it("writes at the namespace when the operator chooses it", async () => {
    const azure = new RoutingAzure();
    const { recorded, block } = mount(azure);
    fireEvent.click(within(block).getByRole("radio", { name: /^The namespace ns1/ }));
    await check(block);
    fireEvent.click(within(block).getByRole("button", { name: "Grant Data Receiver" }));
    fireEvent.click(within(block).getByRole("button", { name: "Confirm grant" }));
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(azure.writes().map((w) => w.path)).toEqual([
      `${NS_ID}/providers/Microsoft.Authorization/roleAssignments/${receiverGrantAssignmentName(NS_ID, P)}`,
    ]);
    expect(recorded[0]?.scopeId).toBe(NS_ID);
  });

  it("reads a covering grant as already granted and offers nothing to write", async () => {
    const azure = new RoutingAzure([
      {
        id: `${NS_ID}/providers/Microsoft.Authorization/roleAssignments/x`,
        name: "x",
        properties: { scope: NS_ID, roleDefinitionId: RECEIVER_DEF, principalId: P },
      },
    ]);
    const { recorded, block } = mount(azure);
    await check(block);
    expect(within(block).getByText(/^Already granted: the principal holds Azure Event Hubs Data Receiver at /)).toBeTruthy();
    expect(within(block).queryByRole("button", { name: "Grant Data Receiver" })).toBeNull();
    expect(azure.writes()).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("refuses a blank object id it cannot look up, and writes nothing", async () => {
    const azure = new RoutingAzure();
    const { block } = mount(azure, values({ criblPrincipalObjectId: "", criblClientId: "cribl-client" }));
    await check(block);
    expect(within(block).getByText(/^Nothing can be granted yet\. The object ID of client ID cribl-client could not be looked up/)).toBeTruthy();
    expect(within(block).queryByRole("button", { name: "Grant Data Receiver" })).toBeNull();
    expect(azure.calls).toHaveLength(0);
  });

  it("reports a refused PUT with the role an administrator grants, and records nothing", async () => {
    const azure = new RoutingAzure([], {
      status: 403,
      body: { error: { code: "AuthorizationFailed", message: "no write" } },
    } as unknown as PortHttpResponse);
    const { recorded, block } = mount(azure);
    await check(block);
    fireEvent.click(within(block).getByRole("button", { name: "Grant Data Receiver" }));
    fireEvent.click(within(block).getByRole("button", { name: "Confirm grant" }));
    await waitFor(() => expect(within(block).getByText(/^The grant stopped: /)).toBeTruthy());
    expect(within(block).getByText(/^The grant stopped: /).textContent).toContain("RBAC Administrator");
    expect(azure.writes()).toHaveLength(1);
    expect(recorded).toHaveLength(0);
  });
});
