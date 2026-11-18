// @vitest-environment happy-dom
/**
 * AZR-99: the Entra ID tenant diagnostic setting, driven through the real
 * screen against a ROUTING AzureManagement fake that records every request.
 *
 * What these pins protect:
 *   - mount spends no Azure call; Deploy is disabled with its reason in text
 *     until the plan names the Event Hub;
 *   - the target is the PLAN's (section 1 writes it): the namespace's own
 *     subscription and resource group, never the configured shared ones;
 *   - Deploy is two clicks; the confirm quotes the setting name, tenant,
 *     namespace, rule and every category; the confirm writes exactly one PUT
 *     with the How-to body; no key is ever read;
 *   - an existing matching setting reads "already applied" and offers no
 *     removal (the app has no record of writing it);
 *   - a rule read without Manage, and another setting sending a chosen
 *     category to the namespace, each disable Deploy and write nothing;
 *   - after the app's own deploy, Remove sits in "Remove or pause what this
 *     app created", is two clicks, quotes setting, tenant and rule, and sends
 *     one DELETE.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FakeKvDocumentStore, FakeLogger, buildEntraSettingPutRequest, entraCategoriesFor, entraDiagnosticInputFor } from "@soc/core";
import type { AzureConfig, AzureManagement, AzureManagementRequest, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureOnboardingScreen } from "./azure-onboarding-screen";

afterEach(cleanup);

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const EH_SUB = "sub-eh";
const EH_RG = "rg-eh";
const NS_NAME = "ns-a";
const HUB = "alerts-hub";
const NS_ID = `/subscriptions/${EH_SUB}/resourceGroups/${EH_RG}/providers/Microsoft.EventHub/namespaces/${NS_NAME}`;
const HUB_ID = `${NS_ID}/eventhubs/${HUB}`;
const LIST = "/providers/microsoft.aadiam/diagnosticSettings";
const OURS = `${LIST}/CriblEntraIDLogs`;
const RULE_ID = `${NS_ID}/authorizationRules/DiagManage`;
const STANDARD = entraCategoriesFor(["Standard"]);
const API = "2017-04-01";

const CONFIG = {
  tenantId: TENANT,
  clientId: "client",
  subscriptionId: "sub-config",
  resourceGroup: "rg-config",
  workspaceName: "law-1",
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse => ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;

function setting(name: string, ruleId: string, categories: readonly string[] = STANDARD): unknown {
  return {
    id: `${LIST}/${name}`,
    name,
    properties: { eventHubAuthorizationRuleId: ruleId, eventHubName: "", logs: categories.map((category) => ({ category, enabled: true })) },
  };
}

/** Answers by method and path; the tenant list is stateful, as Azure's is. */
class RoutingAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];
  private readonly settings: unknown[];
  constructor(settings: unknown[] = []) {
    this.settings = [...settings];
  }
  writes(): AzureManagementRequest[] {
    return this.calls.filter((c) => c.method !== "GET");
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
        ],
      });
    }
    if (r.method === "GET" && r.path === LIST) return ok({ value: this.settings });
    if (r.method === "PUT" && r.path === OURS) {
      const written = { id: OURS, name: "CriblEntraIDLogs", properties: (r.body as { properties: unknown }).properties };
      this.settings.push(written);
      return ok(written);
    }
    if (r.method === "DELETE" && r.path === OURS) {
      const at = this.settings.findIndex((s) => (s as { id: string }).id === OURS);
      if (at >= 0) this.settings.splice(at, 1);
      return ok(null);
    }
    if (r.method === "GET" && r.path === OURS) {
      const found = this.settings.find((s) => (s as { id: string }).id === OURS);
      return found === undefined ? ({ status: 404, body: {} } as unknown as PortHttpResponse) : ok(found);
    }
    // Every other read (the Activity Log, Defender) is not this file's concern.
    if (r.method === "GET") return { status: 404, body: {} } as unknown as PortHttpResponse;
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

function block(): HTMLElement {
  const el = screen.getByRole("heading", { name: "Entra ID diagnostic setting" }).closest<HTMLElement>(".azure-onboarding-block");
  if (el === null) throw new Error("no Entra block");
  return el;
}

function deployButton(): HTMLButtonElement {
  return within(block()).getByRole("button", { name: "Deploy Entra ID setting" }) as HTMLButtonElement;
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
  fireEvent.change(screen.getByRole("textbox", { name: "Namespace or Event Hub resource id" }), { target: { value: HUB_ID } });
  fireEvent.click(screen.getByRole("button", { name: "Use this id" }));
  await waitFor(() => expect(screen.queryByText("Reading hubs and authorization rules...")).toBeNull());
  await waitFor(() => expect(picker("Authorization rule").disabled).toBe(false));
  choose("Authorization rule", rule);
  // Section 1 writes the plan values the Deploy reads.
  await waitFor(() => expect(within(block()).getByText(new RegExp(`Sends with: namespace ${NS_NAME} \\(resource group ${EH_RG}, subscription ${EH_SUB}\\), rule ${rule}`))).toBeTruthy());
}

async function readSettings(): Promise<void> {
  fireEvent.click(within(block()).getByRole("button", { name: "Read Entra ID diagnostic settings" }));
  await waitFor(() => expect(within(block()).getByText("Existing Entra ID diagnostic settings in this tenant")).toBeTruthy());
}

function teardown(): HTMLElement {
  return screen.getByRole("region", { name: "Remove or pause what this app created" });
}

describe("Entra ID section - before anything is chosen", () => {
  it("mounts with no Azure call; Deploy waits for the plan's Event Hub, says so, and the banner says the role is not measured", async () => {
    const azure = mount();
    await loaded();
    expect(azure.calls).toEqual([]);
    expect(screen.getByTestId("azo-choice-entraId").textContent).toBe("Chosen - Automate");
    expect(deployButton().disabled).toBe(true);
    expect(
      within(block()).getByText(
        "The plan does not name the Event Hub namespace and the Send rule yet. Choose them in the Event Hub section, or set them under How to set it up yourself.",
      ),
    ).toBeTruthy();
    expect(within(block()).getByTestId("azo-permission-banner").textContent).toContain("does not measure");
    expect(within(block()).getByText(/Security Administrator or Global Administrator - not by an Azure role/)).toBeTruthy();
    // No record, nothing to remove: the teardown panel offers no Entra row.
    expect(within(teardown()).queryByRole("button", { name: "Remove Entra ID setting" })).toBeNull();
  });
});

describe("Entra ID section - deploy and remove", () => {
  it("deploys the plan's setting on the second click with the How-to body, then removes it from the teardown panel", async () => {
    const azure = mount();
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    expect(within(block()).getByText(/so the duplicate check had nothing to compare against/)).toBeTruthy();
    expect(deployButton().disabled).toBe(false);

    fireEvent.click(deployButton());
    expect(azure.writes()).toEqual([]);
    const confirm = screen.getByRole("group", { name: "Confirm Entra ID deploy" });
    expect(confirm.textContent).toBe(
      `Create the Entra ID diagnostic setting CriblEntraIDLogs in tenant ${TENANT}, sending to namespace ${NS_NAME} ` +
        `(resource group ${EH_RG}, subscription ${EH_SUB}) with rule DiagManage (one hub per category, created by Azure), ` +
        `with the Standard categories enabled: ${STANDARD.join(", ")}? Every other category is written as disabled. ` +
        "This creates one tenant-wide setting in Microsoft Entra ID.Confirm deployCancel",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm deploy" }));
    await waitFor(() => expect(within(block()).getByText(/CriblEntraIDLogs was created and read back from Azure/)).toBeTruthy());

    const expected = buildEntraSettingPutRequest(
      entraDiagnosticInputFor({ namespace: { subscriptionId: EH_SUB, resourceGroup: EH_RG, name: NS_NAME }, ruleName: "DiagManage", categories: STANDARD }),
    );
    expect(azure.writes()).toEqual([{ method: "PUT", path: OURS, apiVersion: API, body: expected.body }]);
    expect(azure.calls.some((c) => c.path.toLowerCase().endsWith("/listkeys"))).toBe(false);
    // The re-read shows it applied, and Deploy says why it is off.
    await waitFor(() => expect(within(block()).getByText(/CriblEntraIDLogs is already applied in this tenant, exactly as this app would write it/)).toBeTruthy());

    // Remove lives in the teardown panel, from the app's record.
    const remove = await waitFor(() => within(teardown()).getByRole("button", { name: "Remove Entra ID setting" }) as HTMLButtonElement);
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    expect(azure.writes().filter((c) => c.method === "DELETE")).toEqual([]);
    const removeConfirm = screen.getByRole("group", { name: "Confirm Entra ID setting removal" });
    expect(removeConfirm.textContent).toContain(`Remove the Entra ID diagnostic setting CriblEntraIDLogs from tenant ${TENANT}?`);
    expect(removeConfirm.textContent).toContain(`still sends with the rule this app recorded writing (${RULE_ID})`);
    fireEvent.click(within(removeConfirm).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(within(teardown()).getByText("CriblEntraIDLogs was removed, and no longer reads back from Azure.")).toBeTruthy());
    expect(azure.writes().filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: OURS, apiVersion: API }]);
    // The record is gone with it: Remove is off, with its reason.
    await waitFor(() => expect((within(teardown()).getByRole("button", { name: "Remove Entra ID setting" }) as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("Entra ID section - a setting this app wrote that now differs", () => {
  it("points at the app's own Remove, not the admin center, and the row is not labelled Deployed", async () => {
    const azure = mount();
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    fireEvent.click(deployButton());
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm Entra ID deploy" })).getByRole("button", { name: "Confirm deploy" }));
    await waitFor(() => expect(within(block()).getByText(/CriblEntraIDLogs is already applied in this tenant, exactly as this app would write it/)).toBeTruthy());
    const row = (): HTMLElement => document.querySelector<HTMLElement>('li[data-item="entraId"] .azure-onboarding-state')!;
    expect(row().textContent).toBe("Deployed");

    // The setting now carries a category the plan did not choose (the tenant's
    // setting widened; a profile change shows the same difference).
    const stored = (azure as unknown as { settings: { properties: { logs: unknown[] } }[] }).settings[0]!;
    stored.properties.logs.push({ category: "MicrosoftGraphActivityLogs", enabled: true });
    await readSettings();
    await waitFor(() => expect(within(block()).getAllByText(/enabled but not chosen: MicrosoftGraphActivityLogs/).length).toBeGreaterThan(0));
    expect(deployButton().disabled).toBe(true);
    expect(
      within(block()).getByText(/This app created it, and does not overwrite it in place\. Remove it under Remove or pause what this app created, then Deploy writes the current choice\./),
    ).toBeTruthy();
    expect(within(block()).queryByText(/change or remove it in the Microsoft Entra admin center/)).toBeNull();
    expect(row().textContent).not.toBe("Deployed");
    expect((within(teardown()).getByRole("button", { name: "Remove Entra ID setting" }) as HTMLButtonElement).disabled).toBe(false);
    expect(azure.writes().map((w) => w.method)).toEqual(["PUT"]);
  });
});

describe("Entra ID section - refusals disable Deploy and write nothing", () => {
  it("a matching setting made elsewhere is already applied, and is never offered for removal", async () => {
    const azure = mount(new RoutingAzure([setting("CriblEntraIDLogs", RULE_ID)]));
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText(/CriblEntraIDLogs is already applied in this tenant, exactly as this app would write it/)).toBeTruthy();
    expect(within(teardown()).queryByRole("button", { name: "Remove Entra ID setting" })).toBeNull();
    expect(azure.writes()).toEqual([]);
  });

  it("our name with another rule is named and never overwritten", async () => {
    const azure = mount(new RoutingAzure([setting("CriblEntraIDLogs", `${NS_ID}/authorizationRules/Other`)]));
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getAllByText(/eventHubAuthorizationRuleId: expected .*DiagManage, found .*Other\./).length).toBeGreaterThan(0);
    expect(within(block()).getByText(/The app does not overwrite a setting it did not write this way/)).toBeTruthy();
    expect(azure.writes()).toEqual([]);
  });

  it("another setting already sending a chosen category to the namespace is flagged and named", async () => {
    const azure = mount(new RoutingAzure([setting("sentinel-entra", `${NS_ID}/authorizationRules/Other`, ["SignInLogs"])]));
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText(/already sends a chosen category to this namespace: sentinel-entra\. Deploying would deliver those events twice\./)).toBeTruthy();
    expect(within(block()).getByText("Possible duplicate - already sends a chosen category to this namespace")).toBeTruthy();
    expect(azure.writes()).toEqual([]);
  });

  it("a Send-only rule read in section 1 cannot create the hubs", async () => {
    const azure = mount();
    await loaded();
    await chooseTarget("SendOnly");
    await readSettings();
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText(/The rule SendOnly has Send\. An Entra ID diagnostic setting needs a rule with Manage rights/)).toBeTruthy();
    expect(azure.writes()).toEqual([]);
  });
});
