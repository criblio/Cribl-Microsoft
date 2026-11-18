// @vitest-environment happy-dom
/**
 * AZR-36: the Listen rule and consumer group panel, and its Remove rows.
 * What these pins protect:
 *   - mounting calls nothing;
 *   - Check sends GETs only, and the confirm quotes each PUT exactly;
 *   - only the confirm click writes, and only the PUT it quoted;
 *   - a change to what the confirm names drops it (no write);
 *   - an existing group is reused: no confirm, no PUT;
 *   - Remove quotes the DELETE, and a recorded Cribl source keeps the object.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CONSUMER_GROUP_STAMP, FakeLogger, consumerGroupRecord } from "@soc/core";
import type { AzureConfig, AzureManagement, AzureManagementRequest, ListenAccessApplyResult, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../../ports-context";
import type { UiPorts } from "../../../ports-context";
import { ListenAccessPanel } from "./listen-access-panel";
import { ListenAccessRemovePanel } from "./listen-access-remove-panel";

afterEach(cleanup);

const NS = { subscriptionId: "sub-1", resourceGroup: "rg-eh", name: "ns1" };
const NS_PATH = "/subscriptions/sub-1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1";
const RULE = `${NS_PATH}/authorizationRules/cribl-listen`;
const CG = `${NS_PATH}/eventhubs/hub-a/consumergroups/cribl`;
const CONFIG = { tenantId: "t", clientId: "c", subscriptionId: "sub-1", resourceGroup: "rg" } as unknown as AzureConfig;

const res = (status: number, body: unknown): PortHttpResponse => ({ ok: status < 300, status, body }) as unknown as PortHttpResponse;

/** A namespace whose objects are a map by path; PUT adds, DELETE removes. */
class NamespaceAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];
  readonly objects: Map<string, unknown>;
  constructor(objects: Map<string, unknown> = new Map()) {
    this.objects = objects;
  }
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    if (r.method === "GET") return this.objects.has(r.path) ? res(200, this.objects.get(r.path)) : res(404, {});
    if (r.method === "PUT") {
      this.objects.set(r.path, { name: r.path.split("/").pop(), ...(r.body as object) });
      return res(200, {});
    }
    if (r.method === "DELETE") {
      this.objects.delete(r.path);
      return res(200, null);
    }
    throw new Error(`unrouted ${r.method} ${r.path}`);
  }
  async requestUrl(): Promise<PortHttpResponse> {
    throw new Error("not used");
  }
}

function mountPanel(azure: NamespaceAzure, readSeq = 1, onCreated = vi.fn<(r: ListenAccessApplyResult) => void>()) {
  const ports = { azure, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  const view = (seq: number) => (
    <PortsProvider ports={ports} config={CONFIG}>
      <ListenAccessPanel namespace={NS} hubs={["hub-a"]} consumerGroup="cribl" ruleName="cribl-listen" readSeq={seq} onCreated={onCreated} />
    </PortsProvider>
  );
  const r = render(view(readSeq));
  return { rerender: (seq: number) => r.rerender(view(seq)), onCreated };
}

describe("ListenAccessPanel", () => {
  it("calls nothing on mount and says the permissions are not measured", () => {
    const azure = new NamespaceAzure();
    mountPanel(azure);
    expect(azure.calls).toEqual([]);
    expect(screen.getByText(/Needed, not yet measured\./)).toBeTruthy();
  });

  it("checks with GETs only, quotes the PUTs, and writes exactly them on confirm", async () => {
    const azure = new NamespaceAzure();
    const { onCreated } = mountPanel(azure);
    fireEvent.click(screen.getByRole("checkbox", { name: /Listen rule cribl-listen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check what to create" }));
    await screen.findByRole("button", { name: "Confirm: create in Azure" });
    expect(azure.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(screen.getByText(`PUT ${RULE}?api-version=2021-11-01 {"properties":{"rights":["Listen"]}}`)).toBeTruthy();
    expect(screen.getByText(`PUT ${CG}?api-version=2021-11-01 {"properties":{"userMetadata":"${CONSUMER_GROUP_STAMP}"}}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm: create in Azure" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(azure.calls.filter((c) => c.method === "PUT").map((c) => [c.path, c.body])).toEqual([
      [RULE, { properties: { rights: ["Listen"] } }],
      [CG, { properties: { userMetadata: CONSUMER_GROUP_STAMP } }],
    ]);
    expect(onCreated.mock.calls[0]?.[0].records.map((r) => r.kind)).toEqual(["listen-rule", "consumer-group"]);
  });

  it("a newer read drops the confirm, and nothing is written", async () => {
    const azure = new NamespaceAzure();
    const { rerender } = mountPanel(azure);
    fireEvent.click(screen.getByRole("button", { name: "Check what to create" }));
    await screen.findByRole("button", { name: "Confirm: create in Azure" });
    rerender(2);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm: create in Azure" })).toBeNull());
    rerender(1);
    expect(screen.queryByRole("button", { name: "Confirm: create in Azure" })).toBeNull();
    expect(azure.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("an existing consumer group is reused: no confirm, no write", async () => {
    const azure = new NamespaceAzure(new Map([[CG, { name: "cribl", properties: {} }]]));
    mountPanel(azure);
    fireEvent.click(screen.getByRole("button", { name: "Check what to create" }));
    await screen.findByText(/Consumer group cribl already exists on hub-a/);
    expect(screen.queryByRole("button", { name: "Confirm: create in Azure" })).toBeNull();
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("ListenAccessRemovePanel", () => {
  const record = consumerGroupRecord(NS, "hub-a", "cribl");
  const stamped = () => new NamespaceAzure(new Map([[CG, { name: "cribl", properties: { userMetadata: CONSUMER_GROUP_STAMP } }]]));

  function mountRemove(azure: NamespaceAzure, inUseBy: string[]) {
    const ports = { azure, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
    const onRemoved = vi.fn();
    render(
      <PortsProvider ports={ports} config={CONFIG}>
        <ListenAccessRemovePanel records={[record]} inUseBy={inUseBy} onRemoved={onRemoved} />
      </PortsProvider>,
    );
    return onRemoved;
  }

  it("quotes the DELETE, then reads, deletes and confirms", async () => {
    const azure = stamped();
    const onRemoved = mountRemove(azure, []);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(new RegExp(`Remove sends DELETE ${CG.replace(/[$]/g, "\\$")}\\?api-version=2021-11-01`))).toBeTruthy();
    expect(azure.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(azure.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${CG}`, `DELETE ${CG}`, `GET ${CG}`]);
    expect(onRemoved.mock.calls[0]?.[1]).toEqual({ kind: "removed", resourceId: CG });
  });

  it("keeps it while a recorded Cribl Event Hubs source remains", async () => {
    const azure = stamped();
    const onRemoved = mountRemove(azure, ["eventhub_in"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await screen.findByText(/eventhub_in this app created may read with cribl/);
    expect(azure.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(onRemoved.mock.calls[0]?.[1].kind).toBe("in-use");
  });
});
