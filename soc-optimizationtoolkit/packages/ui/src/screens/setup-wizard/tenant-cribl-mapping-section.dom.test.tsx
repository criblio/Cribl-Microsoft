// @vitest-environment happy-dom
/**
 * AZR-64: the Setup section that maps each Azure tenant (connection profile)
 * to a Cribl Stream worker group (ADR 0009 decision 5).
 *
 * What these pins protect, each one a way the section could quietly do harm:
 *   - mount reads the one mapping document and makes no Cribl call;
 *   - nothing is chosen by default: the mode starts "Not chosen" and nothing
 *     is written until the operator saves;
 *   - two connections for one tenant are one row, keyed by the tenant;
 *   - switching mode keeps the other mode's choices in what is saved;
 *   - an unreadable or foreign document disables every control and is never
 *     overwritten (a failed read is not a first run);
 *   - a connection with no tenant id is named as unmappable, never dropped.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  FakeKvDocumentStore,
  FakeLogger,
  TENANT_CRIBL_MAPPING_KEY,
  TENANT_CRIBL_MAPPING_KIND,
  TENANT_CRIBL_MAPPING_VERSION,
} from "@soc/core";
import type { AzureConfig, CriblClient, CriblGroupSummary, CriblRequest, Listing, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { TenantCriblMappingSection } from "./tenant-cribl-mapping-section";

afterEach(cleanup);

const TA = "aaaaaaaa-0000-0000-0000-000000000001";
const TB = "bbbbbbbb-0000-0000-0000-000000000002";

const PROFILES = [
  { name: "Contoso prod", config: { tenantId: TA } },
  { name: "Fabrikam", config: { tenantId: TB } },
  { name: "Contoso lab", config: { tenantId: TA.toUpperCase() } },
  { name: "Unfinished", config: { tenantId: "" } },
];

class CountingCribl implements CriblClient {
  readonly calls: CriblRequest[] = [];
  listGroupsCalls = 0;
  private readonly groups: string[];
  private readonly refuse: boolean;
  constructor(groups: string[] = ["default", "g-a", "g-b"], refuse = false) {
    this.groups = groups;
    this.refuse = refuse;
  }
  async request(r: CriblRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    throw new Error("CountingCribl: no request expected");
  }
  async listGroups(): Promise<Listing<CriblGroupSummary>> {
    this.listGroupsCalls++;
    if (this.refuse) throw new Error("HTTP 403");
    return {
      kind: "rows",
      rows: this.groups.map((id) => ({ id, product: "stream" })),
    } as unknown as Listing<CriblGroupSummary>;
  }
}

function mount(opts: { store?: FakeKvDocumentStore; cribl?: CountingCribl; profiles?: typeof PROFILES } = {}) {
  const store = opts.store ?? new FakeKvDocumentStore();
  const cribl = opts.cribl ?? new CountingCribl();
  const ports = { cribl, kvDocuments: store, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  render(
    <PortsProvider ports={ports} config={{ tenantId: TA } as unknown as AzureConfig}>
      <TenantCriblMappingSection profiles={opts.profiles ?? PROFILES} />
    </PortsProvider>,
  );
  return { store, cribl };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
function picker(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}
function choose(label: string, optionLabel: string): void {
  fireEvent.click(picker(label));
  const option = [...document.querySelectorAll(".searchable-select-option")].find(
    (o) => (o.querySelector(".searchable-select-option-label")?.textContent ?? "") === optionLabel,
  );
  if (option === undefined) throw new Error(`no option ${optionLabel} in ${label}`);
  fireEvent.click(option);
}
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByText("Reading the tenant to Cribl mapping...")).toBeNull());
}
async function loadGroups(cribl: CountingCribl): Promise<void> {
  fireEvent.click(button("Load worker groups"));
  await waitFor(() => expect(cribl.listGroupsCalls).toBe(1));
}

function stored(over: Record<string, unknown> = {}): unknown {
  return {
    kind: TENANT_CRIBL_MAPPING_KIND,
    version: TENANT_CRIBL_MAPPING_VERSION,
    mode: null,
    sharedGroup: null,
    groups: {},
    ...over,
  };
}

const PER_TENANT_LABEL_A = `Worker group for Contoso prod, Contoso lab (${TA})`;
const PER_TENANT_LABEL_B = `Worker group for Fabrikam (${TB})`;

describe("TenantCriblMappingSection", () => {
  it("mounts reading only the mapping document, makes no Cribl call, and chooses nothing", async () => {
    const { store, cribl } = mount();
    await loaded();
    expect(store.loads).toEqual([TENANT_CRIBL_MAPPING_KEY]);
    expect(cribl.calls).toEqual([]);
    expect(cribl.listGroupsCalls).toBe(0);
    expect(picker("Mapping mode").textContent).toContain("Not chosen");
    expect(button("Save mapping").disabled).toBe(true);
    expect(store.saves).toEqual([]);
    // The panel carries its (i).
    expect(screen.getAllByRole("button", { name: "More information" }).length).toBeGreaterThan(0);
  });

  it("a worker group per tenant: one row per TENANT, and Save stores exactly the choices made", async () => {
    const { store, cribl } = mount();
    await loaded();
    choose("Mapping mode", "A worker group per tenant");
    await loadGroups(cribl);
    // Two connections for tenant A are one row.
    expect(screen.getAllByRole("button", { name: PER_TENANT_LABEL_A }).length).toBe(1);
    choose(PER_TENANT_LABEL_A, "g-a");
    choose(PER_TENANT_LABEL_B, "g-b");
    fireEvent.click(button("Save mapping"));
    await waitFor(() => expect(store.saves.length).toBe(1));
    expect(store.saves[0]).toEqual({
      key: TENANT_CRIBL_MAPPING_KEY,
      value: stored({ mode: "per-tenant", groups: { [TA]: "g-a", [TB]: "g-b" } }),
    });
    expect(await screen.findByText("Mapping saved.")).toBeTruthy();
    expect(button("Save mapping").disabled).toBe(true);
  });

  it("one worker group for every tenant keeps the per-tenant choices underneath", async () => {
    const store = new FakeKvDocumentStore({
      [TENANT_CRIBL_MAPPING_KEY]: stored({ mode: "per-tenant", groups: { [TA]: "g-a" } }),
    });
    const { cribl } = mount({ store });
    await loaded();
    choose("Mapping mode", "One worker group for every tenant");
    await loadGroups(cribl);
    choose("Worker group for every tenant", "default");
    fireEvent.click(button("Save mapping"));
    await waitFor(() => expect(store.saves.length).toBe(1));
    expect(store.saves[0]?.value).toEqual(stored({ mode: "shared", sharedGroup: "default", groups: { [TA]: "g-a" } }));
  });

  it("shows saved groups before any listing, and names a saved group the listing does not contain", async () => {
    const store = new FakeKvDocumentStore({
      [TENANT_CRIBL_MAPPING_KEY]: stored({ mode: "per-tenant", groups: { [TA]: "gone-group" } }),
    });
    const { cribl } = mount({ store });
    await loaded();
    expect(screen.getByText(/gone-group/)).toBeTruthy();
    await loadGroups(cribl);
    expect(picker(PER_TENANT_LABEL_A).textContent).toContain("gone-group (not in the listing)");
  });

  it("an UNREADABLE mapping disables every control and is never overwritten", async () => {
    const store = new FakeKvDocumentStore().scriptLoad(TENANT_CRIBL_MAPPING_KEY, {
      kind: "unknown",
      reason: "HTTP 403",
      status: 403,
    });
    mount({ store });
    await loaded();
    expect(screen.getByText(/The tenant to Cribl mapping could not be read - HTTP 403/)).toBeTruthy();
    expect(picker("Mapping mode").disabled).toBe(true);
    const save = button("Save mapping");
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await Promise.resolve();
    expect(store.saves).toEqual([]);
  });

  it("a document this app did not write is never overwritten", async () => {
    const store = new FakeKvDocumentStore({ [TENANT_CRIBL_MAPPING_KEY]: { kind: "other", mode: "shared" } });
    mount({ store });
    await loaded();
    expect(screen.getByText(/not a tenant to Cribl mapping this app wrote/)).toBeTruthy();
    expect(picker("Mapping mode").disabled).toBe(true);
    expect(button("Save mapping").disabled).toBe(true);
  });

  it("names the connections with no tenant id instead of dropping them", async () => {
    mount();
    await loaded();
    expect(screen.getByText("Connections with no tenant id cannot be mapped yet: Unfinished.")).toBeTruthy();
  });

  it("a failed save says so and keeps the changes unsaved", async () => {
    const store = new FakeKvDocumentStore().failSaves();
    mount({ store });
    await loaded();
    choose("Mapping mode", "A worker group per tenant");
    fireEvent.click(button("Save mapping"));
    const failure = await screen.findByText(/The mapping was not saved - PUT kvstore: HTTP 500/);
    expect(button("Save mapping").disabled).toBe(false);
    // A failure must not look like "Mapping saved.": error tone, announced.
    expect(failure.getAttribute("role")).toBe("alert");
    expect(failure.className).toContain("azure-onboarding-banner-error");
  });

  it("a successful save reads as information, not an alert", async () => {
    mount();
    await loaded();
    choose("Mapping mode", "A worker group per tenant");
    fireEvent.click(button("Save mapping"));
    const ok = await screen.findByText("Mapping saved.");
    expect(ok.getAttribute("role")).toBeNull();
    expect(ok.className).toContain("azure-onboarding-banner-info");
  });

  it("an unreadable mapping is announced as an error", async () => {
    const store = new FakeKvDocumentStore().scriptLoad(TENANT_CRIBL_MAPPING_KEY, {
      kind: "unknown",
      reason: "HTTP 403",
      status: 403,
    });
    mount({ store });
    await loaded();
    const line = screen.getByText(/The tenant to Cribl mapping could not be read - HTTP 403/);
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.className).toContain("azure-onboarding-banner-error");
  });

  // An unread or permission-filtered listing must not hide a mapping that WAS
  // read: the onboarding screen still routes the tenant to the saved group.
  it("a refused worker-group listing still shows the saved shared group", async () => {
    const store = new FakeKvDocumentStore({
      [TENANT_CRIBL_MAPPING_KEY]: stored({ mode: "shared", sharedGroup: "prod" }),
    });
    const cribl = new CountingCribl([], true);
    mount({ store, cribl });
    await loaded();
    await loadGroups(cribl);
    expect(await screen.findByText(/Could not list worker groups/)).toBeTruthy();
    expect(screen.getByText(/Saved: prod\./)).toBeTruthy();
  });

  it("an empty worker-group listing still shows each tenant's saved group", async () => {
    const store = new FakeKvDocumentStore({
      [TENANT_CRIBL_MAPPING_KEY]: stored({ mode: "per-tenant", groups: { [TA]: "tenant-a-wg" } }),
    });
    const cribl = new CountingCribl([]);
    mount({ store, cribl });
    await loaded();
    await loadGroups(cribl);
    await waitFor(() => expect(screen.queryByText("Loading worker groups...")).toBeNull());
    expect(screen.getByText(/Saved: tenant-a-wg\./)).toBeTruthy();
    expect(screen.getAllByText(/No group chosen\./).length).toBe(1);
  });
});
