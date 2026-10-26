// @vitest-environment happy-dom
/**
 * AZR-18: the Azure Native Source Onboarding screen, driven through its real
 * sections against a ROUTING AzureManagement fake that counts every request
 * and a FakeKvDocumentStore that counts every load and save.
 *
 * WHY ROUTING AND NOT THE FIFO FakeAzureManagement. The flows here interleave
 * a dozen reads across three sections in an order the operator chooses; a FIFO
 * script would pin the click order, not the behaviour. The router answers by
 * method and path, and records every call, so each pin asserts on what reached
 * Azure - above all the number of PUTs, which is the thing that must not
 * happen by accident.
 *
 * What these pins protect, each one a way this screen could quietly do harm:
 *   - mount spends no Azure calls and reads the selection exactly once;
 *   - a failed or missing selection read never turns into a Save;
 *   - a row toggled while a save is in flight stays unsaved, never "saved";
 *   - unticking Defender is a selection edit, never an Azure call;
 *   - an existing export (legacy's, in another resource group), a broken one
 *     or another export to the same hub disables Deploy and writes nothing;
 *   - Deploy is two clicks: the first writes nothing, the confirm writes once,
 *     and changing any input the confirm names disarms it for good;
 *   - the export goes to the chosen resource group's location, never a fixed one;
 *   - a pasted hub a complete listing does not contain cannot be deployed to;
 *   - the controls this slice does not build are visible and disabled;
 *   - a Listen-only rule is never offered;
 *   - a refused plans read never says that no paid plan is enabled;
 *   - every catalog row, unsupported source and the XDR row render, with the
 *     unbuilt ones disabled;
 *   - the connection string never reaches the DOM or the log.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  COVERAGE_CATALOG,
  COVERAGE_SELECTION_KEY,
  COVERAGE_SELECTION_KIND,
  COVERAGE_SELECTION_VERSION,
  DEFENDER_PLANS,
  FakeKvDocumentStore,
  FakeLogger,
  UNSUPPORTED_SOURCES,
} from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  PortHttpResponse,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureOnboardingScreen, SHELL_GAP_MESSAGE } from "./azure-onboarding-screen";

afterEach(cleanup);

const SUB = "sub-1";
const EH_RG = "rg-eh";
const NS_NAME = "ns-a";
const HUB = "alerts-hub";
const TARGET_RG = "rg-target";
const OTHER_HUB = "other-hub";
const NS_B = "ns-b";
/** The target group's location, distinct from CONFIG.location and EH_RG's. */
const TARGET_LOCATION = "westus2";
const NS_ID = `/subscriptions/${SUB}/resourceGroups/${EH_RG}/providers/Microsoft.EventHub/namespaces/${NS_NAME}`;
const NS_B_ID = `/subscriptions/${SUB}/resourceGroups/${EH_RG}/providers/Microsoft.EventHub/namespaces/${NS_B}`;
const HUB_ID = `${NS_ID}/eventhubs/${HUB}`;
const AUTOMATIONS = `/subscriptions/${SUB}/providers/Microsoft.Security/automations`;
const PRICINGS = `/subscriptions/${SUB}/providers/Microsoft.Security/pricings`;
const OURS_PATH = `/subscriptions/${SUB}/resourceGroups/${TARGET_RG}/providers/Microsoft.Security/automations/CriblDefenderExport`;

/** The connection string listKeys returns. It must never surface anywhere. */
const SECRET_KEY = "SENTINELKEY0123456789abcdef";
const SECRET = `Endpoint=sb://${NS_NAME}.servicebus.windows.net/;SharedAccessKeyName=SendOnly;SharedAccessKey=${SECRET_KEY}`;

const DEFENDER_TITLE = "Defender for Cloud alert export";

const CONFIG = {
  tenantId: "tenant",
  clientId: "client",
  subscriptionId: SUB,
  resourceGroup: "rg-config",
  workspaceName: "law-1",
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse =>
  ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;
const fail = (status: number, code = ""): PortHttpResponse =>
  ({ ok: false, status, body: { error: { code, message: `refused ${status}` } } }) as unknown as PortHttpResponse;

/** An automation as ARM lists it. */
function automation(opts: {
  name: string;
  rg: string;
  enabled?: boolean;
  target?: string;
  sources?: string[];
}): unknown {
  return {
    id: `/subscriptions/${SUB}/resourceGroups/${opts.rg}/providers/Microsoft.Security/automations/${opts.name}`,
    name: opts.name,
    properties: {
      isEnabled: opts.enabled ?? true,
      scopes: [{ description: "sub", scopePath: `/subscriptions/${SUB}` }],
      sources: (opts.sources ?? ["Alerts"]).map((eventSource) => ({ eventSource })),
      actions: [{ actionType: "EventHub", eventHubResourceId: opts.target ?? HUB_ID }],
    },
  };
}

interface Scenario {
  pricings?: PortHttpResponse;
  automations?: unknown[];
  automationsResponse?: PortHttpResponse;
  rules?: Array<{ name: string; rights: string[] }>;
  /** Hub names every namespace lists; default HUB and OTHER_HUB. */
  hubs?: string[];
  /** When true the hub listing carries a nextLink (first page only). */
  hubsTruncated?: boolean;
}

/**
 * Answers by method and path and records every call. The automations list is
 * stateful: a successful PUT adds the written export to it, as Azure would.
 */
class RoutingAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];
  private readonly automations: unknown[];
  private readonly scenario: Scenario;

  constructor(scenario: Scenario = {}) {
    this.scenario = scenario;
    this.automations = [...(scenario.automations ?? [])];
  }

  puts(): AzureManagementRequest[] {
    return this.calls.filter((c) => c.method === "PUT");
  }

  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    const s = this.scenario;
    if (r.method === "POST" && r.path === "/providers/Microsoft.ResourceGraph/resources") {
      return ok({
        data: [
          { name: NS_NAME, resourceGroup: EH_RG, subscriptionId: SUB, skuName: "Standard", id: NS_ID, location: "westus2" },
        ],
      });
    }
    if (r.method === "POST" && r.path.endsWith("/listKeys")) {
      return ok({ primaryConnectionString: SECRET, primaryKey: SECRET_KEY });
    }
    const nsPath = [NS_ID, NS_B_ID].find((id) => r.path.startsWith(`${id}/`));
    if (r.method === "GET" && nsPath !== undefined && r.path === `${nsPath}/eventhubs`) {
      const names = s.hubs ?? [HUB, OTHER_HUB];
      return ok({
        value: names.map((name) => ({ name, id: `${nsPath}/eventhubs/${name}`, properties: { partitionCount: 2 } })),
        ...(s.hubsTruncated === true ? { nextLink: `https://management.azure.com${nsPath}/eventhubs?page=2` } : {}),
      });
    }
    if (r.method === "GET" && nsPath !== undefined && r.path === `${nsPath}/authorizationRules`) {
      const rules = s.rules ?? [
        { name: "RootManageSharedAccessKey", rights: ["Listen", "Manage", "Send"] },
        { name: "SendOnly", rights: ["Send"] },
      ];
      return ok({
        value: rules.map((rule) => ({
          name: rule.name,
          id: `${nsPath}/authorizationRules/${rule.name}`,
          properties: { rights: rule.rights },
        })),
      });
    }
    if (r.method === "GET" && r.path === PRICINGS) {
      return (
        s.pricings ??
        ok({
          value: [
            { name: "VirtualMachines", properties: { pricingTier: "Standard" } },
            { name: "SqlServers", properties: { pricingTier: "Free" } },
          ],
        })
      );
    }
    if (r.method === "GET" && r.path === AUTOMATIONS) {
      return s.automationsResponse ?? ok({ value: this.automations });
    }
    if (r.method === "GET" && r.path === `/subscriptions/${SUB}/resourcegroups`) {
      return ok({ value: [{ name: TARGET_RG, location: TARGET_LOCATION }, { name: EH_RG, location: "centralus" }] });
    }
    if (r.method === "PUT" && r.path === OURS_PATH) {
      // Azure does not echo the secret back; neither does this.
      const written = automation({ name: "CriblDefenderExport", rg: TARGET_RG });
      this.automations.push(written);
      return ok(written);
    }
    if (r.method === "GET" && r.path === OURS_PATH) {
      return ok(automation({ name: "CriblDefenderExport", rg: TARGET_RG }));
    }
    throw new Error(`RoutingAzure: unrouted ${r.method} ${r.path}`);
  }
}

function mount(opts: {
  azure?: RoutingAzure;
  store?: FakeKvDocumentStore | null;
  logger?: FakeLogger;
} = {}) {
  const azure = opts.azure ?? new RoutingAzure();
  const store = opts.store === undefined ? new FakeKvDocumentStore() : opts.store;
  const logger = opts.logger ?? new FakeLogger(() => "t");
  const ports = {
    azure,
    logger,
    ...(store === null ? {} : { kvDocuments: store }),
  } as unknown as UiPorts;
  const view = render(
    <PortsProvider ports={ports} config={CONFIG}>
      <AzureOnboardingScreen />
    </PortsProvider>,
  );
  return { azure, store, logger, view };
}

/** A document store whose saves wait for {@link release}, to hold a save in flight. */
class HeldSaveStore extends FakeKvDocumentStore {
  private gate: Promise<void>;
  private open: () => void = () => {};

  constructor() {
    super();
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open();
  }

  override async save(key: string, value: unknown): Promise<void> {
    await this.gate;
    return super.save(key, value);
  }
}

/** Wait for the selection load to land (the loading line goes away). */
async function loaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByText("Loading the saved selection...")).toBeNull();
  });
}

function checkbox(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function select(label: string): HTMLSelectElement {
  return screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
}

/** Paste HUB_ID into the id field, apply it, and wait for the reads. */
async function pasteHubId(): Promise<void> {
  fireEvent.change(screen.getByRole("textbox", { name: "Namespace or Event Hub resource id" }), {
    target: { value: HUB_ID },
  });
  fireEvent.click(button("Use this id"));
  await waitFor(() => {
    expect(screen.queryByText("Reading hubs and authorization rules...")).toBeNull();
  });
}

/** Paste the hub id, wait for the rules, and pick `rule` (when given). */
async function chooseTarget(rule?: string): Promise<void> {
  await pasteHubId();
  await waitFor(() => {
    expect(screen.queryByText("Reading hubs and authorization rules...")).toBeNull();
    expect(select("Event Hub").value).toBe(HUB);
  });
  if (rule !== undefined) {
    fireEvent.change(select("Authorization rule"), { target: { value: rule } });
    expect(select("Authorization rule").value).toBe(rule);
  }
}

async function readDefender(): Promise<void> {
  fireEvent.click(button("Read Defender state"));
  await waitFor(() => {
    expect(button("Read Defender state").disabled).toBe(false);
    expect(screen.getByText("Existing continuous exports")).toBeTruthy();
  });
}

async function chooseGroup(): Promise<void> {
  fireEvent.click(button("Load resource groups"));
  await waitFor(() => {
    expect(select("Resource group").disabled).toBe(false);
  });
  fireEvent.change(select("Resource group"), { target: { value: TARGET_RG } });
  expect(select("Resource group").value).toBe(TARGET_RG);
}

/** Tick Defender, pick a Send rule, read the state, pick the resource group. */
async function readyToDeploy(): Promise<void> {
  await readyToDeployFrom(() => chooseTarget("SendOnly"));
}

/** As readyToDeploy, with the Event Hub target chosen by `target`. */
async function readyToDeployFrom(target: () => Promise<void>): Promise<void> {
  await loaded();
  fireEvent.click(checkbox(DEFENDER_TITLE));
  await target();
  await readDefender();
  await chooseGroup();
}

describe("AzureOnboardingScreen - mount and the saved selection", () => {
  it("mounts with exactly one selection load and zero Azure calls", async () => {
    const { azure, store } = mount();
    await loaded();
    expect(store?.loads).toEqual([COVERAGE_SELECTION_KEY]);
    expect(azure.calls).toEqual([]);
  });

  it("a FAILED read keeps Save disabled, and clicking it writes nothing", async () => {
    const store = new FakeKvDocumentStore().scriptLoad(COVERAGE_SELECTION_KEY, {
      kind: "unknown",
      reason: "HTTP 403",
      status: 403,
    });
    mount({ store });
    await loaded();
    expect(screen.getByText(/The saved selection could not be read - HTTP 403/)).toBeTruthy();
    const save = button("Save selection");
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    // Nothing can be ticked either: the selection was never loaded.
    expect(checkbox(DEFENDER_TITLE).disabled).toBe(true);
    await Promise.resolve();
    expect(store.saves).toEqual([]);
  });

  it("a missing document store is a visible gap with Save disabled", async () => {
    const { azure } = mount({ store: null });
    expect(screen.getByText(SHELL_GAP_MESSAGE)).toBeTruthy();
    expect(button("Save selection").disabled).toBe(true);
    expect(azure.calls).toEqual([]);
  });

  it("an absent load shows the defaults, writes nothing, and Save stores kind and version once asked", async () => {
    const { store } = mount();
    await loaded();
    expect(screen.getByText(/No saved selection was found, so the defaults are shown/)).toBeTruthy();
    expect(button("Save selection").disabled).toBe(true);
    expect(store?.saves).toEqual([]);

    fireEvent.click(checkbox(DEFENDER_TITLE));
    expect(button("Save selection").disabled).toBe(false);
    fireEvent.click(button("Save selection"));
    await waitFor(() => expect(store?.saves.length).toBe(1));
    const saved = store?.saves[0];
    expect(saved?.key).toBe(COVERAGE_SELECTION_KEY);
    const doc = saved?.value as { kind: string; version: number; enabled: string[] };
    expect(doc.kind).toBe(COVERAGE_SELECTION_KIND);
    expect(doc.version).toBe(COVERAGE_SELECTION_VERSION);
    expect(doc.enabled).toContain("defenderExport");
    await waitFor(() => expect(button("Save selection").disabled).toBe(true));
  });

  it("a toggle made while a save is in flight stays unsaved, and Save stays enabled for it", async () => {
    const store = new HeldSaveStore();
    mount({ store });
    await loaded();
    fireEvent.click(checkbox(DEFENDER_TITLE));
    fireEvent.click(button("Save selection"));
    await waitFor(() => expect(button("Saving...").disabled).toBe(true));
    // The operator unticks while the write of the TICKED selection is pending.
    fireEvent.click(checkbox(DEFENDER_TITLE));
    expect(checkbox(DEFENDER_TITLE).checked).toBe(false);
    store.release();
    await waitFor(() => expect(store.saves.length).toBe(1));
    await waitFor(() => expect(button("Save selection")).toBeTruthy());
    // The store holds the ticked selection; the screen shows the unticked one.
    const doc = store.saves[0]?.value as { enabled: string[] };
    expect(doc.enabled).toContain("defenderExport");
    expect(checkbox(DEFENDER_TITLE).checked).toBe(false);
    expect(screen.getByText("Unsaved changes.")).toBeTruthy();
    expect(screen.queryByText("Selection saved.")).toBeNull();
    expect(button("Save selection").disabled).toBe(false);
  });

  it("ticking then unticking Defender makes no Azure call", async () => {
    const { azure } = mount();
    await loaded();
    const box = checkbox(DEFENDER_TITLE);
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    expect(checkbox(DEFENDER_TITLE).checked).toBe(true);
    fireEvent.click(checkbox(DEFENDER_TITLE));
    expect(checkbox(DEFENDER_TITLE).checked).toBe(false);
    expect(azure.calls).toEqual([]);
  });
});

describe("AzureOnboardingScreen - the catalog layout", () => {
  it("renders every catalog row, every unsupported source and the XDR row, with the unbuilt ones disabled", async () => {
    const { view } = mount();
    await loaded();
    const rows = view.container.querySelectorAll(".azure-onboarding-row");
    expect(rows.length).toBe(COVERAGE_CATALOG.length + UNSUPPORTED_SOURCES.length + 1);
    expect(screen.getByText(/BehaviorEntities/)).toBeTruthy();
    expect(screen.getByText(/BehaviorInfo/)).toBeTruthy();
    for (const item of COVERAGE_CATALOG) {
      const box = checkbox(item.title);
      expect({ id: item.id, disabled: box.disabled }).toEqual({
        id: item.id,
        disabled: item.id !== "defenderExport",
      });
    }
    // Spelled out, so a catalog edit cannot quietly drop the two named here.
    const entra = COVERAGE_CATALOG.find((i) => i.id === "entraId");
    const policy = COVERAGE_CATALOG.filter((i) => i.method === "built-in-policy" || i.method === "custom-initiative");
    expect(entra).toBeDefined();
    expect(policy.length).toBeGreaterThan(0);
    expect(checkbox(entra?.title ?? "").disabled).toBe(true);
    for (const item of policy) expect(checkbox(item.title).disabled).toBe(true);
  });
});

describe("AzureOnboardingScreen - the Event Hub target", () => {
  it("never offers a Listen-only rule, says why, and keeps Deploy disabled", async () => {
    const azure = new RoutingAzure({ rules: [{ name: "ListenOnly", rights: ["Listen"] }] });
    mount({ azure });
    await loaded();
    fireEvent.click(checkbox(DEFENDER_TITLE));
    await chooseTarget();
    const options = [...select("Authorization rule").options].map((o) => o.value);
    expect(options).toEqual([""]);
    expect(screen.getByText(/None of this namespace's authorization rules can send events: ListenOnly \(Listen\)/)).toBeTruthy();
    await readDefender();
    await chooseGroup();
    expect(button("Deploy alert export").disabled).toBe(true);
    expect(screen.getByText("Choose the namespace authorization rule the export sends with.")).toBeTruthy();
  });

  it("offers the built-in Manage rule without preselecting it, and notes a Send-only rule is safer", async () => {
    mount();
    await loaded();
    await chooseTarget();
    expect(select("Authorization rule").value).toBe("");
    fireEvent.change(select("Authorization rule"), { target: { value: "RootManageSharedAccessKey" } });
    expect(screen.getByText(/A dedicated rule with only Send rights is safer/)).toBeTruthy();
    expect(screen.getByText("Rights: Listen, Manage, Send")).toBeTruthy();
  });

  it("a pasted hub a complete listing does not contain is dropped, named, and cannot be deployed to", async () => {
    const azure = new RoutingAzure({ hubs: [OTHER_HUB] });
    mount({ azure });
    await readyToDeployFrom(async () => {
      await pasteHubId();
      expect(
        screen.getByText(`Event Hub ${HUB} was not found in namespace ${NS_NAME}. Choose an existing Event Hub.`),
      ).toBeTruthy();
      fireEvent.change(select("Authorization rule"), { target: { value: "SendOnly" } });
    });
    expect(select("Event Hub").value).toBe("");
    expect([...select("Event Hub").options].map((o) => o.value)).toEqual(["", OTHER_HUB]);
    expect(button("Deploy alert export").disabled).toBe(true);
    expect(screen.getByText("Choose the Event Hub the alerts go to.")).toBeTruthy();
    expect(azure.puts()).toEqual([]);
  });

  it("a truncated hub listing cannot prove a pasted hub absent, so it stays selectable", async () => {
    const azure = new RoutingAzure({ hubs: [OTHER_HUB], hubsTruncated: true });
    mount({ azure });
    await loaded();
    await chooseTarget("SendOnly");
    expect([...select("Event Hub").options].map((o) => o.value)).toEqual(["", HUB, OTHER_HUB]);
    expect(screen.queryByText(/was not found in namespace/)).toBeNull();
    expect(screen.getByText("Only the first page was listed - Azure returned more.")).toBeTruthy();
  });

  it("the controls this slice does not build are visible and disabled", async () => {
    mount();
    await loaded();
    for (const name of ["Create namespace", "Create Event Hub", "Create Send-only rule", "Remove export"]) {
      expect({ name, disabled: button(name).disabled }).toEqual({ name, disabled: true });
    }
    for (const name of ["Recommendations", "Secure score", "Regulatory compliance"]) {
      const box = checkbox(name);
      expect({ name, disabled: box.disabled, checked: box.checked }).toEqual({
        name,
        disabled: true,
        checked: false,
      });
    }
    const alerts = checkbox("Security alerts");
    expect({ disabled: alerts.disabled, checked: alerts.checked }).toEqual({ disabled: true, checked: true });
  });

  it("finds namespaces with one Resource Graph read and no per-namespace GET", async () => {
    const { azure } = mount();
    await loaded();
    fireEvent.click(button("Find namespaces"));
    await waitFor(() => expect(select("Event Hub namespace").disabled).toBe(false));
    expect(azure.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /providers/Microsoft.ResourceGraph/resources",
    ]);
  });
});

describe("AzureOnboardingScreen - the Defender deploy", () => {
  it("one Deploy click writes nothing; the confirm writes exactly one PUT and says delivery is unverified", async () => {
    const logger = new FakeLogger(() => "t");
    const { azure, view } = mount({ logger });
    await readyToDeploy();

    const deploy = button("Deploy alert export");
    expect(deploy.disabled).toBe(false);
    fireEvent.click(deploy);
    expect(azure.puts()).toEqual([]);
    const confirm = screen.getByRole("group", { name: "Confirm deploy" });
    for (const named of [SUB, TARGET_RG, TARGET_LOCATION, HUB, NS_NAME, "CriblDefenderExport", "SendOnly"]) {
      expect(confirm.textContent).toContain(named);
    }

    fireEvent.click(button("Confirm deploy"));
    await waitFor(() => {
      expect(screen.getByText(/CriblDefenderExport was created and read back from Azure/)).toBeTruthy();
    });
    expect(azure.puts().length).toBe(1);
    // The location is the chosen group's, never CONFIG.location or a constant.
    const putBody = azure.puts()[0]?.body as { location?: unknown } | undefined;
    expect(putBody?.location).toBe(TARGET_LOCATION);
    expect(screen.getByText(/Delivery is not verified until a Defender alert arrives/)).toBeTruthy();
    // The re-read after the write now sees ours: Deploy is off and stays off.
    await waitFor(() => expect(button("Deploy alert export").disabled).toBe(true));
    expect(azure.puts().length).toBe(1);

    // The key went into exactly one request body and nowhere else.
    expect(view.container.innerHTML).not.toContain(SECRET_KEY);
    expect(document.body.innerHTML).not.toContain(SECRET_KEY);
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(azure.puts()[0]?.body)).toContain(SECRET_KEY);
  });

  /**
   * Every input the confirm names, plus the read it was armed against. Each
   * change must remove the confirm, and changing the input BACK must not bring
   * it back: a stale arm is cleared, not merely hidden.
   */
  const DISARMERS: Array<{ input: string; change: () => Promise<void>; revert?: () => Promise<void> }> = [
    {
      input: "the authorization rule",
      change: async () => {
        fireEvent.change(select("Authorization rule"), { target: { value: "RootManageSharedAccessKey" } });
      },
      revert: async () => {
        fireEvent.change(select("Authorization rule"), { target: { value: "SendOnly" } });
      },
    },
    {
      input: "the resource group",
      change: async () => {
        fireEvent.change(select("Resource group"), { target: { value: EH_RG } });
      },
      revert: async () => {
        fireEvent.change(select("Resource group"), { target: { value: TARGET_RG } });
      },
    },
    {
      input: "the Event Hub",
      change: async () => {
        fireEvent.change(select("Event Hub"), { target: { value: OTHER_HUB } });
      },
      revert: async () => {
        fireEvent.change(select("Event Hub"), { target: { value: HUB } });
      },
    },
    {
      input: "the namespace",
      change: async () => {
        fireEvent.change(screen.getByRole("textbox", { name: "Namespace or Event Hub resource id" }), {
          target: { value: `${NS_B_ID}/eventhubs/${HUB}` },
        });
        fireEvent.click(button("Use this id"));
        await waitFor(() => {
          expect(screen.queryByText("Reading hubs and authorization rules...")).toBeNull();
          expect(screen.getByText(new RegExp(`Namespace ${NS_B} in resource group`))).toBeTruthy();
        });
        fireEvent.change(select("Authorization rule"), { target: { value: "SendOnly" } });
      },
    },
    {
      input: "the Defender tick",
      change: async () => {
        fireEvent.click(checkbox(DEFENDER_TITLE));
      },
      revert: async () => {
        fireEvent.click(checkbox(DEFENDER_TITLE));
      },
    },
    {
      input: "a fresh Defender read",
      change: async () => {
        await readDefender();
      },
    },
  ];

  for (const { input, change, revert } of DISARMERS) {
    it(`changing ${input} disarms the confirm, and changing it back does not re-arm it`, async () => {
      const { azure } = mount();
      await readyToDeploy();
      fireEvent.click(button("Deploy alert export"));
      expect(screen.getByRole("group", { name: "Confirm deploy" })).toBeTruthy();
      await change();
      expect(screen.queryByRole("group", { name: "Confirm deploy" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Confirm deploy" })).toBeNull();
      if (revert !== undefined) {
        await revert();
        expect(button("Deploy alert export").disabled).toBe(false);
        expect(screen.queryByRole("group", { name: "Confirm deploy" })).toBeNull();
      }
      expect(azure.puts()).toEqual([]);
    });
  }

  it("legacy's CriblDefenderExport in CriblSecurityExport disables Deploy, and nothing is written", async () => {
    const azure = new RoutingAzure({
      automations: [automation({ name: "CriblDefenderExport", rg: "CriblSecurityExport", target: NS_ID })],
    });
    mount({ azure });
    await readyToDeploy();
    expect(screen.getByText(/CriblDefenderExport already exists in CriblSecurityExport/)).toBeTruthy();
    const deploy = button("Deploy alert export");
    expect(deploy.disabled).toBe(true);
    fireEvent.click(deploy);
    expect(screen.queryByRole("group", { name: "Confirm deploy" })).toBeNull();
    expect(azure.puts()).toEqual([]);
    expect(azure.calls.filter((c) => c.path.endsWith("/listKeys"))).toEqual([]);
    expect(screen.getByText("Deployed")).toBeTruthy();
  });

  it("a broken export is named as a warning, Repair is disabled, and Deploy writes nothing", async () => {
    const azure = new RoutingAzure({
      automations: [automation({ name: "CriblDefenderExport", rg: "CriblSecurityExport", enabled: false })],
    });
    mount({ azure });
    await readyToDeploy();
    // The present-differs warning's own text: the Deploy disabled-reason hint
    // repeats the diffs, so matching the diff alone would pass without it.
    expect(
      screen.getByText(
        /CriblDefenderExport exists in CriblSecurityExport but differs from what this app writes: .*The export is not enabled\./,
      ),
    ).toBeTruthy();
    expect(button("Repair export").disabled).toBe(true);
    expect(button("Deploy alert export").disabled).toBe(true);
    expect(azure.puts()).toEqual([]);
  });

  it("another export to the same hub is flagged as a possible duplicate and blocks Deploy", async () => {
    const azure = new RoutingAzure({
      automations: [automation({ name: "PortalExport", rg: "rg-other", target: HUB_ID })],
    });
    mount({ azure });
    await readyToDeploy();
    expect(screen.getByText(/Possible duplicate - already sends to the chosen Event Hub/)).toBeTruthy();
    expect(button("Deploy alert export").disabled).toBe(true);
    expect(screen.getByText(/Deploying would deliver every alert twice/)).toBeTruthy();
    expect(azure.puts()).toEqual([]);
  });

  it("an automations list that failed marks the Defender row as unread, never as not selected", async () => {
    const azure = new RoutingAzure({ automationsResponse: fail(500) });
    mount({ azure });
    await loaded();
    fireEvent.click(button("Read Defender state"));
    await waitFor(() => {
      expect(screen.getByText(/^Deployment state could not be read - /)).toBeTruthy();
    });
    expect(button("Deploy alert export").disabled).toBe(true);
  });
});

describe("AzureOnboardingScreen - the plans read", () => {
  /** What a "no paid plan" claim looks like, in any of its wordings. */
  const NO_PLAN = /no (paid )?plans? (is |are )?enabled/i;

  it("a refused plans read never claims that no paid plan is enabled", async () => {
    const azure = new RoutingAzure({ pricings: fail(403, "AuthorizationFailed") });
    const { view } = mount({ azure });
    await loaded();
    await readDefender();
    expect(screen.getByText(/Defender plans could not be read - Azure refused the request/)).toBeTruthy();
    expect(view.container.textContent ?? "").not.toMatch(NO_PLAN);
    expect(screen.queryByRole("table", { name: "Defender plans" })).toBeNull();
  });

  it("the same pattern does catch a real read with every plan off (the pin can fail)", async () => {
    const azure = new RoutingAzure({
      pricings: ok({ value: DEFENDER_PLANS.map((p) => ({ name: p.name, properties: { pricingTier: "Free" } })) }),
    });
    const { view } = mount({ azure });
    await loaded();
    await readDefender();
    expect(view.container.textContent ?? "").toMatch(NO_PLAN);
    const table = screen.getByRole("table", { name: "Defender plans" });
    expect(table.querySelectorAll("tbody tr").length).toBe(DEFENDER_PLANS.length);
  });

  it("lists an unrecognised Standard plan, and says the app never enables one", async () => {
    const azure = new RoutingAzure({
      pricings: ok({ value: [{ name: "CloudPosture", properties: { pricingTier: "Standard" } }] }),
    });
    const { view } = mount({ azure });
    await loaded();
    await readDefender();
    expect(screen.getByText("Enabled, not in the known plan list")).toBeTruthy();
    expect(view.container.textContent ?? "").not.toMatch(NO_PLAN);
    expect(screen.getByText(/It never turns a plan on or changes a plan's tier/)).toBeTruthy();
    expect(screen.getByText(/Needed, not yet measured/)).toBeTruthy();
  });
});
