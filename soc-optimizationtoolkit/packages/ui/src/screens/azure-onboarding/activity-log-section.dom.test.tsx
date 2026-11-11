// @vitest-environment happy-dom
/**
 * AZR-98: the Activity Log export section, driven through the real screen
 * against a ROUTING AzureManagement fake that records every request.
 *
 * What these pins protect, each one a way the section could quietly do harm:
 *   - mount spends no Azure call; Deploy is disabled with its reason in text;
 *   - Deploy is two clicks: the first writes nothing, the confirm quotes the
 *     setting name, subscription, namespace, rule and every category, and the
 *     confirm writes exactly one PUT with exactly the body the usecase builds;
 *   - no listKeys is ever made: a diagnostic setting names the rule by id;
 *   - a rule without Manage rights, another setting in the namespace, and a
 *     subscription at Azure's limit each disable Deploy with the reason, and
 *     no PUT is sent;
 *   - changing the rule after arming disarms the confirm;
 *   - an empty list is said to be unconfirmed, never "none";
 *   - the native-connector sentence is the shared one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  ACTIVITY_LOG_CATEGORIES,
  FakeKvDocumentStore,
  defaultSelection,
  FakeLogger,
  LAKE_ROUTE_SOURCES,
} from "@soc/core";
import type { ActivityLogState, AzureConfig, AzureManagement, AzureManagementRequest, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureOnboardingScreen } from "./azure-onboarding-screen";
import { ActivityLogSection } from "./activity-log-section";

afterEach(cleanup);

const SUB = "sub-1";
const EH_RG = "rg-eh";
const NS_NAME = "ns-a";
const HUB = "alerts-hub";
const NS_ID = `/subscriptions/${SUB}/resourceGroups/${EH_RG}/providers/Microsoft.EventHub/namespaces/${NS_NAME}`;
const HUB_ID = `${NS_ID}/eventhubs/${HUB}`;
const SETTINGS = `/subscriptions/${SUB}/providers/Microsoft.Insights/diagnosticSettings`;
const OURS = `${SETTINGS}/cribl-activity-log`;
const RULE_ID = `${NS_ID}/authorizationRules/DiagManage`;

const CONFIG = {
  tenantId: "tenant",
  clientId: "client",
  subscriptionId: SUB,
  resourceGroup: "rg-config",
  workspaceName: "law-1",
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse => ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;

function setting(name: string, ruleId: string): unknown {
  return {
    id: `${SETTINGS}/${name}`,
    name,
    properties: {
      eventHubAuthorizationRuleId: ruleId,
      logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true })),
    },
  };
}

/** Answers by method and path; the settings list is stateful, as Azure's is. */
class RoutingAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];
  private readonly settings: unknown[];
  constructor(settings: unknown[] = []) {
    this.settings = [...settings];
  }
  puts(): AzureManagementRequest[] {
    return this.calls.filter((c) => c.method === "PUT");
  }
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    if (r.method === "GET" && r.path === `${NS_ID}/eventhubs`) {
      return ok({ value: [{ name: HUB, id: HUB_ID, properties: { partitionCount: 2 } }] });
    }
    if (r.method === "GET" && r.path === `${NS_ID}/authorizationRules`) {
      return ok({
        value: [
          { name: "DiagManage", id: RULE_ID, properties: { rights: ["Listen", "Manage", "Send"] } },
          { name: "SendOnly", id: `${NS_ID}/authorizationRules/SendOnly`, properties: { rights: ["Send"] } },
          { name: "OtherManage", id: `${NS_ID}/authorizationRules/OtherManage`, properties: { rights: ["Manage", "Send"] } },
        ],
      });
    }
    if (r.method === "GET" && r.path === SETTINGS) return ok({ value: this.settings });
    if (r.method === "PUT" && r.path === OURS) {
      const body = r.body as { properties: unknown };
      const written = { id: OURS, name: "cribl-activity-log", properties: body.properties };
      this.settings.push(written);
      return ok(written);
    }
    if (r.method === "GET" && r.path === OURS) {
      const found = this.settings.find((s) => (s as { id: string }).id === OURS);
      return found === undefined ? ({ status: 404, body: {} } as unknown as PortHttpResponse) : ok(found);
    }
    throw new Error(`RoutingAzure: unrouted ${r.method} ${r.path}`);
  }
}

function mount(azure = new RoutingAzure()) {
  const ports = { azure, logger: new FakeLogger(() => "t"), kvDocuments: new FakeKvDocumentStore() } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={CONFIG}>
      <AzureOnboardingScreen />
    </PortsProvider>,
  );
  return azure;
}

async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByText("Loading the saved selection...")).toBeNull());
}

/** The Activity Log section's own block. */
function block(): HTMLElement {
  const el = screen.getByRole("heading", { name: "Activity Log export" }).closest<HTMLElement>(".azure-onboarding-block");
  if (el === null) throw new Error("no Activity Log block");
  return el;
}

function deployButton(): HTMLButtonElement {
  return within(block()).getByRole("button", { name: "Deploy Activity Log setting" }) as HTMLButtonElement;
}

function picker(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

function choose(label: string, value: string): void {
  fireEvent.click(picker(label));
  const option = [...document.querySelectorAll(".searchable-select-option")].find((o) => {
    const text = o.querySelector(".searchable-select-option-label")?.textContent ?? "";
    return text === value || text.startsWith(`${value} (`);
  });
  if (option === undefined) throw new Error(`no option ${value} in ${label}`);
  fireEvent.click(option);
}

async function chooseTarget(rule: string): Promise<void> {
  fireEvent.change(screen.getByRole("textbox", { name: "Namespace or Event Hub resource id" }), {
    target: { value: HUB_ID },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this id" }));
  await waitFor(() => expect(screen.queryByText("Reading hubs and authorization rules...")).toBeNull());
  await waitFor(() => expect(picker("Authorization rule").disabled).toBe(false));
  choose("Authorization rule", rule);
}

async function readSettings(): Promise<void> {
  fireEvent.click(within(block()).getByRole("button", { name: "Read diagnostic settings" }));
  await waitFor(() => expect(within(block()).getByText("Existing diagnostic settings on this subscription")).toBeTruthy());
}

describe("Activity Log section - before anything is read", () => {
  it("mounts with no Azure call, the Activity Log ticked by default, and Deploy disabled with its reason in text", async () => {
    const azure = mount();
    await loaded();
    expect(azure.calls).toEqual([]);
    expect((screen.getByRole("checkbox", { name: "Azure Activity Log" }) as HTMLInputElement).checked).toBe(true);
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText("Read the subscription's diagnostic settings first.")).toBeTruthy();
    // The Sentinel note is the one the Lake route uses, word for word.
    expect(within(block()).getByText(LAKE_ROUTE_SOURCES.activityLog.nativeConnectorCopy)).toBeTruthy();
    // The permission banner says nothing is measured, never silence.
    expect(within(block()).getByTestId("azo-permission-banner").textContent).toContain("does not measure");
    // Every dropdown on the screen is a SearchableSelect.
    expect(document.querySelectorAll("select")).toHaveLength(0);
  });
});

describe("Activity Log section - the deploy", () => {
  it("arms, quotes everything it will write, PUTs once on the confirm with exactly the body, and never reads a key", async () => {
    const azure = mount();
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    // An empty list is unconfirmed, never "none".
    expect(within(block()).getByText(/so the duplicate check had nothing to compare against/)).toBeTruthy();
    expect(deployButton().disabled).toBe(false);

    fireEvent.click(deployButton());
    expect(azure.puts()).toEqual([]);
    const confirm = screen.getByRole("group", { name: "Confirm Activity Log deploy" });
    const text = confirm.textContent ?? "";
    expect(text).toContain("cribl-activity-log");
    expect(text).toContain(`subscription ${SUB}`);
    expect(text).toContain(`namespace ${NS_NAME} with rule DiagManage`);
    expect(text).toContain(ACTIVITY_LOG_CATEGORIES.join(", "));

    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm deploy" }));
    await waitFor(() => expect(within(block()).getByText(/was created and read back from Azure/)).toBeTruthy());
    expect(azure.puts()).toEqual([
      {
        method: "PUT",
        path: OURS,
        apiVersion: "2021-05-01-preview",
        body: {
          properties: {
            eventHubAuthorizationRuleId: RULE_ID,
            logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true })),
          },
        },
      },
    ]);
    expect(azure.calls.some((c) => c.path.toLowerCase().endsWith("/listkeys"))).toBe(false);
    // The re-read after the write shows it deployed, and Deploy says why it is off.
    await waitFor(() =>
      expect(within(block()).getByText("cribl-activity-log already exists on this subscription - there is nothing to deploy.")).toBeTruthy(),
    );
    expect(deployButton().disabled).toBe(true);
  });

  it("changing the rule after arming disarms the confirm, even to another rule that may deploy", async () => {
    const azure = mount();
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    fireEvent.click(deployButton());
    expect(screen.getByRole("group", { name: "Confirm Activity Log deploy" })).toBeTruthy();
    // Another Manage rule: Deploy stays enabled, so only the arm key can disarm it.
    choose("Authorization rule", "OtherManage");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Confirm Activity Log deploy" })).toBeNull());
    expect(deployButton().disabled).toBe(false);
    // Choosing the first rule again does not bring the old confirm back.
    choose("Authorization rule", "DiagManage");
    expect(screen.queryByRole("group", { name: "Confirm Activity Log deploy" })).toBeNull();
    expect(azure.puts()).toEqual([]);
  });
});

describe("Activity Log section - refusals disable Deploy and write nothing", () => {
  it("a rule without Manage rights", async () => {
    const azure = mount();
    await loaded();
    await chooseTarget("SendOnly");
    await readSettings();
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText(/A diagnostic setting needs a rule with Manage rights/)).toBeTruthy();
    expect(azure.puts()).toEqual([]);
  });

  it("another setting already sending to the namespace is flagged and named", async () => {
    const azure = mount(new RoutingAzure([setting("cribl-activitylog-test", `${NS_ID}/authorizationRules/RootManageSharedAccessKey`)]));
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    const table = within(block()).getByRole("table", { name: "Existing diagnostic settings" });
    expect(table.textContent).toContain("Possible duplicate - already sends to the chosen namespace");
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText(/cribl-activitylog-test\. Deploying would deliver every event twice\./)).toBeTruthy();
    expect(azure.puts()).toEqual([]);
  });

  it("a subscription already at Azure's limit of five settings", async () => {
    const other = "/subscriptions/sub-1/resourceGroups/x/providers/Microsoft.EventHub/namespaces/other/authorizationRules/R";
    const azure = mount(new RoutingAzure([1, 2, 3, 4, 5].map((n) => setting(`s${n}`, other))));
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText(/already has 5 diagnostic settings, the most Azure allows/)).toBeTruthy();
    expect(azure.puts()).toEqual([]);
  });

  it("our setting existing with another rule names the field and offers no repair", async () => {
    const azure = mount(new RoutingAzure([setting("cribl-activity-log", `${NS_ID}/authorizationRules/Other`)]));
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getAllByText(/eventHubAuthorizationRuleId: expected/).length).toBeGreaterThan(0);
    expect((within(block()).getByRole("button", { name: "Repair setting" }) as HTMLButtonElement).disabled).toBe(true);
    expect(azure.puts()).toEqual([]);
  });
});

describe("Activity Log section - after a write", () => {
  it("hands the write to onDeployed with its target, so an earlier Validate run can be amended", async () => {
    const azure = new RoutingAzure();
    const onDeployed = vi.fn();
    const ports = { azure, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
    function Harness() {
      const [state, setState] = useState<ActivityLogState | null>(null);
      return (
        <ActivityLogSection
          selection={{ ...defaultSelection(), enabled: ["activityLog"] }}
          target={{
            namespace: { subscriptionId: SUB, resourceGroup: EH_RG, name: NS_NAME },
            hubName: "",
            rule: { name: "DiagManage", id: RULE_ID, rights: ["Listen", "Manage", "Send"], canSend: true },
          }}
          state={state}
          onState={setState}
          onDeployed={onDeployed}
          howtoSection={9}
          onShowHowto={() => {}}
        />
      );
    }
    render(
      <PortsProvider ports={ports} config={CONFIG}>
        <Harness />
      </PortsProvider>,
    );
    await readSettings();
    fireEvent.click(deployButton());
    expect(onDeployed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deploy" }));
    await waitFor(() => expect(onDeployed).toHaveBeenCalledTimes(1));
    expect(onDeployed).toHaveBeenCalledWith({
      source: "activityLog",
      outcome: "written-and-read-back",
      input: { subscriptionId: SUB, namespace: { subscriptionId: SUB, resourceGroup: EH_RG, name: NS_NAME }, ruleName: "DiagManage" },
    });
  });
});
