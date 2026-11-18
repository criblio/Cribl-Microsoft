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
  FakeLogger,
  LAKE_ROUTE_SOURCES,
} from "@soc/core";
import type {
  ActivityLogState,
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  CapabilitySet,
  CapabilityVerdict,
  PortHttpResponse,
} from "@soc/core";
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
  private held: { method: string; path: string; gate: Promise<void> } | null = null;
  puts(): AzureManagementRequest[] {
    return this.calls.filter((c) => c.method === "PUT");
  }
  /** Hold the NEXT request with this method and path until the returned release is called. */
  hold(method: string, path: string): () => void {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { method, path, gate };
    return release;
  }
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    const held = this.held;
    if (held !== null && held.method === r.method && held.path === r.path) {
      this.held = null;
      await held.gate;
    }
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
    if (r.method === "DELETE" && r.path === OURS) {
      const at = this.settings.findIndex((s) => (s as { id: string }).id === OURS);
      if (at >= 0) this.settings.splice(at, 1);
      return ok(null);
    }
    if (r.method === "GET" && r.path === OURS) {
      const found = this.settings.find((s) => (s as { id: string }).id === OURS);
      return found === undefined ? ({ status: 404, body: {} } as unknown as PortHttpResponse) : ok(found);
    }
    throw new Error(`RoutingAzure: unrouted ${r.method} ${r.path}`);
  }
}

function mount(azure = new RoutingAzure(), capabilities?: CapabilitySet) {
  const ports = { azure, logger: new FakeLogger(() => "t"), kvDocuments: new FakeKvDocumentStore() } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={CONFIG} capabilities={capabilities}>
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
  it("mounts with no Azure call, the Activity Log chosen by default, and Deploy disabled with its reason in text", async () => {
    const azure = mount();
    await loaded();
    expect(azure.calls).toEqual([]);
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: "Onboard Azure Activity Log" }) as HTMLInputElement).checked).toBe(true),
    );
    expect(screen.getByTestId("azo-choice-activityLog").textContent).toBe("Chosen - Automate");
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText("Read the subscription's diagnostic settings first.")).toBeTruthy();
    // The Sentinel note is the one the Lake route uses, word for word.
    expect(within(block()).getByText(LAKE_ROUTE_SOURCES.activityLog.nativeConnectorCopy)).toBeTruthy();
    // CAP-10: with no audit wired, the banner says the check has not run - never silence, never a denial.
    expect(within(block()).getByTestId("azo-permission-banner").textContent).toContain(
      "Permissions have not been checked for this connection yet",
    );
    // Every dropdown on the screen is a SearchableSelect.
    expect(document.querySelectorAll("select")).toHaveLength(0);
  });
});

describe("Activity Log section - what the permission check measured (CAP-10)", () => {
  function audited(read?: CapabilityVerdict, write?: CapabilityVerdict, del?: CapabilityVerdict): CapabilitySet {
    return {
      verdicts: {
        ...(read === undefined ? {} : { "subscription-diagnostics.read": read }),
        ...(write === undefined ? {} : { "subscription-diagnostics.write": write }),
        ...(del === undefined ? {} : { "subscription-diagnostics.delete": del }),
      },
      auditedAt: "2026-11-18T10:00:00.000Z",
      connectionId: "c",
    };
  }
  /** Each measured row as action:state, in order. */
  function rows(): string[] {
    return [...block().querySelectorAll("[data-permission-action]")].map(
      (li) => `${li.getAttribute("data-permission-action")}:${li.getAttribute("data-state")}`,
    );
  }
  const READ = "Microsoft.Insights/diagnosticSettings/read";
  const WRITE = "Microsoft.Insights/diagnosticSettings/write";
  const DELETE = "Microsoft.Insights/diagnosticSettings/delete";

  it("granted: three measured rows, no banner, and only the rule's listKeys listed as not measured", async () => {
    mount(new RoutingAzure(), audited("granted", "granted", "granted"));
    await loaded();
    expect(rows()).toEqual([`${READ}:granted`, `${WRITE}:granted`, `${DELETE}:granted`]);
    expect(within(block()).queryByTestId("azo-permission-banner")).toBeNull();
    expect(within(block()).queryByText("On the subscription")).toBeTruthy();
    expect(within(block()).getByText("On the Event Hub namespace rule")).toBeTruthy();
    expect(within(block()).getByText(/Microsoft\.EventHub\/namespaces\/authorizationRules\/listKeys\/action/)).toBeTruthy();
  });

  it("denied: the error banner and a caution beside Deploy, which stays clickable and still deploys", async () => {
    const azure = mount(new RoutingAzure(), audited("granted", "denied", "granted"));
    await loaded();
    expect(rows()).toEqual([`${READ}:granted`, `${WRITE}:denied`, `${DELETE}:granted`]);
    const banner = within(block()).getByTestId("azo-permission-banner");
    expect(banner.textContent).toContain(
      `found your Azure identity cannot create the Activity Log diagnostic setting (${WRITE}), so Azure will likely refuse`,
    );
    await chooseTarget("DiagManage");
    await readSettings();
    // The audit informs, never forbids: Deploy is enabled, described by the caution.
    expect(deployButton().disabled).toBe(false);
    const caution = within(block()).getByText(/^Azure will likely refuse this deploy:/);
    expect(deployButton().getAttribute("aria-describedby")).toBe(caution.id);
    fireEvent.click(deployButton());
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm Activity Log deploy" })).getByRole("button", { name: "Confirm deploy" }));
    await waitFor(() => expect(azure.puts()).toHaveLength(1));
  });

  it("read denied too: the caution beside a DISABLED Deploy never claims the button is available", async () => {
    // A measured read denial and the section's own 403 on the list meet at the
    // same button: the gate disables Deploy with its reason, and the caution
    // beside it must not contradict that.
    class ForbiddenList extends RoutingAzure {
      override async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
        if (r.method === "GET" && r.path === SETTINGS) {
          this.calls.push(r);
          return { status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } } as unknown as PortHttpResponse;
        }
        return super.request(r);
      }
    }
    mount(new ForbiddenList(), audited("denied", "denied", "granted"));
    await loaded();
    expect(rows()).toEqual([`${READ}:denied`, `${WRITE}:denied`, `${DELETE}:granted`]);
    const CAUTION =
      "Azure will likely refuse this deploy: the last permission check found your Azure identity cannot " +
      `list the subscription's diagnostic settings and create the Activity Log diagnostic setting (${READ}, ${WRITE}). ` +
      "This check never disables Deploy; Azure's answer decides. " +
      "Re-check permissions if the role was granted since, or switch it to How-to in section 2.";
    // Before any read: the gate's reason and the caution, side by side.
    expect(deployButton().disabled).toBe(true);
    expect(within(block()).getByText(CAUTION)).toBeTruthy();
    expect(within(block()).getByText("Read the subscription's diagnostic settings first.")).toBeTruthy();
    await chooseTarget("DiagManage");
    fireEvent.click(within(block()).getByRole("button", { name: "Read diagnostic settings" }));
    const REASON =
      "The subscription's diagnostic settings could not be read - List the subscription's diagnostic settings: HTTP 403 - no";
    await waitFor(() => expect(within(block()).getByText(REASON)).toBeTruthy());
    expect(deployButton().disabled).toBe(true);
    const caution = within(block()).getByText(CAUTION);
    const reason = within(block()).getByText(REASON);
    expect(deployButton().getAttribute("aria-describedby")).toBe(`${reason.id} ${caution.id}`);
    // No sentence beside the button says it can be pressed.
    const controls = deployButton().closest(".panel-controls")?.textContent ?? "";
    expect(controls).not.toMatch(/stays available|stays clickable|still works/);
  });

  it("unknown: an audit that did not measure them is a soft note, rows say not measured, no caution", async () => {
    mount(new RoutingAzure(), audited());
    await loaded();
    expect(rows()).toEqual([`${READ}:unknown`, `${WRITE}:unknown`, `${DELETE}:unknown`]);
    const banner = within(block()).getByTestId("azo-permission-banner");
    expect(banner.textContent).toContain("The last permission check did not measure whether your Azure identity can");
    expect(banner.textContent).not.toMatch(/\bdenied\b|\brefuse/i);
    expect(within(block()).queryByText(/^Azure will likely refuse this deploy:/)).toBeNull();
  });

  it("never checked: no audit for this connection says so, and rows say not checked yet", async () => {
    mount(new RoutingAzure(), { verdicts: {}, auditedAt: null, connectionId: null });
    await loaded();
    expect(rows()).toEqual([`${READ}:never-checked`, `${WRITE}:never-checked`, `${DELETE}:never-checked`]);
    expect(within(block()).getByTestId("azo-permission-banner").textContent).toContain(
      "Permissions have not been checked for this connection yet",
    );
  });
});

describe("Activity Log setting - remove, from the teardown panel (AZR-105, AZR-121)", () => {
  const REMOVE = "Remove Activity Log setting";
  const CONFIRM_TEXT =
    `Remove the diagnostic setting cribl-activity-log from subscription ${SUB}? ` +
    `It is removed only if it still sends with the rule this app recorded writing (${RULE_ID}); otherwise nothing is removed. ` +
    "Azure then stops sending this subscription's Activity Log to the Event Hub. The hub, its events and the Cribl source are not touched. " +
    "This deletes one setting in Azure.Confirm removeCancel";

  function teardown(): HTMLElement {
    return screen.getByRole("region", { name: "Remove or pause what this app created" });
  }
  function removeButton(): HTMLButtonElement {
    return within(teardown()).getByRole("button", { name: REMOVE }) as HTMLButtonElement;
  }
  function deletes(azure: RoutingAzure): AzureManagementRequest[] {
    return azure.calls.filter((c) => c.method === "DELETE");
  }

  /** Deploy through the section, so the app records writing the setting. */
  async function deployOurs(): Promise<RoutingAzure> {
    const azure = mount();
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    fireEvent.click(deployButton());
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm Activity Log deploy" })).getByRole("button", { name: "Confirm deploy" }));
    await waitFor(() => expect(within(block()).getByText(/was created and read back from Azure/)).toBeTruthy());
    await waitFor(() => expect(removeButton().disabled).toBe(false));
    return azure;
  }

  async function removeIt(azure: RoutingAzure): Promise<void> {
    fireEvent.click(removeButton());
    // The first click writes nothing; it arms a confirm quoting what goes.
    expect(deletes(azure)).toEqual([]);
    const confirm = screen.getByRole("group", { name: "Confirm Activity Log removal" });
    expect(confirm.textContent).toBe(CONFIRM_TEXT);
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(within(teardown()).getByText("cribl-activity-log was removed, and no longer reads back from Azure.")).toBeTruthy());
    expect(deletes(azure)).toEqual([{ method: "DELETE", path: OURS, apiVersion: "2021-05-01-preview" }]);
    // The record is gone with it: Remove is off.
    await waitFor(() => expect(removeButton().disabled).toBe(true));
  }

  it("offers no removal of a setting the app has no record of writing, even one under its name", async () => {
    const azure = mount(new RoutingAzure([setting("cribl-activity-log", RULE_ID)]));
    await loaded();
    await readSettings();
    expect(within(teardown()).queryByRole("button", { name: REMOVE })).toBeNull();
    // Nothing is offered in the Activity Log section either.
    expect(within(block()).queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(deletes(azure)).toEqual([]);
  });

  it("in Automate mode: two clicks, the exact confirm, one DELETE, and the screen re-reads so Deploy is offered again", async () => {
    const azure = await deployOurs();
    await waitFor(() =>
      expect(within(block()).getByText("cribl-activity-log already exists on this subscription - there is nothing to deploy.")).toBeTruthy(),
    );
    const listsBefore = azure.calls.filter((c) => c.method === "GET" && c.path === SETTINGS).length;
    await removeIt(azure);
    // The screen re-read the subscription: the section no longer describes the removed setting.
    await waitFor(() =>
      expect(azure.calls.filter((c) => c.method === "GET" && c.path === SETTINGS).length).toBe(listsBefore + 1),
    );
    await waitFor(() => expect(within(block()).queryByText(/already exists on this subscription/)).toBeNull());
    expect(deployButton().disabled).toBe(false);
  });

  it("the screen's re-read after a Remove disarms a Deploy confirm armed against the earlier read", async () => {
    const azure = await deployOurs();
    // Deleted by hand in the portal: the section's next read shows it absent, so Deploy can be armed.
    const stored = (azure as unknown as { settings: unknown[] }).settings;
    stored.splice(0, stored.length);
    await readSettings();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    fireEvent.click(deployButton());
    expect(screen.getByRole("group", { name: "Confirm Activity Log deploy" })).toBeTruthy();
    // Remove from the teardown panel finds it already gone; the screen re-reads.
    fireEvent.click(removeButton());
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm Activity Log removal" })).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(within(teardown()).getByText("Nothing was removed: cribl-activity-log is not on this subscription.")).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole("group", { name: "Confirm Activity Log deploy" })).toBeNull());
    expect(azure.puts()).toHaveLength(1);
    expect(deletes(azure)).toEqual([]);
  });

  // AZR-121 review round 1: Deploy and Remove now live apart, and each must
  // still turn the other off, as on main where both lived in the section.
  it("Remove is off while a Deploy's PUT is in flight, and back on when it lands", async () => {
    const azure = await deployOurs();
    const stored = (azure as unknown as { settings: unknown[] }).settings;
    stored.splice(0, stored.length);
    await readSettings();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    // Arm Remove first, so the only thing that can take it away is the Deploy.
    fireEvent.click(removeButton());
    expect(screen.getByRole("group", { name: "Confirm Activity Log removal" })).toBeTruthy();
    const release = azure.hold("PUT", OURS);
    fireEvent.click(deployButton());
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm Activity Log deploy" })).getByRole("button", { name: "Confirm deploy" }));
    await waitFor(() => expect(azure.puts()).toHaveLength(2));
    await waitFor(() => expect(removeButton().disabled).toBe(true));
    expect(screen.queryByRole("group", { name: "Confirm Activity Log removal" })).toBeNull();
    expect(within(teardown()).getByText("A change is already running.")).toBeTruthy();
    release();
    await waitFor(() => expect(within(block()).getByText(/was created and read back from Azure/)).toBeTruthy());
    await waitFor(() => expect(removeButton().disabled).toBe(false));
    expect(within(teardown()).queryByText("A change is already running.")).toBeNull();
    // The Remove armed before the Deploy does not come back armed after it.
    expect(screen.queryByRole("group", { name: "Confirm Activity Log removal" })).toBeNull();
    expect(deletes(azure)).toEqual([]);
  });

  it("Deploy is off while a Remove is in flight, and back on when it finishes", async () => {
    const azure = await deployOurs();
    const stored = (azure as unknown as { settings: unknown[] }).settings;
    stored.splice(0, stored.length);
    await readSettings();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    fireEvent.click(deployButton());
    expect(screen.getByRole("group", { name: "Confirm Activity Log deploy" })).toBeTruthy();
    const release = azure.hold("GET", OURS);
    fireEvent.click(removeButton());
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm Activity Log removal" })).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(deployButton().disabled).toBe(true));
    expect(screen.queryByRole("group", { name: "Confirm Activity Log deploy" })).toBeNull();
    expect(
      within(block()).getByText("A removal of cribl-activity-log is running. Deploy is off until it finishes."),
    ).toBeTruthy();
    release();
    await waitFor(() => expect(within(teardown()).getByText("Nothing was removed: cribl-activity-log is not on this subscription.")).toBeTruthy());
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    expect(screen.queryByRole("group", { name: "Confirm Activity Log deploy" })).toBeNull();
    expect(azure.puts()).toHaveLength(1);
    expect(deletes(azure)).toEqual([]);
  });

  it("a Deploy confirm armed before a Remove that changes nothing does not come back armed after it", async () => {
    const azure = await deployOurs();
    const stored = (azure as unknown as { settings: unknown[] }).settings;
    stored.splice(0, stored.length);
    await readSettings();
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    fireEvent.click(deployButton());
    expect(screen.getByRole("group", { name: "Confirm Activity Log deploy" })).toBeTruthy();
    // Azure refuses the Remove's by-name read: no re-read follows, so only the in-flight drop can disarm Deploy.
    const original = azure.request.bind(azure);
    azure.request = async (r) =>
      r.method === "GET" && r.path === OURS
        ? (azure.calls.push(r), { ok: false, status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } } as unknown as PortHttpResponse)
        : original(r);
    const lists = azure.calls.filter((c) => c.method === "GET" && c.path === SETTINGS).length;
    fireEvent.click(removeButton());
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm Activity Log removal" })).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() =>
      expect(within(teardown()).getByText("Remove stopped at reading the setting. Read cribl-activity-log: HTTP 403 - no")).toBeTruthy(),
    );
    await waitFor(() => expect(deployButton().disabled).toBe(false));
    expect(azure.calls.filter((c) => c.method === "GET" && c.path === SETTINGS)).toHaveLength(lists);
    expect(screen.queryByRole("group", { name: "Confirm Activity Log deploy" })).toBeNull();
    expect(azure.puts()).toHaveLength(1);
    expect(deletes(azure)).toEqual([]);
  });

  it("with the Activity Log switched to How-to, the section is gone but the Remove of the recorded setting stays", async () => {
    const azure = await deployOurs();
    fireEvent.click(screen.getByRole("radio", { name: "How-to Azure Activity Log" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Activity Log export" })).toBeNull());
    expect(screen.getByTestId("azo-howto-note-activityLog")).toBeTruthy();
    expect(removeButton().disabled).toBe(false);
    await removeIt(azure);
  });

  it("with the Activity Log unchosen in How-to mode, the Remove of the recorded setting stays", async () => {
    const azure = await deployOurs();
    fireEvent.click(screen.getByRole("radio", { name: "How-to Azure Activity Log" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Activity Log export" })).toBeNull());
    fireEvent.click(screen.getByRole("checkbox", { name: "Onboard Azure Activity Log" }));
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: "Onboard Azure Activity Log" }) as HTMLInputElement).checked).toBe(false),
    );
    expect(screen.queryByTestId("azo-howto-note-activityLog")).toBeNull();
    expect(removeButton().disabled).toBe(false);
    await removeIt(azure);
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

  it("lists a category group in Categories enabled, and none only when neither a category nor a group is on", async () => {
    const groupOnly = {
      id: `${SETTINGS}/group-only`,
      name: "group-only",
      properties: {
        eventHubAuthorizationRuleId: `${NS_ID}/authorizationRules/RootManageSharedAccessKey`,
        logs: [{ categoryGroup: "allLogs", enabled: true }],
      },
    };
    const nothing = {
      id: `${SETTINGS}/nothing-on`,
      name: "nothing-on",
      properties: {
        eventHubAuthorizationRuleId: `${NS_ID}/authorizationRules/RootManageSharedAccessKey`,
        logs: [{ categoryGroup: "allLogs", enabled: false }],
      },
    };
    mount(new RoutingAzure([groupOnly, nothing]));
    await loaded();
    await chooseTarget("DiagManage");
    await readSettings();
    const table = within(block()).getByRole("table", { name: "Existing diagnostic settings" });
    const cells = (name: string): string[] =>
      Array.from(within(table).getByText(name).closest("tr")?.querySelectorAll("td") ?? []).map((td) => td.textContent ?? "");
    expect(cells("group-only")[3]).toBe("allLogs");
    expect(cells("nothing-on")[3]).toBe("none");
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
          choice={{ kind: "chosen", mode: "automate" }}
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
          removing={false}
          onRunningChange={() => {}}
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
