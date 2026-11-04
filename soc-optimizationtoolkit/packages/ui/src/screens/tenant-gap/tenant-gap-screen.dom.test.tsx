// @vitest-environment happy-dom
/**
 * The multi-tenant logging gap dashboard (ADR 0009 decision 6).
 *
 * What these pins protect:
 *   - MOUNT reads nothing: no Azure request, no tenant session, no KV load, no
 *     Cribl call - a cached answer is shown with its time instead;
 *   - reads run only on request, one tenant at a time through the session,
 *     and "Read all tenants" visits every connection in order;
 *   - a tenant whose proof fails reads unknown in every cell;
 *   - every indicator carries a word as well as a colour, and its reason sits
 *     in its (i); the panel and each tile carry an (i);
 *   - without a session or pacing the reads are disabled with the reason.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FakeKvDocumentStore, FakeLogger, GAP_SOURCES, rowUnknown } from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  BatchPacing,
  CriblClient,
  CriblRequest,
  GraphDirectory,
  PortHttpResponse,
  TenantPorts,
  TenantProfile,
  TenantRun,
  TenantSession,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { TenantGapScreen } from "./tenant-gap-screen";
import { TenantGapCache } from "./tenant-gap-state";

afterEach(cleanup);

const TA = "aaaaaaaa-0000-0000-0000-000000000001";
const TB = "bbbbbbbb-0000-0000-0000-000000000002";
const PROFILES = [
  { id: "pa", name: "Contoso", config: { tenantId: TA, clientId: "ca", subscriptionId: "sub-a", resourceGroup: "rg" } },
  { id: "pb", name: "Fabrikam", config: { tenantId: TB, clientId: "cb", subscriptionId: "sub-b", resourceGroup: "rg" } },
];

class CountingAzure implements AzureManagement {
  readonly sent: AzureManagementRequest[] = [];
  /** While set, every request waits for it before answering. */
  gate: Promise<void> | null = null;
  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.sent.push(r);
    if (this.gate !== null) await this.gate;
    return { status: 403, body: { error: { code: "AuthorizationFailed" } } };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
  private readonly failProofFor: string | null;
  constructor(azure: AzureManagement, failProofFor: string | null = null) {
    this.azure = azure;
    this.failProofFor = failProofFor;
  }
  async runForTenant<T>(profile: TenantProfile, work: (ports: TenantPorts) => Promise<T>): Promise<TenantRun<T>> {
    this.runs.push(profile.id);
    if (profile.config.tenantId === this.failProofFor) {
      return {
        kind: "unknown",
        tenantId: profile.config.tenantId,
        stage: "proof",
        reason: "another tenant answered the proof read",
        restore: { kind: "restored" },
      };
    }
    const value = await work({ azure: this.azure, graph: {} as GraphDirectory });
    return { kind: "done", tenantId: profile.config.tenantId, value, restore: { kind: "not-needed" } };
  }
}

const PACING: BatchPacing = { now: () => 0, sleep: () => Promise.resolve() };

function mount(
  opts: {
    session?: FakeSession | null;
    pacing?: BatchPacing | null;
    cache?: TenantGapCache;
    failProofFor?: string;
    azure?: CountingAzure;
    profiles?: typeof PROFILES;
  } = {},
) {
  const azure = opts.azure ?? new CountingAzure();
  const session = opts.session === null ? undefined : (opts.session ?? new FakeSession(azure, opts.failProofFor ?? null));
  const store = new FakeKvDocumentStore();
  const cribl = new CountingCribl();
  const ports = { azure, cribl, kvDocuments: store, logger: new FakeLogger(() => "t") } as unknown as UiPorts;
  const cache = opts.cache ?? new TenantGapCache();
  render(
    <PortsProvider ports={ports} config={{ tenantId: TA } as unknown as AzureConfig}>
      <TenantGapScreen
        profiles={opts.profiles ?? PROFILES}
        cache={cache}
        now={() => Date.UTC(2026, 10, 3, 12, 0, 0)}
        {...(session !== undefined ? { session } : {})}
        {...(opts.pacing === null ? {} : { pacing: opts.pacing ?? PACING })}
      />
    </PortsProvider>,
  );
  return { azure, session, store, cribl, cache };
}

function indicators(profileId: string, side: "azure" | "cribl"): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-profile="${profileId}"] [data-side="${side}"]`)];
}

describe("TenantGapScreen", () => {
  it("mounting makes no Azure, session, KV or Cribl call", () => {
    const { azure, session, store, cribl } = mount();
    expect(azure.sent).toEqual([]);
    expect(session?.runs).toEqual([]);
    expect(store.loads).toEqual([]);
    expect(cribl.calls).toEqual([]);
    // Every cell reads unknown "not read yet" until asked.
    for (const p of PROFILES) {
      const cells = indicators(p.id, "azure");
      expect(cells.length).toBe(GAP_SOURCES.length);
      expect(cells.every((c) => c.dataset.state === "unknown")).toBe(true);
    }
  });

  it("has one column per catalog source and one row per connection", () => {
    mount();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
    for (const s of GAP_SOURCES) expect(headers.some((h) => h.includes(s.title))).toBe(true);
    expect(document.querySelectorAll("tbody tr").length).toBe(PROFILES.length);
  });

  it("reads one tenant on request, through the session only", async () => {
    const { session, azure, store } = mount();
    const row = document.querySelector<HTMLElement>('[data-profile="pb"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "Read Fabrikam" }));
    await waitFor(() => expect(within(row).getByText(/^Read at /)).toBeTruthy());
    expect(session?.runs).toEqual(["pb"]);
    expect(azure.sent.length).toBeGreaterThan(0);
    expect(store.saves).toEqual([]);
    // Every Azure cell of a fully refused read is unknown, never red.
    expect(indicators("pb", "azure").some((c) => c.dataset.state === "red")).toBe(false);
  });

  it("Read all tenants visits every connection, in order, one at a time", async () => {
    const { session } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Read all tenants" }));
    await waitFor(() => expect(session?.runs).toEqual(["pa", "pb"]));
    await waitFor(() => expect(screen.getAllByText(/^Read at /).length).toBe(2));
  });

  it("a tenant whose proof fails is unknown in every cell, both indicators, with the reason", async () => {
    mount({ failProofFor: TB });
    fireEvent.click(screen.getByRole("button", { name: "Read all tenants" }));
    await waitFor(() => expect(screen.getAllByText(/^Read at /).length).toBe(2));
    for (const side of ["azure", "cribl"] as const) {
      const cells = indicators("pb", side);
      expect(cells.length).toBe(GAP_SOURCES.length);
      for (const c of cells) {
        expect(c.dataset.state).toBe("unknown");
        expect(c.querySelector('[role="tooltip"]')?.textContent).toContain("another tenant answered");
      }
    }
    // The other tenant's Cribl side was read: no record there is a measured gap.
    expect(indicators("pa", "cribl").every((c) => c.dataset.state === "red")).toBe(true);
  });

  it("shows a cached answer with its time on mount, without reading", () => {
    const cache = new TenantGapCache();
    cache.set({
      readAt: Date.UTC(2026, 10, 3, 11, 0, 0),
      row: { profileId: "pa", tenantId: TA, cells: rowUnknown("cached reason"), status: { state: "unknown", reason: "x" }, warnings: [], plannedReads: 0, cancelled: false },
    });
    const { session, store } = mount({ cache });
    expect(session?.runs).toEqual([]);
    expect(store.loads).toEqual([]);
    const row = document.querySelector<HTMLElement>('[data-profile="pa"]')!;
    expect(within(row).getByText(/^Read at /)).toBeTruthy();
    expect(indicators("pa", "azure")[0]!.querySelector('[role="tooltip"]')?.textContent).toBe("cached reason");
  });

  it("every indicator carries a word, not colour alone", () => {
    mount();
    for (const c of indicators("pa", "azure")) expect(c.textContent).toContain("Azure");
    for (const c of indicators("pa", "cribl")) expect(c.textContent).toContain("Cribl");
  });

  it("the panel and both summary tiles carry an (i)", () => {
    mount();
    const panel = document.querySelector(".tgap-screen")!;
    expect(panel.querySelector(".panel-title .info-tip")).not.toBeNull();
    const tiles = [...document.querySelectorAll(".tgap-tile")];
    expect(tiles.length).toBe(2);
    for (const t of tiles) expect(t.querySelector(".info-tip")).not.toBeNull();
  });

  it("without a tenant session the reads are disabled and say why", () => {
    mount({ session: null });
    expect((screen.getByRole("button", { name: "Read all tenants" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/cannot read tenants/i)).toBeTruthy();
  });

  it("without pacing the reads are disabled: nothing goes out unpaced", () => {
    mount({ pacing: null });
    expect((screen.getByRole("button", { name: "Read all tenants" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // AZR-63 review: each tenant got a fresh 40/min cap, so a read-all sent 40
  // per tenant per minute, not the 40 the (i) promises.
  it("Read all spends ONE Validate-rate cap across every tenant, and Cancel sends nothing more", async () => {
    // Two first-page reads each: 24 tenants need 48, more than one minute's 40.
    const many = Array.from({ length: 24 }, (_, i) => ({
      id: `p${i}`,
      name: `Tenant ${i}`,
      config: { tenantId: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`, clientId: `c${i}`, subscriptionId: `sub-${i}`, resourceGroup: "rg" },
    }));
    const sleeps: number[] = [];
    // The clock never moves, so a full window waits until Cancel ends the sleep.
    const pacing: BatchPacing = {
      now: () => 0,
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          sleeps.push(ms);
          const s = signal as AbortSignal | undefined;
          if (s === undefined) return;
          if (s.aborted) resolve();
          else s.addEventListener("abort", () => resolve(), { once: true });
        }),
    };
    const { azure } = mount({ profiles: many, pacing });
    fireEvent.click(screen.getByRole("button", { name: "Read all tenants" }));
    await waitFor(() => expect(sleeps.length).toBeGreaterThan(0));
    expect(azure.sent.length).toBe(40);
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    fireEvent.click(cancel);
    // Cancelling shows, and cannot be pressed again, until the run settles.
    const cancelling = screen.getByRole("button", { name: "Cancelling..." }) as HTMLButtonElement;
    expect(cancelling.disabled).toBe(true);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancelling..." })).toBeNull());
    expect(azure.sent.length).toBe(40);
  });

  // AZR-63 review: a cancelled read replaced the tenant's last complete answer.
  it("a read cancelled mid-tenant keeps that tenant's earlier complete answer and its time", async () => {
    const cache = new TenantGapCache();
    const earlier = {
      readAt: Date.UTC(2026, 10, 2, 9, 0, 0),
      row: { profileId: "pa", tenantId: TA, cells: rowUnknown("earlier answer"), status: { state: "green" as const, reason: "x" }, warnings: [], plannedReads: 3, cancelled: false },
    };
    cache.set(earlier);
    const azure = new CountingAzure();
    const gate = deferred();
    azure.gate = gate.promise;
    mount({ cache, azure });
    const row = document.querySelector<HTMLElement>('[data-profile="pa"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "Read Contoso" }));
    await waitFor(() => expect(azure.sent.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    gate.resolve();
    await waitFor(() => expect(screen.getByText(/cancelled/i)).toBeTruthy());
    expect(cache.get(PROFILES[0]!)).toBe(earlier);
    expect(indicators("pa", "azure")[0]!.querySelector('[role="tooltip"]')?.textContent).toBe("earlier answer");
    expect(screen.getByText(/Contoso/, { selector: ".field-hint" })).toBeTruthy();
  });

  // AZR-63 review: leaving mid-read and coming back let a second run take the
  // lease the first one then released, so the new run's tenant read unknown.
  it("a read still finishing from an earlier visit blocks a new one until it settles", async () => {
    const cache = new TenantGapCache();
    const azure = new CountingAzure();
    const gate = deferred();
    azure.gate = gate.promise;
    const first = mount({ cache, azure });
    fireEvent.click(screen.getByRole("button", { name: "Read all tenants" }));
    await waitFor(() => expect(azure.sent.length).toBe(1));
    cleanup(); // leave the screen mid-read
    const second = mount({ cache, azure });
    const readAll = screen.getByRole("button", { name: "Read all tenants" }) as HTMLButtonElement;
    expect(readAll.disabled).toBe(true);
    expect(screen.getByText(/earlier read is still finishing/i)).toBeTruthy();
    gate.resolve();
    await waitFor(() => expect(readAll.disabled).toBe(false));
    expect(first.session?.runs).toEqual(["pa"]);
    expect(second.session?.runs).toEqual([]);
  });

  // AZR-63 review: every tip was an identical "More information" stop.
  it("each indicator's (i) names its tenant, source and side", () => {
    mount();
    const first = GAP_SOURCES[0]!;
    const tip = indicators("pa", "cribl")[0]!.querySelector('[role="button"]')!;
    expect(tip.getAttribute("aria-label")).toBe(`Contoso, ${first.title}, Cribl: why`);
  });

  it("uses no native select", () => {
    mount();
    expect(document.querySelector("select")).toBeNull();
  });
});

describe("TenantGapCache", () => {
  it("returns nothing for a connection whose tenant id changed since it was read", () => {
    const cache = new TenantGapCache();
    cache.set({
      readAt: 1,
      row: { profileId: "pa", tenantId: TA, cells: [], status: { state: "green", reason: "" }, warnings: [], plannedReads: 0, cancelled: false },
    });
    expect(cache.get({ id: "pa", config: { tenantId: TA.toUpperCase() } })).not.toBeNull();
    expect(cache.get({ id: "pa", config: { tenantId: TB } })).toBeNull();
  });
});
