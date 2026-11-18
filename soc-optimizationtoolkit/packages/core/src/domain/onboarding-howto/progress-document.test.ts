import { describe, expect, it } from "vitest";
import { COVERAGE_SELECTION_KIND } from "../coverage-model";
import {
  EVENT_HUB_PLAN_KEYS,
  ONBOARDING_PROGRESS_KEY,
  canWriteProgressDocument,
  decodeProgress,
  emptyProgress,
  encodeProgress,
  eventHubFollowsSection1,
  eventHubLocation,
  planFingerprint,
  withEventHubSource,
  progressFrom,
  readProgressDocument,
  strandedCriblSources,
  tickState,
  withCriblSource,
  withLakeRoute,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  withTick,
  withWorkerGroup,
  withoutTick,
  activityLogSettingRecord,
  withActivityLogSetting,
  withEntraSetting,
  withoutEntraSetting,
  entraSettingRecord,
  withLakeRouteAfterTeardown,
  withoutActivityLogSetting,
  withoutCriblSource,
  withEventHubAccess,
  withoutEventHubAccess,
} from "./index";
import type { OnboardingProgress } from "./index";

function sample(): OnboardingProgress {
  let p = emptyProgress({ subscriptionId: "sub1", resourceGroup: "rg1" });
  p = withSourceChosen(p, "defenderExport", true);
  p = withSourceMode(p, "defenderExport", "automate");
  p = withSourceChosen(p, "vnetFlowLogs", true);
  p = withPlanValues(p, { ...p.planValues, namespace: "ns1", hubName: "h1", listenRule: "reader" });
  p = withTick(p, "P1", ["namespace", "region"]);
  p = withCriblSource(p, "defenderExport", {
    groupId: "default",
    inputId: "azure_onb_eh_ns1_h1",
    inputType: "eventhub",
    secretId: "azure_onb_eh_ns1_h1_cs",
  });
  return withWorkerGroup(p, "default");
}

const value = (v: unknown) => ({ kind: "value" as const, value: v });

describe("progress document codec", () => {
  it("uses its own key, not the coverage selection's", () => {
    expect(ONBOARDING_PROGRESS_KEY).toBe("azure-onboarding-progress");
  });

  it("round-trips through encode and read", () => {
    const p = sample();
    const doc = readProgressDocument(value(JSON.parse(encodeProgress(p))));
    expect(doc.status).toBe("ok");
    if (doc.status !== "ok") return;
    expect(doc.decoded.dropped).toEqual([]);
    expect(doc.decoded.progress).toEqual(p);
    // And a string value (JSON inside JSON) reads the same.
    expect(progressFrom(readProgressDocument(value(encodeProgress(p))))).toEqual(p);
  });

  it("is deterministic regardless of insertion order", () => {
    let a = emptyProgress();
    a = withTick(withTick(a, "B", ["namespace"]), "A", ["hubName"]);
    let b = emptyProgress();
    b = withTick(withTick(b, "A", ["hubName"]), "B", ["namespace"]);
    expect(encodeProgress(a)).toBe(encodeProgress(b));
  });

  it("reads the coverage selection's kind as foreign and blocks writes", () => {
    const doc = readProgressDocument(value({ kind: COVERAGE_SELECTION_KIND, version: 1 }));
    expect(doc).toEqual({ status: "foreign", kind: COVERAGE_SELECTION_KIND });
    expect(canWriteProgressDocument(doc)).toBe(false);
  });

  it("reads any version other than exactly 1 as unreadable", () => {
    for (const version of [2, 0, "1", undefined]) {
      const raw: Record<string, unknown> = { kind: "azure-onboarding-progress" };
      if (version !== undefined) raw.version = version;
      const doc = readProgressDocument(value(raw));
      expect(doc.status, String(version)).toBe("unreadable");
      expect(canWriteProgressDocument(doc)).toBe(false);
    }
  });

  it("reads a failed load as read-unknown, never as a first run", () => {
    const doc = readProgressDocument({ kind: "unknown", reason: "HTTP 403", status: 403 });
    expect(doc).toEqual({ status: "read-unknown", reason: "HTTP 403" });
    expect(canWriteProgressDocument(doc)).toBe(false);
    expect(progressFrom(doc)).toBeNull();
  });

  it("reads absent, corrupt and identity-less values as absent, and allows writes", () => {
    for (const load of [
      { kind: "absent" as const, why: "not-found" as const },
      value("{not json"),
      value({}),
      value([1, 2]),
    ]) {
      const doc = readProgressDocument(load);
      expect(doc.status).toBe("absent");
      expect(canWriteProgressDocument(doc)).toBe(true);
      expect(progressFrom(doc)).toEqual(emptyProgress());
    }
  });

  it("never writes a secret, even when one is pushed into a plan value or tick", () => {
    const cs =
      "Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=reader;SharedAccessKey=abc";
    let p = sample();
    p = { ...p, planValues: { ...p.planValues, namespace: cs } };
    p = { ...p, ticks: { ...p.ticks, X: { fingerprint: "f", values: { namespace: cs } } } };
    const text = encodeProgress(p);
    for (const word of ["password", "SharedAccessKey", "connectionString", "abc"]) {
      expect(text).not.toContain(word);
    }
    // withPlanValues blanks it too.
    expect(withPlanValues(sample(), { ...sample().planValues, hubName: cs }).planValues.hubName).toBe("");
  });

  it("keeps the rule name RootManageSharedAccessKey through apply and a KV round trip", () => {
    const cs =
      "Endpoint=sb://ns1.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc";
    const applied = withPlanValues(sample(), {
      ...sample().planValues,
      listenRule: "RootManageSharedAccessKey",
      sendRule: "RootManageSharedAccessKey",
      hubName: cs,
    });
    expect(applied.planValues.listenRule).toBe("RootManageSharedAccessKey");
    expect(applied.planValues.sendRule).toBe("RootManageSharedAccessKey");
    expect(applied.planValues.hubName).toBe("");
    const doc = readProgressDocument(value(encodeProgress(applied)));
    expect(doc.status).toBe("ok");
    const back = progressFrom(doc);
    if (back === null) throw new Error("expected progress from an ok document");
    expect(back.planValues.listenRule).toBe("RootManageSharedAccessKey");
    expect(back.planValues.sendRule).toBe("RootManageSharedAccessKey");
    expect(back.planValues.hubName).toBe("");
    const { dropped } = decodeProgress(JSON.parse(encodeProgress(applied)));
    expect(dropped.filter((d) => d.endsWith(":credential"))).toEqual([]);
    expect(encodeProgress(applied)).not.toContain("SharedAccessKey=");
  });

  it("decodes a stored automate as manual where the source is not automatable", () => {
    const raw = JSON.parse(encodeProgress(emptyProgress()));
    raw.sources = {
      xdrStreaming: { chosen: true, mode: "automate" },
      defenderExport: { chosen: true, mode: "automate" },
    };
    const { progress, dropped } = decodeProgress(raw);
    expect(progress.sources.xdrStreaming).toEqual({ chosen: true, mode: "manual" });
    expect(progress.sources.defenderExport).toEqual({ chosen: true, mode: "automate" });
    expect(dropped).toContain("sources.xdrStreaming.mode:automate");
  });

  it("drops and reports unknown source ids, keys and malformed records", () => {
    const raw = JSON.parse(encodeProgress(sample()));
    raw.sources.notASource = { chosen: true, mode: "manual" };
    raw.planValues.bogus = "x";
    raw.criblSources.vnetFlowLogs = { groupId: "g", inputId: "i", inputType: "azure_eventhub", secretId: "s" };
    raw.ticks.Bad = { fingerprint: 3 };
    raw.extra = true;
    const { progress, dropped } = decodeProgress(raw);
    expect([...dropped].sort()).toEqual(
      ["criblSources.vnetFlowLogs", "extra", "planValues.bogus", "sources.notASource", "ticks.Bad"].sort(),
    );
    expect(Object.keys(progress.sources)).not.toContain("notASource");
    expect(progress.criblSources.vnetFlowLogs).toBeUndefined();
    expect(progress.criblSources.defenderExport?.inputType).toBe("eventhub");
  });
});

describe("transitions", () => {
  it("refuses automate on a non-automatable source", () => {
    const p = withSourceMode(emptyProgress(), "xdrStreaming", "automate");
    expect(p.sources.xdrStreaming?.mode).toBe("manual");
    expect(withSourceMode(emptyProgress(), "defenderExport", "automate").sources.defenderExport?.mode).toBe(
      "automate",
    );
  });

  it("preserves mode when choosing and chosen when changing mode", () => {
    let p = withSourceMode(emptyProgress(), "defenderExport", "automate");
    p = withSourceChosen(p, "defenderExport", true);
    expect(p.sources.defenderExport).toEqual({ chosen: true, mode: "automate" });
    p = withSourceMode(p, "defenderExport", "manual");
    expect(p.sources.defenderExport).toEqual({ chosen: true, mode: "manual" });
  });

  it("goes stale only when a depended-on value changes, and names the changed key", () => {
    const deps = ["namespace", "hubName"] as const;
    let p = withPlanValues(emptyProgress(), { ...emptyProgress().planValues, namespace: "ns1", hubName: "h1" });
    expect(tickState(p, "P2", deps)).toEqual({ status: "not-done" });
    p = withTick(p, "P2", deps);
    expect(tickState(p, "P2", deps)).toEqual({ status: "done" });
    const otherKey = withPlanValues(p, { ...p.planValues, region: "eastus" });
    expect(tickState(otherKey, "P2", deps)).toEqual({ status: "done" });
    const changed = withPlanValues(p, { ...p.planValues, namespace: "ns2" });
    expect(tickState(changed, "P2", deps)).toEqual({ status: "stale", changedKeys: ["namespace"] });
    expect(tickState(withoutTick(changed, "P2"), "P2", deps)).toEqual({ status: "not-done" });
  });

  it("survives a reload: a stale tick read back is still stale", () => {
    let p = withPlanValues(emptyProgress(), { ...emptyProgress().planValues, namespace: "ns1" });
    p = withTick(p, "P1", ["namespace"]);
    p = withPlanValues(p, { ...p.planValues, namespace: "ns2" });
    const back = progressFrom(readProgressDocument(value(JSON.parse(encodeProgress(p)))))!;
    expect(tickState(back, "P1", ["namespace"])).toEqual({ status: "stale", changedKeys: ["namespace"] });
  });
});

describe("Lake route records (AZR-35)", () => {
  const RECORD = { groupId: "default", datasetId: "azure_activity_log", pipelineId: "azure_onb_unroll_records", routeId: "azure_onb_activity_log_lake" };

  it("round-trips a record, a null step included", () => {
    let p = withLakeRoute(sample(), "activityLog", RECORD);
    p = withLakeRoute(p, "defenderExport", { ...RECORD, datasetId: "azure_defender_alerts", routeId: null });
    const doc = readProgressDocument(value(encodeProgress(p)));
    const back = progressFrom(doc);
    expect(doc.status === "ok" ? doc.decoded.dropped : null).toEqual([]);
    expect(back?.criblLakeRoutes?.activityLog).toEqual(RECORD);
    expect(back?.criblLakeRoutes?.defenderExport).toEqual({ ...RECORD, datasetId: "azure_defender_alerts", routeId: null });
  });

  it("a document with no Lake route encodes exactly as before AZR-35 (no new key)", () => {
    expect(JSON.parse(encodeProgress(sample()))).not.toHaveProperty("criblLakeRoutes");
  });

  it("drops and reports a malformed record, never invents one", () => {
    const raw = JSON.parse(encodeProgress(sample()));
    raw.criblLakeRoutes = { activityLog: { groupId: "g", datasetId: 7, pipelineId: null, routeId: null }, notASource: RECORD };
    const { progress, dropped } = decodeProgress(raw);
    expect([...dropped].sort()).toEqual(["criblLakeRoutes.activityLog", "criblLakeRoutes.notASource"]);
    expect(progress.criblLakeRoutes).toBeUndefined();
  });
});

describe("teardown records (AZR-105)", () => {
  const RECORD = { groupId: "default", datasetId: "azure_activity_log", pipelineId: "azure_onb_unroll_records", routeId: "azure_onb_activity_log_lake" };
  const RULE = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns/authorizationRules/m";

  it("round-trips datasetCreated only as a literal true", () => {
    const p = withLakeRoute(sample(), "activityLog", { ...RECORD, datasetCreated: true });
    expect(progressFrom(readProgressDocument(value(encodeProgress(p))))?.criblLakeRoutes?.activityLog).toEqual({ ...RECORD, datasetCreated: true });
    const raw = JSON.parse(encodeProgress(withLakeRoute(sample(), "activityLog", RECORD)));
    expect(raw.criblLakeRoutes.activityLog).not.toHaveProperty("datasetCreated");
    raw.criblLakeRoutes.activityLog.datasetCreated = "yes";
    expect(decodeProgress(raw).progress.criblLakeRoutes?.activityLog).toEqual(RECORD);
  });

  it("a later apply that found the dataset present keeps the proof the app created it", () => {
    let p = withLakeRoute(sample(), "activityLog", { ...RECORD, pipelineId: null, routeId: null, datasetCreated: true });
    p = withLakeRoute(p, "activityLog", RECORD);
    expect(p.criblLakeRoutes?.activityLog).toEqual({ ...RECORD, datasetCreated: true });
    // ...but not when that apply saw the dataset absent and did not create it.
    expect(withLakeRoute(p, "activityLog", RECORD, { datasetSeenAbsent: true }).criblLakeRoutes?.activityLog).toEqual(RECORD);
    // ...and not across a different group or dataset.
    p = withLakeRoute(p, "activityLog", { ...RECORD, groupId: "other" });
    expect(p.criblLakeRoutes?.activityLog).toEqual({ ...RECORD, groupId: "other" });
  });

  it("forgets a Cribl source and a Lake route record", () => {
    let p = withLakeRoute(sample(), "activityLog", RECORD);
    p = withoutCriblSource(p, "defenderExport");
    expect(p.criblSources).toEqual({});
    p = withLakeRouteAfterTeardown(p, "activityLog", { ...RECORD, routeId: null });
    expect(p.criblLakeRoutes?.activityLog).toEqual({ ...RECORD, routeId: null });
    p = withLakeRouteAfterTeardown(p, "activityLog", null);
    expect(p).not.toHaveProperty("criblLakeRoutes");
  });

  it("records one Activity Log setting per subscription, round-trips it, and forgets it", () => {
    let p = withActivityLogSetting(sample(), { subscriptionId: "S1", settingName: "cribl-activity-log", ruleId: RULE });
    p = withActivityLogSetting(p, { subscriptionId: "s1", settingName: "cribl-activity-log", ruleId: `${RULE}2` });
    p = withActivityLogSetting(p, { subscriptionId: "s2", settingName: "cribl-activity-log", ruleId: RULE });
    expect(p.activityLogSettings).toHaveLength(2);
    expect(activityLogSettingRecord(p, "S1")?.ruleId).toBe(`${RULE}2`);
    const back = progressFrom(readProgressDocument(value(encodeProgress(p))));
    expect(back?.activityLogSettings?.map((r) => r.subscriptionId)).toEqual(["s1", "s2"]);
    const gone = withoutActivityLogSetting(withoutActivityLogSetting(p, "s1"), "S2");
    expect(gone).not.toHaveProperty("activityLogSettings");
    expect(JSON.parse(encodeProgress(gone))).not.toHaveProperty("activityLogSettings");
  });

  it("drops and reports a malformed or duplicate Activity Log record", () => {
    const raw = JSON.parse(encodeProgress(sample()));
    raw.activityLogSettings = [
      { subscriptionId: "s1", settingName: "cribl-activity-log", ruleId: RULE },
      { subscriptionId: "S1", settingName: "cribl-activity-log", ruleId: RULE },
      { subscriptionId: 7 },
    ];
    const { progress, dropped } = decodeProgress(raw);
    expect(dropped).toEqual(["activityLogSettings[1]", "activityLogSettings[2]"]);
    expect(progress.activityLogSettings).toEqual([{ subscriptionId: "s1", settingName: "cribl-activity-log", ruleId: RULE }]);
  });
});

describe("where the Event Hub plan values come from (AZR-102)", () => {
  it("round-trips both sources, and a document without one encodes exactly as before (no new key)", () => {
    for (const source of ["section1", "own"] as const) {
      const doc = readProgressDocument(value(encodeProgress(withEventHubSource(sample(), source))));
      expect(doc.status === "ok" ? doc.decoded.dropped : null).toEqual([]);
      expect(progressFrom(doc)?.eventHubSource).toBe(source);
    }
    expect(JSON.parse(encodeProgress(sample()))).not.toHaveProperty("eventHubSource");
    expect(decodeProgress(JSON.parse(encodeProgress(sample()))).progress).not.toHaveProperty("eventHubSource");
  });

  it("drops and reports an unknown value, never guesses one", () => {
    const raw = JSON.parse(encodeProgress(sample()));
    raw.eventHubSource = "picker";
    const { progress, dropped } = decodeProgress(raw);
    expect(dropped).toEqual(["eventHubSource"]);
    expect(progress.eventHubSource).toBeUndefined();
  });

  it("an explicit source decides, whatever the names", () => {
    const named = sample(); // names ns1/h1
    expect(eventHubFollowsSection1(withEventHubSource(named, "section1"))).toBe(true);
    expect(eventHubFollowsSection1(withEventHubSource(named, "own"))).toBe(false);
    expect(eventHubFollowsSection1(withEventHubSource(emptyProgress(), "own"))).toBe(false);
  });

  it("MIGRATION: a pre-AZR-102 document follows section 1 only when it names no Event Hub", () => {
    // The first-run subscription and resource group are not Event Hub names of the operator's.
    expect(eventHubFollowsSection1(emptyProgress({ subscriptionId: "sub1", resourceGroup: "rg1" }))).toBe(true);
    const blank = emptyProgress().planValues;
    for (const key of EVENT_HUB_PLAN_KEYS) {
      const saved = withPlanValues(emptyProgress(), { ...blank, [key]: "mine" });
      expect(eventHubFollowsSection1(saved), key).toBe(false);
    }
    // The shared subscription and resource group are not the picker's and never decide it.
    const typed = withPlanValues(emptyProgress(), { ...blank, subscriptionId: "sub-x", resourceGroup: "rg-x" });
    expect(eventHubFollowsSection1(typed)).toBe(true);
    // Whitespace is not a name.
    expect(eventHubFollowsSection1(withPlanValues(emptyProgress(), { ...blank, namespace: "  " }))).toBe(true);
  });

  it("names exactly the five Event Hub keys, never the shared subscription or resource group", () => {
    expect([...EVENT_HUB_PLAN_KEYS]).toEqual([
      "eventHubSubscriptionId",
      "eventHubResourceGroup",
      "namespace",
      "hubName",
      "sendRule",
    ]);
  });

  it("the namespace's own location falls back to the shared one when blank", () => {
    const base = emptyProgress({ subscriptionId: "sub1", resourceGroup: "rg1" }).planValues;
    expect(eventHubLocation(base)).toEqual({ subscriptionId: "sub1", resourceGroup: "rg1" });
    expect(eventHubLocation({ ...base, eventHubSubscriptionId: "sub-eh", eventHubResourceGroup: " " })).toEqual({
      subscriptionId: "sub-eh",
      resourceGroup: "rg1",
    });
  });

  it("an old tick keeps its fingerprint: a blank namespace location key reads as its shared key", () => {
    const p = withPlanValues(emptyProgress({ subscriptionId: "s", resourceGroup: "r" }), {
      ...emptyProgress({ subscriptionId: "s", resourceGroup: "r" }).planValues,
      namespace: "ns1",
    });
    // A tick from before AZR-102 fingerprinted the shared keys.
    const before = planFingerprint(p.planValues, ["subscriptionId", "resourceGroup", "namespace"]);
    const now = ["eventHubSubscriptionId", "eventHubResourceGroup", "namespace"] as const;
    expect(planFingerprint(p.planValues, now)).toBe(before);
    // A step that uses both reads the same as before too.
    expect(planFingerprint(p.planValues, [...now, "subscriptionId", "resourceGroup"])).toBe(before);
    // With the key blank, moving the shared resource group moves the namespace: stale.
    expect(planFingerprint({ ...p.planValues, resourceGroup: "r2" }, now)).not.toBe(before);
    // Its own value, once set, is what counts.
    const located = { ...p.planValues, eventHubResourceGroup: "rg-eh" };
    expect(planFingerprint(located, now)).not.toBe(before);
    expect(planFingerprint({ ...located, resourceGroup: "r2" }, now)).toBe(planFingerprint(located, now));
    // Re-review: naming the SAME address explicitly (following section 1 and
    // picking the namespace in the shared resource group) is no change.
    const explicitSame = { ...p.planValues, eventHubSubscriptionId: "s", eventHubResourceGroup: "r" };
    expect(planFingerprint(explicitSame, now)).toBe(before);
    expect(planFingerprint(explicitSame, [...now, "subscriptionId", "resourceGroup"])).toBe(before);
    // A step that uses both, with the namespace elsewhere, records both values.
    expect(planFingerprint(located, ["resourceGroup", "eventHubResourceGroup"])).toBe(
      JSON.stringify([
        ["resourceGroup", "r"],
        ["resourceGroup", "rg-eh"],
      ]),
    );
  });
});

describe("strandedCriblSources (AZR-96)", () => {
  const STRANDED = {
    groupId: "default",
    inputId: "azure_onb_eh_ehnsjpedersoneastus_ehjpedersoneastus",
    inputType: "eventhub" as const,
    secretId: "azure_onb_eh_ehnsjpedersoneastus_ehjpedersoneastus_cs",
  };

  it("returns exactly the record the legacy body holds and the current progress does not", () => {
    const current = emptyProgress();
    const legacy = JSON.parse(encodeProgress(withCriblSource(emptyProgress(), "defenderExport", STRANDED)));
    const out = strandedCriblSources(current, legacy);
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceId).toBe("defenderExport");
    expect(out[0]?.record.inputId).toBe("azure_onb_eh_ehnsjpedersoneastus_ehjpedersoneastus");
    expect(out[0]?.record.groupId).toBe("default");
  });

  it("returns nothing when both hold the same record", () => {
    const p = withCriblSource(emptyProgress(), "defenderExport", STRANDED);
    expect(strandedCriblSources(p, JSON.parse(encodeProgress(p)))).toEqual([]);
  });

  it("returns the legacy record when the current one has the same input id in another worker group", () => {
    const current = withCriblSource(emptyProgress(), "defenderExport", { ...STRANDED, groupId: "other-group" });
    const legacy = JSON.parse(encodeProgress(withCriblSource(emptyProgress(), "defenderExport", STRANDED)));
    const out = strandedCriblSources(current, legacy);
    expect(out).toHaveLength(1);
    expect(out[0]?.record.groupId).toBe("default");
  });

  it("returns the legacy record when the current one names a different input", () => {
    const current = sample(); // defenderExport -> azure_onb_eh_ns1_h1
    const legacy = JSON.parse(encodeProgress(withCriblSource(emptyProgress(), "defenderExport", STRANDED)));
    const out = strandedCriblSources(current, legacy);
    expect(out.map((r) => r.record.inputId)).toEqual(["azure_onb_eh_ehnsjpedersoneastus_ehjpedersoneastus"]);
  });

  it("reads a string-encoded legacy body, and nothing from one that is not a readable progress document", () => {
    const legacy = encodeProgress(withCriblSource(emptyProgress(), "defenderExport", STRANDED));
    expect(strandedCriblSources(emptyProgress(), legacy)).toHaveLength(1);
    const foreign = { ...JSON.parse(legacy), kind: "something-else" };
    expect(strandedCriblSources(emptyProgress(), foreign)).toEqual([]);
    const wrongVersion = { ...JSON.parse(legacy), version: 2 };
    expect(strandedCriblSources(emptyProgress(), wrongVersion)).toEqual([]);
  });
});

describe("Entra ID setting records (AZR-99)", () => {
  const RULE = "/subscriptions/s/resourceGroups/r/providers/Microsoft.EventHub/namespaces/n/authorizationRules/send";

  it("keeps one record per tenant, round-trips, and forgets one without touching the other", () => {
    let p = withEntraSetting(emptyProgress(), { tenantId: "T1", settingName: "CriblEntraIDLogs", ruleId: RULE });
    p = withEntraSetting(p, { tenantId: "t1", settingName: "CriblEntraIDLogs", ruleId: `${RULE}2` });
    p = withEntraSetting(p, { tenantId: "t2", settingName: "CriblEntraIDLogs", ruleId: RULE });
    expect(p.entraSettings).toHaveLength(2);
    expect(entraSettingRecord(p, "T1")?.ruleId).toBe(`${RULE}2`);
    const back = decodeProgress(JSON.parse(encodeProgress(p))).progress;
    expect(back.entraSettings?.map((r) => r.tenantId)).toEqual(["t1", "t2"]);
    expect(entraSettingRecord(back, "t2")).toEqual({ tenantId: "t2", settingName: "CriblEntraIDLogs", ruleId: RULE });
    const one = withoutEntraSetting(back, "T2");
    expect(one.entraSettings?.map((r) => r.tenantId)).toEqual(["t1"]);
    const gone = withoutEntraSetting(one, "t1");
    expect(gone).not.toHaveProperty("entraSettings");
    expect(JSON.parse(encodeProgress(gone))).not.toHaveProperty("entraSettings");
  });

  it("drops and reports malformed and duplicate records, never inventing one", () => {
    const raw = JSON.parse(encodeProgress(emptyProgress()));
    raw.entraSettings = [
      { tenantId: "t1", settingName: "CriblEntraIDLogs", ruleId: RULE },
      { tenantId: "T1", settingName: "CriblEntraIDLogs", ruleId: RULE },
      { tenantId: "t2", settingName: "CriblEntraIDLogs" },
    ];
    const { progress, dropped } = decodeProgress(raw);
    expect(progress.entraSettings).toEqual([{ tenantId: "t1", settingName: "CriblEntraIDLogs", ruleId: RULE }]);
    expect(dropped).toEqual(["entraSettings[1]", "entraSettings[2]"]);
  });
});

describe("Event Hub access records (AZR-36)", () => {
  const NS = "/subscriptions/s/resourceGroups/r/providers/Microsoft.EventHub/namespaces/n";
  const RULE = { kind: "listen-rule" as const, resourceId: `${NS}/authorizationRules/cribl-listen` };
  const CG = { kind: "consumer-group" as const, resourceId: `${NS}/eventhubs/h/consumergroups/cribl` };

  it("adds one record per resource id, round-trips sorted, and forgets one at a time", () => {
    let p = withEventHubAccess(emptyProgress(), [CG]);
    p = withEventHubAccess(p, [RULE, { ...CG, resourceId: CG.resourceId.toUpperCase() }]);
    expect(p.eventHubAccess).toHaveLength(2);
    const back = decodeProgress(JSON.parse(encodeProgress(p))).progress;
    expect(back.eventHubAccess?.map((r) => r.kind)).toEqual(["consumer-group", "listen-rule"]);
    const one = withoutEventHubAccess(back, RULE.resourceId.toLowerCase());
    expect(one.eventHubAccess?.map((r) => r.kind)).toEqual(["consumer-group"]);
    const gone = withoutEventHubAccess(one, CG.resourceId);
    expect(gone).not.toHaveProperty("eventHubAccess");
    expect(JSON.parse(encodeProgress(gone))).not.toHaveProperty("eventHubAccess");
    expect(withEventHubAccess(gone, [])).toBe(gone);
  });

  it("drops and reports malformed and duplicate records, never inventing one", () => {
    const raw = JSON.parse(encodeProgress(emptyProgress()));
    raw.eventHubAccess = [RULE, { ...RULE }, { kind: "hub", resourceId: "x" }, { kind: "consumer-group", resourceId: " " }, CG];
    const { progress, dropped } = decodeProgress(raw);
    expect(progress.eventHubAccess).toEqual([RULE, CG]);
    expect(dropped).toEqual(["eventHubAccess[1]", "eventHubAccess[2]", "eventHubAccess[3]"]);
  });
});
