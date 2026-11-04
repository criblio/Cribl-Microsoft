// Pins for the Cribl source panel's pure state (AZR-34, unit S2).
//
// The failures these exist to catch: a confirm that stays armed after what it
// names changed (another worker group, another pasted key), a Send-only rule
// offered to a source that must Listen, a confirm that omits what it writes,
// and two outcomes that read the same so an operator cannot tell them apart.

import { describe, expect, it } from "vitest";
import { defaultPlanValues, parseEventHubConnectionString } from "@soc/core";
import type {
  ApplyCriblSourceOutcome,
  ApplyFailureStage,
  ApplyRefusalReason,
  ConnectionDescriptor,
  NotDeployedReason,
  PlanCriblSourceResult,
  ReadyCriblSource,
} from "@soc/core";
import { findHistoryInCopy } from "../../../components/copy-rules";
import {
  CONFIRM_IDLE,
  CLIENT_SECRET_IS_CONNECTION_STRING,
  PLAN_REFUSAL_COPY,
  armKey,
  confirmReducer,
  confirmText,
  createClick,
  ATTESTATION_LABEL,
  createDisabledReason,
  credentialChoices,
  needsAttestation,
  isArmed,
  listenRuleMessage,
  listenRules,
  outcomeView,
  pasteDescriptorView,
  planResultView,
  sourceRows,
  type ArmInputs,
  type ConfirmState,
  type CreateGateInput,
} from "./cribl-source-state";

const KEY = "s3cr3tKeyValue==";
const PASTE = `Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=reader;SharedAccessKey=${KEY};EntityPath=h1`;

const READY: ReadyCriblSource = {
  groupId: "g1",
  sourceId: "defenderExport",
  inputId: "azure_onb_eh_ns1_h1",
  inputType: "eventhub",
  secretId: "azure_onb_eh_ns1_h1_secret",
  keyNameOrPrincipal: "reader",
  credentialKind: "paste",
  attested: false,
  descriptor: { host: "ns1.servicebus.windows.net", keyName: "reader", entityPath: "h1" },
  commitFiles: ["groups/g1/cribl/inputs.yml", "groups/g1/cribl/secrets.yml"],
  dirtyAlready: [],
  scope: { alreadyDirty: [], elsewhere: [], unplaced: [], unknown: false },
  inputBody: {},
  namespace: { subscriptionId: "sub", resourceGroup: "rg", name: "ns1" },
  kvRecord: null,
  secretDescription: "",
  readsFrom: { hubs: ["h1"], consumerGroup: "cribl" },
  entraPrincipal: null,
};

const RECORD = { groupId: "g1", inputId: READY.inputId, inputType: "eventhub" as const, secretId: READY.secretId };

const BASE_ARM: ArmInputs = {
  groupId: "g1",
  sourceId: "defenderExport",
  credentialKind: "paste",
  rule: "",
  attested: false,
  values: defaultPlanValues(null),
  readSeq: 1,
  descriptor: READY.descriptor,
};

function armedFor(key: string): ConfirmState {
  const planning = confirmReducer(CONFIRM_IDLE, { type: "plan-start", key });
  return confirmReducer(planning, { type: "plan-result", key, result: { kind: "ready", ready: READY } });
}

describe("the confirm machine", () => {
  it("plans on the first click, applies only on a click while armed for the same key", () => {
    const key = armKey(BASE_ARM);
    expect(createClick(CONFIRM_IDLE, key)).toBe("plan");
    const armed = armedFor(key);
    expect(isArmed(armed, key)).toBe(true);
    expect(createClick(armed, key)).toBe("apply");
    // Armed for another key (the inputs moved before the disarm landed): plan again, never apply.
    expect(createClick(armed, armKey({ ...BASE_ARM, groupId: "g2" }))).toBe("plan");
  });

  it("disarms on a worker group change, and reverting does not re-arm", () => {
    const key = armKey(BASE_ARM);
    const otherKey = armKey({ ...BASE_ARM, groupId: "g2" });
    expect(otherKey).not.toBe(key);
    const after = confirmReducer(armedFor(key), { type: "inputs", key: otherKey });
    expect(after).toBe(CONFIRM_IDLE);
    expect(createClick(after, key)).toBe("plan");
    expect(confirmReducer(armedFor(key), { type: "inputs", key })).toEqual(armedFor(key));
  });

  it("disarms on a paste whose descriptor changes", () => {
    const key = armKey(BASE_ARM);
    const changed: ConnectionDescriptor = { host: "ns1.servicebus.windows.net", keyName: "other" };
    const otherKey = armKey({ ...BASE_ARM, descriptor: changed });
    expect(otherKey).not.toBe(key);
    expect(isArmed(confirmReducer(armedFor(key), { type: "inputs", key: otherKey }), key)).toBe(false);
  });

  it("gives every input the confirm names its own key", () => {
    const values = { ...BASE_ARM.values, namespace: "ns2" };
    const variants: ArmInputs[] = [
      { ...BASE_ARM, rule: "listen" },
      { ...BASE_ARM, credentialKind: "listKeys" },
      { ...BASE_ARM, attested: true },
      { ...BASE_ARM, values },
      { ...BASE_ARM, readSeq: 2 },
      { ...BASE_ARM, sourceId: "entraId" },
      { ...BASE_ARM, descriptor: null },
    ];
    const keys = new Set([armKey(BASE_ARM), ...variants.map(armKey)]);
    expect(keys.size).toBe(variants.length + 1);
  });

  it("drops a plan result for a stale key, and maps a refusal to planned", () => {
    const key = armKey(BASE_ARM);
    const planning = confirmReducer(CONFIRM_IDLE, { type: "plan-start", key });
    expect(
      confirmReducer(planning, { type: "plan-result", key: "stale", result: { kind: "ready", ready: READY } }),
    ).toBe(planning);
    const refused: PlanCriblSourceResult = { kind: "refused", reason: "basic-sku", detail: "" };
    expect(confirmReducer(planning, { type: "plan-result", key, result: refused }).phase).toBe("planned");
  });

  it("applies only from armed, and records the outcome", () => {
    const key = armKey(BASE_ARM);
    expect(confirmReducer(CONFIRM_IDLE, { type: "apply-start", key })).toBe(CONFIRM_IDLE);
    const applying = confirmReducer(armedFor(key), { type: "apply-start", key });
    expect(applying.phase).toBe("applying");
    expect(createClick(applying, key)).toBe("none");
    // A click while a plan is in flight starts no second plan.
    expect(createClick(confirmReducer(CONFIRM_IDLE, { type: "plan-start", key }), key)).toBe("none");
    // An apply in flight is not dropped by an input change.
    expect(confirmReducer(applying, { type: "inputs", key: "other" })).toBe(applying);
    const outcome: ApplyCriblSourceOutcome = { kind: "failed", stage: "input-create", detail: "" };
    expect(confirmReducer(applying, { type: "apply-result", outcome })).toEqual({ phase: "done", outcome });
  });
});

describe("listenRules", () => {
  // AZR-58: Manage-capable rules are never offered for a Cribl source.
  it("offers rules that can Listen without Manage, and nothing else", () => {
    const rules = [
      { name: "send", id: "", rights: ["Send"] },
      { name: "listen", id: "", rights: ["Listen"] },
      { name: "listensend", id: "", rights: ["Listen", "Send"] },
      { name: "root", id: "", rights: ["Listen", "Send", "Manage"] },
      { name: "manage", id: "", rights: ["Manage"] },
    ];
    expect(listenRules(rules).map((r) => r.name)).toEqual(["listen", "listensend"]);
  });

  it("names the Manage rules it left out and says to create a Listen-only rule", () => {
    const msg = listenRuleMessage({
      state: "read",
      rows: [{ name: "RootManageSharedAccessKey", id: "", rights: ["Listen", "Manage", "Send"] }],
    });
    expect(msg).toContain("RootManageSharedAccessKey");
    expect(msg).toContain("Manage");
    expect(msg).toContain("Listen-only");
  });

  it("says why a Manage-capable key is refused", () => {
    expect(createDisabledReason({ ...GATE, pasteCheck: { ok: false, reason: "rule-can-manage", detail: "" } })).toContain(
      "Manage",
    );
  });

  it("says a refused rules read is unknown, never none", () => {
    const msg = listenRuleMessage({
      state: "refused",
      refusal: { request: "x", status: 403, code: "AuthorizationFailed", text: "", reason: "http" },
    });
    expect(msg).toContain("could not be read");
    expect(listenRuleMessage({ state: "read", rows: [{ name: "send", id: "", rights: ["Send"] }] })).toContain(
      "None of this namespace's authorization rules can listen",
    );
    expect(listenRuleMessage({ state: "read", rows: [{ name: "l", id: "", rights: ["Listen"] }] })).toBeNull();
  });
});

describe("credentialChoices", () => {
  // AZR-59, ADR 0008 section 1: Entra ID first and the default in every mode;
  // listKeys then paste are the fallbacks.
  it("offers Entra ID first and as the default for every Event Hub lane, then listKeys and paste", () => {
    for (const mode of ["automate", "manual"] as const) {
      const choices = credentialChoices(mode, "eventhub");
      expect(choices.map((c) => c.kind), mode).toEqual(["entra-id", "listKeys", "paste"]);
      expect(choices.filter((c) => c.isDefault).map((c) => c.kind), mode).toEqual(["entra-id"]);
      expect(choices[0]!.label).toBe("Entra ID - a Cribl service principal (recommended)");
    }
    expect(credentialChoices("manual", "blob").map((c) => c.kind)).toEqual(["client-secret"]);
  });
});

describe("pasteDescriptorView", () => {
  it("shows the host, key name and hub, and never the key", () => {
    const view = pasteDescriptorView(parseEventHubConnectionString(PASTE));
    expect(view).toEqual({
      ok: true,
      rows: [
        { label: "Namespace host", value: "ns1.servicebus.windows.net" },
        { label: "Key name", value: "reader" },
        { label: "Hub", value: "h1" },
      ],
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it("explains an invalid paste and shows nothing for no paste", () => {
    expect(pasteDescriptorView(null)).toBeNull();
    const bad = pasteDescriptorView(parseEventHubConnectionString("not a string"));
    expect(bad !== null && !bad.ok).toBe(true);
  });
});

const GATE: CreateGateInput = {
  groupId: "g1",
  busy: false,
  transport: "eventhub",
  credentialKind: "paste",
  rule: "",
  paste: parseEventHubConnectionString(PASTE),
  pasteCheck: { ok: true, attested: false },
  topics: { kind: "ok", topics: ["h1"] },
};

describe("createDisabledReason", () => {
  it("is enabled for a checked paste and a named topic", () => {
    expect(createDisabledReason(GATE)).toBeNull();
  });

  it("says no hub has appeared yet when the lane's topics refused", () => {
    for (const reason of ["no-hub-measured", "hubs-not-measured"] as const) {
      const r = createDisabledReason({ ...GATE, topics: { kind: "refused", reason, detail: "" } });
      expect(r?.toLowerCase(), reason).toContain("no hub has appeared yet");
    }
  });

  it("gives the paste refusal's reason", () => {
    expect(
      createDisabledReason({ ...GATE, pasteCheck: { ok: false, reason: "rule-cannot-listen", detail: "" } }),
    ).toContain("cannot listen");
    expect(
      createDisabledReason({ ...GATE, pasteCheck: { ok: false, reason: "wrong-namespace", detail: "" } }),
    ).toContain("Wrong namespace");
  });

  it("offers the Listen attestation when the rules could not be read, and enables Create once attested", () => {
    const unknown: CreateGateInput = {
      ...GATE,
      pasteCheck: { ok: false, reason: "rule-rights-unknown", detail: "" },
    };
    expect(needsAttestation(unknown)).toBe(true);
    expect(createDisabledReason(unknown)).toContain(`tick "${ATTESTATION_LABEL}"`);
    expect(ATTESTATION_LABEL).toBe("This key has Listen rights");
    const attested: CreateGateInput = { ...GATE, pasteCheck: { ok: true, attested: true } };
    expect(needsAttestation(attested)).toBe(false);
    expect(createDisabledReason(attested)).toBeNull();
    // A plan that refused for the same reason also asks for it; other refusals do not.
    expect(
      needsAttestation({ pasteCheck: null, planResult: { kind: "refused", reason: "rule-rights-unknown", detail: "" } }),
    ).toBe(true);
    expect(
      needsAttestation({ pasteCheck: { ok: false, reason: "rule-cannot-listen", detail: "" }, planResult: null }),
    ).toBe(false);
    expect(
      needsAttestation({ pasteCheck: null, planResult: { kind: "refused", reason: "basic-sku", detail: "" } }),
    ).toBe(false);
  });

  it("requires a group, a rule for listKeys, and a secret for blob", () => {
    expect(createDisabledReason({ ...GATE, groupId: "" })).toBe(PLAN_REFUSAL_COPY["no-group"]);
    expect(createDisabledReason({ ...GATE, credentialKind: "listKeys" })).toContain("Listen rights");
    expect(createDisabledReason({ ...GATE, credentialKind: "listKeys", rule: "listen" })).toBeNull();
    expect(createDisabledReason({ ...GATE, paste: null })).not.toBeNull();
    const blob: CreateGateInput = { ...GATE, transport: "blob", credentialKind: "client-secret", topics: null };
    expect(createDisabledReason(blob)).not.toBeNull();
    expect(createDisabledReason({ ...blob, hasClientSecret: true })).toBeNull();
  });
});

describe("confirmText", () => {
  it("names the group, input id and type, secret id, key name, each commit file and the restart", () => {
    const text = confirmText(READY).join("\n");
    for (const part of [
      "g1",
      READY.inputId,
      "(eventhub)",
      READY.secretId,
      "reader",
      ...READY.commitFiles,
      "restarts its workers",
    ]) {
      expect(text, part).toContain(part);
    }
    expect(text).not.toContain("confirmed that");
  });

  // AZR-56: the consumer group is part of what the operator is agreeing to.
  it("names the hubs the source reads and its consumer group", () => {
    expect(confirmText(READY)).toContain("Reads hub h1 with consumer group cribl.");
    expect(confirmText({ ...READY, readsFrom: { hubs: ["h1", "h2"], consumerGroup: "cg" } })).toContain(
      "Reads hubs h1, h2 with consumer group cg.",
    );
    expect(confirmText({ ...READY, readsFrom: null }).join(" ")).not.toContain("consumer group");
  });

  // AZR-57: the first line read "Create a Azure Event Hubs source".
  it("opens with a sentence whose article never depends on the source type", () => {
    expect(confirmText(READY)[0]).toBe(
      "New Cribl source azure_onb_eh_ns1_h1, an Azure Event Hubs source (eventhub), in worker group g1.",
    );
    expect(confirmText({ ...READY, inputType: "azure_blob", readsFrom: null })[0]).toBe(
      "New Cribl source azure_onb_eh_ns1_h1, an Azure Blob Storage source (azure_blob), in worker group g1.",
    );
    for (const line of confirmText(READY)) expect(line).not.toContain(" a A");
  });

  // DBT-164: the kit commits only the files still pending after the create,
  // so the list is an upper bound and must be worded as one.
  it("words the commit file list as an upper bound, never as what the commit carries", () => {
    const lines = confirmText(READY);
    const line = lines.find((l) => l.includes(READY.commitFiles[0]!));
    expect(line).toBe(
      `The commit can include at most these files, and only those still uncommitted after the create: ${READY.commitFiles.join(", ")}.`,
    );
    expect(lines.join("\n")).not.toContain("The commit carries");
  });

  it("names the attestation and other people's pending work", () => {
    const text = confirmText({ ...READY, attested: true, dirtyAlready: ["groups/g1/cribl/inputs.yml"] }).join("\n");
    expect(text).toContain("You confirmed that reader has Listen rights");
    expect(text).toContain("someone else's uncommitted changes");
  });
});

const NOT_DEPLOYED: readonly NotDeployedReason[] = [
  "nothing-to-commit",
  "status-unknown",
  "scope-unknown",
  "newer-commit",
  "head-unknown",
  "committed-unknown-hash",
  "commit-failed",
  "incomplete",
  "unverified",
  "deploy-failed",
  "stored-mismatch",
  "stored-unreadable",
  "commit-sequence-failed",
];
const REFUSED: readonly ApplyRefusalReason[] = [
  "credential-changed",
  "status-unknown",
  "scope-unplaced",
  "scope-grew",
  "secret-appeared",
  "input-appeared",
  "inputs-unreadable",
  "secret-unreadable",
  "paste-invalid",
  "paste-is-connection-string",
  "pasted-changed",
  "secret-exists",
];
const STAGES: readonly ApplyFailureStage[] = ["list-keys", "secret-create", "input-create"];

function allOutcomes(): ApplyCriblSourceOutcome[] {
  return [
    { kind: "created-running", record: RECORD, hash: "a1b2c3d4", configVersion: "a1b2c3d" },
    { kind: "created-deployed-unconfirmed", record: RECORD, hash: "a1b2", configVersion: null },
    { kind: "created-deployed-unconfirmed", record: RECORD, hash: "a1b2", configVersion: "ffff" },
    ...NOT_DEPLOYED.map((reason): ApplyCriblSourceOutcome => ({ kind: "created-not-deployed", record: RECORD, reason, detail: "" })),
    ...REFUSED.map((reason): ApplyCriblSourceOutcome => ({ kind: "refused", reason, detail: "" })),
    ...STAGES.map((stage): ApplyCriblSourceOutcome => ({ kind: "failed", stage, detail: "" })),
  ];
}

describe("outcomeView", () => {
  it("is pairwise distinct across every outcome and sub-reason", () => {
    const outcomes = allOutcomes();
    const headlines = outcomes.map((o) => outcomeView(o).headline);
    expect(new Set(headlines).size).toBe(outcomes.length);
    // The literal bare "committed" (the old wire-source fallback) is never an outcome.
    expect(headlines.map((h) => h.trim().toLowerCase())).not.toContain("committed");
  });

  it("says what to do in Cribl for every not-deployed outcome", () => {
    for (const reason of NOT_DEPLOYED) {
      const v = outcomeView({ kind: "created-not-deployed", record: RECORD, reason, detail: "" });
      expect(v.inCribl, reason).toMatch(/^In Cribl, /);
    }
  });

  it("names the deploy route on deploy-failed", () => {
    const v = outcomeView({ kind: "created-not-deployed", record: RECORD, reason: "deploy-failed", detail: "", route: "products" });
    expect(v.headline).toContain("products deploy path");
  });

  it("names a secret left behind", () => {
    const v = outcomeView({ kind: "failed", stage: "input-create", detail: "HTTP 400.", leftBehind: { secretId: "sec1" } });
    expect(v.detail).toContain("sec1");
    expect(v.inCribl).toContain("sec1");
  });

  it("separates an unreadable running version from a different one", () => {
    const unread = outcomeView({ kind: "created-deployed-unconfirmed", record: RECORD, hash: "a", configVersion: null });
    const other = outcomeView({ kind: "created-deployed-unconfirmed", record: RECORD, hash: "a", configVersion: "ffff" });
    expect(unread.headline).toContain("could not be read");
    expect(other.headline).toContain("ffff");
  });
});

describe("planResultView and refusal copy", () => {
  it("names the differing fields and the already-applied record", () => {
    expect(planResultView({ kind: "refused", reason: "input-differs", detail: "", fields: ["topics"] }).detail).toContain("topics");
    expect(planResultView({ kind: "already-applied", record: RECORD }).headline).toContain(RECORD.inputId);
  });

  it("gives every plan refusal distinct copy", () => {
    const copies = Object.values(PLAN_REFUSAL_COPY);
    expect(new Set(copies).size).toBe(copies.length);
  });
});

describe("sourceRows", () => {
  it("maps blob to azure_blob and Event Hub to eventhub, and shows the record", () => {
    const rows = sourceRows(["defenderExport", "vnetFlowLogs"], { criblSources: { defenderExport: RECORD } });
    expect(rows.map((r) => r.inputType)).toEqual(["eventhub", "azure_blob"]);
    expect(rows[0]!.status).toContain(RECORD.inputId);
    expect(rows[1]!.record).toBeNull();
  });
});

describe("copy", () => {
  it("carries no project history", () => {
    const texts: string[] = [
      ...Object.values(PLAN_REFUSAL_COPY),
      ...confirmText({ ...READY, attested: true, dirtyAlready: ["x"] }),
      ...allOutcomes().flatMap((o) => {
        const v = outcomeView(o);
        return [v.headline, v.inCribl ?? ""];
      }),
      ...credentialChoices("automate", "eventhub").map((c) => c.label),
    ];
    expect(findHistoryInCopy(texts.map((text, i) => ({ where: `cribl-source#${i}`, text })))).toEqual([]);
  });
});

// AZR-59, ADR 0008: the Entra ID mode's gate, arm key and confirm.
describe("Entra ID mode", () => {
  const ENTRA_GATE: CreateGateInput = {
    ...GATE,
    credentialKind: "entra-id",
    paste: null,
    pasteCheck: null,
    entra: { tenantId: "t1", clientId: "c1", objectId: "obj-1" },
    hasClientSecret: true,
  };
  const ENTRA_READY: ReadyCriblSource = {
    ...READY,
    credentialKind: "entra-id",
    keyNameOrPrincipal: "c1",
    descriptor: null,
    namespace: null,
    entraPrincipal: {
      tenantId: "t1",
      clientId: "c1",
      objectId: "obj-1",
      role: "Azure Event Hubs Data Receiver",
      roleScope: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns1",
      principalCheck: "matched",
    },
  };

  it("enables Create with the three ids and a client secret, and says what is missing otherwise", () => {
    expect(createDisabledReason(ENTRA_GATE)).toBeNull();
    expect(createDisabledReason({ ...ENTRA_GATE, hasClientSecret: false })).toBe("Paste the Cribl service principal's client secret.");
    expect(createDisabledReason({ ...ENTRA_GATE, entra: { tenantId: "t1", clientId: " ", objectId: "obj-1" } })).toContain("client ID");
    expect(createDisabledReason({ ...ENTRA_GATE, entra: { tenantId: "t1", clientId: "c1", objectId: "" } })).toContain("object ID");
    expect(createDisabledReason({ ...ENTRA_GATE, entra: undefined })).not.toBeNull();
    expect(createDisabledReason({ ...ENTRA_GATE, topics: { kind: "refused", reason: "no-hub-named", detail: "" } })).toBe(
      PLAN_REFUSAL_COPY["no-hub-named"],
    );
  });

  it("refuses the app's own registration as the Cribl principal", () => {
    expect(createDisabledReason({ ...ENTRA_GATE, appClientId: "C1" })).toBe(PLAN_REFUSAL_COPY["app-principal"]);
  });

  it("disarms when the tenant or client id changes", () => {
    const base = armKey({ ...BASE_ARM, credentialKind: "entra-id", descriptor: null, entra: ["t1", "c1"] });
    expect(armKey({ ...BASE_ARM, credentialKind: "entra-id", descriptor: null, entra: ["t1", "c2"] })).not.toBe(base);
    expect(armKey({ ...BASE_ARM, credentialKind: "entra-id", descriptor: null, entra: ["t2", "c1"] })).not.toBe(base);
  });

  it("the confirm names the principal, its role, the role's scope and that no SAS key is used", () => {
    const text = confirmText(ENTRA_READY).join("\n");
    expect(text).toContain(
      "Authenticates with Entra ID as the Cribl service principal c1 (object ID obj-1, tenant t1). " +
        "Object ID obj-1 holds Azure Event Hubs Data Receiver at /subscriptions/s/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns1. " +
        "No SAS key is used.",
    );
    expect(text).toContain("The directory confirms client ID c1 is object ID obj-1.");
    expect(text).toContain(`Store the principal's client secret in a new Cribl secret ${READY.secretId}`);
    expect(text).not.toMatch(/rule|Listen/);
  });

  // Review findings 1 and 7: never present an unchecked client id as verified.
  it("the confirm says when the client id was NOT cross-checked against the object id", () => {
    const unchecked = { ...ENTRA_READY, entraPrincipal: { ...ENTRA_READY.entraPrincipal!, principalCheck: "not-cross-checked" as const } };
    const text = confirmText(unchecked).join("\n");
    expect(text).toContain(
      "The role was read for object ID obj-1 as entered; the app could not confirm that client ID c1 is that principal. Check they belong together before you confirm.",
    );
    expect(text).not.toContain("The directory confirms");
  });

  // Review finding 8: a key-bearing string in the client secret field never arms.
  it("refuses a connection string pasted as the client secret, on Entra ID and on blob", () => {
    expect(createDisabledReason({ ...ENTRA_GATE, secretIsConnectionString: true })).toBe(CLIENT_SECRET_IS_CONNECTION_STRING);
    expect(
      createDisabledReason({ ...GATE, transport: "blob", credentialKind: "client-secret", paste: null, pasteCheck: null, hasClientSecret: true, secretIsConnectionString: true }),
    ).toBe(CLIENT_SECRET_IS_CONNECTION_STRING);
    expect(CLIENT_SECRET_IS_CONNECTION_STRING).toContain("connection string");
  });

  it("has words for the three new refusals", () => {
    expect(PLAN_REFUSAL_COPY["receiver-role-missing"]).toContain("Azure Event Hubs Data Receiver");
    expect(PLAN_REFUSAL_COPY["receiver-role-unreadable"]).toContain("could not be read");
    expect(PLAN_REFUSAL_COPY["app-principal"]).toContain("this app's own");
    expect(PLAN_REFUSAL_COPY["principal-mismatch"]).toContain("object ID");
    expect(PLAN_REFUSAL_COPY["receiver-role-overprivileged"]).toContain("Data Owner");
    expect(PLAN_REFUSAL_COPY["receiver-role-overprivileged"]).toContain("listKeys");
  });
});
