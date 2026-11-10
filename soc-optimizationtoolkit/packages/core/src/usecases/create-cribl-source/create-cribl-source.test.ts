import { describe, expect, it } from "vitest";
import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { CriblClient, CriblRequest } from "../../ports/cribl-client";
import type { GraphDirectory, ServicePrincipalRef } from "../../ports/graph-directory";
import type { PortHttpResponse } from "../../ports/http";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeLogger } from "../../testing/fake-logger";
import { defaultPlanValues, type PlanValues } from "../../domain/onboarding-howto/plan-values";
import { onboardingSource, type OnboardingSource } from "../../domain/onboarding-howto/sources";
import {
  COMMIT_MARKERS,
  buildEventHubInputBody,
  onboardingInputId,
  onboardingSecretId,
} from "../../domain/cribl-onboarding-source";
import {
  applyCriblSource,
  planCriblSource,
  type ApplyCredential,
  type ApplyCriblSourceOutcome,
  type CriblSourcePorts,
  type PlanCredential,
  type PlanCriblSourceInput,
  type ReadyCriblSource,
} from "./index";
import { commitFilesFor } from "./plan-cribl-source";
import { placePath } from "../../kit/config-writes/commitDeploy";

// ---------------------------------------------------------------------------
// One call log across both ports, so the pinned order spans Cribl and Azure.
// ---------------------------------------------------------------------------

type Entry =
  | { port: "cribl"; req: CriblRequest; label: string }
  | { port: "azure"; req: AzureManagementRequest; label: string };

function criblLabel(r: CriblRequest): string {
  const q = r.query ? `?${Object.entries(r.query).map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  return `${r.method} ${r.groupId === undefined ? "" : `/m/${r.groupId}`}${r.path}${q}`;
}

function harness() {
  const cribl = new FakeCriblClient();
  const azure = new FakeAzureManagement();
  const logger = new FakeLogger(() => "t");
  const log: Entry[] = [];
  const criblPort: CriblClient = {
    request: (req) => {
      log.push({ port: "cribl", req, label: criblLabel(req) });
      return cribl.request(req);
    },
    listGroups: () => cribl.listGroups(),
  };
  const azurePort: AzureManagement = {
    request: (req) => {
      log.push({ port: "azure", req, label: `AZ ${req.method} ${req.path}` });
      return azure.request(req);
    },
  };
  const ports: CriblSourcePorts = { cribl: criblPort, azure: azurePort, logger };
  const labels = () => log.map((e) => e.label);
  const writes = () => log.filter((e) => e.port === "cribl" && e.req.method !== "GET");
  return { cribl, azure, logger, log, ports, labels, writes };
}

const ok = (body: unknown): PortHttpResponse => ({ status: 200, body });
const status = (code: number, body: unknown = { message: "x" }): PortHttpResponse => ({ status: code, body });

const G = "g1";
const KEY = "SUPERSECRETKEYVALUE==";
const LISTEN_CS = `Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=reader;SharedAccessKey=${KEY}`;
const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function defender(): OnboardingSource {
  const s = onboardingSource("defenderExport");
  if (s === undefined) throw new Error("no defender source");
  return s;
}

function values(over: Partial<Record<keyof PlanValues, string>> = {}): PlanValues {
  return {
    ...defaultPlanValues({ subscriptionId: "sub1", resourceGroup: "rg1" }),
    namespace: "ns1",
    hubName: "h1",
    ...over,
  };
}

const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const INPUT_ID = onboardingInputId(defender(), values(), TENANT)!;
const SECRET_ID = onboardingSecretId(INPUT_ID);

function planInput(credential: PlanCredential, over: Partial<PlanCriblSourceInput> = {}): PlanCriblSourceInput {
  return {
    groupId: G,
    lane: { source: defender(), subSelection: [] },
    values: values(),
    measuredHubs: null,
    kvRecord: null,
    credential,
    tenantId: TENANT,
    ...over,
  };
}

const RULES = {
  value: [
    { name: "reader", id: "r1", properties: { rights: ["Listen"] } },
    { name: "sender", id: "r2", properties: { rights: ["Send"] } },
    { name: "admin", id: "r3", properties: { rights: ["Manage", "Listen", "Send"] } },
  ],
};

/** Azure answers for the plan: namespace (sku), the rules list, then the consumer group on h1. */
function scriptAzurePlan(h: ReturnType<typeof harness>, sku = "Standard"): void {
  h.azure.respondWith(ok({ name: "ns1", sku: { name: sku } }), ok(RULES), ok({ name: "cribl" }));
}

/** Cribl answers for a clean plan: no inputs, no secret, nothing pending. */
function scriptCriblPlan(h: ReturnType<typeof harness>): void {
  h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [] }));
}

const DIRTY = { items: [{ modified: [`groups/${G}/local/cribl/inputs.yml`, `groups/${G}/local/cribl/secrets.yml`] }] };

/** Cribl answers for apply, up to and including the input read-back. */
function scriptApplyThroughCreate(h: ReturnType<typeof harness>, ready: ReadyCriblSource): void {
  h.cribl.respondWith(
    ok({ items: [] }), // 1 GET status
    status(404), // 2 GET secret
    ok({ items: [] }), // 2 GET inputs
    ok({ items: [{ id: SECRET_ID }] }), // 4 POST secrets
    ok({ items: [] }), // 5 GET inputs
    ok({ items: [ready.inputBody] }), // 5 POST inputs
    ok({ items: [ready.inputBody] }), // 6 GET input/:id
  );
}

/** The kit's commit sequence, happy. */
function scriptCommitDeploy(h: ReturnType<typeof harness>, configVersion: PortHttpResponse = ok({ items: [{ id: G, configVersion: "a1b2c3d" }] })): void {
  h.cribl.respondWith(
    ok(DIRTY), // GET status
    ok({ items: [{ commit: HASH }] }), // POST commit
    ok({ items: [] }), // GET status
    ok({ items: [{ hash: HASH }] }), // GET version (HEAD)
    ok({}), // PATCH deploy
    configVersion, // GET group
  );
}

async function readyListKeys(h: ReturnType<typeof harness>, rule = "reader"): Promise<ReadyCriblSource> {
  scriptAzurePlan(h);
  scriptCriblPlan(h);
  const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule }));
  if (plan.kind !== "ready") throw new Error(`plan not ready: ${JSON.stringify(plan)}`);
  return plan.ready;
}

async function readyPaste(h: ReturnType<typeof harness>, keyName = "reader"): Promise<ReadyCriblSource> {
  scriptAzurePlan(h);
  scriptCriblPlan(h);
  const plan = await planCriblSource(
    h.ports,
    planInput({ kind: "paste", descriptor: { host: "ns1.servicebus.windows.net", keyName }, attested: false }),
  );
  if (plan.kind !== "ready") throw new Error(`plan not ready: ${JSON.stringify(plan)}`);
  return plan.ready;
}

const LIST_KEYS = ok({ primaryConnectionString: LISTEN_CS, primaryKey: KEY });

const APPLY_LOG = [
  `GET /m/${G}/version/status`,
  `GET /m/${G}/system/secrets/${SECRET_ID}`,
  `GET /m/${G}/system/inputs`,
  "AZ POST /subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.EventHub/namespaces/ns1/authorizationRules/reader/listKeys",
  `POST /m/${G}/system/secrets`,
  `GET /m/${G}/system/inputs`,
  `POST /m/${G}/system/inputs`,
  `GET /m/${G}/system/inputs/${INPUT_ID}`,
  `GET /m/${G}/version/status`,
  `POST /m/${G}/version/commit`,
  `GET /m/${G}/version/status`,
  `GET /m/${G}/version?offset=0&limit=1`,
  `PATCH /products/stream/groups/${G}/deploy`,
  `GET /products/stream/groups/${G}`,
];

function deepContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? null).includes(needle);
}

// ---------------------------------------------------------------------------

describe("commitFilesFor", () => {
  // DBT-164: the confirm names these as an upper bound on the commit. The kit
  // exports no path builder, so each name is held to the kit's own classifier:
  // a name the kit would not place as this group's file could never be
  // committed, and the confirm would list a file the commit cannot carry.
  it("names one file per marker, each placed by the kit as this group's", () => {
    const files = commitFilesFor(G);
    expect(files).toHaveLength(COMMIT_MARKERS.length);
    for (const f of files) expect(placePath(f, G, COMMIT_MARKERS), f).toBe("mine");
  });
});

describe("planCriblSource", () => {
  it("makes only GETs, on both ports, and names what the confirm shows", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    expect(h.log.length).toBe(6);
    expect(h.log.every((e) => e.req.method === "GET")).toBe(true);
    expect(ready.readsFrom).toEqual({ hubs: ["h1"], consumerGroup: "cribl" });
    expect(ready).toMatchObject({
      groupId: G,
      inputId: INPUT_ID,
      inputType: "eventhub",
      secretId: SECRET_ID,
      keyNameOrPrincipal: "reader",
      commitFiles: [`groups/${G}/local/cribl/inputs.yml`, `groups/${G}/local/cribl/secrets.yml`, `groups/${G}/local/cribl/auth/cribl.secret`],
      dirtyAlready: [],
    });
  });

  // AZR-56: an input whose consumer group does not exist cannot read.
  it("reads the plan's consumer group on the lane's hub, by name", async () => {
    const h = harness();
    await readyListKeys(h);
    const cg = h.log.find((e) => e.port === "azure" && e.req.path.includes("/consumergroups/"));
    expect(cg?.req.path).toMatch(/\/namespaces\/ns1\/eventhubs\/h1\/consumergroups\/cribl$/);
  });

  it("refuses a missing consumer group before any Cribl call, naming the group and the hub", async () => {
    const h = harness();
    h.azure.respondWith(ok({ name: "ns1", sku: { name: "Standard" } }), ok(RULES), status(404, { error: { code: "NotFound" } }));
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "consumer-group-missing" });
    expect(JSON.stringify(plan)).toContain("cribl");
    expect(JSON.stringify(plan)).toContain("h1");
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  it("refuses when the consumer group cannot be read, never assuming it exists", async () => {
    const h = harness();
    h.azure.respondWith(ok({ name: "ns1", sku: { name: "Standard" } }), ok(RULES), status(403, { error: { code: "AuthorizationFailed" } }));
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "consumer-group-unreadable" });
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  it("refuses a listKeys rule without Listen before any write", async () => {
    const h = harness();
    scriptAzurePlan(h);
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "sender" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "rule-cannot-listen" });
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  // AZR-58: listKeys on a Manage rule would put namespace control in a Cribl secret.
  it("refuses a Manage-capable rule for listKeys before any Cribl call, naming the rule", async () => {
    const h = harness();
    scriptAzurePlan(h);
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "admin" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "rule-can-manage" });
    expect(JSON.stringify(plan)).toContain("admin");
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
    expect(h.writes()).toEqual([]);
  });

  it("refuses a pasted Manage-capable key name before any write", async () => {
    const h = harness();
    scriptAzurePlan(h);
    const plan = await planCriblSource(
      h.ports,
      planInput({ kind: "paste", descriptor: { host: "ns1.servicebus.windows.net", keyName: "admin" }, attested: false }),
    );
    expect(plan).toMatchObject({ kind: "refused", reason: "rule-can-manage" });
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  it("refuses when the rules list is denied (listKeys)", async () => {
    const h = harness();
    h.azure.respondWith(ok({ sku: { name: "Standard" } }), status(403, { error: { code: "AuthorizationFailed" } }));
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "rules-unreadable" });
    expect(h.writes()).toEqual([]);
  });

  it("refuses a Basic namespace, and an unknown SKU", async () => {
    const h = harness();
    scriptAzurePlan(h, "Basic");
    expect(await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }))).toMatchObject({ kind: "refused", reason: "basic-sku" });
    const h2 = harness();
    scriptAzurePlan(h2, "");
    expect(await planCriblSource(h2.ports, planInput({ kind: "listKeys", rule: "reader" }))).toMatchObject({ kind: "refused", reason: "sku-unknown" });
    expect([...h.writes(), ...h2.writes()]).toEqual([]);
  });

  it("refuses a pasted Send-only key name before any write", async () => {
    const h = harness();
    scriptAzurePlan(h);
    const plan = await planCriblSource(
      h.ports,
      planInput({ kind: "paste", descriptor: { host: "ns1.servicebus.windows.net", keyName: "sender" }, attested: false }),
    );
    expect(plan).toMatchObject({ kind: "refused", reason: "rule-cannot-listen" });
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  it("carries an attestation into ready when the rules read is denied and the operator attested", async () => {
    const h = harness();
    h.azure.respondWith(ok({ name: "ns1", sku: { name: "Standard" } }), status(403, { error: { code: "AuthorizationFailed" } }), ok({ name: "cribl" }));
    scriptCriblPlan(h);
    const plan = await planCriblSource(
      h.ports,
      planInput({ kind: "paste", descriptor: { host: "ns1.servicebus.windows.net", keyName: "pasted-reader" }, attested: true }),
    );
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.ready.attested).toBe(true);
    expect(plan.ready.keyNameOrPrincipal).toBe("pasted-reader");
    expect(h.writes()).toEqual([]);
  });

  it("refuses an empty group, and laneTopics refusals, with no call at all", async () => {
    const h = harness();
    expect(await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }, { groupId: " " }))).toMatchObject({ kind: "refused", reason: "no-group" });
    const entra = onboardingSource("entraId")!;
    expect(
      await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }, { lane: { source: entra, subSelection: [] } })),
    ).toMatchObject({ kind: "refused", reason: "hubs-not-measured" });
    expect(h.log).toEqual([]);
  });

  it("refuses a differing input with the fields named, and writes nothing", async () => {
    const h = harness();
    scriptAzurePlan(h);
    const existing = buildEventHubInputBody({
      id: INPUT_ID,
      namespace: "ns1",
      topics: ["other-hub"],
      consumerGroup: "cribl",
      secretId: SECRET_ID,
      sourceId: "defenderExport",
      sourceTitle: defender().title,
      connectionTenantId: TENANT,
    });
    h.cribl.respondWith(ok({ items: [existing] }));
    const plan = await planCriblSource(
      h.ports,
      planInput({ kind: "listKeys", rule: "reader" }, { kvRecord: { groupId: G, inputId: INPUT_ID, inputType: "eventhub", secretId: SECRET_ID } }),
    );
    expect(plan).toMatchObject({ kind: "refused", reason: "input-differs", fields: ["topics"] });
    expect(h.writes()).toEqual([]);
  });

  it("reports an ours-matching input as already applied, with zero writes", async () => {
    const h = harness();
    scriptAzurePlan(h);
    const existing = buildEventHubInputBody({
      id: INPUT_ID,
      namespace: "ns1",
      topics: ["h1"],
      consumerGroup: "cribl",
      secretId: SECRET_ID,
      sourceId: "defenderExport",
      sourceTitle: defender().title,
      connectionTenantId: TENANT,
    });
    h.cribl.respondWith(ok({ items: [existing] }));
    const record = { groupId: G, inputId: INPUT_ID, inputType: "eventhub" as const, secretId: SECRET_ID };
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }, { kvRecord: record }));
    expect(plan).toEqual({ kind: "already-applied", record });
    expect(h.writes()).toEqual([]);
  });

  it("keeps a lane's RECORDED id from before tenant ids, so an existing input is never created twice", async () => {
    // ADR 0009 gave new ids a tenant component. A lane created earlier has a
    // record naming the old id; planning under the new id found nothing and
    // offered a SECOND input on the same hubs and consumer group. The record is
    // this tenant's own (the progress document is tenant-scoped), so its id is
    // the lane's id.
    const LEGACY_ID = "azure_onb_eh_ns1_h1";
    const LEGACY_SECRET = `${LEGACY_ID}_secret`;
    const h = harness();
    scriptAzurePlan(h);
    const existing = buildEventHubInputBody({
      id: LEGACY_ID,
      namespace: "ns1",
      topics: ["h1"],
      consumerGroup: "cribl",
      secretId: LEGACY_SECRET,
      sourceId: "defenderExport",
      sourceTitle: defender().title,
      connectionTenantId: TENANT,
    });
    h.cribl.respondWith(ok({ items: [existing] }));
    const record = { groupId: G, inputId: LEGACY_ID, inputType: "eventhub" as const, secretId: LEGACY_SECRET };
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }, { kvRecord: record }));
    expect(plan).toEqual({ kind: "already-applied", record });
    expect(h.writes()).toEqual([]);
  });

  it("does NOT keep a recorded id the CURRENT values would not produce - the operator changed the hub", async () => {
    // Review finding: the record was kept whenever it was well-formed, so after
    // the hub moved from h0 to h1 the plan targeted the OLD input, found it
    // differing, and refused - and after the operator removed it, recreated it
    // under an id naming h0 while it read h1.
    for (const staleId of ["azure_onb_eh_ns1_h0", onboardingInputId(defender(), { ...values(), hubName: "h0" }, TENANT)!]) {
      const h = harness();
      scriptAzurePlan(h);
      scriptCriblPlan(h);
      const record = { groupId: G, inputId: staleId, inputType: "eventhub" as const, secretId: `${staleId}_secret` };
      const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }, { kvRecord: record }));
      expect(plan.kind, staleId).toBe("ready");
      expect(plan.kind === "ready" ? plan.ready : null, staleId).toMatchObject({ inputId: INPUT_ID, secretId: SECRET_ID });
    }
  });

  it("keeps a recorded LEGACY id only while it is the legacy id of the current values", async () => {
    const h = harness();
    scriptAzurePlan(h);
    scriptCriblPlan(h);
    const record = { groupId: G, inputId: "azure_onb_eh_ns1_h1", inputType: "eventhub" as const, secretId: "azure_onb_eh_ns1_h1_secret" };
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }, { kvRecord: record }));
    expect(plan.kind === "ready" ? plan.ready : null).toMatchObject({
      inputId: "azure_onb_eh_ns1_h1",
      secretId: "azure_onb_eh_ns1_h1_secret",
    });
  });

  it("refuses while a pending path cannot be placed", async () => {
    const h = harness();
    scriptAzurePlan(h);
    h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [{ modified: ["local/cribl/inputs.yml"] }] }));
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "scope-unplaced" });
  });

  it("plans a blob lane with no Azure call and an azure_blob body", async () => {
    const h = harness();
    h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [] }));
    const plan = await planCriblSource(
      h.ports,
      planInput(
        { kind: "client-secret", tenantId: "t1", clientId: "c1" },
        { lane: { source: onboardingSource("vnetFlowLogs")!, subSelection: [] }, values: values({ storageAccount: "sa1", queueName: "q1" }) },
      ),
    );
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.ready.inputType).toBe("azure_blob");
    expect(plan.ready.inputBody["type"]).toBe("azure_blob");
    expect(plan.ready.keyNameOrPrincipal).toBe("c1");
    expect(h.log.filter((e) => e.port === "azure")).toEqual([]);
  });

  // AZR-66: the blob lane signed in as the app's own registration, whose
  // secret then sat in a Cribl secret with the app's ARM write rights.
  it("refuses the app's own registration as the blob lane's principal, with no call", async () => {
    const blob = { lane: { source: onboardingSource("vnetFlowLogs")!, subSelection: [] }, values: values({ storageAccount: "sa1", queueName: "q1" }) };
    for (const appClientId of ["c1", " C1 "]) {
      const h = harness();
      const plan = await planCriblSource(h.ports, planInput({ kind: "client-secret", tenantId: "t1", clientId: "c1" }, { ...blob, appClientId }));
      expect(plan).toMatchObject({ kind: "refused", reason: "app-principal" });
      expect(h.log).toEqual([]);
    }
    // A dedicated principal still plans.
    const h = harness();
    h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [] }));
    const plan = await planCriblSource(h.ports, planInput({ kind: "client-secret", tenantId: "t1", clientId: "c1" }, { ...blob, appClientId: "app-1" }));
    expect(plan.kind).toBe("ready");
  });

  it("reports an existing blob input that signs in as the app's registration, and changes nothing", async () => {
    const blob = { lane: { source: onboardingSource("vnetFlowLogs")!, subSelection: [] }, values: values({ storageAccount: "sa1", queueName: "q1" }) };
    // The input as an earlier create made it, with the app's own client id.
    const first = harness();
    first.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [] }));
    const earlier = await planCriblSource(first.ports, planInput({ kind: "client-secret", tenantId: "t1", clientId: "app-1" }, blob));
    if (earlier.kind !== "ready") throw new Error(`expected ready, got ${earlier.kind}`);
    const existing = earlier.ready.inputBody;
    const kvRecord = { groupId: G, inputId: earlier.ready.inputId, inputType: "azure_blob" as const, secretId: earlier.ready.secretId };

    const h = harness();
    h.cribl.respondWith(ok({ items: [existing] }));
    const plan = await planCriblSource(
      h.ports,
      planInput({ kind: "client-secret", tenantId: "t1", clientId: "cribl-sp" }, { ...blob, appClientId: "APP-1", kvRecord }),
    );
    expect(plan).toMatchObject({ kind: "refused", reason: "input-differs" });
    expect(plan.kind === "refused" ? plan.detail : "").toContain("signs in as this app's own registration");
    expect(h.log.every((e) => e.req.method === "GET")).toBe(true);

    // The same difference on an input that does NOT use the app's id says nothing about it.
    const other = harness();
    other.cribl.respondWith(ok({ items: [{ ...existing, clientId: "someone-else" }] }));
    const plain = await planCriblSource(
      other.ports,
      planInput({ kind: "client-secret", tenantId: "t1", clientId: "cribl-sp" }, { ...blob, appClientId: "app-1", kvRecord }),
    );
    expect(plain).toMatchObject({ kind: "refused", reason: "input-differs" });
    expect(plain.kind === "refused" ? plain.detail : "").not.toContain("own registration");
  });
});

describe("applyCriblSource", () => {
  it("runs the pinned call order and ends created-running on a prefix-equal configVersion", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    scriptApplyThroughCreate(h, ready);
    scriptCommitDeploy(h);
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(h.labels()).toEqual(APPLY_LOG);
    expect(outcome).toEqual({
      kind: "created-running",
      record: { groupId: G, inputId: INPUT_ID, inputType: "eventhub", secretId: SECRET_ID },
      hash: HASH,
      configVersion: "a1b2c3d",
    });
    const commit = h.log.find((e) => e.label === `POST /m/${G}/version/commit`)!;
    expect(commit.req).toMatchObject({ body: { files: DIRTY.items[0]!.modified } });
    const secretPost = h.log.find((e) => e.label === `POST /m/${G}/system/secrets`)!;
    expect(secretPost.req).toMatchObject({ body: { id: SECRET_ID, secretType: "text", value: LISTEN_CS } });
    expect((secretPost.req as CriblRequest).body).not.toHaveProperty("type");
  });

  it("never sends a password in the input POST body", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    scriptApplyThroughCreate(h, ready);
    scriptCommitDeploy(h);
    await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    const inputPost = h.log.find((e) => e.label === `POST /m/${G}/system/inputs`)!;
    expect(deepContains(inputPost.req, "password")).toBe(false);
    expect((inputPost.req as CriblRequest).body).toMatchObject({ type: "eventhub", sasl: { textSecret: SECRET_ID } });
  });

  it("falls back to the master deploy path only on a 404", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    scriptApplyThroughCreate(h, ready);
    h.cribl.respondWith(
      ok(DIRTY),
      ok({ items: [{ commit: HASH }] }),
      ok({ items: [] }),
      ok({ items: [{ hash: HASH }] }),
      status(404), // products deploy
      ok({}), // master deploy
      ok({ items: [{ id: G, configVersion: HASH }] }), // products group read
    );
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(h.labels().slice(-3)).toEqual([
      `PATCH /products/stream/groups/${G}/deploy`,
      `PATCH /master/groups/${G}/deploy`,
      `GET /products/stream/groups/${G}`,
    ]);
    expect(outcome.kind).toBe("created-running");
  });

  it("a 403 on the products deploy is deploy-failed via products, with no master call", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    scriptApplyThroughCreate(h, ready);
    h.cribl.respondWith(ok(DIRTY), ok({ items: [{ commit: HASH }] }), ok({ items: [] }), ok({ items: [{ hash: HASH }] }), status(403));
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "created-not-deployed", reason: "deploy-failed", route: "products", hash: HASH });
    expect(h.labels().some((l) => l.includes("/master/"))).toBe(false);
  });

  it("refuses a secret 409 with no PATCH and no input POST", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [] }), status(409));
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "secret-exists" });
    expect(h.writes().map((e) => e.label)).toEqual([`POST /m/${G}/system/secrets`]);
  });

  it("refuses scope-grew with zero writes and no listKeys", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.cribl.respondWith(ok({ items: [{ modified: [`groups/${G}/local/cribl/inputs.yml`] }] }));
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "scope-grew" });
    expect(h.writes()).toEqual([]);
    expect(h.log.filter((e) => e.port === "azure")).toEqual([]);
  });

  it("refuses when the input appeared since the confirm, before listKeys", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [{ id: INPUT_ID, description: "hand made" }] }));
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "input-appeared" });
    expect(h.log.filter((e) => e.port === "azure")).toEqual([]);
    expect(h.writes()).toEqual([]);
  });

  it("refuses a paste whose descriptor changed between plan and apply, with zero writes", async () => {
    const h = harness();
    const ready = await readyPaste(h);
    h.log.length = 0;
    h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [] }));
    const changed = LISTEN_CS.replace("reader", "admin");
    const outcome = await applyCriblSource(h.ports, ready, { kind: "paste", value: () => changed });
    expect(outcome).toMatchObject({ kind: "refused", reason: "pasted-changed" });
    expect(h.writes()).toEqual([]);
  });

  it("refuses a credential kind that differs from the confirmed one, with no call", async () => {
    const h = harness();
    const ready = await readyPaste(h);
    h.log.length = 0;
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "credential-changed" });
    expect(h.log).toEqual([]);
  });

  it("holds the credential value ONLY in the secrets POST body (paste and listKeys)", async () => {
    for (const mode of ["paste", "listKeys"] as const) {
      const h = harness();
      const ready = mode === "paste" ? await readyPaste(h) : await readyListKeys(h);
      if (mode === "listKeys") h.azure.respondWith(LIST_KEYS);
      scriptApplyThroughCreate(h, ready);
      scriptCommitDeploy(h);
      const credential: ApplyCredential = mode === "paste" ? { kind: "paste", value: () => LISTEN_CS } : { kind: "listKeys" };
      const outcome = await applyCriblSource(h.ports, ready, credential);
      expect(outcome.kind).toBe("created-running");
      const carriers = h.log.filter((e) => deepContains(e.req, KEY)).map((e) => e.label);
      expect(carriers).toEqual([`POST /m/${G}/system/secrets`]);
      expect(deepContains(outcome, KEY)).toBe(false);
      expect(deepContains(ready, KEY)).toBe(false);
      expect(deepContains(h.logger.entries, KEY)).toBe(false);
      expect(h.logger.entries.every((e) => e.message.startsWith("azure-onboarding:"))).toBe(true);
    }
  });

  it("an unreadable configVersion is created-deployed-unconfirmed, a different one too", async () => {
    for (const [answer, version] of [
      [status(500), null],
      [ok({ items: [{ id: G, configVersion: "ffffffff" }] }), "ffffffff"],
    ] as const) {
      const h = harness();
      const ready = await readyListKeys(h);
      h.azure.respondWith(LIST_KEYS);
      scriptApplyThroughCreate(h, ready);
      scriptCommitDeploy(h, answer);
      const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
      expect(outcome).toMatchObject({ kind: "created-deployed-unconfirmed", hash: HASH, configVersion: version });
    }
  });

  it("a read-back mismatch is created-not-deployed and never commits", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    h.cribl.respondWith(
      ok({ items: [] }),
      status(404),
      ok({ items: [] }),
      ok({}),
      ok({ items: [] }),
      ok({}),
      ok({ items: [{ ...ready.inputBody, topics: ["reset"] }] }),
    );
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "created-not-deployed", reason: "stored-mismatch" });
    expect(h.labels().some((l) => l.includes("/version/commit"))).toBe(false);
  });

  it("refuses when the secret appeared since the confirm: no write, no listKeys", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.cribl.respondWith(ok({ items: [] }), ok({ items: [{ id: SECRET_ID }] }));
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "secret-appeared" });
    expect(outcome).not.toHaveProperty("leftBehind");
    expect(h.writes()).toEqual([]);
    expect(h.log.filter((e) => e.port === "azure")).toEqual([]);
  });

  it("refuses when the input appeared in the step-5 re-list, naming the secret left behind", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    h.cribl.respondWith(
      ok({ items: [] }), // 1 GET status
      status(404), // 2 GET secret
      ok({ items: [] }), // 2 GET inputs: still absent
      ok({ items: [{ id: SECRET_ID }] }), // 4 POST secrets
      ok({ items: [{ id: INPUT_ID, description: "hand made" }] }), // 5 GET inputs: appeared
    );
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "input-appeared", leftBehind: { secretId: SECRET_ID } });
    expect(h.writes().map((e) => e.label)).toEqual([`POST /m/${G}/system/secrets`]);
  });

  const FAILURE_CASES: ReadonlyArray<{
    stage: "list-keys" | "secret-create" | "input-create";
    azure: PortHttpResponse;
    cribl: PortHttpResponse[];
    writes: string[];
    /** The operator-visible detail names the refusing answer, not a downstream symptom. */
    detail: RegExp;
    leftBehind?: { secretId: string };
  }> = [
    {
      stage: "list-keys",
      azure: status(403, { error: { code: "AuthorizationFailed" } }),
      cribl: [ok({ items: [] }), status(404), ok({ items: [] })],
      writes: [],
      detail: /^listKeys on rule reader was refused \(HTTP 403\)\.$/,
    },
    {
      stage: "secret-create",
      azure: LIST_KEYS,
      cribl: [ok({ items: [] }), status(404), ok({ items: [] }), status(500)],
      writes: [`POST /m/${G}/system/secrets`],
      detail: new RegExp(`^creating secret ${SECRET_ID}: HTTP 500$`),
    },
    {
      stage: "input-create",
      azure: LIST_KEYS,
      cribl: [ok({ items: [] }), status(404), ok({ items: [] }), ok({ items: [{ id: SECRET_ID }] }), ok({ items: [] }), status(500)],
      writes: [`POST /m/${G}/system/secrets`, `POST /m/${G}/system/inputs`],
      detail: new RegExp(`^creating input ${INPUT_ID}: HTTP 500$`),
      leftBehind: { secretId: SECRET_ID },
    },
  ];

  it.each(FAILURE_CASES)("fails at stage $stage and stops: no later write, no commit or deploy", async (c) => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(c.azure);
    h.cribl.respondWith(...c.cribl);
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect({ kind: outcome.kind, stage: outcome.stage, leftBehind: outcome.leftBehind }).toEqual({
      kind: "failed",
      stage: c.stage,
      leftBehind: c.leftBehind,
    });
    expect(outcome.detail).toMatch(c.detail);
    expect(h.writes().map((e) => e.label)).toEqual(c.writes);
    expect(h.labels().some((l) => l.includes("/version/commit") || l.includes("/deploy"))).toBe(false);
    // Every scripted Cribl answer was consumed: the apply stopped where it failed.
    await expect(h.cribl.request({ method: "GET", path: "/x" })).rejects.toThrow(/no scripted response/);
  });

  const KIT_CASES: ReadonlyArray<[string, PortHttpResponse[]]> = [
    ["nothing-to-commit", [ok({ items: [] })]],
    ["status-unknown", [status(500)]],
    ["scope-unknown", [ok({ items: [{ modified: ["local/cribl/inputs.yml"] }] })]],
    ["commit-failed", [ok(DIRTY), status(500)]],
    ["committed-unknown-hash", [ok(DIRTY), ok({})]],
    ["unverified", [ok(DIRTY), ok({ items: [{ commit: HASH }] }), status(500)]],
    ["incomplete", [ok(DIRTY), ok({ items: [{ commit: HASH }] }), ok(DIRTY)]],
    ["head-unknown", [ok(DIRTY), ok({ items: [{ commit: HASH }] }), ok({ items: [] }), status(500)]],
    ["newer-commit", [ok(DIRTY), ok({ items: [{ commit: HASH }] }), ok({ items: [] }), ok({ items: [{ hash: "ffffffffffff" }] })]],
  ];

  it.each(KIT_CASES)("surfaces the kit outcome %s by name, with no deploy call", async (name, commitAnswers) => {
    const h = harness();
    const ready = await readyListKeys(h);
    h.log.length = 0;
    h.azure.respondWith(LIST_KEYS);
    scriptApplyThroughCreate(h, ready);
    h.cribl.respondWith(...commitAnswers);
    const outcome: ApplyCriblSourceOutcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "created-not-deployed", reason: name });
    expect(h.labels().some((l) => l.includes("/deploy"))).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('"committed"');
    // Every call scripted was consumed: the sequence stopped where the kit says.
    await expect(h.cribl.request({ method: "GET", path: "/x" })).rejects.toThrow(/no scripted response/);
  });
});

// ---------------------------------------------------------------------------
// AZR-59, ADR 0008: Entra ID is the Event Hub lane's default credential.
// ---------------------------------------------------------------------------

describe("planCriblSource with Entra ID", () => {
  const OBJ = "obj-1";
  const CLIENT_SECRET = "ENTRA-CLIENT-SECRET-VALUE";
  const NS_PATH = "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.EventHub/namespaces/ns1";
  const HUB_PATH = `${NS_PATH}/eventhubs/h1`;
  const RECEIVER_ID = "/subscriptions/sub1/providers/Microsoft.Authorization/roleDefinitions/a638d3c7-ab3a-418d-83e6-5f17a39d4fde";
  const ra = (scope: string, roleDefinitionId = RECEIVER_ID) => ({ properties: { roleDefinitionId, scope, principalId: OBJ } });
  const ENTRA: PlanCredential = { kind: "entra-id", tenantId: "t1", clientId: "c1" };
  const entraValues = values({ criblPrincipalObjectId: OBJ });

  function entraInput(over: Partial<PlanCriblSourceInput> = {}): PlanCriblSourceInput {
    return planInput(ENTRA, { values: entraValues, ...over });
  }

  /** namespace (sku), the consumer group on h1, then the role reads given. */
  function scriptAzureEntra(h: ReturnType<typeof harness>, ...roleReads: PortHttpResponse[]): void {
    h.azure.respondWith(ok({ name: "ns1", sku: { name: "Standard" } }), ok({ name: "cribl" }), ...roleReads);
  }

  async function readyEntra(h: ReturnType<typeof harness>): Promise<ReadyCriblSource> {
    scriptAzureEntra(h, ok({ value: [ra(NS_PATH)] }));
    scriptCriblPlan(h);
    const plan = await planCriblSource(h.ports, entraInput());
    if (plan.kind !== "ready") throw new Error(`plan not ready: ${JSON.stringify(plan)}`);
    return plan.ready;
  }

  it("reads the namespace, the consumer group, then the principal's role assignments; never the SAS rules", async () => {
    const h = harness();
    const ready = await readyEntra(h);
    expect(h.log.filter((e) => e.port === "azure").map((e) => e.label)).toEqual([
      `AZ GET ${NS_PATH}`,
      `AZ GET ${HUB_PATH}/consumergroups/cribl`,
      `AZ GET ${NS_PATH}/providers/Microsoft.Authorization/roleAssignments`,
    ]);
    const roleRead = h.log.find((e) => e.label.endsWith("/roleAssignments"))!;
    expect((roleRead.req as AzureManagementRequest).query).toMatchObject({ $filter: "assignedTo('obj-1')" });
    expect(h.log.some((e) => e.label.includes("authorizationRules"))).toBe(false);
    expect(h.log.every((e) => e.req.method === "GET")).toBe(true);
    expect(ready).toMatchObject({
      credentialKind: "entra-id",
      keyNameOrPrincipal: "c1",
      namespace: null,
      entraPrincipal: {
        tenantId: "t1",
        clientId: "c1",
        objectId: OBJ,
        role: "Azure Event Hubs Data Receiver",
        roleScope: NS_PATH,
        principalCheck: "not-cross-checked",
      },
      readsFrom: { hubs: ["h1"], consumerGroup: "cribl" },
    });
    expect(ready.inputBody["sasl"]).toEqual(
      buildEventHubInputBody({
        id: INPUT_ID,
        connectionTenantId: TENANT,
        namespace: "ns1",
        topics: ["h1"],
        consumerGroup: "cribl",
        secretId: SECRET_ID,
        sourceId: "defenderExport",
        sourceTitle: defender().title,
        auth: { kind: "entra-id", tenantId: "t1", clientId: "c1" },
      })["sasl"],
    );
  });

  it("falls back to the hub scope when the namespace read shows no qualifying grant", async () => {
    const h = harness();
    scriptAzureEntra(h, ok({ value: [] }), ok({ value: [ra(HUB_PATH)] }));
    scriptCriblPlan(h);
    const plan = await planCriblSource(h.ports, entraInput());
    expect(plan.kind).toBe("ready");
    expect(h.log.filter((e) => e.label.endsWith("/roleAssignments")).map((e) => e.label)).toEqual([
      `AZ GET ${NS_PATH}/providers/Microsoft.Authorization/roleAssignments`,
      `AZ GET ${HUB_PATH}/providers/Microsoft.Authorization/roleAssignments`,
    ]);
  });

  it("a grant on another hub, or a role that cannot receive, does not count", async () => {
    const h = harness();
    const SENDER = "/subscriptions/sub1/providers/Microsoft.Authorization/roleDefinitions/2b629674-e913-4c01-ae53-ef4638d8f975";
    scriptAzureEntra(h, ok({ value: [ra(`${NS_PATH}/eventhubs/other`)] }), ok({ value: [ra(HUB_PATH, SENDER)] }));
    const plan = await planCriblSource(h.ports, entraInput());
    expect(plan).toMatchObject({ kind: "refused", reason: "receiver-role-missing" });
  });

  it("refuses receiver-role-missing from complete reads, naming the principal and the hub, before any Cribl call", async () => {
    const h = harness();
    scriptAzureEntra(h, ok({ value: [] }), ok({ value: [] }));
    const plan = await planCriblSource(h.ports, entraInput());
    expect(plan).toMatchObject({ kind: "refused", reason: "receiver-role-missing" });
    const text = JSON.stringify(plan);
    expect(text).toContain(OBJ);
    expect(text).toContain("h1");
    expect(text).toContain("Azure Event Hubs Data Receiver");
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  it("refuses receiver-role-unreadable when the hub read is refused, never assuming absent", async () => {
    const h = harness();
    scriptAzureEntra(h, ok({ value: [] }), status(403, { error: { code: "AuthorizationFailed" } }));
    const plan = await planCriblSource(h.ports, entraInput());
    expect(plan).toMatchObject({ kind: "refused", reason: "receiver-role-unreadable" });
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  it("a refused namespace read is answered by a complete hub read (assignedTo returns grants above the scope)", async () => {
    const h = harness();
    scriptAzureEntra(h, status(403, { error: { code: "AuthorizationFailed" } }), ok({ value: [ra(NS_PATH)] }));
    scriptCriblPlan(h);
    expect((await planCriblSource(h.ports, entraInput())).kind).toBe("ready");
    const h2 = harness();
    scriptAzureEntra(h2, status(403, { error: { code: "AuthorizationFailed" } }), ok({ value: [] }));
    // The hub read is complete and empty; it covers grants above the hub, so
    // this is a real absence even though the namespace read was refused.
    expect(await planCriblSource(h2.ports, entraInput())).toMatchObject({ kind: "refused", reason: "receiver-role-missing" });
  });

  it("refuses missing-value for a blank object id, tenant or client, with no call", async () => {
    for (const input of [
      entraInput({ values: values({ criblPrincipalObjectId: "" }) }),
      entraInput({ credential: { kind: "entra-id", tenantId: " ", clientId: "c1" } }),
      entraInput({ credential: { kind: "entra-id", tenantId: "t1", clientId: "" } }),
    ]) {
      const h = harness();
      const plan = await planCriblSource(h.ports, input);
      expect(plan).toMatchObject({ kind: "refused", reason: "missing-value" });
      expect(h.log).toEqual([]);
    }
  });

  // ADR 0008 section 2: the app's own registration holds ARM write rights.
  it("refuses the app's own registration as the Cribl principal, with no call", async () => {
    const h = harness();
    const plan = await planCriblSource(h.ports, entraInput({ appClientId: "C1" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "app-principal" });
    expect(h.log).toEqual([]);
  });

  // Review finding 5: Data Owner carries listKeys on every rule (Manage-equivalent).
  it("refuses receiver-role-overprivileged when Data Owner covers the hub, even alongside Data Receiver", async () => {
    const OWNER_ID = "/subscriptions/sub1/providers/Microsoft.Authorization/roleDefinitions/f526a384-b230-433a-b45c-95f59c4a2dec";
    for (const rows of [[ra("/subscriptions/sub1", OWNER_ID)], [ra(NS_PATH), ra(HUB_PATH, OWNER_ID)]]) {
      const h = harness();
      scriptAzureEntra(h, ok({ value: rows }), ok({ value: [] }));
      const plan = await planCriblSource(h.ports, entraInput());
      expect(plan).toMatchObject({ kind: "refused", reason: "receiver-role-overprivileged" });
      expect(JSON.stringify(plan)).toContain("listKeys");
      expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
    }
  });

  // Review findings 1 and 7: the role is read for the object id; the input
  // signs in as the client id. The directory ties the two together.
  function graphOf(sps: ServicePrincipalRef[] | Error): GraphDirectory & { calls: number } {
    const g = {
      calls: 0,
      readSubscribedSkus: async () => ({ kind: "denied" as const, status: 403, detail: "unused" }),
      listServicePrincipals: () => {
        g.calls += 1;
        return sps instanceof Error ? Promise.reject(sps) : Promise.resolve(sps);
      },
    };
    return g;
  }
  const sp = (id: string, appId: string): ServicePrincipalRef => ({ id, appId, displayName: appId });

  it("refuses principal-mismatch when the directory names another object id for the client id, before any Azure or Cribl call", async () => {
    const h = harness();
    const graph = graphOf([sp("obj-OTHER", "C1")]);
    const plan = await planCriblSource({ ...h.ports, graph }, entraInput());
    expect(plan).toMatchObject({ kind: "refused", reason: "principal-mismatch" });
    const text = JSON.stringify(plan);
    expect(text).toContain("obj-OTHER");
    expect(text).toContain(OBJ);
    expect(h.log).toEqual([]);
    expect(graph.calls).toBe(1);
  });

  it("marks the principal matched when the directory ties the client id to the object id", async () => {
    const h = harness();
    scriptAzureEntra(h, ok({ value: [ra(NS_PATH)] }));
    scriptCriblPlan(h);
    const plan = await planCriblSource({ ...h.ports, graph: graphOf([sp("x", "other"), sp(OBJ.toUpperCase(), "c1")]) }, entraInput());
    expect(plan).toMatchObject({ kind: "ready", ready: { entraPrincipal: { principalCheck: "matched" } } });
  });

  it("an unreadable directory, or a client id it does not list, is not-cross-checked, never matched", async () => {
    for (const graph of [graphOf(new Error("403 Application.Read.All")), graphOf([sp("x", "other")])]) {
      const h = harness();
      scriptAzureEntra(h, ok({ value: [ra(NS_PATH)] }));
      scriptCriblPlan(h);
      const plan = await planCriblSource({ ...h.ports, graph }, entraInput());
      expect(plan).toMatchObject({ kind: "ready", ready: { entraPrincipal: { principalCheck: "not-cross-checked" } } });
    }
  });

  it("refuses app-principal when the object id is this app's own service principal", async () => {
    const h = harness();
    const plan = await planCriblSource(
      { ...h.ports, graph: graphOf([sp(OBJ, "app-client"), sp("obj-2", "c1")]) },
      entraInput({ appClientId: "app-client" }),
    );
    expect(plan).toMatchObject({ kind: "refused", reason: "app-principal" });
    expect(h.log).toEqual([]);
  });

  it("refuses Entra ID on a blob lane as a credential mismatch", async () => {
    const h = harness();
    const blob = onboardingSource("vnetFlowLogs")!;
    const plan = await planCriblSource(h.ports, entraInput({ lane: { source: blob, subSelection: [] } }));
    expect(plan).toMatchObject({ kind: "refused", reason: "credential-mismatch" });
  });

  it("applies with the pasted client secret as the Cribl text secret: pinned order, no listKeys ever", async () => {
    const h = harness();
    const ready = await readyEntra(h);
    h.log.length = 0;
    scriptApplyThroughCreate(h, ready);
    scriptCommitDeploy(h);
    const outcome = await applyCriblSource(h.ports, ready, { kind: "paste", value: () => CLIENT_SECRET });
    expect(outcome.kind).toBe("created-running");
    expect(h.labels()).toEqual(APPLY_LOG.filter((l) => !l.startsWith("AZ ")));
    expect(h.log.filter((e) => e.port === "azure")).toEqual([]);
    const secretPost = h.log.find((e) => e.label === `POST /m/${G}/system/secrets`)!;
    expect(secretPost.req).toMatchObject({ body: { id: SECRET_ID, secretType: "text", value: CLIENT_SECRET } });
    expect(h.log.filter((e) => deepContains(e.req, CLIENT_SECRET)).map((e) => e.label)).toEqual([`POST /m/${G}/system/secrets`]);
    expect(deepContains(outcome, CLIENT_SECRET)).toBe(false);
    expect(deepContains(h.logger.entries, CLIENT_SECRET)).toBe(false);
  });

  // Review finding 8: a connection string pasted into the client secret field
  // (the Manage key included) is never stored.
  it("refuses a pasted connection string as the client secret, before any write", async () => {
    for (const pasted of [
      `Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${KEY}`,
      `  SharedAccessKeyName=x;SharedAccessKey=${KEY}`,
      `DefaultEndpointsProtocol=https;AccountName=sa;AccountKey=${KEY};EndpointSuffix=core.windows.net`,
    ]) {
      const h = harness();
      const ready = await readyEntra(h);
      h.log.length = 0;
      h.cribl.respondWith(ok({ items: [] }), status(404), ok({ items: [] }));
      const outcome = await applyCriblSource(h.ports, ready, { kind: "paste", value: () => pasted });
      expect(outcome).toMatchObject({ kind: "refused", reason: "paste-is-connection-string" });
      expect(h.writes()).toEqual([]);
      expect(deepContains(outcome, KEY)).toBe(false);
    }
  });

  it("refuses a listKeys apply of an Entra ID plan, with no call", async () => {
    const h = harness();
    const ready = await readyEntra(h);
    h.log.length = 0;
    const outcome = await applyCriblSource(h.ports, ready, { kind: "listKeys" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "credential-changed" });
    expect(h.log).toEqual([]);
  });
});
