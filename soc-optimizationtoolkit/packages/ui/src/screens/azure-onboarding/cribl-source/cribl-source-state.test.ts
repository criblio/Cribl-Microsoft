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
  it("excludes Send-only rules and includes Manage", () => {
    const rules = [
      { name: "send", id: "", rights: ["Send"] },
      { name: "listen", id: "", rights: ["Listen"] },
      { name: "root", id: "", rights: ["Listen", "Send", "Manage"] },
      { name: "manage", id: "", rights: ["Manage"] },
    ];
    expect(listenRules(rules).map((r) => r.name)).toEqual(["listen", "root", "manage"]);
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
  it("defaults an Automated source to listKeys and a How-to source to paste", () => {
    expect(credentialChoices("automate", "eventhub").find((c) => c.isDefault)?.kind).toBe("listKeys");
    expect(credentialChoices("manual", "eventhub").find((c) => c.isDefault)?.kind).toBe("paste");
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
