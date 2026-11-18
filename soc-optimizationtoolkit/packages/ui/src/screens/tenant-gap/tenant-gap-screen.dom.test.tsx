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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  FakeKvDocumentStore,
  FakeLogger,
  GAP_SOURCES,
  ONBOARDING_PROGRESS_KEY,
  emptyProgress,
  encodeProgress,
  rowUnknown,
  tenantMigrationClaimKey,
  tenantMigrationMarker,
  withCriblSource,
} from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  BatchPacing,
  CriblClient,
  CriblRequest,
  GraphDirectory,
  PortHttpResponse,
  TenantBatchRun,
  TenantPorts,
  TenantProfile,
  TenantRestore,
  TenantRun,
  TenantSession,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { RESTORE_FAILED, TENANT_READ_IN_FLIGHT, TenantGapScreen, TenantReadInFlightNotice } from "./tenant-gap-screen";
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
  /** Each batch: the profiles its runs read (AZR-90: a Read all is ONE batch). */
  readonly batches: string[][] = [];
  batchRestore: TenantRestore = { kind: "restored" };
  async runBatch<R>(body: (session: TenantSession) => Promise<R>): Promise<TenantBatchRun<R>> {
    const runs: string[] = [];
    this.batches.push(runs);
    const inner: TenantSession = {
      runForTenant: (profile, work) => {
        runs.push(profile.id);
        return this.runForTenant(profile, work);
      },
      runBatch: (b) => this.runBatch(b),
    };
    const value = await body(inner);
    return { value, restore: this.batchRestore };
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
    store?: FakeKvDocumentStore;
  } = {},
) {
  const azure = opts.azure ?? new CountingAzure();
  const session = opts.session === null ? undefined : (opts.session ?? new FakeSession(azure, opts.failProofFor ?? null));
  const store = opts.store ?? new FakeKvDocumentStore();
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

  // AZR-90: the active credential went back after EVERY tenant (two paced
  // token mints each); a Read all is now one batch with one restore.
  it("Read all reads every tenant inside ONE session batch", async () => {
    const { session } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Read all tenants" }));
    await waitFor(() => expect(screen.getAllByText(/^Read at /).length).toBe(2));
    expect(session?.batches).toEqual([["pa", "pb"]]);
  });

  it("says so when the run's one restore of the active credential failed", async () => {
    const session = new FakeSession(new CountingAzure());
    session.batchRestore = { kind: "failed", reason: "AADSTS700016" };
    mount({ session });
    fireEvent.click(screen.getByRole("button", { name: "Read all tenants" }));
    await waitFor(() => expect(screen.getByText(`${RESTORE_FAILED} (AADSTS700016)`)).toBeTruthy());
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

  // AZR-108: a Cribl source an earlier app version recorded under the legacy
  // key, after this tenant's own progress existed, showed as "not created".
  it("a Cribl source stranded under the legacy key shows as recorded by an earlier version, not adopted, and nothing is written", async () => {
    const own = emptyProgress({ subscriptionId: "sub-a", resourceGroup: "rg" });
    const legacy = withCriblSource(own, "activityLog", {
      groupId: "grp-old",
      inputId: "in_activity_old",
      inputType: "eventhub",
      secretId: "s0",
    });
    const store = new FakeKvDocumentStore({
      [`${ONBOARDING_PROGRESS_KEY}.${TA}`]: JSON.parse(encodeProgress(own)),
      [ONBOARDING_PROGRESS_KEY]: JSON.parse(encodeProgress(legacy)),
      [tenantMigrationClaimKey(ONBOARDING_PROGRESS_KEY)]: tenantMigrationMarker(TA),
    });
    mount({ store });
    const row = document.querySelector<HTMLElement>('[data-profile="pa"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "Read Contoso" }));
    await waitFor(() => expect(within(row).getByText(/^Read at /)).toBeTruthy());
    const cribl = indicators("pa", "cribl");
    const activity = cribl.find((c) => c.dataset.source === "activityLog")!;
    expect(activity.dataset.state).toBe("unknown");
    expect(activity.querySelector('[role="tooltip"]')?.textContent).toContain(
      "in_activity_old in worker group grp-old for this tenant. It was recorded by an earlier app version and not adopted",
    );
    expect(cribl.filter((c) => c.dataset.state === "red").length).toBe(GAP_SOURCES.length - 1);
    expect([...row.querySelectorAll(".tgap-warning")].map((w) => w.textContent)).toEqual([
      "1 Cribl source record was recorded by an earlier app version for this tenant and not adopted. " +
        "It is not counted here; review it on Azure Native Source Onboarding.",
    ]);
    expect(store.saves).toEqual([]);
  });

  it("an unreadable legacy key reads as could-not-check, never as not created", async () => {
    const own = emptyProgress({ subscriptionId: "sub-a", resourceGroup: "rg" });
    const store = new FakeKvDocumentStore({ [`${ONBOARDING_PROGRESS_KEY}.${TA}`]: JSON.parse(encodeProgress(own)) });
    store.scriptLoad(ONBOARDING_PROGRESS_KEY, { kind: "unknown", reason: "HTTP 503" });
    mount({ store });
    const row = document.querySelector<HTMLElement>('[data-profile="pa"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "Read Contoso" }));
    await waitFor(() => expect(within(row).getByText(/^Read at /)).toBeTruthy());
    const cribl = indicators("pa", "cribl");
    expect(cribl.length).toBe(GAP_SOURCES.length);
    expect(cribl.filter((c) => c.dataset.state === "unknown").length).toBe(GAP_SOURCES.length);
    expect(row.querySelector(".tgap-warning")?.textContent).toContain("could not be checked");
    expect(store.saves).toEqual([]);
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

  // AZR-108 review: the tip said a cell with an earlier-version record is
  // always unknown, but a source with its own record keeps that record's colour.
  it("the Cribl tile tip says a legacy record makes the cell unknown only when this app holds none of its own", () => {
    mount();
    const tile = [...document.querySelectorAll(".tgap-tile")].find((t) => t.textContent?.includes("Onboarded to Cribl"))!;
    const text = tile.querySelector('[role="tooltip"]')?.textContent ?? "";
    expect(text).toContain(
      "where this app holds no record of its own for that source the cell is unknown, and where it does the cell " +
        "keeps the colour of its own record.",
    );
    expect(text).not.toContain("(that cell is unknown)");
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
    expect(screen.getByText(/earlier read is still finishing/i).textContent).toBe(
      "An earlier read is still finishing: leaving this screen cancelled it, and it stops once its current request " +
        "returns and the active connection's credential is back. Reads can start again once it has.",
    );
    // Leaving cancelled it: no Cancel is offered for a run this visit does not own.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
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
    expect(tip.getAttribute("aria-label")).toBe(`Contoso, ${first.title}, Cribl: Unknown, why`);
  });

  describe("one tab stop with arrow keys between cells (AZR-91)", () => {
    const COLS = GAP_SOURCES.length * 2;
    const gridTips = () => [...document.querySelectorAll<HTMLElement>("tbody [data-col] [role='button']")];
    const tipAt = (row: number, col: number) =>
      document.querySelector<HTMLElement>(`tbody [data-row="${row}"][data-col="${col}"] [role="button"]`)!;
    const stops = () => gridTips().filter((t) => t.tabIndex === 0);
    const press = (key: string, init: { ctrlKey?: boolean } = {}) =>
      fireEvent.keyDown(document.activeElement as HTMLElement, { key, ...init });

    it("gives the whole grid of tips ONE tab stop, so each row's Read button is a stop away", () => {
      mount();
      expect(gridTips().length).toBe(PROFILES.length * COLS);
      expect(stops()).toEqual([tipAt(0, 0)]);
      // Everything tabbable in the body: one Read button per tenant plus the grid's one stop.
      const tabbable = [...document.querySelectorAll<HTMLElement>("tbody button, tbody [tabindex]")].filter(
        (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
      );
      expect(tabbable.length).toBe(PROFILES.length + 1);
    });

    it("moves focus and the stop with the arrows, clamped at the edges", () => {
      mount();
      tipAt(0, 0).focus();
      press("ArrowLeft");
      expect(document.activeElement).toBe(tipAt(0, 0));
      press("ArrowRight");
      expect(document.activeElement).toBe(tipAt(0, 1));
      press("ArrowDown");
      expect(document.activeElement).toBe(tipAt(1, 1));
      press("ArrowDown");
      expect(document.activeElement).toBe(tipAt(1, 1));
      press("ArrowUp");
      expect(document.activeElement).toBe(tipAt(0, 1));
      expect(stops()).toEqual([tipAt(0, 1)]);
    });

    it("Home and End go to the row's ends; with Ctrl, to the grid's", () => {
      mount();
      tipAt(1, 3).focus();
      press("End");
      expect(document.activeElement).toBe(tipAt(1, COLS - 1));
      press("Home");
      expect(document.activeElement).toBe(tipAt(1, 0));
      press("End", { ctrlKey: true });
      expect(document.activeElement).toBe(tipAt(PROFILES.length - 1, COLS - 1));
      press("Home", { ctrlKey: true });
      expect(document.activeElement).toBe(tipAt(0, 0));
      expect(stops()).toEqual([tipAt(0, 0)]);
    });

    it("a tip focused by click takes the stop, and Enter still toggles its reason", () => {
      mount();
      const tip = tipAt(1, 2);
      tip.focus();
      // A browser fires focusin with focus(); happy-dom does not, so send it.
      fireEvent.focusIn(tip);
      expect(stops()).toEqual([tip]);
      expect(tip.getAttribute("aria-expanded")).toBe("true");
      fireEvent.keyDown(tip, { key: "Enter" });
      expect(tip.getAttribute("aria-expanded")).toBe("false");
      // Enter is the tip's own key: focus does not move.
      expect(document.activeElement).toBe(tip);
    });

    it("every grid tip is described by the keyboard hint", () => {
      mount();
      const hint = document.getElementById("tgap-grid-keys")!;
      expect(hint.textContent).toContain("Arrow keys move between indicators");
      expect(gridTips().every((t) => t.getAttribute("aria-describedby") === "tgap-grid-keys")).toBe(true);
    });
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

// AZR-90 review: a Read all holds the slot's exclusive section for its whole
// run, so other screens' Azure reads wait. The shell says so on every screen
// while the run is in flight, and the notice goes when it ends.
describe("TenantReadInFlightNotice", () => {
  it("shows exactly while a read is tracked, and goes when it settles", async () => {
    const cache = new TenantGapCache();
    render(<TenantReadInFlightNotice cache={cache} />);
    expect(screen.queryByRole("status")).toBeNull();
    let finish: () => void = () => undefined;
    act(() => {
      cache.track(new Promise<void>((r) => (finish = r)));
    });
    expect(screen.getByRole("status").textContent).toBe(TENANT_READ_IN_FLIGHT);
    // Review round 3: off Tenant Logging Gaps the run is already cancelled, so
    // the notice says leaving cancels it rather than sending the operator back
    // to a Cancel button the screen no longer shows.
    expect(TENANT_READ_IN_FLIGHT).toBe(
      "A tenant gap read is running or finishing. From the first tenant it reads through Azure until it ends, it holds " +
        "the app's Azure credential slot, and Azure reads on every screen of this tab wait. Cancel on Tenant Logging " +
        "Gaps stops it, and leaving that screen cancels it too; the slot frees once its current request returns and " +
        "the active connection's credential is back.",
    );
    await act(async () => {
      finish();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the cache tells each subscriber on start and end, and not after unsubscribe", async () => {
    const cache = new TenantGapCache();
    let calls = 0;
    const off = cache.subscribe(() => calls++);
    let finish: () => void = () => undefined;
    cache.track(new Promise<void>((r) => (finish = r)));
    expect(calls).toBe(1);
    finish();
    await cache.inFlight();
    expect(calls).toBe(2);
    off();
    cache.track(Promise.resolve());
    expect(calls).toBe(2);
  });
});
