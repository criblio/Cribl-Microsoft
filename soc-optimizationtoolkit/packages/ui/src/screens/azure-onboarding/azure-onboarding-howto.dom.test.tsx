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
  tenantDocumentKey,
  ONBOARDING_PROGRESS_KIND,
  ONBOARDING_PROGRESS_VERSION,
  TENANT_CRIBL_MAPPING_KEY,
  TENANT_CRIBL_MAPPING_KIND,
  TENANT_CRIBL_MAPPING_VERSION,
} from "@soc/core";
import type {
  AzureConfig,
  AzureManagement,
  AzureManagementRequest,
  BatchPacing,
  CriblClient,
  CriblGroupSummary,
  CriblRequest,
  GraphDirectory,
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

// The CONFIG tenant's own documents (ADR 0009 decision 3): the screen reads and
// writes `{key}.{tenantId}`, never the legacy single-tenant key.
const SELECTION_KEY = tenantDocumentKey(COVERAGE_SELECTION_KEY, "tenant") as string;
const PROGRESS_KEY = tenantDocumentKey(ONBOARDING_PROGRESS_KEY, "tenant") as string;

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

/**
 * A progress document with Defender chosen in How-to mode against ns1/h1. The
 * Activity Log is pinned to How-to and not chosen: it became automatable
 * (AZR-98), and with no stored mode the default selection would choose it,
 * putting a second source into every Defender-only pin here.
 */
function progressDoc(over: Record<string, unknown> = {}): unknown {
  return {
    kind: ONBOARDING_PROGRESS_KIND,
    version: ONBOARDING_PROGRESS_VERSION,
    sources: { defenderExport: { chosen: true, mode: "manual" }, activityLog: { chosen: false, mode: "manual" } },
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
    // AZR-56: the plan reads the consumer group the source will use.
    if (r.path === `${NS_PATH}/eventhubs/${HUB}/consumergroups/cribl`) {
      return ok({ name: "cribl", id: `${NS_PATH}/eventhubs/${HUB}/consumergroups/cribl` });
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
  groups: CriblGroupSummary[];
  /** The one worker group this fake answers for; every other group is unrouted. */
  private readonly group: string;
  constructor(group: string = G) {
    this.group = group;
    this.groups = [{ id: group, product: "stream" }];
  }
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
    if (r.groupId === this.group) {
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
            ? { items: [{ modified: [`groups/${this.group}/local/cribl/inputs.yml`, `groups/${this.group}/local/cribl/secrets.yml`] }] }
            : { items: [] },
        );
      }
      if (r.method === "POST" && p === "/version/commit") {
        this.dirty = false;
        return ok({ items: [{ commit: HASH }] });
      }
      if (r.method === "GET" && p === "/version") return ok({ items: [{ hash: HASH }] });
    }
    if (r.groupId === undefined && r.method === "PATCH" && p === `/products/stream/groups/${this.group}/deploy`) return ok({});
    if (r.groupId === undefined && r.method === "GET" && p === `/products/stream/groups/${this.group}`) {
      return ok({ items: [{ id: this.group, configVersion: "a1b2c3d" }] });
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
  graph?: GraphDirectory;
} = {}) {
  const store = opts.store ?? new FakeKvDocumentStore();
  const azure = opts.azure ?? new RoutingAzure();
  const cribl = opts.cribl ?? new RoutingCribl();
  const logger = new FakeLogger(() => "t");
  const pacing = opts.pacing === undefined ? countingPacing() : opts.pacing;
  const ports = {
    azure,
    cribl,
    logger,
    kvDocuments: store,
    ...(opts.graph === undefined ? {} : { graph: opts.graph }),
  } as unknown as UiPorts;
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
  return store.saves.filter((s) => s.key === PROGRESS_KEY);
}

describe("AzureOnboardingScreen - the How-to composition at mount", () => {
  it("loads exactly the selection, the progress document and the tenant to Cribl mapping, and makes no Azure or Cribl call", async () => {
    const { store, azure, cribl } = mount();
    await loaded();
    // First run: each tenant document absent, so its legacy copy is looked at once.
    // The mapping is one app-wide document (AZR-64), read once.
    expect([...store.loads].sort()).toEqual(
      [SELECTION_KEY, COVERAGE_SELECTION_KEY, PROGRESS_KEY, ONBOARDING_PROGRESS_KEY, TENANT_CRIBL_MAPPING_KEY].sort(),
    );
    expect(azure.calls).toEqual([]);
    expect(cribl.calls).toEqual([]);
    expect(cribl.listGroupsCalls).toBe(0);
    // The four new sections are there.
    for (const title of NEW_SECTION_TITLES) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
  });

  it("lists worker groups only when asked", async () => {
    const { cribl } = mount({ store: new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() }) });
    await loaded();
    expect(cribl.listGroupsCalls).toBe(0);
    fireEvent.click(button("Load worker groups"));
    await waitFor(() => expect(cribl.listGroupsCalls).toBe(1));
    expect(cribl.calls).toEqual([]);
  });
});

describe("AzureOnboardingScreen - progress writes", () => {
  it("a tick writes the progress document once and never the selection", async () => {
    const store = new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() });
    mount({ store });
    await loaded();
    const ticks = await waitFor(() => {
      const found = screen.getAllByRole("checkbox", { name: /^Done: / });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    fireEvent.click(ticks[0] as HTMLElement);
    await waitFor(() => expect(progressSaves(store).length).toBe(1));
    expect(store.saves.map((s) => s.key)).toEqual([PROGRESS_KEY]);
    const doc = progressSaves(store)[0]?.value as { kind: string; ticks: Record<string, unknown> };
    expect(doc.kind).toBe(ONBOARDING_PROGRESS_KIND);
    expect(Object.keys(doc.ticks).length).toBe(1);
  });

  it("a FAILED progress read blocks every progress write, and the selection's Save still works", async () => {
    const store = new FakeKvDocumentStore().scriptLoad(PROGRESS_KEY, {
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
    await waitFor(() => expect(store.saves.map((s) => s.key)).toEqual([SELECTION_KEY]));
    expect(progressSaves(store)).toEqual([]);
  });

  it("the 'choice not carried over' notice outlives the progress save that its mode change queued", async () => {
    // The saved selection could not be read, and Defender is chosen in How-to mode.
    const store = new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() }).scriptLoad(
      SELECTION_KEY,
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
    const store = new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() });
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
    mount({ store: new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() }) });
    await loaded();
    // Both deployable sources are in How-to in progressDoc, so each shows the note.
    expect(screen.getAllByText(DEFENDER_HOWTO_NOTE)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Read Defender state" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Read diagnostic settings" })).toBeNull();
  });

  it("with no progress stored, Defender stays Automated and its deploy controls are shown", async () => {
    mount();
    await loaded();
    expect(screen.queryByText(DEFENDER_HOWTO_NOTE)).toBeNull();
    expect(screen.getByRole("button", { name: "Read Defender state" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read diagnostic settings" })).toBeTruthy();
  });
});

describe("AzureOnboardingScreen - Validate", () => {
  it("sends only GETs, each one through the paced wrapper", async () => {
    const { azure, pacing } = mount({ store: new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() }) });
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

  // AZR-42 (found live 2026-10-28): after the plan moved to another namespace,
  // the old run's answers stayed beside the new values in every step.
  it("a run's answers stop describing the steps once the plan values change", async () => {
    mount({ store: new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() }) });
    await loaded();
    const validate = button("Validate (read only)");
    await waitFor(() => expect(validate.disabled).toBe(false));
    fireEvent.click(validate);
    await waitFor(() => expect(screen.getByText(/^Checked as of /)).toBeTruthy());
    const nsStep = (name: string) =>
      Array.from(document.querySelectorAll("li")).find((li) =>
        li.textContent?.includes(`Create or pick the Event Hub namespace ${name}`),
      );
    await waitFor(() => expect(nsStep(NS)?.textContent).not.toContain("Check: not checked yet"));

    fireEvent.change(screen.getByRole("textbox", { name: "Event Hub namespace" }), { target: { value: "ns-other" } });
    fireEvent.click(button("Apply"));

    await waitFor(() => expect(nsStep("ns-other")?.textContent).toContain("Check: not checked yet"));
    expect(screen.getByRole("note").textContent).toContain("changed since: Event Hub namespace");
  });

  it("without a pacing, Validate is disabled with its reason and reads nothing", async () => {
    const { azure } = mount({
      store: new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() }),
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
    const store = new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() });
    const { cribl, azure, view } = mount({ store });
    await loaded();

    fireEvent.click(button("Read the namespace's rules"));
    await waitFor(() => expect(azure.calls.map((c) => c.path)).toEqual([`${NS_PATH}/authorizationRules`]));

    // Entra ID is the default (ADR 0008); this pin drives the paste fallback.
    fireEvent.click(screen.getByLabelText(/^Paste a connection string/));
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

  it("an Entra ID plan asks the bound directory to tie the client id to the object id, and refuses a mismatch", async () => {
    // AZR-59 review: without ports.graph reaching the plan, the cross-check
    // never runs in the product and every create is "not cross-checked".
    const CRIBL_CLIENT = "11111111-1111-1111-1111-111111111111";
    const store = new FakeKvDocumentStore({
      [ONBOARDING_PROGRESS_KEY]: progressDoc({
        planValues: {
          subscriptionId: SUB,
          resourceGroup: RG,
          namespace: NS,
          hubName: HUB,
          consumerGroup: "cribl",
          criblTenantId: "cribl-tenant",
          criblClientId: CRIBL_CLIENT,
          criblPrincipalObjectId: "object-entered",
        },
      }),
    });
    let listed = 0;
    const graph: GraphDirectory = {
      readSubscribedSkus: async () => ({ kind: "denied", status: 403, detail: "unused" }),
      listServicePrincipals: async () => {
        listed++;
        return [{ id: "object-real", appId: CRIBL_CLIENT, displayName: "cribl-reader" }];
      },
    };
    const { cribl } = mount({ store, graph });
    await loaded();
    const secret = screen.getByLabelText(`Cribl principal client secret for ${DEFENDER_TITLE}`) as HTMLInputElement;
    fireEvent.change(secret, { target: { value: "entra-client-secret-value" } });
    const create = await waitFor(() => {
      const b = button("Create the Cribl source");
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByText(/belongs to the service principal with object ID object-real/)).toBeTruthy());
    expect(listed).toBe(1);
    expect(cribl.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

/** A stored tenant to Cribl mapping (AZR-64). */
function mappingDoc(over: Record<string, unknown> = {}): unknown {
  return {
    kind: TENANT_CRIBL_MAPPING_KIND,
    version: TENANT_CRIBL_MAPPING_VERSION,
    mode: "per-tenant",
    sharedGroup: null,
    groups: {},
    ...over,
  };
}

/**
 * The Defender lane's paste field. Entra ID is the default credential since
 * AZR-59 (ADR 0008), so the paste choice is picked first when it is not
 * already showing.
 */
function pasteField(): HTMLInputElement {
  if (screen.queryByLabelText(`Connection string for ${DEFENDER_TITLE}`) === null) {
    fireEvent.click(screen.getByLabelText(/^Paste a connection string/));
  }
  return screen.getByLabelText(`Connection string for ${DEFENDER_TITLE}`) as HTMLInputElement;
}

/** Read the rules, paste a Listen key, and click Create then Confirm. */
async function createThroughConfirm(store: FakeKvDocumentStore, azure: RoutingAzure): Promise<void> {
  fireEvent.click(button("Read the namespace's rules"));
  await waitFor(() => expect(azure.calls.map((c) => c.path)).toContain(`${NS_PATH}/authorizationRules`));
  fireEvent.change(pasteField(), { target: { value: LISTEN_CS } });
  const create = await waitFor(() => {
    const b = button("Create the Cribl source");
    expect(b.disabled).toBe(false);
    return b;
  });
  const savesBefore = progressSaves(store).length;
  fireEvent.click(create);
  fireEvent.click(await waitFor(() => button("Confirm: create the source")));
  await waitFor(() => expect(progressSaves(store).length).toBe(savesBefore + 1));
}

describe("AzureOnboardingScreen - the tenant to Cribl mapping (AZR-64)", () => {
  const MAPPED = "g-mapped";

  it("creates in the TENANT'S mapped group, not the group saved on the screen, and records that group", async () => {
    // The screen's own saved group is G; the mapping says this tenant uses MAPPED.
    // The fake answers only for MAPPED, so a create aimed at G fails loudly.
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc(),
      [TENANT_CRIBL_MAPPING_KEY]: mappingDoc({ groups: { tenant: MAPPED } }),
    });
    const azure = new RoutingAzure();
    const cribl = new RoutingCribl(MAPPED);
    mount({ store, azure, cribl });
    await loaded();
    expect(
      await screen.findByText(
        `Worker group ${MAPPED}: this tenant's own group, from the tenant to Cribl mapping on Setup.`,
      ),
    ).toBeTruthy();
    // One answer to "which group": the screen's picker is not offered.
    expect(screen.queryByRole("button", { name: "Load worker groups" })).toBeNull();

    await createThroughConfirm(store, azure);
    expect(cribl.calls.filter((c) => c.groupId !== undefined).every((c) => c.groupId === MAPPED)).toBe(true);
    expect(cribl.labels()).toContain(`PATCH /products/stream/groups/${MAPPED}/deploy`);
    const saved = progressSaves(store).at(-1)?.value as {
      criblSources: Record<string, { groupId: string }>;
      workerGroup: string | null;
    };
    expect(saved.criblSources["defenderExport"]?.groupId).toBe(MAPPED);
  });

  it("one group for every tenant: Read Cribl side reads the shared group", async () => {
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc(),
      [TENANT_CRIBL_MAPPING_KEY]: mappingDoc({ mode: "shared", sharedGroup: MAPPED, groups: { tenant: "elsewhere" } }),
    });
    const cribl = new RoutingCribl(MAPPED);
    mount({ store, cribl });
    await loaded();
    await screen.findByText(
      `Worker group ${MAPPED}: the one group for every tenant, from the tenant to Cribl mapping on Setup.`,
    );
    fireEvent.click(button("Read Cribl side"));
    await waitFor(() => expect(cribl.calls.length).toBeGreaterThan(0));
    const groups = cribl.calls.filter((c) => c.groupId !== undefined).map((c) => c.groupId);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g === MAPPED)).toBe(true);
  });

  it("the live flow watches the mapped group even when the screen chose none", async () => {
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc({
        workerGroup: null,
        criblSources: { defenderExport: { groupId: MAPPED, inputId: "in-1", inputType: "eventhub", secretId: "s-1" } },
      }),
      [TENANT_CRIBL_MAPPING_KEY]: mappingDoc({ groups: { tenant: MAPPED } }),
    });
    mount({ store });
    await loaded();
    await screen.findByText(`Worker group ${MAPPED}: this tenant's own group, from the tenant to Cribl mapping on Setup.`);
    const watch = screen.getByRole("checkbox", { name: "Watch for data" }) as HTMLInputElement;
    expect(watch.disabled).toBe(false);
    expect(screen.queryByText("Choose a worker group under Cribl Stream source first.")).toBeNull();
  });

  it("the live flow watches the mapped group, not the group saved on the screen", async () => {
    // The lane's source is in MAPPED; the screen's saved group is G. The Watch
    // (i) spells out the literal metrics request, which names the group asked.
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc({
        criblSources: { defenderExport: { groupId: MAPPED, inputId: "in-1", inputType: "eventhub", secretId: "s-1" } },
      }),
      [TENANT_CRIBL_MAPPING_KEY]: mappingDoc({ groups: { tenant: MAPPED } }),
    });
    const { view } = mount({ store });
    await loaded();
    await screen.findByText(`Worker group ${MAPPED}: this tenant's own group, from the tenant to Cribl mapping on Setup.`);
    fireEvent.click(screen.getByRole("checkbox", { name: "Watch for data" }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "Watch for data" }) as HTMLInputElement).checked).toBe(true));
    const tip = view.container.querySelector(".azo-flow-watch .info-tip-pop")?.textContent ?? "";
    // AZR-95: the path is the leader's; the mapped group is the one the body's where scopes.
    expect(tip).toContain("POST /system/metrics/query");
    expect(tip).toContain(`__worker_group==\\"${MAPPED}\\"`);
    expect(tip).not.toContain(`__worker_group==\\"${G}\\"`);
  });

  it("UNSET falls back to the group chosen on the screen, and says so as information, not a fault", async () => {
    const store = new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc() });
    mount({ store });
    await loaded();
    const line = await screen.findByText(
      "No tenant to Cribl mapping is set up yet. The worker group chosen here is used; the mapping on Setup can set one per tenant.",
    );
    expect(line.className).toContain("azure-onboarding-banner-info");
    expect(line.getAttribute("role")).toBeNull();
    expect(button("Load worker groups")).toBeTruthy();
    expect(button("Read Cribl side").disabled).toBe(false);
  });

  it("a per-tenant mapping with no row for THIS tenant is unset, never another tenant's group", async () => {
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc(),
      [TENANT_CRIBL_MAPPING_KEY]: mappingDoc({ groups: { "other-tenant": "g-other" } }),
    });
    mount({ store });
    await loaded();
    expect(
      await screen.findByText(/none is chosen for this tenant yet\. The worker group chosen here is used/),
    ).toBeTruthy();
    expect(screen.queryByText(/Worker group g-other/)).toBeNull();
  });

  it("an UNREADABLE mapping never falls back: Create, Read Cribl side and Watch are all unavailable, and nothing reaches Cribl", async () => {
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc({
        criblSources: { defenderExport: { groupId: G, inputId: "in-1", inputType: "eventhub", secretId: "s-1" } },
      }),
    }).scriptLoad(TENANT_CRIBL_MAPPING_KEY, { kind: "unknown", reason: "HTTP 503", status: 503 });
    const { cribl } = mount({ store });
    await loaded();
    expect(await screen.findByText(/Which worker group this tenant uses is unknown: HTTP 503/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load worker groups" })).toBeNull();
    expect(button("Read Cribl side").disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Watch for data" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(pasteField(), { target: { value: LISTEN_CS } });
    await waitFor(() => expect(button("Create the Cribl source").disabled).toBe(true));
    fireEvent.click(button("Create the Cribl source"));
    fireEvent.click(button("Read Cribl side"));
    await Promise.resolve();
    expect(cribl.calls).toEqual([]);
    expect(cribl.listGroupsCalls).toBe(0);
  });

  it("our own mapping with a mode this release cannot read is unknown, never a fall back to the screen's group", async () => {
    const store = new FakeKvDocumentStore({
      [PROGRESS_KEY]: progressDoc(),
      [TENANT_CRIBL_MAPPING_KEY]: mappingDoc({ mode: "Shared", sharedGroup: "hub" }),
    });
    const { cribl } = mount({ store });
    await loaded();
    expect(await screen.findByText(/Which worker group this tenant uses is unknown: .*mode/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load worker groups" })).toBeNull();
    expect(button("Read Cribl side").disabled).toBe(true);
    expect(cribl.listGroupsCalls).toBe(0);
  });

  it("a mapping document this app did not write is unknown too, and is never overwritten", async () => {
    const foreign = { kind: "someone-else", mode: "shared", sharedGroup: MAPPED };
    const store = new FakeKvDocumentStore({ [PROGRESS_KEY]: progressDoc(), [TENANT_CRIBL_MAPPING_KEY]: foreign });
    mount({ store });
    await loaded();
    expect(await screen.findByText(/Which worker group this tenant uses is unknown/)).toBeTruthy();
    expect(store.saves.filter((s) => s.key === TENANT_CRIBL_MAPPING_KEY)).toEqual([]);
  });
});
