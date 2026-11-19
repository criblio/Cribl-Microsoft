// @vitest-environment happy-dom
/**
 * AZR-141 through the real screen: a Data Receiver grant the progress
 * document records shows a Remove row in "Remove or pause what this app
 * created"; removing it forgets the record (the saved document no longer
 * holds it) and the row goes. A Cribl Event Hubs source the document records
 * refuses the removal first.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  FakeKvDocumentStore,
  FakeLogger,
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_PROGRESS_KIND,
  ONBOARDING_PROGRESS_VERSION,
  RECEIVER_GRANT_ROLE,
  receiverGrantAssignmentName,
  receiverGrantDescription,
  tenantDocumentKey,
} from "@soc/core";
import type { AzureConfig, AzureManagement, AzureManagementRequest, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureOnboardingScreen } from "./azure-onboarding-screen";

afterEach(cleanup);

const PROGRESS_KEY = tenantDocumentKey(ONBOARDING_PROGRESS_KEY, "tenant") as string;
const SUB = "sub1";
const NS_PATH = `/subscriptions/${SUB}/resourceGroups/rg1/providers/Microsoft.EventHub/namespaces/ns1`;
const HUB_ID = `${NS_PATH}/eventhubs/h1`;
const P = "0f1e2d3c-4b5a-4968-8776-655443322110";
const NAME = receiverGrantAssignmentName(HUB_ID, P);
const PATH = `${HUB_ID}/providers/Microsoft.Authorization/roleAssignments/${NAME}`;
const RECORD = { scopeId: HUB_ID, principalId: P, assignmentName: NAME };
const TITLE = `Azure Event Hubs Data Receiver for object ID ${P} on hub h1 in namespace ns1 (Azure)`;

const CONFIG = {
  tenantId: "tenant",
  clientId: "client",
  subscriptionId: SUB,
  resourceGroup: "rg1",
  workspaceName: "law-1",
  location: "eastus",
} as unknown as AzureConfig;

function progressDoc(over: Record<string, unknown> = {}): unknown {
  return {
    kind: ONBOARDING_PROGRESS_KIND,
    version: ONBOARDING_PROGRESS_VERSION,
    sources: {
      defenderExport: { chosen: false, mode: "manual" },
      activityLog: { chosen: false, mode: "manual" },
      entraId: { chosen: false, mode: "manual" },
    },
    planValues: { subscriptionId: SUB, resourceGroup: "rg1", namespace: "ns1", hubName: "h1", consumerGroup: "cribl", criblPrincipalObjectId: P },
    ticks: {},
    criblSources: {},
    workerGroup: "g1",
    receiverGrants: [RECORD],
    ...over,
  };
}

/** The recorded assignment, by name: GET and DELETE. Any other call is unexpected. */
class RoutingAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];
  present = true;
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    if (r.path === PATH && r.method === "GET") {
      return (
        this.present
          ? {
              status: 200,
              body: {
                id: PATH,
                name: NAME,
                properties: {
                  scope: HUB_ID,
                  roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${RECEIVER_GRANT_ROLE.guid}`,
                  principalId: P,
                  description: receiverGrantDescription(),
                },
              },
            }
          : { status: 404, body: {} }
      ) as unknown as PortHttpResponse;
    }
    if (r.path === PATH && r.method === "DELETE") {
      this.present = false;
      return { status: 200, body: {} } as unknown as PortHttpResponse;
    }
    // Reads the screen makes of its own accord answer 404; a write is a failure.
    if (r.method !== "GET") throw new Error(`RoutingAzure: unexpected ${r.method} ${r.path}`);
    return { status: 404, body: { error: { code: "NotFound", message: "nf" } } } as unknown as PortHttpResponse;
  }
}

function mount(store: FakeKvDocumentStore, azure: RoutingAzure) {
  const ports = { azure, logger: new FakeLogger(() => "t"), kvDocuments: store } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={CONFIG}>
      <AzureOnboardingScreen />
    </PortsProvider>,
  );
}

function teardown(): HTMLElement {
  return screen.getByRole("region", { name: "Remove or pause what this app created" });
}

describe("Data Receiver grant removal through the screen (AZR-141)", () => {
  it("offers the recorded grant, removes it by name, and forgets the record", async () => {
    const store = new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() });
    const azure = new RoutingAzure();
    mount(store, azure);
    const row = await waitFor(() => within(teardown()).getByLabelText(TITLE));
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(within(teardown()).queryByLabelText(TITLE)).toBeNull());
    expect(azure.calls.filter((c) => c.path === PATH).map((c) => c.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(azure.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
    const saved = store.saves.filter((s) => s.key === PROGRESS_KEY).at(-1)?.value as Record<string, unknown> | undefined;
    expect(saved).toBeDefined();
    expect(saved?.["receiverGrants"]).toBeUndefined();
    expect(within(teardown()).getByText(new RegExp(`assignment ${NAME} was removed`))).toBeTruthy();
  });

  it("a recorded Cribl Event Hubs source refuses the removal and keeps the record", async () => {
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc({
        criblSources: { defenderExport: { groupId: "g1", inputId: "in_eh_x", inputType: "eventhub", secretId: "sec_x" } },
      }),
    });
    const azure = new RoutingAzure();
    mount(store, azure);
    const row = await waitFor(() => within(teardown()).getByLabelText(TITLE));
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(within(row).getByRole("button", { name: "Remove anyway" })).toBeTruthy());
    expect(azure.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(within(teardown()).getByText(/^Nothing was removed\. The Cribl source in_eh_x this app created may sign in/)).toBeTruthy();
    expect(store.saves.filter((s) => s.key === PROGRESS_KEY && (s.value as Record<string, unknown>)["receiverGrants"] === undefined)).toEqual([]);
  });
});
