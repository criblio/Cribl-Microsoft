// @vitest-environment happy-dom
/**
 * Azure Native Source Onboarding with Tenant Logging Gaps folded in (AZR-147,
 * ADR 0009 decision 6 amendment 2026-11-19).
 *
 * What these pins protect, one per operator decision:
 *   1. All tenants opens the page, collapsed, holding the grid; the active row
 *      is highlighted; collapsing hides it without unmounting it.
 *   2. The old route's signal opens All tenants.
 *   3. Open on the active tenant jumps to the source's row; on another tenant
 *      a confirm naming tenant and source comes first, the switch is the
 *      shell's, and it is REFUSED with the reason while a Read all, the
 *      credential slot or another tab's lease holds the slot.
 *   4. Each tenant's latest read is saved in ONE KV document and seeds the grid
 *      and Focus after a reload; mount loads that document and reads nothing
 *      from Azure, Graph or Cribl; a missing or unreadable document is "not
 *      read yet", never green.
 *   5. Focus here lists the red sources with their reasons and jump links,
 *      counts unknown sources apart, shows the read's age, and the chooser
 *      badges each red source.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  CREDENTIAL_LEASE_KEY,
  FakeKvDocumentStore,
  FakeLogger,
  GAP_SOURCES,
  TENANT_GAP_READS_KEY,
  emptyGapReads,
  encodeGapReads,
  rowUnknown,
  takenLease,
  withGapRead,
} from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  BatchPacing,
  CriblClient,
  CriblRequest,
  GapCell,
  GraphDirectory,
  PortHttpResponse,
  TenantBatchRun,
  TenantPorts,
  TenantProfile,
  TenantRun,
  TenantSession,
} from "@soc/core";
import { PortsProvider } from "../../../ports-context";
import type { UiPorts } from "../../../ports-context";
import { TenantGapCache } from "../../tenant-gap/tenant-gap-state";
import { howtoRowAnchorId } from "../howto/howto-state";
import { AzureOnboardingPage } from "./azure-onboarding-page";
import type { AzureOnboardingPageProps } from "./azure-onboarding-page";
import { FOCUS_CANCELLED_TEXT } from "./focus-summary";
import { SWITCH_REFUSED_ACTIVE_CHANGED, SWITCH_REFUSED_READ_ALL, switchConfirmText } from "./tenant-switch";

afterEach(cleanup);

const TA = "aaaaaaaa-0000-0000-0000-000000000001";
const TB = "bbbbbbbb-0000-0000-0000-000000000002";
const PROFILES = [
  { id: "pa", name: "Contoso", config: { tenantId: TA, clientId: "ca", subscriptionId: "sub-a", resourceGroup: "rg" } },
  { id: "pb", name: "Fabrikam", config: { tenantId: TB, clientId: "cb", subscriptionId: "sub-b", resourceGroup: "rg" } },
];
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const PACING: BatchPacing = { now: () => 0, sleep: () => Promise.resolve() };
const [RED_SOURCE, UNKNOWN_SOURCE] = GAP_SOURCES;
const AZURE_RED_REASON = "Not configured as planned: the Activity Log diagnostic setting was not found.";

class CountingAzure implements AzureManagement {
  readonly sent: AzureManagementRequest[] = [];
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.sent.push(r);
    return { status: 403, body: { error: { code: "AuthorizationFailed" } } };
  }
}

class CountingCribl implements CriblClient {
  readonly calls: CriblRequest[] = [];
  request(r: CriblRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    return Promise.resolve({ status: 200, body: { items: [] } });
  }
  listGroups(): never {
    throw new Error("not used");
  }
}

class FakeSession implements TenantSession {
  readonly runs: string[] = [];
  private readonly azure: AzureManagement;
  constructor(azure: AzureManagement) {
    this.azure = azure;
  }
  async runForTenant<T>(profile: TenantProfile, work: (ports: TenantPorts) => Promise<T>): Promise<TenantRun<T>> {
    this.runs.push(profile.id);
    const value = await work({ azure: this.azure, graph: {} as GraphDirectory });
    return { kind: "done", tenantId: profile.config.tenantId, value, restore: { kind: "not-needed" } };
  }
  async runBatch<R>(body: (session: TenantSession) => Promise<R>): Promise<TenantBatchRun<R>> {
    const value = await body(this);
    return { value, restore: { kind: "restored" } };
  }
}

/** A saved row for Contoso: the first source red on Azure, the second unknown, the rest green. */
function savedCells(): GapCell[] {
  return GAP_SOURCES.map((s) => ({
    sourceId: s.id,
    azure:
      s.id === RED_SOURCE!.id
        ? { state: "red", reason: AZURE_RED_REASON }
        : s.id === UNKNOWN_SOURCE!.id
          ? { state: "unknown", reason: "Could not tell: denied." }
          : { state: "green", reason: "Configured." },
    cribl: { state: "green", reason: "Onboarded." },
  }));
}

function savedDoc(readAt = NOW - 2 * 60 * 60 * 1000): unknown {
  const reads = withGapRead(emptyGapReads(), {
    readAt,
    row: {
      profileId: "pa",
      tenantId: TA,
      cells: savedCells(),
      status: { state: "green", reason: "Read and proven." },
      warnings: [],
      plannedReads: 4,
      cancelled: false,
    },
  });
  return JSON.parse(encodeGapReads(reads));
}

/** Holds the next credential-lease load until `release`, so a test can act while the confirm says "Checking...". */
class HeldLeaseStore extends FakeKvDocumentStore {
  private gate: Promise<void> | null = null;
  release: () => void = () => undefined;
  holdLease(): this {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return this;
  }
  override async load(key: string) {
    const gate = key === CREDENTIAL_LEASE_KEY ? this.gate : null;
    if (gate !== null) {
      this.gate = null;
      await gate;
    }
    return super.load(key);
  }
}

/** Let every queued promise continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => Promise.resolve());
}

function configFor(tenantId: string): AzureConfig {
  return { tenantId, clientId: "c", subscriptionId: "sub-a", resourceGroup: "rg" } as unknown as AzureConfig;
}

function mount(opts: {
  store?: FakeKvDocumentStore;
  cache?: TenantGapCache;
  activeProfileId?: string;
  extra?: Partial<AzureOnboardingPageProps>;
} = {}) {
  const azure = new CountingAzure();
  const cribl = new CountingCribl();
  const store = opts.store ?? new FakeKvDocumentStore();
  const cache = opts.cache ?? new TenantGapCache();
  const session = new FakeSession(azure);
  const switched: string[] = [];
  const ports = { azure, cribl, kvDocuments: store, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  const active = opts.activeProfileId ?? "pa";
  const page = (activeProfileId: string, extra: Partial<AzureOnboardingPageProps> = {}) => (
    <PortsProvider ports={ports} config={configFor(activeProfileId === "pa" ? TA : TB)}>
      <AzureOnboardingPage
        profiles={PROFILES}
        activeProfileId={activeProfileId}
        tenantGapCache={cache}
        tenantSession={session}
        onSwitchConnection={(id) => switched.push(id)}
        leaseHolderId="this-tab"
        pacing={PACING}
        now={() => NOW}
        {...(opts.extra ?? {})}
        {...extra}
      />
    </PortsProvider>
  );
  const view = render(page(active));
  return { azure, cribl, store, cache, session, switched, rerender: (id: string, extra?: Partial<AzureOnboardingPageProps>) => view.rerender(page(id, extra)) };
}

const disclosure = () => screen.getByRole("button", { name: /^(Show|Hide) all tenants$/ });
/** Open All tenants, so the grid's controls are reachable as an operator reaches them. */
const expand = () => {
  if (disclosure().getAttribute("aria-expanded") === "false") fireEvent.click(disclosure());
};
const allTenantsBody = () => document.getElementById("azo-all-tenants-body")!;
const chooserRow = (id: string) => document.getElementById(howtoRowAnchorId(id as never));

describe("1. All tenants opens the page", () => {
  it("is collapsed by default, holds the grid, and highlights the active row", async () => {
    mount({ activeProfileId: "pb" });
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
    expect(disclosure().textContent).toBe("Show all tenants");
    expect(allTenantsBody().hidden).toBe(true);
    expect(allTenantsBody().querySelectorAll("tr").length).toBe(PROFILES.length + 1);
    const rows = [...allTenantsBody().querySelectorAll<HTMLElement>("tbody tr")];
    expect(rows.map((r) => r.dataset.active ?? "")).toEqual(["", "true"]);
    fireEvent.click(disclosure());
    expect(allTenantsBody().hidden).toBe(false);
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    // The All tenants section sits above the onboarding screen.
    const page = document.body.innerHTML;
    expect(page.indexOf("azo-all-tenants")).toBeLessThan(page.indexOf("Choose what to onboard"));
  });

  it("collapsing hides a running Read all but does not cancel it", async () => {
    const { session } = mount();
    fireEvent.click(disclosure());
    fireEvent.click(screen.getByRole("button", { name: "Read all tenants" }));
    fireEvent.click(disclosure());
    expect(allTenantsBody().hidden).toBe(true);
    await waitFor(() => expect(session.runs).toEqual(["pa", "pb"]));
    expect(screen.queryByText(/Reading was cancelled/)).toBeNull();
  });
});

describe("2. the old tenant-gaps route opens All tenants", () => {
  it("a new signal expands the section; mounting with one starts expanded", () => {
    const m = mount();
    expect(allTenantsBody().hidden).toBe(true);
    m.rerender("pa", { openAllTenantsSignal: 1 });
    expect(allTenantsBody().hidden).toBe(false);
    cleanup();
    mount({ extra: { openAllTenantsSignal: 3 } });
    expect(allTenantsBody().hidden).toBe(false);
  });
});

describe("3. following a gap", () => {
  it("Open on the active tenant focuses that source's row in the chooser", async () => {
    mount();
    expand();
    await waitFor(() => expect(chooserRow(RED_SOURCE!.id)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: `Open ${RED_SOURCE!.title} on this page` }));
    await waitFor(() => expect(document.activeElement).toBe(chooserRow(RED_SOURCE!.id)));
    expect(screen.queryByRole("group", { name: "Confirm switching the active tenant" })).toBeNull();
  });

  it("Open on another tenant asks first, naming tenant and source; Cancel switches nothing", () => {
    const { switched, store } = mount();
    expand();
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${RED_SOURCE!.title}` }));
    const confirm = screen.getByRole("group", { name: "Confirm switching the active tenant" });
    expect(within(confirm).getByText(switchConfirmText("Fabrikam", RED_SOURCE!.title))).toBeTruthy();
    expect(switchConfirmText("Fabrikam", "Azure Activity Log")).toBe("Switch the active tenant to Fabrikam and open Azure Activity Log?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm switching the active tenant" })).toBeNull();
    expect(switched).toEqual([]);
    expect(store.loads.filter((k) => k === CREDENTIAL_LEASE_KEY)).toEqual([]);
  });

  it("the confirm reads the lease, switches with the shell's switch, and jumps once the screen is the new tenant's", async () => {
    const m = mount();
    expand();
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${RED_SOURCE!.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() => expect(m.switched).toEqual(["pb"]));
    expect(m.store.loads.filter((k) => k === CREDENTIAL_LEASE_KEY).length).toBe(1);
    // The shell re-renders with the new active connection.
    m.rerender("pb");
    await waitFor(() => expect(document.activeElement).toBe(chooserRow(RED_SOURCE!.id)));
    expect(m.azure.sent).toEqual([]);
  });

  it("refuses while a Read all holds the slot, and says why", async () => {
    const cache = new TenantGapCache();
    let finish: () => void = () => undefined;
    cache.track(new Promise<void>((r) => (finish = r)));
    const { switched } = mount({ cache });
    expand();
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${RED_SOURCE!.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SWITCH_REFUSED_READ_ALL));
    expect(switched).toEqual([]);
    await act(async () => finish());
  });

  it("refuses while the credential slot is busy, quoting the shell's reason", async () => {
    const { switched, store } = mount({ extra: { slotBusyReason: () => "an Azure change is being sent from this tab" } });
    expand();
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${RED_SOURCE!.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Not switched: an Azure change is being sent from this tab. Try again when it finishes.",
      ),
    );
    expect(switched).toEqual([]);
    // Refused before the lease was even read.
    expect(store.loads.filter((k) => k === CREDENTIAL_LEASE_KEY)).toEqual([]);
  });

  it("refuses while another tab holds the lease, and while the lease cannot be read", async () => {
    const held = new FakeKvDocumentStore({ [CREDENTIAL_LEASE_KEY]: takenLease("other-tab", NOW, 60_000) });
    const a = mount({ store: held });
    expand();
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${RED_SOURCE!.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Not switched: another tab of this app is reading a tenant through the shared credential right now. Try again when it finishes.",
      ),
    );
    expect(a.switched).toEqual([]);
    cleanup();

    const unreadable = new FakeKvDocumentStore().scriptLoad(CREDENTIAL_LEASE_KEY, { kind: "unknown", reason: "HTTP 503" });
    const b = mount({ store: unreadable });
    expand();
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${RED_SOURCE!.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("the credential lease could not be read (HTTP 503)"));
    expect(b.switched).toEqual([]);
  });

  it("this tab's own lease does not block the switch", async () => {
    const own = new FakeKvDocumentStore({ [CREDENTIAL_LEASE_KEY]: takenLease("this-tab", NOW, 60_000) });
    const { switched } = mount({ store: own });
    expand();
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${RED_SOURCE!.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    await waitFor(() => expect(switched).toEqual(["pb"]));
  });
});

describe("4. gap reads saved per tenant", () => {
  it("mount loads the saved reads once and reads nothing from Azure, Graph or Cribl", async () => {
    const { azure, cribl, session, store } = mount();
    await waitFor(() => expect(store.loads).toContain(TENANT_GAP_READS_KEY));
    expect(store.loads.filter((k) => k === TENANT_GAP_READS_KEY).length).toBe(1);
    expect(azure.sent).toEqual([]);
    expect(cribl.calls).toEqual([]);
    expect(session.runs).toEqual([]);
    expect(store.saves).toEqual([]);
  });

  it("a saved read seeds the grid with its age, and survives a reload", async () => {
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: savedDoc() });
    mount({ store });
    const row = await waitFor(() => {
      const r = allTenantsBody().querySelector<HTMLElement>('[data-profile="pa"]')!;
      expect(within(r).getByText(/^Read at .*, 2 hours ago$/)).toBeTruthy();
      return r;
    });
    const red = row.querySelector<HTMLElement>(`[data-side="azure"][data-source="${RED_SOURCE!.id}"]`)!;
    expect(red.dataset.state).toBe("red");
    // The other tenant has nothing saved: not read yet.
    expect(within(allTenantsBody().querySelector<HTMLElement>('[data-profile="pb"]')!).getByText("Not read yet")).toBeTruthy();
  });

  it("a document this release cannot read seeds nothing - every cell unknown, never green - and says why", async () => {
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: { kind: "tenant-gap-reads", version: 2, tenants: {} } });
    mount({ store });
    await waitFor(() => expect(screen.getByText(/written by a newer release/)).toBeTruthy());
    const states = [...allTenantsBody().querySelectorAll<HTMLElement>("[data-state]")].map((e) => e.dataset.state);
    expect(states.length).toBe(PROFILES.length * GAP_SOURCES.length * 2);
    expect(new Set(states)).toEqual(new Set(["unknown"]));
    expect(screen.getByText("No gap read is saved for Contoso yet, so its gaps are not known.")).toBeTruthy();
  });

  it("a complete read is saved under its tenant, merged with what is stored", async () => {
    const other = withGapRead(emptyGapReads(), {
      readAt: 5,
      row: { profileId: "pb", tenantId: TB, cells: rowUnknown("x"), status: { state: "unknown", reason: "x" }, warnings: [], plannedReads: 0, cancelled: false },
    });
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: JSON.parse(encodeGapReads(other)) });
    mount({ store });
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Read Contoso" }));
    await waitFor(() => expect(store.saves.filter((s) => s.key === TENANT_GAP_READS_KEY).length).toBe(1));
    const saved = JSON.parse(store.saves.find((s) => s.key === TENANT_GAP_READS_KEY)!.value as string) as {
      tenants: Record<string, { readAt: number; profileId: string }>;
    };
    expect(Object.keys(saved.tenants).sort()).toEqual([TA, TB]);
    expect(saved.tenants[TA]).toMatchObject({ readAt: NOW, profileId: "pa" });
    expect(saved.tenants[TB]).toMatchObject({ readAt: 5, profileId: "pb" });
  });

  it("never saves over a document this release cannot read, and says the read was not saved", async () => {
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: { kind: "someone-else" } });
    mount({ store });
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Read Contoso" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "The gap read of Contoso was not saved: the saved gap reads key holds a document this app did not write. It shows until the page is reloaded.",
        ),
      ).toBeTruthy(),
    );
    expect(store.saves).toEqual([]);
  });
});

describe("5. Focus here", () => {
  it("lists each red source with its reason and a jump link, counts unknown apart, and shows the age", async () => {
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: savedDoc() });
    mount({ store });
    const counts = await waitFor(() => screen.getByTestId("azo-focus-counts"));
    expect(counts.textContent).toBe(
      `1 source with a gap, 1 not read or unknown, ${GAP_SOURCES.length - 2} configured and onboarded.`,
    );
    expect(screen.getByTestId("azo-focus-read-at").textContent).toMatch(/^Read at .*, 2 hours ago\. /);
    const gaps = [...document.querySelectorAll<HTMLElement>(".azo-focus-gap")];
    expect(gaps.map((g) => g.dataset.source)).toEqual([RED_SOURCE!.id]);
    expect(within(gaps[0]!).getByText("Azure: Not configured")).toBeTruthy();
    expect(within(gaps[0]!).getByText(AZURE_RED_REASON)).toBeTruthy();
    await waitFor(() => expect(chooserRow(RED_SOURCE!.id)).not.toBeNull());
    fireEvent.click(within(gaps[0]!).getByRole("button", { name: `Go to ${RED_SOURCE!.title} on this page` }));
    await waitFor(() => expect(document.activeElement).toBe(chooserRow(RED_SOURCE!.id)));
  });

  it("badges each red source's row in the chooser, and only those", async () => {
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: savedDoc() });
    mount({ store });
    await waitFor(() => expect(screen.getByTestId(`azo-gap-badge-${RED_SOURCE!.id}`)).toBeTruthy());
    expect(document.querySelectorAll('[data-testid^="azo-gap-badge-"]').length).toBe(1);
  });

  it("with no saved read for the active tenant, says so and offers to open All tenants", async () => {
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: savedDoc() });
    mount({ store, activeProfileId: "pb" });
    expect(screen.getByText("No gap read is saved for Fabrikam yet, so its gaps are not known.")).toBeTruthy();
    expect(document.querySelectorAll('[data-testid^="azo-gap-badge-"]').length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Open All tenants to read it" }));
    expect(allTenantsBody().hidden).toBe(false);
  });
});

describe("3b. the switch happens only for the confirm on screen (review round 1)", () => {
  const openFabrikam = (source = RED_SOURCE!) =>
    fireEvent.click(screen.getByRole("button", { name: `Switch to Fabrikam and open ${source.title}` }));
  const confirmGroup = () => screen.queryByRole("group", { name: "Confirm switching the active tenant" });

  it("a Cancel while the lease is read drops the switch: the shell switch is never called", async () => {
    const store = new HeldLeaseStore().holdLease();
    const m = mount({ store });
    expand();
    openFabrikam();
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    expect(screen.getByRole("button", { name: "Checking..." })).toBeTruthy();
    fireEvent.click(within(confirmGroup()!).getByRole("button", { name: "Cancel" }));
    expect(confirmGroup()).toBeNull();
    store.release();
    await waitFor(() => expect(store.loads.filter((k) => k === CREDENTIAL_LEASE_KEY).length).toBe(1));
    await settle();
    expect(m.switched).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(confirmGroup()).toBeNull();
  });

  it("a new Open while the lease is read replaces the confirm, and the earlier one never switches", async () => {
    const store = new HeldLeaseStore().holdLease();
    const m = mount({ store });
    expand();
    openFabrikam(RED_SOURCE!);
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    openFabrikam(UNKNOWN_SOURCE!);
    store.release();
    await waitFor(() => expect(store.loads.filter((k) => k === CREDENTIAL_LEASE_KEY).length).toBe(1));
    await settle();
    expect(m.switched).toEqual([]);
    expect(within(confirmGroup()!).getByText(switchConfirmText("Fabrikam", UNKNOWN_SOURCE!.title))).toBeTruthy();
    // The new confirm is not stuck on the dropped check.
    expect(within(confirmGroup()!).getByRole("button", { name: "Switch and open" }).hasAttribute("disabled")).toBe(false);
  });

  it("a switch made elsewhere while the lease is read drops this one, and says why", async () => {
    const store = new HeldLeaseStore().holdLease();
    const m = mount({ store });
    expand();
    openFabrikam();
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    // The connection bar switches to Fabrikam meanwhile.
    m.rerender("pb");
    store.release();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SWITCH_REFUSED_ACTIVE_CHANGED));
    expect(m.switched).toEqual([]);
  });

  it("calls the shell's CURRENT switch after the await, never the one from the click's render", async () => {
    const store = new HeldLeaseStore().holdLease();
    const m = mount({ store });
    expand();
    openFabrikam();
    fireEvent.click(screen.getByRole("button", { name: "Switch and open" }));
    const latest: string[] = [];
    m.rerender("pa", { onSwitchConnection: (id) => latest.push(id) });
    store.release();
    await waitFor(() => expect(latest).toEqual(["pb"]));
    expect(m.switched).toEqual([]);
  });
});

describe("3c. a jump is acted on once (review round 1)", () => {
  it("switching away and back does not repeat an old jump", async () => {
    const m = mount();
    expand();
    await waitFor(() => expect(chooserRow(RED_SOURCE!.id)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: `Open ${RED_SOURCE!.title} on this page` }));
    await waitFor(() => expect(document.activeElement).toBe(chooserRow(RED_SOURCE!.id)));
    m.rerender("pb");
    await waitFor(() => expect(chooserRow(RED_SOURCE!.id)).not.toBeNull());
    m.rerender("pa");
    await waitFor(() => expect(chooserRow(RED_SOURCE!.id)).not.toBeNull());
    await settle();
    expect(document.activeElement).not.toBe(chooserRow(RED_SOURCE!.id));
    expect(document.activeElement).toBe(document.body);
  });
});

describe("5b. Focus here on a cancelled read (review round 1)", () => {
  it("says a cancelled read is incomplete and not saved; a complete one does not", () => {
    const cache = new TenantGapCache();
    const row = {
      profileId: "pa",
      tenantId: TA,
      cells: savedCells(),
      status: { state: "unknown" as const, reason: "Cancelled." },
      warnings: [],
      plannedReads: 4,
      cancelled: true,
    };
    cache.set({ readAt: NOW, row });
    mount({ cache });
    expect(screen.getByTestId("azo-focus-cancelled").textContent).toBe(FOCUS_CANCELLED_TEXT);
    expect(FOCUS_CANCELLED_TEXT).toBe(
      "This read was cancelled before it finished: checks it had not finished are unknown, and it is not saved. " +
        "Read this tenant again in All tenants for a complete answer.",
    );
    cleanup();

    const complete = new TenantGapCache();
    complete.set({ readAt: NOW, row: { ...row, cancelled: false } });
    mount({ cache: complete });
    expect(screen.getByTestId("azo-focus-counts")).toBeTruthy();
    expect(screen.queryByTestId("azo-focus-cancelled")).toBeNull();
  });
});

describe("4b. a save after a failed mount load (review round 1)", () => {
  it("seeds the other tenants it loaded and drops the mount load's note", async () => {
    const other = withGapRead(emptyGapReads(), {
      readAt: NOW - 60_000,
      row: { profileId: "pb", tenantId: TB, cells: rowUnknown("x"), status: { state: "unknown", reason: "x" }, warnings: [], plannedReads: 0, cancelled: false },
    });
    const store = new FakeKvDocumentStore({ [TENANT_GAP_READS_KEY]: JSON.parse(encodeGapReads(other)) }).scriptLoad(
      TENANT_GAP_READS_KEY,
      { kind: "unknown", reason: "HTTP 504" },
    );
    mount({ store });
    expand();
    const failed =
      "Saved gap reads could not be loaded (HTTP 504), so every tenant shows as not read yet. Reading a tenant again shows its answer, but it is not saved until the saved reads load.";
    await waitFor(() => expect(screen.getByText(failed)).toBeTruthy());
    const fabrikam = () => allTenantsBody().querySelector<HTMLElement>('[data-profile="pb"]')!;
    expect(within(fabrikam()).getByText("Not read yet")).toBeTruthy();
    store.clearScript();
    fireEvent.click(screen.getByRole("button", { name: "Read Contoso" }));
    await waitFor(() => expect(store.saves.filter((x) => x.key === TENANT_GAP_READS_KEY).length).toBe(1));
    await waitFor(() => expect(screen.queryByText(failed)).toBeNull());
    expect(within(fabrikam()).getByText(/^Read at .*, 1 minute ago$/)).toBeTruthy();
    expect(within(fabrikam()).queryByText("Not read yet")).toBeNull();
  });
});
