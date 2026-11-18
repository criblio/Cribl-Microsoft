/**
 * Remove (and pause) what the Azure Native Source Onboarding screen created -
 * PURE planning (AZR-105).
 *
 * THE HOUSE RULE (claude-kit cribl-config-writes rule 11): delete only what the
 * app can PROVE it created, and in an order the server accepts. Proof is the
 * kit's three signals (kit/config-writes/ownership.ts proveOwnership): the id
 * is one this feature's manifest declares, the description carries the app's
 * stamp, and the app's own KV record (the onboarding progress document) says
 * it wrote that object. Any one alone has been wrong. There is no uninstall
 * hook on the App Platform, so Remove and Pause are in-app actions.
 *
 * WHAT A SOURCE OWNS, and the order it goes in (referrers before what they
 * reference, the kit's teardownOrder):
 *
 *   1. route     the Lake route (AZR-35) - it names the pipeline, the dataset
 *                and (in its filter) the input
 *   2. pipeline  the shared unroll pipeline - only when no route left in the
 *                table, no input, and no OTHER source's recorded Lake route
 *                uses it
 *   3. input     the Cribl Event Hubs / Blob source (AZR-34) - only when no
 *                route left in the table names it in its filter
 *   4. secret    the input's text secret - only when no input left names it
 *   5. dataset   the Lake dataset - ONLY ON EXPLICIT OPT-IN, because it holds
 *                data, and only when the app's record says the app CREATED it
 *                (an existing dataset it merely used is never the app's). It
 *                is a leader object outside the group commit, so the usecase
 *                deletes it after the group change is deployed.
 *
 * Every candidate gets exactly one verdict:
 *
 *   delete        proven ours and nothing that stays refers to it
 *   already-gone  not there: success, nothing to send
 *   keep          with a reason: not-proven (names the missing signal),
 *                 in-use (names what still refers to it), opt-in-off (the
 *                 dataset), unreadable (the read it needs was refused; a 401
 *                 or 403 is flagged `denied` and said as a permission refusal)
 *
 * NOT CHECKED: a destination's post-processing pipeline naming the unroll
 * pipeline (destinations are not read here). The pipeline is the app's own,
 * stamped, created for its routes alone; Cribl's answer to the DELETE is
 * reported as it comes.
 *
 * The Activity Log diagnostic setting (AZR-98) is an Azure object with no
 * description or tags. Its proof is the manifest name, the app's KV record
 * for the subscription, and - in place of a description stamp - the rule id
 * the record says the app wrote: a setting under the app's name that now
 * sends with another rule is not provably the app's ({@link classifyActivityLogRemoval}).
 *
 * PAUSE. A Cribl input has `disabled`; pausing sets it true, resuming false,
 * through the kit's read-modify-write. Nothing else is paused: a route,
 * pipeline or dataset carries nothing once its input stops, a secret is inert,
 * and a diagnostic setting has no switch of its own (turning its categories
 * off is a re-PUT that replaces the setting, which the app does not do) - so
 * the Activity Log setting is removed, never paused.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import { proveOwnership, teardownOrder } from "../../kit/config-writes/ownership";
import { readProp } from "../cribl-api/envelope";
import { APP_ID } from "../cribl-secrets/secret-body";
import { findSecretRecord } from "../cribl-secrets/secret-record";
import { isOnboardingInputId, isOnboardingSecretId } from "../cribl-onboarding-source/input-bodies";
import {
  LAKE_ROUTE_SOURCES,
  UNROLL_PIPELINE_ID,
  isLakeRouteSource,
  lakeOutputFor,
} from "../onboarding-lake-route/lake-route";
import type {
  ActivityLogSettingRecord,
  CriblSourceRecord,
  EntraSettingRecord,
  LakeRouteRecord,
} from "../onboarding-howto/progress-document";
import type { OnboardingSourceId } from "../onboarding-howto/sources";
import { ACTIVITY_LOG_SETTING_NAME } from "../activity-log-export/activity-log-setting";
import { ENTRA_SETTING_NAME } from "../entra-diagnostics/entra-setting-deploy";
import type { DiagnosticSettingRead } from "../activity-log-export/diagnostic-setting";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One Cribl read a teardown depends on: its items, or why there are none.
 * `status` is the HTTP status of a refusal (0 for no answer), so a 401/403 can
 * be said as a permission refusal rather than an outage.
 */
export type TeardownRead =
  | { readonly state: "read"; readonly items: readonly unknown[] }
  | { readonly state: "refused"; readonly status: number; readonly detail: string };

/**
 * What a teardown reads. `inputs` (GET /system/inputs) and `routes` (the
 * routing table's `routes` array) are always read: nearly every verdict
 * depends on what still refers to an object. The others are read only when
 * there is a candidate for them ({@link teardownReadsNeeded}); null = not read.
 */
export interface CriblTeardownReads {
  readonly inputs: TeardownRead;
  readonly routes: TeardownRead;
  /** GET /system/secrets/:id (a 404 is a read with no items). */
  readonly secret: TeardownRead | null;
  /** GET /pipelines. */
  readonly pipelines: TeardownRead | null;
  /** GET /products/lake/lakes/default/datasets (leader). */
  readonly datasets: TeardownRead | null;
  /**
   * GET /system/outputs of the teardown group: destinations, whose
   * post-processing pipeline, secrets and cribl_lake dataset can name an object
   * the app would delete. Absent (older callers) reads as not read.
   */
  readonly outputs?: TeardownRead | null;
  /** GET /jobs of the teardown group: collectors, which can name a pipeline or a secret. */
  readonly jobs?: TeardownRead | null;
  /**
   * The routes and destinations of EVERY OTHER worker group the app can see,
   * for the Lake dataset (a leader object any group can send to). Refused when
   * the groups, or any one group's routes or destinations, could not be read.
   */
  readonly otherGroups?: OtherGroupsRead | null;
}

/** One other group's routes array and destinations. */
export interface OtherGroupRead {
  readonly groupId: string;
  readonly routes: readonly unknown[];
  readonly outputs: readonly unknown[];
}

export type OtherGroupsRead =
  | { readonly state: "read"; readonly groups: readonly OtherGroupRead[] }
  | { readonly state: "refused"; readonly status: number; readonly detail: string };

/** Whether a refused read was a permission refusal. */
export function isDenied(status: number): boolean {
  return status === 401 || status === 403;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type TeardownObjectKind = "route" | "pipeline" | "input" | "secret" | "dataset";

export type TeardownKeepReason = "not-proven" | "in-use" | "opt-in-off" | "unreadable";

export type TeardownVerdict =
  | { readonly kind: "delete" }
  | { readonly kind: "already-gone" }
  | {
      readonly kind: "keep";
      readonly reason: TeardownKeepReason;
      readonly detail: string;
      /** Set on `unreadable` when the read was refused with 401 or 403. */
      readonly denied?: true;
    };

export interface TeardownStep {
  readonly kind: TeardownObjectKind;
  readonly id: string;
  readonly verdict: TeardownVerdict;
}

/** Another source's Lake route record: the shared pipeline stays while one still uses it. */
export interface OtherLakeRoute {
  readonly sourceId: OnboardingSourceId;
  readonly record: LakeRouteRecord;
}

export interface CriblTeardownInput {
  readonly sourceId: OnboardingSourceId;
  /** progress.criblSources[sourceId]. */
  readonly criblSource: CriblSourceRecord | null;
  /** progress.criblLakeRoutes[sourceId]. */
  readonly lakeRoute: LakeRouteRecord | null;
  /** Every OTHER source's Lake route record. */
  readonly otherLakeRoutes: readonly OtherLakeRoute[];
  /** The operator's explicit opt-in to delete the Lake dataset (it holds data). */
  readonly removeDataset: boolean;
}

export type CriblTeardownRefusalReason =
  | "nothing-recorded"
  | "groups-differ"
  | "inputs-unreadable"
  | "routes-unreadable";

export type CriblTeardownPlan =
  | {
      readonly kind: "plan";
      readonly groupId: string;
      /**
       * Every candidate, in execution order: the group objects in the kit's
       * teardownOrder (route, pipeline, input, secret), then the leader's
       * dataset, which goes only after the group change is deployed.
       */
      readonly steps: readonly TeardownStep[];
    }
  | {
      readonly kind: "refused";
      readonly reason: CriblTeardownRefusalReason;
      readonly detail: string;
      readonly denied?: true;
    };

/** The worker group a source's records name, or why they cannot be torn down together. */
export function teardownGroup(
  input: Pick<CriblTeardownInput, "criblSource" | "lakeRoute">,
): { readonly groupId: string } | { readonly refused: CriblTeardownRefusalReason; readonly detail: string } {
  const a = input.criblSource?.groupId ?? null;
  const b = input.lakeRoute?.groupId ?? null;
  if (a === null && b === null) {
    return { refused: "nothing-recorded", detail: "This app has no record of creating anything in Cribl for this source, so there is nothing it can remove." };
  }
  if (a !== null && b !== null && a !== b) {
    return {
      refused: "groups-differ",
      detail: `This app's records name two worker groups for this source (the source in ${a}, the Lake route in ${b}). Nothing was changed; remove them in Cribl.`,
    };
  }
  return { groupId: (a ?? b) as string };
}

/** Which optional reads a plan needs for this source's records. */
export function teardownReadsNeeded(input: CriblTeardownInput): {
  readonly secret: boolean;
  readonly pipelines: boolean;
  readonly datasets: boolean;
  readonly outputs: boolean;
  readonly jobs: boolean;
  readonly otherGroups: boolean;
} {
  const secret = input.criblSource !== null;
  const pipelines = input.lakeRoute !== null && input.lakeRoute.pipelineId !== null;
  const datasets = input.lakeRoute !== null && input.removeDataset;
  return { secret, pipelines, datasets, outputs: secret || pipelines || datasets, jobs: secret || pipelines, otherGroups: datasets };
}

/** What the in-use checks read, said in the confirm so the operator knows what was looked at. */
export const IN_USE_CHECKED = {
  pipeline: "every route, source (QuickConnect connections included), destination and collector in the worker group, and this app's other recorded routes",
  secret: "every source, destination and collector in the worker group",
  input: "every route filter in the worker group",
  dataset: "every route and Cribl Lake destination in every worker group this app can read",
} as const;

/**
 * Who among `lists` names `needle` anywhere in its config (canonical JSON, so
 * any field: a QuickConnect connection's pipeline, a destination's
 * post-processing pipeline, a collector's secret). A list that was not read
 * makes the answer unknown: the object is kept rather than deleted on partial
 * knowledge.
 */
function namedBy(
  needle: string,
  lists: readonly { readonly label: string; readonly read: TeardownRead | null | undefined; readonly skipId?: string }[],
): { readonly users: string[] } | { readonly unread: Extract<TeardownRead, { state: "refused" }> | null; readonly what: string } {
  const quoted = JSON.stringify(needle);
  const users: string[] = [];
  for (const l of lists) {
    if (l.read === null || l.read === undefined) return { unread: null, what: `The ${l.label}s` };
    if (l.read.state === "refused") return { unread: l.read, what: `The ${l.label}s` };
    for (const it of l.read.items) {
      if (!isRecord(it)) continue;
      if (l.skipId !== undefined && it["id"] === l.skipId) continue;
      if (canonical(it).includes(quoted)) users.push(`${l.label} ${String(it["id"])}`);
    }
  }
  return { users };
}

function cannotCheck(object: string, what: string, read: Extract<TeardownRead, { state: "refused" }> | null): TeardownVerdict {
  if (read === null) return { kind: "keep", reason: "unreadable", detail: `${what} were not read, so whether anything still uses ${object} is unknown. It was kept.` };
  const denied = isDenied(read.status);
  return {
    kind: "keep",
    reason: "unreadable",
    detail: denied
      ? `${what} could not be read: Cribl refused it (HTTP ${read.status}), so whether anything still uses ${object} is unknown. It was kept.`
      : `${what} could not be read (${read.detail}), so whether anything still uses ${object} is unknown. It was kept.`,
    ...(denied ? { denied: true as const } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function findItem(items: readonly unknown[], id: string): Record<string, unknown> | null {
  for (const it of items) if (isRecord(it) && it["id"] === id) return it;
  return null;
}

/** JSON with object keys sorted, so a reference is found wherever it sits. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function unreadable(what: string, read: Extract<TeardownRead, { state: "refused" }>): TeardownVerdict {
  const denied = isDenied(read.status);
  return {
    kind: "keep",
    reason: "unreadable",
    detail: denied
      ? `${what} could not be read: Cribl refused it (HTTP ${read.status}), so this account may lack the permission. It was kept.`
      : `${what} could not be read (${read.detail}). It was kept.`,
    ...(denied ? { denied: true as const } : {}),
  };
}

function notProven(missing: readonly string[]): TeardownVerdict {
  return {
    kind: "keep",
    reason: "not-proven",
    detail: `This app cannot prove it created it (${missing.join("; ")}), so it was kept. Remove it in Cribl if it should go.`,
  };
}

function inUse(by: readonly string[]): TeardownVerdict {
  return { kind: "keep", reason: "in-use", detail: `Still used by ${by.join(", ")}, so it was kept.` };
}

/** A route row's id, or a placeholder for one without. */
function routeName(r: Record<string, unknown>): string {
  return typeof r["id"] === "string" && r["id"] !== "" ? `route ${r["id"]}` : "a route without an id";
}

/** Whether a route row sends to the dataset (`cribl_lake:<id>` as its output, or anywhere in it). */
function routeSendsTo(r: unknown, datasetId: string): boolean {
  return isRecord(r) && canonical(r).includes(JSON.stringify(lakeOutputFor(datasetId)).slice(0, -1));
}

/** Whether a destination is a Cribl Lake destination naming the dataset. */
function outputSendsTo(o: unknown, datasetId: string): boolean {
  return isRecord(o) && o["type"] === "cribl_lake" && canonical(o).includes(JSON.stringify(datasetId));
}

/**
 * Who sends to the Lake dataset: the teardown group's staying routes and its
 * Cribl Lake destinations, then every other worker group's. Unknown (the
 * dataset is kept) when any of those could not be read.
 */
function datasetUsers(
  datasetId: string,
  groupId: string,
  staying: readonly Record<string, unknown>[],
  reads: CriblTeardownReads,
): { readonly users: string[] } | { readonly unread: TeardownVerdict } {
  const object = `Cribl Lake dataset ${datasetId}`;
  const own = reads.outputs;
  if (own === null || own === undefined) return { unread: cannotCheck(object, `Worker group ${groupId}'s destinations`, null) };
  if (own.state === "refused") return { unread: cannotCheck(object, `Worker group ${groupId}'s destinations`, own) };
  const others = reads.otherGroups;
  if (others === null || others === undefined) return { unread: cannotCheck(object, "The other worker groups' routes and destinations", null) };
  if (others.state === "refused") return { unread: cannotCheck(object, "The other worker groups' routes and destinations", others) };
  const users = [
    ...staying.filter((r) => routeSendsTo(r, datasetId)).map((r) => `${routeName(r)} in ${groupId}`),
    ...own.items.filter((o) => outputSendsTo(o, datasetId)).map((o) => `destination ${String((o as Record<string, unknown>)["id"])} in ${groupId}`),
  ];
  for (const g of others.groups) {
    if (g.groupId === groupId) continue;
    for (const r of g.routes) if (routeSendsTo(r, datasetId)) users.push(`${routeName(r as Record<string, unknown>)} in ${g.groupId}`);
    for (const o of g.outputs) if (outputSendsTo(o, datasetId)) users.push(`destination ${String((o as Record<string, unknown>)["id"])} in ${g.groupId}`);
  }
  return { users };
}

/**
 * Plan the Cribl side of one source's teardown. Every candidate comes from the
 * app's own records; nothing found only by searching Cribl is ever a candidate.
 */
export function planCriblTeardown(input: CriblTeardownInput, reads: CriblTeardownReads): CriblTeardownPlan {
  const group = teardownGroup(input);
  if ("refused" in group) return { kind: "refused", reason: group.refused, detail: group.detail };
  const { groupId } = group;
  if (reads.inputs.state === "refused") {
    const denied = isDenied(reads.inputs.status);
    return {
      kind: "refused",
      reason: "inputs-unreadable",
      detail: `The worker group's sources could not be read (${reads.inputs.detail}), so what still uses each object is unknown. Nothing was changed.`,
      ...(denied ? { denied: true as const } : {}),
    };
  }
  if (reads.routes.state === "refused") {
    const denied = isDenied(reads.routes.status);
    return {
      kind: "refused",
      reason: "routes-unreadable",
      detail: `The routing table could not be read (${reads.routes.detail}), so what still uses each object is unknown. Nothing was changed.`,
      ...(denied ? { denied: true as const } : {}),
    };
  }
  const inputs = reads.inputs.items;
  const routes = reads.routes.items.filter(isRecord);
  const lake = input.lakeRoute;
  const src = input.criblSource;
  const verdicts = new Map<TeardownObjectKind, TeardownStep>();

  // 1. The route.
  const routeId = lake?.routeId ?? null;
  if (routeId !== null) {
    const found = findItem(routes, routeId);
    let verdict: TeardownVerdict;
    if (found === null) verdict = { kind: "already-gone" };
    else {
      const proof = proveOwnership(APP_ID, {
        manifestIds: isLakeRouteSource(input.sourceId) ? new Set([LAKE_ROUTE_SOURCES[input.sourceId].routeId]) : new Set<string>(),
        object: { id: routeId, description: found["description"] },
        recordedWrite: true,
      });
      verdict = proof.mine ? { kind: "delete" } : notProven(proof.missing);
    }
    verdicts.set("route", { kind: "route", id: routeId, verdict });
  }
  const routeGoes = (verdicts.get("route")?.verdict.kind ?? "already-gone") !== "keep";
  // The routes that stay: every row except ours when ours goes.
  const staying = routes.filter((r) => !(routeGoes && routeId !== null && r["id"] === routeId));

  // 2. The pipeline.
  const pipelineId = lake?.pipelineId ?? null;
  if (pipelineId !== null) {
    let verdict: TeardownVerdict;
    const read = reads.pipelines;
    if (read === null) verdict = { kind: "keep", reason: "unreadable", detail: "The pipelines were not read. It was kept." };
    else if (read.state === "refused") verdict = unreadable(`Pipeline ${pipelineId}`, read);
    else {
      const found = findItem(read.items, pipelineId);
      if (found === null) verdict = { kind: "already-gone" };
      else {
        const proof = proveOwnership(APP_ID, {
          manifestIds: new Set([UNROLL_PIPELINE_ID]),
          object: { id: pipelineId, description: readProp(readProp(found, "conf"), "description") },
          recordedWrite: true,
        });
        if (!proof.mine) verdict = notProven(proof.missing);
        else {
          // Sources (pre-processing pipeline and QuickConnect connections),
          // destinations (post-processing pipeline) and collectors, anywhere
          // in their config.
          const named = namedBy(pipelineId, [
            { label: "source", read: reads.inputs },
            { label: "destination", read: reads.outputs },
            { label: "collector", read: reads.jobs },
          ]);
          if ("unread" in named) verdict = cannotCheck(`pipeline ${pipelineId}`, named.what, named.unread);
          else {
            const users = [
              ...staying.filter((r) => r["pipeline"] === pipelineId).map(routeName),
              ...named.users,
              ...input.otherLakeRoutes
                .filter((o) => o.record.groupId === groupId && o.record.pipelineId === pipelineId && o.record.routeId !== null)
                .map((o) => `this app's recorded route ${o.record.routeId as string} (${o.sourceId})`),
            ];
            verdict = users.length > 0 ? inUse([...new Set(users)]) : { kind: "delete" };
          }
        }
      }
    }
    verdicts.set("pipeline", { kind: "pipeline", id: pipelineId, verdict });
  }

  // 3. The input.
  if (src !== null) {
    const found = findItem(inputs, src.inputId);
    let verdict: TeardownVerdict;
    if (found === null) verdict = { kind: "already-gone" };
    else {
      const proof = proveOwnership(APP_ID, {
        manifestIds: isOnboardingInputId(src.inputId) ? new Set([src.inputId]) : new Set<string>(),
        object: { id: src.inputId, description: found["description"] },
        recordedWrite: found["type"] === src.inputType,
      });
      if (!proof.mine) verdict = notProven(proof.missing);
      else {
        // A text match: a filter that names the input id in any form keeps it.
        const users = staying.filter((r) => typeof r["filter"] === "string" && r["filter"].includes(src.inputId)).map(routeName);
        verdict = users.length > 0 ? inUse(users) : { kind: "delete" };
      }
    }
    verdicts.set("input", { kind: "input", id: src.inputId, verdict });
  }
  const inputGoes = (verdicts.get("input")?.verdict.kind ?? "already-gone") !== "keep";

  // 4. The secret.
  if (src !== null) {
    let verdict: TeardownVerdict;
    const read = reads.secret;
    if (read === null) verdict = { kind: "keep", reason: "unreadable", detail: "The secret was not read. It was kept." };
    else if (read.state === "refused") verdict = unreadable(`Secret ${src.secretId}`, read);
    else {
      const lookup = findSecretRecord(read.items, src.secretId);
      if (lookup.kind === "malformed") {
        verdict = { kind: "keep", reason: "unreadable", detail: `Secret ${src.secretId} could not be read (the secret read ${lookup.detail}). It was kept.` };
      } else if (lookup.kind === "missing") verdict = { kind: "already-gone" };
      else {
        const proof = proveOwnership(APP_ID, {
          manifestIds: isOnboardingSecretId(src.secretId) ? new Set([src.secretId]) : new Set<string>(),
          object: { id: src.secretId, description: lookup.record["description"] },
          recordedWrite: true,
        });
        if (!proof.mine) verdict = notProven(proof.missing);
        else {
          const named = namedBy(src.secretId, [
            { label: "source", read: reads.inputs, ...(inputGoes ? { skipId: src.inputId } : {}) },
            { label: "destination", read: reads.outputs },
            { label: "collector", read: reads.jobs },
          ]);
          if ("unread" in named) verdict = cannotCheck(`secret ${src.secretId}`, named.what, named.unread);
          else verdict = named.users.length > 0 ? inUse(named.users) : { kind: "delete" };
        }
      }
    }
    verdicts.set("secret", { kind: "secret", id: src.secretId, verdict });
  }

  // 5. The dataset: opt-in only, and only one the app created.
  if (lake !== null) {
    const datasetId = lake.datasetId;
    let verdict: TeardownVerdict;
    if (!input.removeDataset) {
      verdict = {
        kind: "keep",
        reason: "opt-in-off",
        detail: "Kept: it holds the data already stored. Tick the option to delete it as well.",
      };
    } else if (lake.datasetCreated !== true) {
      verdict = notProven(["this app has no record of creating it (it may have existed before, or been recorded by an earlier version)"]);
    } else if (reads.datasets === null) {
      verdict = { kind: "keep", reason: "unreadable", detail: "The Lake datasets were not read. It was kept." };
    } else if (reads.datasets.state === "refused") {
      verdict = unreadable(`Cribl Lake dataset ${datasetId}`, reads.datasets);
    } else {
      const found = findItem(reads.datasets.items, datasetId);
      if (found === null) verdict = { kind: "already-gone" };
      else {
        const proof = proveOwnership(APP_ID, {
          manifestIds: isLakeRouteSource(input.sourceId) ? new Set([LAKE_ROUTE_SOURCES[input.sourceId].datasetId]) : new Set<string>(),
          object: { id: datasetId, description: found["description"] },
          recordedWrite: true,
        });
        if (!proof.mine) verdict = notProven(proof.missing);
        else {
          // A leader object: any worker group can send to it. Every group's
          // routes and Cribl Lake destinations are checked; one that could
          // not be read keeps the dataset.
          const users = datasetUsers(datasetId, groupId, staying, reads);
          verdict = "unread" in users ? users.unread : users.users.length > 0 ? inUse(users.users) : { kind: "delete" };
        }
      }
    }
    verdicts.set("dataset", { kind: "dataset", id: datasetId, verdict });
  }

  // Order: the kit's teardownOrder over the group objects, then the dataset.
  const nodes = (["route", "pipeline", "input", "secret"] as const)
    .filter((k) => verdicts.has(k))
    .map((k) => ({
      id: k,
      references: k === "route" ? ["pipeline", "input"] : k === "input" ? ["secret"] : [],
    }));
  const ordered = teardownOrder(nodes) as TeardownObjectKind[];
  const steps = [...ordered, ...(verdicts.has("dataset") ? (["dataset"] as const) : [])].map(
    (k) => verdicts.get(k) as TeardownStep,
  );
  return { kind: "plan", groupId, steps };
}

/** The steps a plan will send a DELETE (or the routes write) for, in order. */
export function teardownDeletions(steps: readonly TeardownStep[]): TeardownStep[] {
  return steps.filter((s) => s.verdict.kind === "delete");
}

/** Whether two plans would delete exactly the same objects in the same order. */
export function sameDeletions(a: readonly TeardownStep[], b: readonly TeardownStep[]): boolean {
  const x = teardownDeletions(a);
  const y = teardownDeletions(b);
  return x.length === y.length && x.every((s, i) => s.kind === y[i]?.kind && s.id === y[i]?.id);
}

/** An object as the confirm names it. */
export function describeTeardownObject(step: Pick<TeardownStep, "kind" | "id">, groupId: string): string {
  switch (step.kind) {
    case "route":
      return `route ${step.id} in worker group ${groupId}`;
    case "pipeline":
      return `pipeline ${step.id} in worker group ${groupId}`;
    case "input":
      return `Cribl source ${step.id} in worker group ${groupId}`;
    case "secret":
      return `secret ${step.id} in worker group ${groupId}`;
    case "dataset":
      return `Cribl Lake dataset ${step.id} and the data it holds`;
  }
}

// ---------------------------------------------------------------------------
// Records after a teardown
// ---------------------------------------------------------------------------

/** What happened to one object in an apply. */
export type TeardownStepResult = "removed" | "already-gone" | "kept" | "not-reached" | "failed";

/**
 * Which records still describe something that is there. A group object counts
 * as GONE only when it was removed or read as already gone AND the group is
 * settled (`committed`: nothing of it pending, and the deployed version is
 * HEAD); the leader's dataset counts when its DELETE was accepted or it was
 * already gone. A removal left uncommitted keeps its record: discarding the
 * pending change in Cribl brings the object back, and without the record the
 * app could never prove it again.
 */
export function recordsAfterTeardown(args: {
  readonly criblSource: CriblSourceRecord | null;
  readonly lakeRoute: LakeRouteRecord | null;
  readonly results: Readonly<Partial<Record<TeardownObjectKind, TeardownStepResult>>>;
  /**
   * True only when the group is SETTLED: none of this source's files are
   * pending, and the workers run HEAD (the removals are committed and deployed).
   */
  readonly committed: boolean;
}): { readonly criblSource: CriblSourceRecord | null; readonly lakeRoute: LakeRouteRecord | null } {
  const { results, committed } = args;
  // A group object that reads as gone may only be gone in the WORKING config:
  // an earlier run's removal left uncommitted (or committed, not deployed)
  // comes back if someone discards it. So "already gone" counts only when the
  // group is settled, exactly like "removed". The leader's dataset has no
  // commit: gone is gone.
  const gone = (k: TeardownObjectKind): boolean => {
    const r = results[k];
    if (r !== "removed" && r !== "already-gone") return false;
    return k === "dataset" ? true : committed;
  };
  let criblSource = args.criblSource;
  if (criblSource !== null && gone("input") && gone("secret")) criblSource = null;
  let lakeRoute = args.lakeRoute;
  if (lakeRoute !== null) {
    const routeId = lakeRoute.routeId !== null && gone("route") ? null : lakeRoute.routeId;
    const pipelineId = lakeRoute.pipelineId !== null && gone("pipeline") ? null : lakeRoute.pipelineId;
    const datasetGone = gone("dataset");
    // A dataset the app did not create is not the app's to keep a record of
    // once its route is gone; one it created stays recorded until deleted.
    const datasetHeld = lakeRoute.datasetCreated === true && !datasetGone;
    if (routeId === null && pipelineId === null && !datasetHeld) lakeRoute = null;
    else {
      lakeRoute = {
        groupId: lakeRoute.groupId,
        datasetId: lakeRoute.datasetId,
        pipelineId,
        routeId,
        ...(datasetHeld ? { datasetCreated: true as const } : {}),
      };
    }
  }
  return { criblSource, lakeRoute };
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

export type PauseVerdict =
  /** Proven ours, and not yet in the asked state: the apply PATCHes `disabled`. */
  | { readonly kind: "ready" }
  /** Already paused (or running): nothing to write. */
  | { readonly kind: "already" }
  | { readonly kind: "absent" }
  | { readonly kind: "not-proven"; readonly detail: string }
  | { readonly kind: "unreadable"; readonly detail: string; readonly denied?: true };

/**
 * May the app pause (`pause` true) or resume the recorded input? Only an input
 * proven ours, read from GET /system/inputs.
 */
export function classifyInputForPause(inputs: TeardownRead, record: CriblSourceRecord, pause: boolean): PauseVerdict {
  if (inputs.state === "refused") {
    const denied = isDenied(inputs.status);
    return {
      kind: "unreadable",
      detail: denied
        ? `The worker group's sources could not be read: Cribl refused it (HTTP ${inputs.status}), so this account may lack the permission. Nothing was changed.`
        : `The worker group's sources could not be read (${inputs.detail}). Nothing was changed.`,
      ...(denied ? { denied: true as const } : {}),
    };
  }
  const found = findItem(inputs.items, record.inputId);
  if (found === null) return { kind: "absent" };
  const proof = proveOwnership(APP_ID, {
    manifestIds: isOnboardingInputId(record.inputId) ? new Set([record.inputId]) : new Set<string>(),
    object: { id: record.inputId, description: found["description"] },
    recordedWrite: found["type"] === record.inputType,
  });
  if (!proof.mine) {
    return {
      kind: "not-proven",
      detail: `This app cannot prove it created Cribl source ${record.inputId} (${proof.missing.join("; ")}), so it does not change it.`,
    };
  }
  return (found["disabled"] === true) === pause ? { kind: "already" } : { kind: "ready" };
}

// ---------------------------------------------------------------------------
// The Activity Log diagnostic setting (Azure)
// ---------------------------------------------------------------------------

/** GET .../diagnosticSettings/cribl-activity-log, as the removal reads it. */
export type ActivityLogSettingLookup =
  | { readonly kind: "found"; readonly setting: DiagnosticSettingRead }
  | { readonly kind: "absent" };

export type ActivityLogRemovalVerdict =
  | { readonly kind: "delete" }
  | { readonly kind: "already-gone" }
  | { readonly kind: "not-proven"; readonly detail: string };

function sameArmId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * May the app delete the Activity Log setting? Three signals, as rule 11 asks:
 * the name is the app's ({@link ACTIVITY_LOG_SETTING_NAME}), the app's KV
 * record names this subscription, and the setting still sends with the rule
 * the record says the app wrote (the stand-in for a description stamp, which
 * a diagnostic setting cannot carry).
 */
export function classifyActivityLogRemoval(
  lookup: ActivityLogSettingLookup,
  record: ActivityLogSettingRecord | null,
  subscriptionId: string,
): ActivityLogRemovalVerdict {
  if (lookup.kind === "absent") return { kind: "already-gone" };
  const missing: string[] = [];
  if (!sameArmId(lookup.setting.name, ACTIVITY_LOG_SETTING_NAME)) missing.push(`its name is ${lookup.setting.name}, not ${ACTIVITY_LOG_SETTING_NAME}`);
  if (record === null || !sameArmId(record.subscriptionId, subscriptionId)) {
    missing.push("this app has no record of creating it on this subscription (a setting made before removal was built, or by hand, is never removed from here)");
  } else if (!sameArmId(record.ruleId, lookup.setting.ruleId)) {
    missing.push(`it now sends with rule ${lookup.setting.ruleId || "(none)"}, not the rule this app wrote (${record.ruleId})`);
  }
  if (missing.length > 0) {
    return {
      kind: "not-proven",
      detail: `This app cannot prove it created ${ACTIVITY_LOG_SETTING_NAME} as it is now (${missing.join("; ")}), so it does not remove it. Remove it in the Azure portal if it should go.`,
    };
  }
  return { kind: "delete" };
}

// ---------------------------------------------------------------------------
// The Entra ID tenant diagnostic setting (Azure, AZR-99)
// ---------------------------------------------------------------------------

/**
 * May the app delete the Entra ID tenant setting? The same three signals as
 * {@link classifyActivityLogRemoval}, keyed by tenant: the name is the app's
 * ({@link ENTRA_SETTING_NAME}), the app's KV record names THIS tenant, and the
 * setting still sends with the rule the record says the app wrote.
 *
 * The name alone proves nothing here: CriblEntraIDLogs is also the name the
 * How-to step tells an operator to type by hand, so a setting made that way
 * has no record and is never removed from the app.
 */
export function classifyEntraSettingRemoval(
  lookup: ActivityLogSettingLookup,
  record: EntraSettingRecord | null,
  tenantId: string,
): ActivityLogRemovalVerdict {
  if (lookup.kind === "absent") return { kind: "already-gone" };
  const missing: string[] = [];
  if (!sameArmId(lookup.setting.name, ENTRA_SETTING_NAME)) missing.push(`its name is ${lookup.setting.name}, not ${ENTRA_SETTING_NAME}`);
  if (record === null || tenantId.trim() === "" || !sameArmId(record.tenantId, tenantId)) {
    missing.push("this app has no record of creating it in this tenant (a setting made by hand from the How-to steps, or by another tool, is never removed from here)");
  } else if (!sameArmId(record.ruleId, lookup.setting.ruleId)) {
    missing.push(`it now sends with rule ${lookup.setting.ruleId || "(none)"}, not the rule this app wrote (${record.ruleId})`);
  }
  if (missing.length > 0) {
    return {
      kind: "not-proven",
      detail: `This app cannot prove it created ${ENTRA_SETTING_NAME} as it is now (${missing.join("; ")}), so it does not remove it. Remove it in the Microsoft Entra admin center if it should go.`,
    };
  }
  return { kind: "delete" };
}
