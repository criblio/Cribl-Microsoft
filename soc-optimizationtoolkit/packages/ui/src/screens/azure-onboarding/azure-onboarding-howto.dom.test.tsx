// @vitest-environment happy-dom
/**
 * AZR-30..34: the How-to, Validate, Cribl source and dataflow sections the
 * Azure Native Source Onboarding screen composes, driven through the real
 * screen against routing fakes that record every call (ADR 0007).
 *
 * What these pins protect, each one a way the composition could quietly do harm:
 *   - mount reads exactly the selection and the progress document, and spends
 *     no Azure or Cribl call - not even a worker-group listing;
 *   - a tick writes the PROGRESS document only, never the selection;
 *   - a failed progress read blocks every progress write, while the AZR-18
 *     selection's Save keeps working;
 *   - a source in How-to mode hides the Defender deploy controls;
 *   - Validate sends only GETs, and only through the paced wrapper;
 *   - without a pacing, Validate cannot run at all;
 *   - the Cribl source is created only on the SECOND click, in the pinned
 *     order, its ids are recorded in progress, and the pasted connection
 *     string reaches the secret POST and nowhere else the screen keeps.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  COVERAGE_SELECTION_KEY,
  FakeKvDocumentStore,
  FakeLogger,
  ONBOARDING_PROGRESS_KEY,
  ONBOARDING_PROGRESS_KIND,
  ONBOARDING_PROGRESS_VERSION,
} from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  BatchPacing,
  CriblClient,
  CriblGroupSummary,
  CriblRequest,
  Listing,
  PortHttpResponse,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureOnboardingScreen, DEFENDER_HOWTO_NOTE } from "./azure-onboarding-screen";
import { MODE_CHOICE_NOT_CARRIED } from "./howto/howto-state";

/** The four sections the screen adds after the catalog sections. */
const NEW_SECTION_TITLES = [
  "Dataflow",
  "How to set it up yourself",
  "Check the Azure configuration",
  "Cribl Stream source",
];

afterEach(cleanup);

const SUB = "sub1";
const RG = "rg1";
const NS = "ns1";
const HUB = "h1";
const G = "g1";
const NS_PATH = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.EventHub/namespaces/${NS}`;
const KEY = "PASTEDSECRETKEYVALUE0123==";
const LISTEN_CS = `Endpoint=sb://${NS}.servicebus.windows.net/;SharedAccessKeyName=reader;SharedAccessKey=${KEY}`;
const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const DEFENDER_TITLE = "Defender for Cloud alert export";

const CONFIG = {
  tenantId: "tenant",
  clientId: "client",
  subscriptionId: SUB,
  resourceGroup: RG,
  workspaceName: "law-1",
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse => ({ status: 200, body }) as unknown as PortHttpResponse;
const notFound = (): PortHttpResponse =>
  ({ status: 404, body: { error: { code: "NotFound", message: "not found" } } }) as unknown as PortHttpResponse;

/** A progress document with Defender chosen in How-to mode against ns1/h1. */
function progressDoc(over: Record<string, unknown> = {}): unknown {
  return {
    kind: ONBOARDING_PROGRESS_KIND,
    version: ONBOARDING_PROGRESS_VERSION,
    sources: { defenderExport: { chosen: true, mode: "manual" } },
    planValues: { subscriptionId: SUB, resourceGroup: RG, namespace: NS, hubName: HUB, consumerGroup: "cribl" },
    ticks: {},
    criblSources: {},
    workerGroup: G,
    ...over,
  };
}

/** Answers the namespace, its rules and Event Hubs; every other GET is a 404. Never a write. */
class RoutingAzure implements AzureManagement {
  readonly calls: AzureManagementRequest[] = [];

  async request(r: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    if (r.method !== "GET") throw new Error(`RoutingAzure: unexpected ${r.method} ${r.path}`);
    if (r.path === NS_PATH) return ok({ name: NS, id: NS_PATH, sku: { name: "Standard" } });
    if (r.path === `${NS_PATH}/authorizationRules`) {
      return ok({
        value: [
          { name: "reader", id: `${NS_PATH}/authorizationRules/reader`, properties: { rights: ["Listen"] } },
          { name: "sender", id: `${NS_PATH}/authorizationRules/sender`, properties: { rights: ["Send"] } },
        ],
      });
    }
    if (r.path === `${NS_PATH}/eventhubs`) {
      return ok({ value: [{ name: HUB, id: `${NS_PATH}/eventhubs/${HUB}`, properties: { partitionCount: 2 } }] });
    }
    return notFound();
  }
}

/**
 * A stateful Cribl worker group: inputs and secrets are kept as they are
 * created, `/version/status` reports the files dirty until a commit, and the
 * deploy and configVersion answer as a healthy leader would.
 */
class RoutingCribl implements CriblClient {
  readonly calls: CriblRequest[] = [];
  groups: CriblGroupSummary[] = [{ id: G, product: "stream" }];
  listGroupsCalls = 0;
  private inputs: Record<string, unknown>[] = [];
  private secrets: string[] = [];
  private dirty = false;

  labels(): string[] {
    return this.calls.map((r) => {
      const q = r.query ? `?${Object.entries(r.query).map(([k, v]) => `${k}=${v}`).join("&")}` : "";
      return `${r.method} ${r.groupId === undefined ? "" : `/m/${r.groupId}`}${r.path}${q}`;
    });
  }

  async request(r: CriblRequest): Promise<PortHttpResponse> {
    this.calls.push(r);
    const p = r.path;
    if (r.groupId === G) {
      if (r.method === "GET" && p === "/system/inputs") return ok({ items: this.inputs });
      if (r.method === "GET" && p.startsWith("/system/inputs/")) {
        const id = decodeURIComponent(p.slice("/system/inputs/".length));
        const found = this.inputs.find((i) => i["id"] === id);
        return found === undefined ? notFound() : ok({ items: [found] });
      }
      if (r.method === "POST" && p === "/system/inputs") {
        const body = r.body as Record<string, unknown>;
        this.inputs.push(body);
        this.dirty = true;
        return ok({ items: [body] });
      }
      if (r.method === "GET" && p.startsWith("/system/secrets/")) {
        const id = decodeURIComponent(p.slice("/system/secrets/".length));
        return this.secrets.includes(id) ? ok({ items: [{ id }] }) : notFound();
      }
      if (r.method === "POST" && p === "/system/secrets") {
        const id = (r.body as { id: string }).id;
        this.secrets.push(id);
        this.dirty = true;
        return ok({ items: [{ id }] });
      }
      if (r.method === "GET" && p === "/version/status") {
        return ok(
          this.dirty
            ? { items: [{ modified: [`groups/${G}/local/cribl/inputs.yml`, `groups/${G}/local/cribl/secrets.yml`] }] }
            : { items: [] },
        );
      }
      if (r.method === "POST" && p === "/version/commit") {
        this.dirty = false;
        return ok({ items: [{ commit: HASH }] });
      }
      if (r.method === "GET" && p === "/version") return ok({ items: [{ hash: HASH }] });
    }
    if (r.groupId === undefined && r.method === "PATCH" && p === `/products/stream/groups/${G}/deploy`) return ok({});
    if (r.groupId === undefined && r.method === "GET" && p === `/products/stream/groups/${G}`) {
      return ok({ items: [{ id: G, configVersion: "a1b2c3d" }] });
    }
    throw new Error(`RoutingCribl: unrouted ${r.method} ${r.groupId ?? ""} ${p}`);
  }

  async listGroups(): Promise<Listing<CriblGroupSummary>> {
    this.listGroupsCalls++;
    return { kind: "rows", rows: this.groups.map((g) => ({ ...g })) } as unknown as Listing<CriblGroupSummary>;
  }
}

/** A pacing whose clock and sleep are counted, so the paced wrapper is observable. */
function countingPacing(): BatchPacing & { nowCalls: number; sleeps: number[] } {
  const p = {
    nowCalls: 0,
    sleeps: [] as number[],
    now: () => {
      p.nowCalls++;
      return 1_000_000;
    },
    sleep: async (ms: number) => {
      p.sleeps.push(ms);
    },
  };
  return p;
}

function mount(opts: {
  store?: FakeKvDocumentStore;
  azure?: RoutingAzure;
  cribl?: RoutingCribl;
  pacing?: BatchPacing | null;
} = {}) {
  const store = opts.store ?? new FakeKvDocumentStore();
  const azure = opts.azure ?? new RoutingAzure();
  const cribl = opts.cribl ?? new RoutingCribl();
  const logger = new FakeLogger(() => "t");
  const pacing = opts.pacing === undefined ? countingPacing() : opts.pacing;
  const ports = { azure, cribl, logger, kvDocuments: store } as unknown as UiPorts;
  const view = render(
    <PortsProvider ports={ports} config={CONFIG}>
      {pacing === null ? <AzureOnboardingScreen /> : <AzureOnboardingScreen pacing={pacing} />}
    </PortsProvider>,
  );
  return { store, azure, cribl, logger, pacing, view };
}

async function loaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByText("Loading the saved selection...")).toBeNull();
    expect(screen.queryByText("Loading your saved How-to progress.")).toBeNull();
  });
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function progressSaves(store: FakeKvDocumentStore) {
  return store.saves.filter((s) => s.key === ONBOARDING_PROGRESS_KEY);
}

describe("AzureOnboardingScreen - the How-to composition at mount", () => {
  it("loads exactly the selection and the progress document, and makes no Azure or Cribl call", async () => {
    const { store, azure, cribl } = mount();
    await loaded();
    expect(store.loads).toEqual([COVERAGE_SELECTION_KEY, ONBOARDING_PROGRESS_KEY]);
    expect(azure.calls).toEqual([]);
    expect(cribl.calls).toEqual([]);
    expect(cribl.listGroupsCalls).toBe(0);
    // The four new sections are there.
    for (const title of NEW_SECTION_TITLES) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it("lists worker groups only when asked", async () => {
    const { cribl } = mount({ store: new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() }) });
    await loaded();
    expect(cribl.listGroupsCalls).toBe(0);
    fireEvent.click(button("Load worker groups"));
    await waitFor(() => expect(cribl.listGroupsCalls).toBe(1));
    expect(cribl.calls).toEqual([]);
  });
});

describe("AzureOnboardingScreen - progress writes", () => {
  it("a tick writes the progress document once and never the selection", async () => {
    const store = new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() });
    mount({ store });
    await loaded();
    const ticks = await waitFor(() => {
      const found = screen.getAllByRole("checkbox", { name: /^Done: / });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    fireEvent.click(ticks[0] as HTMLElement);
    await waitFor(() => expect(progressSaves(store).length).toBe(1));
    expect(store.saves.map((s) => s.key)).toEqual([ONBOARDING_PROGRESS_KEY]);
    const doc = progressSaves(store)[0]?.value as { kind: string; ticks: Record<string, unknown> };
    expect(doc.kind).toBe(ONBOARDING_PROGRESS_KIND);
    expect(Object.keys(doc.ticks).length).toBe(1);
  });

  it("a FAILED progress read blocks every progress write, and the selection's Save still works", async () => {
    const store = new FakeKvDocumentStore().scriptLoad(ONBOARDING_PROGRESS_KEY, {
      kind: "unknown",
      reason: "HTTP 403",
      status: 403,
    });
    mount({ store });
    await loaded();
    expect(screen.getByText(/Your saved How-to progress could not be read - HTTP 403/)).toBeTruthy();
    // No chooser or step can be ticked: none is drawn for a document that may exist.
    expect(screen.queryAllByRole("checkbox", { name: /^Onboard / })).toEqual([]);
    expect(screen.queryAllByRole("checkbox", { name: /^Done: / })).toEqual([]);
    // The AZR-18 selection is untouched by the progress failure.
    fireEvent.click(screen.getByRole("checkbox", { name: DEFENDER_TITLE }));
    fireEvent.click(button("Save selection"));
    await waitFor(() => expect(store.saves.map((s) => s.key)).toEqual([COVERAGE_SELECTION_KEY]));
    expect(progressSaves(store)).toEqual([]);
  });

  it("the 'choice not carried over' notice outlives the progress save that its mode change queued", async () => {
    // The saved selection could not be read, and Defender is chosen in How-to mode.
    const store = new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() }).scriptLoad(
      COVERAGE_SELECTION_KEY,
      { kind: "unknown", reason: "HTTP 403", status: 403 },
    );
    mount({ store });
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: `Automate ${DEFENDER_TITLE}` }));
    // The mode change is written...
    await waitFor(() => expect(progressSaves(store).length).toBe(1));
    const doc = progressSaves(store)[0]?.value as { sources: Record<string, { mode?: string }> };
    expect(doc.sources["defenderExport"]?.mode).toBe("automate");
    // ...and after that write has resolved, the operator is still told the choice was dropped.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(MODE_CHOICE_NOT_CARRIED)).toBeTruthy();
  });

  it("a successful progress save clears an earlier save failure", async () => {
    const store = new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() });
    mount({ store });
    await loaded();
    const ticks = await waitFor(() => {
      const found = screen.getAllByRole("checkbox", { name: /^Done: / });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    store.failSaves();
    fireEvent.click(ticks[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText(/Your How-to progress was not saved/)).toBeTruthy());
    store.failSaves(null);
    fireEvent.click(ticks[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByText(/Your How-to progress was not saved/)).toBeNull());
  });

  it("a source in How-to mode hides the Defender deploy controls behind a note", async () => {
    mount({ store: new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() }) });
    await loaded();
    expect(screen.getByText(DEFENDER_HOWTO_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read Defender state" })).toBeNull();
  });

  it("with no progress stored, Defender stays Automated and its deploy controls are shown", async () => {
    mount();
    await loaded();
    expect(screen.queryByText(DEFENDER_HOWTO_NOTE)).toBeNull();
    expect(screen.getByRole("button", { name: "Read Defender state" })).toBeTruthy();
  });
});

describe("AzureOnboardingScreen - Validate", () => {
  it("sends only GETs, each one through the paced wrapper", async () => {
    const { azure, pacing } = mount({ store: new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() }) });
    await loaded();
    const validate = button("Validate (read only)");
    await waitFor(() => expect(validate.disabled).toBe(false));
    fireEvent.click(validate);
    await waitFor(() => expect(screen.getByText(/^Checked as of /)).toBeTruthy());
    expect(azure.calls.length).toBeGreaterThan(0);
    expect(azure.calls.every((c) => c.method === "GET")).toBe(true);
    // paceAzureManagement reads the shell's clock once per request it lets through.
    const counted = pacing as ReturnType<typeof countingPacing>;
    expect(counted.nowCalls).toBe(azure.calls.length);
  });

  it("without a pacing, Validate is disabled with its reason and reads nothing", async () => {
    const { azure } = mount({
      store: new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() }),
      pacing: null,
    });
    await loaded();
    const validate = button("Validate (read only)");
    expect(validate.disabled).toBe(true);
    expect(screen.getByText(/pacing unavailable/)).toBeTruthy();
    fireEvent.click(validate);
    expect(azure.calls).toEqual([]);
  });
});

describe("AzureOnboardingScreen - the Cribl source create", () => {
  it("creates only on the second click, in order, records the ids, and keeps the pasted key out of progress", async () => {
    const store = new FakeKvDocumentStore({ [ONBOARDING_PROGRESS_KEY]: progressDoc() });
    const { cribl, azure, view } = mount({ store });
    await loaded();

    fireEvent.click(button("Read the namespace's rules"));
    await waitFor(() => expect(azure.calls.map((c) => c.path)).toEqual([`${NS_PATH}/authorizationRules`]));

    const paste = screen.getByLabelText(`Connection string for ${DEFENDER_TITLE}`) as HTMLInputElement;
    fireEvent.change(paste, { target: { value: LISTEN_CS } });

    const create = await waitFor(() => {
      const b = button("Create the Cribl source");
      expect(b.disabled).toBe(false);
      return b;
    });
    const savesBefore = progressSaves(store).length;
    fireEvent.click(create);
    const confirm = await waitFor(() => button("Confirm: create the source"));
    // The first click planned: GETs only, nothing written anywhere.
    expect(cribl.calls.every((c) => c.method === "GET")).toBe(true);
    expect(azure.calls.every((c) => c.method === "GET")).toBe(true);
    expect(progressSaves(store).length).toBe(savesBefore);
    const planned = cribl.calls.length;

    fireEvent.click(confirm);
    await waitFor(() => expect(progressSaves(store).length).toBe(savesBefore + 1));

    const postedId = (path: string): string => {
      const call = cribl.calls.find((c) => c.method === "POST" && c.path === path);
      if (call === undefined) throw new Error(`no POST ${path}`);
      return (call.body as { id: string }).id;
    };
    const inputId = postedId("/system/inputs");
    const secretId = postedId("/system/secrets");
    expect(cribl.labels().slice(planned)).toEqual([
      `GET /m/${G}/version/status`,
      `GET /m/${G}/system/secrets/${secretId}`,
      `GET /m/${G}/system/inputs`,
      `POST /m/${G}/system/secrets`,
      `GET /m/${G}/system/inputs`,
      `POST /m/${G}/system/inputs`,
      `GET /m/${G}/system/inputs/${inputId}`,
      `GET /m/${G}/version/status`,
      `POST /m/${G}/version/commit`,
      `GET /m/${G}/version/status`,
      `GET /m/${G}/version?offset=0&limit=1`,
      `PATCH /products/stream/groups/${G}/deploy`,
      `GET /products/stream/groups/${G}`,
    ]);

    const saved = progressSaves(store).at(-1)?.value as {
      criblSources: Record<string, { inputId: string; secretId: string; groupId: string; inputType: string }>;
    };
    expect(saved.criblSources["defenderExport"]).toEqual({ groupId: G, inputId, inputType: "eventhub", secretId });

    // The pasted key went into the secret POST and nowhere the screen keeps.
    const secretPost = cribl.calls.find((c) => c.method === "POST" && c.path === "/system/secrets");
    expect(JSON.stringify(secretPost?.body)).toContain(KEY);
    for (const s of store.saves) expect(JSON.stringify(s.value)).not.toContain(KEY);
    const others = cribl.calls.filter((c) => c !== secretPost);
    for (const c of others) expect(JSON.stringify(c)).not.toContain(KEY);
    expect(view.container.innerHTML).not.toContain(KEY);
    expect(paste.value).toBe("");
  });
});
