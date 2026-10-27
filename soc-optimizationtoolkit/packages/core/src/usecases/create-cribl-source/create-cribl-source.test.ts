import { describe, expect, it } from "vitest";
import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { CriblClient, CriblRequest } from "../../ports/cribl-client";
import type { PortHttpResponse } from "../../ports/http";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { FakeLogger } from "../../testing/fake-logger";
import { defaultPlanValues, type PlanValues } from "../../domain/onboarding-howto/plan-values";
import { onboardingSource, type OnboardingSource } from "../../domain/onboarding-howto/sources";
import {
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

const INPUT_ID = onboardingInputId(defender(), values())!;
const SECRET_ID = onboardingSecretId(INPUT_ID);

function planInput(credential: PlanCredential, over: Partial<PlanCriblSourceInput> = {}): PlanCriblSourceInput {
  return {
    groupId: G,
    lane: { source: defender(), subSelection: [] },
    values: values(),
    measuredHubs: null,
    kvRecord: null,
    credential,
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

/** Azure answers for the plan: namespace (sku), then the rules list. */
function scriptAzurePlan(h: ReturnType<typeof harness>, sku = "Standard"): void {
  h.azure.respondWith(ok({ name: "ns1", sku: { name: sku } }), ok(RULES));
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

describe("planCriblSource", () => {
  it("makes only GETs, on both ports, and names what the confirm shows", async () => {
    const h = harness();
    const ready = await readyListKeys(h);
    expect(h.log.length).toBe(5);
    expect(h.log.every((e) => e.req.method === "GET")).toBe(true);
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

  it("refuses a listKeys rule without Listen before any write", async () => {
    const h = harness();
    scriptAzurePlan(h);
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "sender" }));
    expect(plan).toMatchObject({ kind: "refused", reason: "rule-cannot-listen" });
    expect(h.log.filter((e) => e.port === "cribl")).toEqual([]);
  });

  it("accepts a Manage rule for listKeys", async () => {
    const h = harness();
    const ready = await readyListKeys(h, "admin");
    expect(ready.keyNameOrPrincipal).toBe("admin");
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
    h.azure.respondWith(ok({ name: "ns1", sku: { name: "Standard" } }), status(403, { error: { code: "AuthorizationFailed" } }));
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
    });
    h.cribl.respondWith(ok({ items: [existing] }));
    const record = { groupId: G, inputId: INPUT_ID, inputType: "eventhub" as const, secretId: SECRET_ID };
    const plan = await planCriblSource(h.ports, planInput({ kind: "listKeys", rule: "reader" }, { kvRecord: record }));
    expect(plan).toEqual({ kind: "already-applied", record });
    expect(h.writes()).toEqual([]);
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
