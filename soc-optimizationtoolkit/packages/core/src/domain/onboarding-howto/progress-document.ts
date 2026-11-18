/**
 * Progress document - WHAT THE OPERATOR HAS CHOSEN AND DONE, surviving a reload.
 *
 * A SEPARATE KV DOCUMENT (D1, ADR 0007). The AZR-18 selection document
 * (`azure-coverage-selection` v1) is left byte-for-byte unchanged: its encoder
 * strips unknown keys and drops ids outside the coverage catalog, so How-to
 * progress written into it would vanish on the next Save. This document holds
 * the How-to side: which sources are chosen and in which mode, the plan values,
 * the done ticks, the Cribl inputs the app created, the Lake routes it created
 * for them (AZR-35), and the worker group.
 *
 * THE GATE MIRRORS readCoverageDocument. {@link readProgressDocument} answers
 * the two questions claude-kit standards/cribl-kv-store.md keeps apart - is it
 * ours (`kind`), can this release read it (`version` exactly 1) - plus the
 * port's third answer, a refused read (`read-unknown`). A write is allowed only
 * after `absent` or `ok`; anything else may be hiding real progress.
 *
 * NO SECRET SLOT. Nothing in {@link OnboardingProgress} can hold a key or a
 * connection string: plan values are names (and a value that looks like a
 * credential is blanked on encode and decode), and a Cribl source record holds
 * the SECRET'S ID, never its value.
 *
 * MODE IS COERCED. A stored `automate` for a source the app cannot deploy
 * (isAutomatable false - everything but the Defender export and the Activity
 * Log today) decodes as
 * `manual`, so an older or hand-edited document cannot offer a deploy path that
 * does not exist.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import type { KvDocumentLoad } from "../../ports/kv-document-store";
import {
  changedValueKeys,
  PLAN_VALUE_KEYS,
  defaultPlanValues,
  isPlanValueKey,
  planFingerprint,
  sanitizePlanValue,
  type PlanValueKey,
  type PlanValues,
} from "./plan-values";
import {
  ONBOARDING_SOURCES,
  isAutomatable,
  isOnboardingSourceId,
  type CriblInputType,
  type OnboardingSourceId,
} from "./sources";

/** The KV key. */
export const ONBOARDING_PROGRESS_KEY = "azure-onboarding-progress";
/** The document's identity, written into the value. */
export const ONBOARDING_PROGRESS_KIND = "azure-onboarding-progress";
/** The only version this release reads or writes. */
export const ONBOARDING_PROGRESS_VERSION = 1;

/** How a source's Azure side is set up: by the app, or by the operator following steps. */
export type SourceMode = "automate" | "manual";

export interface SourceProgress {
  readonly chosen: boolean;
  readonly mode: SourceMode;
}

/**
 * A done tick. `values` is the snapshot of the plan values the step depended on
 * when it was ticked, so a later change can be NAMED, not just detected (D5).
 */
export interface StepTick {
  readonly fingerprint: string;
  readonly values: Readonly<Partial<Record<PlanValueKey, string>>>;
}

/** What the app created in Cribl for one source. Ids only; never a secret value. */
export interface CriblSourceRecord {
  readonly groupId: string;
  readonly inputId: string;
  readonly inputType: CriblInputType;
  readonly secretId: string;
}

/**
 * What the app created in Cribl to route one source to Cribl Lake (AZR-35).
 * Ids only. Written after an apply that created (or proved its own) at least
 * one object, so the app can later prove it created them and the dataflow can
 * draw the route hop. A null id is a step that did not complete.
 */
export interface LakeRouteRecord {
  readonly groupId: string;
  /** The Lake dataset the route sends to (created by the app, or one that already existed). */
  readonly datasetId: string;
  /** The unroll pipeline the app created or proved its own; null when that step did not complete. */
  readonly pipelineId: string | null;
  /** The route the app wrote into the group's routing table; null when it was not written. */
  readonly routeId: string | null;
  /**
   * AZR-105: true only when THIS APP created the dataset (POST answered 2xx
   * and the read-back listed it). `datasetId` alone does not say so: it is
   * also recorded when the dataset already existed and was used as it is.
   * Without it a teardown can never prove the dataset is the app's, so it is
   * kept. Absent (every record written before AZR-105) reads as not created.
   */
  readonly datasetCreated?: true;
}

/**
 * The subscription diagnostic setting the app created for the Activity Log
 * (AZR-98), recorded so a removal can prove it (AZR-105). A diagnostic
 * setting carries no description or tags, so the KV record also holds the
 * rule id the app wrote: a setting under the app's name that now sends with
 * another rule is not provably the one the app wrote.
 */
export interface ActivityLogSettingRecord {
  readonly subscriptionId: string;
  /** The setting's name as written (ACTIVITY_LOG_SETTING_NAME). */
  readonly settingName: string;
  /** The eventHubAuthorizationRuleId the PUT wrote. */
  readonly ruleId: string;
}

export interface OnboardingProgress {
  readonly sources: Readonly<Partial<Record<OnboardingSourceId, SourceProgress>>>;
  readonly planValues: PlanValues;
  /** Keyed by step id. */
  readonly ticks: Readonly<Record<string, StepTick>>;
  readonly criblSources: Readonly<Partial<Record<OnboardingSourceId, CriblSourceRecord>>>;
  readonly workerGroup: string | null;
  /**
   * AZR-35: the Lake routes the app created, by source. Optional so a document
   * (and every literal) from before AZR-35 still reads; absent reads as none.
   * An older release decodes this key as dropped, and its next save omits it.
   */
  readonly criblLakeRoutes?: Readonly<Partial<Record<OnboardingSourceId, LakeRouteRecord>>>;
  /**
   * AZR-105: the Activity Log diagnostic settings the app created, one per
   * subscription. Optional for the same reason as criblLakeRoutes; absent
   * reads as none, so a setting deployed before AZR-105 cannot be proven
   * and is never removed by the app.
   */
  readonly activityLogSettings?: readonly ActivityLogSettingRecord[];
}

/** The progress a first run starts from. */
export function emptyProgress(
  config: Parameters<typeof defaultPlanValues>[0] = null,
): OnboardingProgress {
  return {
    sources: {},
    planValues: defaultPlanValues(config),
    ticks: {},
    criblSources: {},
    workerGroup: null,
  };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function sortedRecord<T>(rec: Readonly<Record<string, T | undefined>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec).sort()) {
    const v = rec[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Serialize for the KV store. Deterministic: same progress, same text. */
export function encodeProgress(progress: OnboardingProgress): string {
  const sources: Record<string, SourceProgress> = {};
  for (const s of ONBOARDING_SOURCES) {
    const p = progress.sources[s.id];
    if (p !== undefined) sources[s.id] = { chosen: p.chosen, mode: p.mode };
  }
  const planValues: Record<string, string> = {};
  for (const k of PLAN_VALUE_KEYS) planValues[k] = sanitizePlanValue(progress.planValues[k] ?? "");
  const ticks: Record<string, StepTick> = {};
  for (const [id, t] of Object.entries(sortedRecord(progress.ticks))) {
    const values: Record<string, string> = {};
    for (const k of Object.keys(t.values).sort()) {
      if (isPlanValueKey(k)) values[k] = sanitizePlanValue(t.values[k] ?? "");
    }
    ticks[id] = { fingerprint: t.fingerprint, values };
  }
  const criblSources: Record<string, CriblSourceRecord> = {};
  for (const s of ONBOARDING_SOURCES) {
    const r = progress.criblSources[s.id];
    if (r !== undefined) {
      criblSources[s.id] = {
        groupId: r.groupId,
        inputId: r.inputId,
        inputType: r.inputType,
        secretId: r.secretId,
      };
    }
  }
  const criblLakeRoutes: Record<string, LakeRouteRecord> = {};
  for (const s of ONBOARDING_SOURCES) {
    const r = progress.criblLakeRoutes?.[s.id];
    if (r !== undefined) {
      criblLakeRoutes[s.id] = {
        groupId: r.groupId,
        datasetId: r.datasetId,
        pipelineId: r.pipelineId,
        routeId: r.routeId,
        // Written only when true, so a record without it encodes as before.
        ...(r.datasetCreated === true ? { datasetCreated: true as const } : {}),
      };
    }
  }
  const activityLogSettings = [...(progress.activityLogSettings ?? [])]
    .map((r) => ({ subscriptionId: r.subscriptionId, settingName: r.settingName, ruleId: r.ruleId }))
    .sort((a, b) => (a.subscriptionId < b.subscriptionId ? -1 : a.subscriptionId > b.subscriptionId ? 1 : 0));
  return JSON.stringify({
    kind: ONBOARDING_PROGRESS_KIND,
    version: ONBOARDING_PROGRESS_VERSION,
    sources,
    planValues,
    ticks,
    criblSources,
    workerGroup: progress.workerGroup,
    // Written only when there is one, so a document without Lake routes
    // encodes exactly as it did before AZR-35.
    ...(Object.keys(criblLakeRoutes).length > 0 ? { criblLakeRoutes } : {}),
    ...(activityLogSettings.length > 0 ? { activityLogSettings } : {}),
  });
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** What a decode produced and what it dropped (reported, never silent). */
export interface DecodedProgress {
  readonly progress: OnboardingProgress;
  readonly dropped: readonly string[];
}

/**
 * Decode an object of ours. Tolerant: keeps what still resolves, drops unknown
 * keys and source ids (reporting them), and coerces `automate` to `manual`
 * where the source is not automatable. Never throws.
 */
export function decodeProgress(raw: unknown): DecodedProgress {
  const dropped: string[] = [];
  const base = emptyProgress();
  if (!isRecord(raw)) return { progress: base, dropped };

  const sources: Partial<Record<OnboardingSourceId, SourceProgress>> = {};
  if (isRecord(raw["sources"])) {
    for (const [id, v] of Object.entries(raw["sources"])) {
      if (!isOnboardingSourceId(id) || !isRecord(v)) {
        dropped.push(`sources.${id}`);
        continue;
      }
      let mode: SourceMode = v["mode"] === "automate" ? "automate" : "manual";
      if (mode === "automate" && !isAutomatable(id)) {
        mode = "manual";
        dropped.push(`sources.${id}.mode:automate`);
      }
      sources[id] = { chosen: v["chosen"] === true, mode };
    }
  }

  const planValues: Record<PlanValueKey, string> = { ...base.planValues };
  if (isRecord(raw["planValues"])) {
    for (const [k, v] of Object.entries(raw["planValues"])) {
      const s = str(v);
      if (!isPlanValueKey(k) || s === null) {
        dropped.push(`planValues.${k}`);
        continue;
      }
      const clean = sanitizePlanValue(s);
      if (clean !== s) dropped.push(`planValues.${k}:credential`);
      planValues[k] = clean;
    }
  }

  const ticks: Record<string, StepTick> = {};
  if (isRecord(raw["ticks"])) {
    for (const [id, v] of Object.entries(raw["ticks"])) {
      const fingerprint = isRecord(v) ? str(v["fingerprint"]) : null;
      if (!isRecord(v) || fingerprint === null || !isRecord(v["values"])) {
        dropped.push(`ticks.${id}`);
        continue;
      }
      const values: Partial<Record<PlanValueKey, string>> = {};
      for (const [k, tv] of Object.entries(v["values"])) {
        const s = str(tv);
        if (isPlanValueKey(k) && s !== null) values[k] = sanitizePlanValue(s);
        else dropped.push(`ticks.${id}.values.${k}`);
      }
      ticks[id] = { fingerprint, values };
    }
  }

  const criblSources: Partial<Record<OnboardingSourceId, CriblSourceRecord>> = {};
  if (isRecord(raw["criblSources"])) {
    for (const [id, v] of Object.entries(raw["criblSources"])) {
      const ok =
        isOnboardingSourceId(id) &&
        isRecord(v) &&
        str(v["groupId"]) !== null &&
        str(v["inputId"]) !== null &&
        str(v["secretId"]) !== null &&
        (v["inputType"] === "eventhub" || v["inputType"] === "azure_blob");
      if (!ok) {
        dropped.push(`criblSources.${id}`);
        continue;
      }
      const r = v as Record<string, string>;
      criblSources[id as OnboardingSourceId] = {
        groupId: r["groupId"],
        inputId: r["inputId"],
        inputType: r["inputType"] as CriblInputType,
        secretId: r["secretId"],
      };
    }
  }

  const workerGroup = str(raw["workerGroup"]);

  const criblLakeRoutes: Partial<Record<OnboardingSourceId, LakeRouteRecord>> = {};
  if (isRecord(raw["criblLakeRoutes"])) {
    for (const [id, v] of Object.entries(raw["criblLakeRoutes"])) {
      const nullableStr = (x: unknown): x is string | null => x === null || typeof x === "string";
      const ok =
        isOnboardingSourceId(id) &&
        isRecord(v) &&
        str(v["groupId"]) !== null &&
        str(v["datasetId"]) !== null &&
        nullableStr(v["pipelineId"]) &&
        nullableStr(v["routeId"]);
      if (!ok) {
        dropped.push(`criblLakeRoutes.${id}`);
        continue;
      }
      criblLakeRoutes[id as OnboardingSourceId] = {
        groupId: v["groupId"] as string,
        datasetId: v["datasetId"] as string,
        pipelineId: v["pipelineId"] as string | null,
        routeId: v["routeId"] as string | null,
        // Only a literal true counts: anything else is "not created by the app".
        ...(v["datasetCreated"] === true ? { datasetCreated: true as const } : {}),
      };
    }
  }

  const activityLogSettings: ActivityLogSettingRecord[] = [];
  if (Array.isArray(raw["activityLogSettings"])) {
    raw["activityLogSettings"].forEach((v, i) => {
      const ok =
        isRecord(v) &&
        str(v["subscriptionId"]) !== null &&
        str(v["settingName"]) !== null &&
        str(v["ruleId"]) !== null &&
        !activityLogSettings.some((r) => r.subscriptionId.toLowerCase() === String(v["subscriptionId"]).toLowerCase());
      if (!ok) {
        dropped.push(`activityLogSettings[${i}]`);
        return;
      }
      activityLogSettings.push({
        subscriptionId: v["subscriptionId"] as string,
        settingName: v["settingName"] as string,
        ruleId: v["ruleId"] as string,
      });
    });
  } else if (raw["activityLogSettings"] !== undefined) {
    dropped.push("activityLogSettings");
  }

  for (const k of Object.keys(raw)) {
    if (
      ![
        "kind",
        "version",
        "sources",
        "planValues",
        "ticks",
        "criblSources",
        "workerGroup",
        "criblLakeRoutes",
        "activityLogSettings",
      ].includes(k)
    ) {
      dropped.push(k);
    }
  }

  return {
    progress: {
      sources,
      planValues,
      ticks,
      criblSources,
      workerGroup,
      ...(Object.keys(criblLakeRoutes).length > 0 ? { criblLakeRoutes } : {}),
      ...(activityLogSettings.length > 0 ? { activityLogSettings } : {}),
    },
    dropped,
  };
}

/**
 * What the progress KV read means.
 *
 *   absent        nothing of ours is stored (not found, empty, corrupt, or an
 *                 object with neither kind nor version); start empty, writes OK
 *   ok            ours and readable; writes OK
 *   foreign       `kind` present and not ours; writes blocked
 *   unreadable    ours but `version` is not exactly 1; writes blocked
 *   read-unknown  the read failed (403, 5xx, timeout); writes blocked
 */
export type ProgressDocument =
  | { readonly status: "absent"; readonly progress: OnboardingProgress }
  | { readonly status: "ok"; readonly decoded: DecodedProgress }
  | { readonly status: "foreign"; readonly kind: unknown }
  | { readonly status: "unreadable"; readonly version: unknown }
  | { readonly status: "read-unknown"; readonly reason: string };

/** Classify the port's answer, decoding only a readable document of ours. Never throws. */
export function readProgressDocument(load: KvDocumentLoad): ProgressDocument {
  if (load.kind === "unknown") return { status: "read-unknown", reason: load.reason };
  if (load.kind === "absent") return { status: "absent", progress: emptyProgress() };
  let parsed: unknown = load.value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { status: "absent", progress: emptyProgress() };
    }
  }
  if (!isRecord(parsed)) return { status: "absent", progress: emptyProgress() };
  if ("kind" in parsed && parsed["kind"] !== ONBOARDING_PROGRESS_KIND) {
    return { status: "foreign", kind: parsed["kind"] };
  }
  if (!("kind" in parsed) && !("version" in parsed)) {
    return { status: "absent", progress: emptyProgress() };
  }
  if (parsed["version"] !== ONBOARDING_PROGRESS_VERSION) {
    return { status: "unreadable", version: parsed["version"] };
  }
  return { status: "ok", decoded: decodeProgress(parsed) };
}

/** Whether a write is allowed after this read. */
export function canWriteProgressDocument(doc: ProgressDocument): boolean {
  return doc.status === "absent" || doc.status === "ok";
}

/** The progress to show, or null when the read blocks writes. */
export function progressFrom(doc: ProgressDocument): OnboardingProgress | null {
  if (doc.status === "absent") return doc.progress;
  if (doc.status === "ok") return doc.decoded.progress;
  return null;
}

// ---------------------------------------------------------------------------
// Transitions (pure: each returns a new progress)
// ---------------------------------------------------------------------------

function sourceOf(p: OnboardingProgress, id: OnboardingSourceId): SourceProgress {
  return p.sources[id] ?? { chosen: false, mode: "manual" };
}

/** Choose or unchoose a source. */
export function withSourceChosen(
  p: OnboardingProgress,
  id: OnboardingSourceId,
  chosen: boolean,
): OnboardingProgress {
  return { ...p, sources: { ...p.sources, [id]: { ...sourceOf(p, id), chosen } } };
}

/** Set a source's mode. `automate` on a non-automatable source is refused: it stays `manual`. */
export function withSourceMode(
  p: OnboardingProgress,
  id: OnboardingSourceId,
  mode: SourceMode,
): OnboardingProgress {
  const effective: SourceMode = mode === "automate" && isAutomatable(id) ? "automate" : "manual";
  return { ...p, sources: { ...p.sources, [id]: { ...sourceOf(p, id), mode: effective } } };
}

/** Replace the plan values (the form's Apply). Credential-looking values are blanked. */
export function withPlanValues(p: OnboardingProgress, values: PlanValues): OnboardingProgress {
  const clean = Object.fromEntries(
    PLAN_VALUE_KEYS.map((k) => [k, sanitizePlanValue(values[k] ?? "")]),
  ) as Record<PlanValueKey, string>;
  return { ...p, planValues: clean };
}

/** Tick a step done against the CURRENT plan values of the keys it depends on. */
export function withTick(
  p: OnboardingProgress,
  stepId: string,
  dependsOnValues: readonly PlanValueKey[],
): OnboardingProgress {
  const values: Partial<Record<PlanValueKey, string>> = {};
  for (const k of [...new Set(dependsOnValues)].sort()) values[k] = p.planValues[k];
  const tick: StepTick = { fingerprint: planFingerprint(p.planValues, dependsOnValues), values };
  return { ...p, ticks: { ...p.ticks, [stepId]: tick } };
}

/** Untick a step. */
export function withoutTick(p: OnboardingProgress, stepId: string): OnboardingProgress {
  const ticks = { ...p.ticks };
  delete ticks[stepId];
  return { ...p, ticks };
}

/** Record what the app created in Cribl for a source. */
export function withCriblSource(
  p: OnboardingProgress,
  id: OnboardingSourceId,
  record: CriblSourceRecord,
): OnboardingProgress {
  return { ...p, criblSources: { ...p.criblSources, [id]: record } };
}

/** A Cribl source record found in the legacy unscoped document but not in the tenant's own (AZR-96). */
export interface StrandedCriblSource {
  readonly sourceId: OnboardingSourceId;
  readonly record: CriblSourceRecord;
}

/**
 * The Cribl source records a legacy unscoped progress document holds that the
 * tenant's current progress does not (AZR-96): the source id is missing from
 * `current.criblSources`, or it is there with a different input id or worker
 * group. A record
 * an earlier app version wrote to the legacy key after the tenant's own
 * document existed is otherwise never read again.
 *
 * REPORT ONLY. Nothing here merges the records into `current`; the caller
 * shows them and leaves them where they are.
 *
 * The legacy body is classified with {@link readProgressDocument} first, so a
 * body that is not ours (a migration marker, a foreign kind) or a version this
 * release cannot read yields no records rather than an empty decode posing as
 * one. Never throws.
 */
export function strandedCriblSources(current: OnboardingProgress, legacyRaw: unknown): readonly StrandedCriblSource[] {
  const doc = readProgressDocument({ kind: "value", value: legacyRaw });
  if (doc.status !== "ok") return [];
  const out: StrandedCriblSource[] = [];
  for (const s of ONBOARDING_SOURCES) {
    const record = doc.decoded.progress.criblSources[s.id];
    if (record === undefined) continue;
    const mine = current.criblSources[s.id];
    // Input ids are unique only within a worker group, so the group decides too.
    if (mine === undefined || mine.inputId !== record.inputId || mine.groupId !== record.groupId) out.push({ sourceId: s.id, record });
  }
  return out;
}

/**
 * Record what the app created to route a source to Cribl Lake (AZR-35).
 *
 * KEEPS THE PROOF OF A DATASET THE APP CREATED (AZR-105). A second apply
 * after one that created the dataset finds it present and reports it as
 * "existed"; replacing the record whole would then forget that the app made
 * it, and a later Remove could never delete it. So `datasetCreated` carries
 * over from the earlier record when the group and the dataset are the same.
 */
export function withLakeRoute(
  p: OnboardingProgress,
  id: OnboardingSourceId,
  record: LakeRouteRecord,
): OnboardingProgress {
  const prev = p.criblLakeRoutes?.[id];
  const keepCreated =
    record.datasetCreated !== true &&
    prev?.datasetCreated === true &&
    prev.groupId === record.groupId &&
    prev.datasetId === record.datasetId;
  const next: LakeRouteRecord = keepCreated ? { ...record, datasetCreated: true } : record;
  return { ...p, criblLakeRoutes: { ...(p.criblLakeRoutes ?? {}), [id]: next } };
}

/**
 * Forget a source's Cribl source record (AZR-105), after a teardown removed
 * the input and its secret (or found them already gone).
 */
export function withoutCriblSource(p: OnboardingProgress, id: OnboardingSourceId): OnboardingProgress {
  const criblSources = { ...p.criblSources };
  delete criblSources[id];
  return { ...p, criblSources };
}

/**
 * Replace (or, with null, forget) a source's Lake route record after a
 * teardown (AZR-105). Unlike {@link withLakeRoute} nothing carries over: the
 * teardown computed exactly what is still there.
 */
export function withLakeRouteAfterTeardown(
  p: OnboardingProgress,
  id: OnboardingSourceId,
  record: LakeRouteRecord | null,
): OnboardingProgress {
  const criblLakeRoutes = { ...(p.criblLakeRoutes ?? {}) };
  if (record === null) delete criblLakeRoutes[id];
  else criblLakeRoutes[id] = record;
  const { criblLakeRoutes: _drop, ...rest } = p;
  return Object.keys(criblLakeRoutes).length > 0 ? { ...rest, criblLakeRoutes } : rest;
}

function sameSubscription(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The Activity Log setting record for a subscription, or null (AZR-105). */
export function activityLogSettingRecord(p: OnboardingProgress, subscriptionId: string): ActivityLogSettingRecord | null {
  return (p.activityLogSettings ?? []).find((r) => sameSubscription(r.subscriptionId, subscriptionId)) ?? null;
}

/** Record the Activity Log setting the app wrote on a subscription, replacing an earlier record for it (AZR-105). */
export function withActivityLogSetting(p: OnboardingProgress, record: ActivityLogSettingRecord): OnboardingProgress {
  const others = (p.activityLogSettings ?? []).filter((r) => !sameSubscription(r.subscriptionId, record.subscriptionId));
  return { ...p, activityLogSettings: [...others, record] };
}

/** Forget the Activity Log setting record of a subscription (AZR-105), after it was removed or found gone. */
export function withoutActivityLogSetting(p: OnboardingProgress, subscriptionId: string): OnboardingProgress {
  const left = (p.activityLogSettings ?? []).filter((r) => !sameSubscription(r.subscriptionId, subscriptionId));
  const { activityLogSettings: _drop, ...rest } = p;
  return left.length > 0 ? { ...rest, activityLogSettings: left } : rest;
}

/** Remember the worker group the operator picked. */
export function withWorkerGroup(p: OnboardingProgress, groupId: string | null): OnboardingProgress {
  return { ...p, workerGroup: groupId };
}

/**
 * Whether a step counts as done (D5).
 *
 *   not-done  never ticked
 *   done      ticked, and the values it depends on are unchanged
 *   stale     ticked against older values; `changedKeys` names them. Does NOT
 *             count as done.
 */
export type TickState =
  | { readonly status: "not-done" }
  | { readonly status: "done" }
  | { readonly status: "stale"; readonly changedKeys: readonly PlanValueKey[] };

export function tickState(
  p: OnboardingProgress,
  stepId: string,
  dependsOnValues: readonly PlanValueKey[],
): TickState {
  const tick = p.ticks[stepId];
  if (tick === undefined) return { status: "not-done" };
  if (tick.fingerprint === planFingerprint(p.planValues, dependsOnValues)) {
    return { status: "done" };
  }
  const changedKeys = changedValueKeys(tick.values, p.planValues, [...new Set(dependsOnValues)].sort());
  // A fingerprint mismatch with no named key means the step's dependency list
  // itself changed; every listed key is then reported rather than none.
  return {
    status: "stale",
    changedKeys: changedKeys.length > 0 ? changedKeys : [...new Set(dependsOnValues)].sort(),
  };
}
