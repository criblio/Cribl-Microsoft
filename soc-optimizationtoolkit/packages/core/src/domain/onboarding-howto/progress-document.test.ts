import { describe, expect, it } from "vitest";
import { COVERAGE_SELECTION_KIND } from "../coverage-model";
import {
  ONBOARDING_PROGRESS_KEY,
  canWriteProgressDocument,
  decodeProgress,
  emptyProgress,
  encodeProgress,
  progressFrom,
  readProgressDocument,
  tickState,
  withCriblSource,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  withTick,
  withWorkerGroup,
  withoutTick,
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
      entraId: { chosen: true, mode: "automate" },
      defenderExport: { chosen: true, mode: "automate" },
    };
    const { progress, dropped } = decodeProgress(raw);
    expect(progress.sources.entraId).toEqual({ chosen: true, mode: "manual" });
    expect(progress.sources.defenderExport).toEqual({ chosen: true, mode: "automate" });
    expect(dropped).toContain("sources.entraId.mode:automate");
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
    const p = withSourceMode(emptyProgress(), "entraId", "automate");
    expect(p.sources.entraId?.mode).toBe("manual");
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
