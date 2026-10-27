import { describe, expect, it } from "vitest";
import { commitScope } from "../../kit/config-writes/commitDeploy";
import { stampFor } from "../../kit/config-writes/ownership";
import { defaultPlanValues } from "../onboarding-howto/plan-values";
import { onboardingSource, type OnboardingSource } from "../onboarding-howto/sources";
import type { CriblSourceRecord } from "../onboarding-howto/progress-document";
import { APP_ID, buildBlobInputBody, buildEventHubInputBody, isOnboardingInputId, isOnboardingSecretId } from "./input-bodies";
import {
  COMMIT_MARKERS,
  classifyExistingInput,
  classifyExistingSecret,
  laneTopics,
} from "./classify-existing";

const src = (id: string): OnboardingSource => onboardingSource(id)!;

const expected = buildEventHubInputBody({
  id: "azure_onb_eh_ns1_hub1",
  namespace: "ns1",
  topics: ["hub1"],
  consumerGroup: "cribl",
  secretId: "azure_onb_eh_ns1_hub1_secret",
  sourceId: "defenderExport",
  sourceTitle: "Defender",
});
const record: CriblSourceRecord = {
  groupId: "g1",
  inputId: "azure_onb_eh_ns1_hub1",
  inputType: "eventhub",
  secretId: "azure_onb_eh_ns1_hub1_secret",
};
/** What Cribl returns: the body plus defaults it adds on save. */
const stored = { ...expected, connectionTimeout: 10000, status: { health: "Green" } };

describe("classifyExistingInput", () => {
  it("absent when the id is not in a complete read", () => {
    expect(classifyExistingInput({ read: { state: "read", items: [{ id: "other" }] }, expected, recorded: null })).toEqual({ kind: "absent" });
  });

  it("unknown, never absent, when the read was refused", () => {
    expect(classifyExistingInput({ read: { state: "refused", detail: "403" }, expected, recorded: record })).toEqual({ kind: "unknown", detail: "403" });
  });

  it("ours-matching only with stamp, matching fields and the KV record together", () => {
    expect(classifyExistingInput({ read: { state: "read", items: [stored] }, expected, recorded: record })).toEqual({ kind: "ours-matching" });
  });

  it("differs names the changed identity field", () => {
    const edited = { ...stored, topics: ["hub2"] };
    expect(classifyExistingInput({ read: { state: "read", items: [edited] }, expected, recorded: record })).toEqual({ kind: "differs", fields: ["topics"] });
  });

  it("foreign when the stamp is missing, even with a record", () => {
    const hand = { ...stored, description: "made by hand" };
    const v = classifyExistingInput({ read: { state: "read", items: [hand] }, expected, recorded: record });
    expect(v.kind).toBe("foreign");
  });

  it("a hand edit to run state, routing, SASL or TLS posture is differs, not already applied", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...stored, tls: { disabled: false, rejectUnauthorized: false } }, "tls.rejectUnauthorized"],
      [{ ...stored, disabled: true }, "disabled"],
      [{ ...stored, sendToRoutes: false }, "sendToRoutes"],
      [{ ...stored, sasl: { ...(expected["sasl"] as Record<string, unknown>), disabled: true } }, "sasl.disabled"],
    ];
    for (const [edited, field] of cases) {
      expect(classifyExistingInput({ read: { state: "read", items: [edited] }, expected, recorded: record })).toEqual({
        kind: "differs",
        fields: [field],
      });
    }
  });

  it("a hand edit to a blob input's run state or routing is differs", () => {
    const blob = buildBlobInputBody({
      id: "azure_onb_blob_acct_q1",
      storageAccount: "acct",
      queueName: "q1",
      tenantId: "t",
      clientId: "c",
      secretId: "azure_onb_blob_acct_q1_secret",
      sourceId: "vnetFlowLogs",
      sourceTitle: "VNet",
    });
    const blobRecord: CriblSourceRecord = { groupId: "g1", inputId: "azure_onb_blob_acct_q1", inputType: "azure_blob", secretId: "azure_onb_blob_acct_q1_secret" };
    for (const [edit, field] of [[{ disabled: true }, "disabled"], [{ sendToRoutes: false }, "sendToRoutes"]] as const) {
      expect(classifyExistingInput({ read: { state: "read", items: [{ ...blob, ...edit }] }, expected: blob, recorded: blobRecord })).toEqual({
        kind: "differs",
        fields: [field],
      });
    }
  });

  it("foreign, on the manifest signal, for an id outside the feature's id grammar even with stamp and KV record", () => {
    const outsider = { ...expected, id: "my_hub_input" };
    const outsiderRecord: CriblSourceRecord = { ...record, inputId: "my_hub_input" };
    const v = classifyExistingInput({ read: { state: "read", items: [{ ...stored, id: "my_hub_input" }] }, expected: outsider, recorded: outsiderRecord });
    expect(v).toEqual({ kind: "foreign", missing: ["id is not in this app’s manifest"] });
  });

  it("foreign when there is no KV record of the write", () => {
    expect(classifyExistingInput({ read: { state: "read", items: [stored] }, expected, recorded: null }).kind).toBe("foreign");
  });
});

describe("classifyExistingSecret", () => {
  const ours = { id: record.secretId, secretType: "text", description: `x ${stampFor(APP_ID)}` };
  it("absent, ours, foreign without a stamp, unknown on a refused read", () => {
    expect(classifyExistingSecret({ read: { state: "read", items: [] }, secretId: record.secretId, recorded: null })).toEqual({ kind: "absent" });
    expect(classifyExistingSecret({ read: { state: "read", items: [ours] }, secretId: record.secretId, recorded: record })).toEqual({ kind: "ours" });
    const foreign = classifyExistingSecret({
      read: { state: "read", items: [{ id: record.secretId, secretType: "text" }] },
      secretId: record.secretId,
      recorded: record,
    });
    expect(foreign.kind).toBe("foreign");
    expect(classifyExistingSecret({ read: { state: "refused", detail: "500" }, secretId: record.secretId, recorded: record }).kind).toBe("unknown");
  });

  it("foreign, on the manifest signal, for a secret id outside the feature's grammar even with stamp and KV record", () => {
    const id = "shared_eventhub_secret";
    const v = classifyExistingSecret({
      read: { state: "read", items: [{ id, secretType: "text", description: `x ${stampFor(APP_ID)}` }] },
      secretId: id,
      recorded: { ...record, secretId: id },
    });
    expect(v).toEqual({ kind: "foreign", missing: ["id is not in this app’s manifest"] });
  });
});

describe("COMMIT_MARKERS", () => {
  it("place this group's files as mine under the kit's exact-path matching", () => {
    // Literal status paths, not derived from COMMIT_MARKERS, so a bare
    // `cribl/inputs.yml` marker (which the kit places as `elsewhere`) fails here.
    const pending = [
      "groups/g1/local/cribl/inputs.yml",
      "groups/g1/local/cribl/secrets.yml",
      "groups/g1/local/cribl/auth/cribl.secret",
    ];
    expect(commitScope(pending, "g1", COMMIT_MARKERS)).toEqual({
      alreadyDirty: pending,
      elsewhere: [],
      unplaced: [],
      unknown: false,
    });
  });
});

describe("laneTopics", () => {
  const values = { ...defaultPlanValues(null), namespace: "ns1", hubName: "cribl-defender" };

  it("a named hub is that one hub, without a measurement", () => {
    expect(laneTopics({ source: src("defenderExport"), values, subSelection: [], measuredHubs: null, otherLanes: [] })).toEqual({
      kind: "ok",
      topics: ["cribl-defender"],
    });
  });

  it("a named source without a hub name refuses", () => {
    expect(laneTopics({ source: src("defenderExport"), values: { ...values, hubName: "" }, subSelection: [], measuredHubs: [], otherLanes: [] })).toMatchObject({
      kind: "refused",
      reason: "no-hub-named",
    });
  });

  it("auto-created hubs refuse until a hub list was measured", () => {
    expect(laneTopics({ source: src("activityLog"), values, subSelection: [], measuredHubs: null, otherLanes: [] })).toMatchObject({
      kind: "refused",
      reason: "hubs-not-measured",
    });
  });

  it("auto-created hubs are the expected ones the measurement found, and only those", () => {
    const measured = ["insights-logs-signinlogs", "insights-logs-auditlogs", "unrelated-hub"];
    const out = laneTopics({ source: src("entraId"), values, subSelection: ["Standard"], measuredHubs: measured, otherLanes: [] });
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" ? [...out.topics].sort() : null).toEqual(["insights-logs-auditlogs", "insights-logs-signinlogs"]);
  });

  it("refuses when none of the expected hubs has appeared", () => {
    expect(laneTopics({ source: src("activityLog"), values, subSelection: [], measuredHubs: ["other"], otherLanes: [] })).toMatchObject({
      kind: "refused",
      reason: "no-hub-measured",
    });
    expect(laneTopics({ source: src("activityLog"), values, subSelection: [], measuredHubs: ["insights-activity-logs"], otherLanes: [] })).toEqual({
      kind: "ok",
      topics: ["insights-activity-logs"],
    });
  });

  it("a policy initiative reads every measured insights-logs- hub", () => {
    expect(
      laneTopics({ source: src("diagnosticSettingsInitiative"), values, subSelection: [], measuredHubs: ["insights-logs-a", "x", "insights-logs-b"], otherLanes: [] }),
    ).toEqual({ kind: "ok", topics: ["insights-logs-a", "insights-logs-b"] });
  });

  it("XDR uses the plan hub only once measured", () => {
    expect(laneTopics({ source: src("xdrStreaming"), values, subSelection: [], measuredHubs: [], otherLanes: [] })).toMatchObject({ kind: "refused", reason: "no-hub-measured" });
    expect(laneTopics({ source: src("xdrStreaming"), values, subSelection: [], measuredHubs: ["cribl-defender"], otherLanes: [] })).toEqual({ kind: "ok", topics: ["cribl-defender"] });
  });

  it("a blob source has no topics", () => {
    expect(laneTopics({ source: src("vnetFlowLogs"), values, subSelection: [], measuredHubs: [], otherLanes: [] })).toMatchObject({ kind: "refused", reason: "blob-source" });
  });

  it("Entra and a policy initiative never both read an Entra hub", () => {
    const measured = ["insights-logs-signinlogs", "insights-logs-auditlogs", "insights-logs-kubeaudit"];
    const entra = laneTopics({
      source: src("entraId"),
      values,
      subSelection: ["Standard"],
      measuredHubs: measured,
      otherLanes: [{ source: src("diagnosticSettingsInitiative"), subSelection: [] }],
    });
    const initiative = laneTopics({
      source: src("diagnosticSettingsInitiative"),
      values,
      subSelection: [],
      measuredHubs: measured,
      otherLanes: [{ source: src("entraId"), subSelection: ["Standard"] }],
    });
    expect(entra.kind === "ok" ? [...entra.topics].sort() : entra).toEqual(["insights-logs-auditlogs", "insights-logs-signinlogs"]);
    expect(initiative).toEqual({ kind: "ok", topics: ["insights-logs-kubeaudit"] });
  });

  it("two policy initiatives refuse hub-claimed rather than split the insights-logs- hubs", () => {
    const out = laneTopics({
      source: src("diagnosticSettingsInitiative"),
      values,
      subSelection: [],
      measuredHubs: ["insights-logs-a"],
      otherLanes: [{ source: src("communityPolicyInitiative"), subSelection: [] }],
    });
    expect(out).toMatchObject({ kind: "refused", reason: "hub-claimed" });
  });

  it("two lanes naming the same hub refuse hub-claimed", () => {
    const out = laneTopics({
      source: src("xdrStreaming"),
      values,
      subSelection: [],
      measuredHubs: ["cribl-defender"],
      otherLanes: [{ source: src("defenderExport"), subSelection: [] }],
    });
    expect(out).toMatchObject({ kind: "refused", reason: "hub-claimed" });
    // And from the named side: Defender refuses its hub when XDR reads it too.
    expect(
      laneTopics({
        source: src("defenderExport"),
        values,
        subSelection: [],
        measuredHubs: null,
        otherLanes: [{ source: src("xdrStreaming"), subSelection: [] }],
      }),
    ).toMatchObject({ kind: "refused", reason: "hub-claimed" });
  });

  it("the lane itself and blob lanes in otherLanes claim nothing", () => {
    expect(
      laneTopics({
        source: src("diagnosticSettingsInitiative"),
        values,
        subSelection: [],
        measuredHubs: ["insights-logs-a"],
        otherLanes: [
          { source: src("diagnosticSettingsInitiative"), subSelection: [] },
          { source: src("vnetFlowLogs"), subSelection: [] },
        ],
      }),
    ).toEqual({ kind: "ok", topics: ["insights-logs-a"] });
  });
});

describe("the id manifest", () => {
  it("accepts the feature's input and secret grammar and nothing else", () => {
    expect(isOnboardingInputId("azure_onb_eh_ns1_hub1")).toBe(true);
    expect(isOnboardingInputId("azure_onb_blob_acct_q1")).toBe(true);
    expect(isOnboardingInputId("azure_onb_other")).toBe(false);
    expect(isOnboardingInputId("my_hub_input")).toBe(false);
    expect(isOnboardingInputId(`azure_onb_eh_${"x".repeat(80)}`)).toBe(false);
    expect(isOnboardingSecretId("azure_onb_eh_ns1_hub1_secret")).toBe(true);
    expect(isOnboardingSecretId("azure_onb_eh_ns1_hub1")).toBe(false);
    expect(isOnboardingSecretId("shared_eventhub_secret")).toBe(false);
  });
});
