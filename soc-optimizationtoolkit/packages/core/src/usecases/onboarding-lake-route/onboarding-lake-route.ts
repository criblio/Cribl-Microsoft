/**
 * onboarding-lake-route (AZR-35, first slice): route the Defender for Cloud
 * export or the Azure Activity Log, from the Cribl source the app created for
 * it (AZR-34), to its own Cribl Lake dataset through the app's shared unroll
 * pipeline. PLAN (read-only, before the confirm), then APPLY (after it).
 *
 * WHY LAKE AND NOT SENTINEL: Sentinel gets both through Microsoft's native
 * connectors (domain/onboarding-lake-route, LAKE_ROUTE_SOURCES); Cribl is for
 * archive here. No Sentinel destination, _CL table or DCR is touched.
 *
 * PLAN, in order (GETs only):
 *   gate                                  - Cribl.Cloud only; a Lake source;
 *                                           the source's Cribl input recorded
 *   1. GET /products/lake/lakes/default/datasets (leader)
 *                                         - create the dataset, or use the one
 *                                           already there (said in the confirm)
 *   2. GET /m/<g>/pipelines               - the unroll pipeline: create, reuse
 *                                           (provably ours, unchanged), or
 *                                           REFUSE (foreign, or ours but edited)
 *   3. route-insert's plan                - listing, position + conflicts (an
 *                                           equal filter refuses, naming the
 *                                           route and where it sends), the
 *                                           table read, commit scope with the
 *                                           pipeline's marker when it is created
 *
 * APPLY, in order; each write create-only; a failure stops every later step
 * and the outcome names what was created:
 *   0. GET /m/<g>/version/status          - the confirm's scope must not have
 *                                           grown, checked BEFORE the first
 *                                           write (route-insert re-checks later)
 *   1. GET datasets, POST datasets        - only when absent; 409 = exists;
 *      GET datasets                         the read-back must list it
 *   2. GET /m/<g>/pipelines, POST         - only when the plan said create and
 *      /m/<g>/pipelines, GET pipelines      it is still absent; the read-back
 *                                           must hold every field sent
 *   3. route-insert's apply               - re-read, write, verify, ONE commit
 *                                           carrying the routes file and the
 *                                           pipeline's files, deploy
 *
 * The Lake dataset is a leader object outside the group commit (as in
 * guided-deploy/wire-source.ts). NOT MEASURED LIVE: the spec path used for the
 * dataset create (POST /products/lake/lakes/{lakeId}/datasets; the listing GET
 * is measured, 2026-08-19, and wire-source still POSTs the non-spec
 * /system/lake/datasets), the spec documents no 409 for it, the pipeline create
 * body, the pipeline's commit file names (the kit's directory marker is used,
 * so any file under it counts), the `cribl_lake:<dataset>` route output, and
 * what an unrolled event looks like.
 *
 * Never throws for an HTTP answer: every path ends in a named outcome.
 */

import {
  LAKE_ROUTE_SOURCES,
  UNROLL_PIPELINE_ID,
  buildLakeDatasetBody,
  buildLakeRoute,
  buildUnrollPipelineBody,
  classifyUnrollPipeline,
  datasetPresence,
  describeDifference,
  findPipeline,
  isLakeRouteSource,
  pipelineCommitMarker,
  subsetDifferences,
  type DatasetPresence,
  type FieldDifference,
  type LakeRouteSourceId,
  type PipelineVerdict,
} from "../../domain/onboarding-lake-route";
import type { NewRoute, RouteConflict, RoutePosition, RouteRowSnapshot } from "../../domain/routes-table";
import type { CriblSourceRecord, LakeRouteRecord } from "../../domain/onboarding-howto/progress-document";
import type { OnboardingSourceId } from "../../domain/onboarding-howto/sources";
import { commitScope, commitScopeGrew, pendingFiles, observeCommitDeploy } from "../../kit/config-writes/commitDeploy";
import { isOk, type ApiResponse, type Request } from "../../kit/config-writes/transport";
import { commitDeployTimeouts, criblRequestFor } from "../../kit/cribl-request";
import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import {
  ROUTE_INSERT_COMMIT_TIMEOUT_MS,
  applyRouteInsert,
  planRouteInsert,
  type ApplyRouteInsertOutcome,
  type PlanRouteInsertRefusalReason,
  type ReadyRouteInsert,
  type RouteInsertPorts,
  type RoutesTableSnapshot,
} from "../route-insert";

/** Every log line this usecase writes starts with this. */
export const LAKE_ROUTE_LOG_PREFIX = "azure-onboarding: lake route";

export interface LakeRoutePorts {
  readonly cribl: CriblClient;
  readonly logger?: Logger;
  /** As route-insert's: every commit-path status, for the shell's write gate. */
  readonly onCommitStep?: RouteInsertPorts["onCommitStep"];
}

// ---------------------------------------------------------------------------
// The gate (pure): may this source be routed to Lake from here at all?
// ---------------------------------------------------------------------------

export type LakeRouteGateReason = "not-a-lake-source" | "not-cloud" | "no-cribl-source" | "not-eventhub";

export interface LakeRouteGateInput {
  readonly sourceId: OnboardingSourceId;
  readonly criblSource: CriblSourceRecord | null;
  /** The shell's declared deployment; absent reads as not Cribl.Cloud (as ports-context documents). */
  readonly deploymentType: "cloud" | "onprem" | undefined;
}

/** Why the action is disabled, in words, or null when it is allowed. Pure. */
export function lakeRouteGate(g: LakeRouteGateInput): { readonly reason: LakeRouteGateReason; readonly detail: string } | null {
  if (!isLakeRouteSource(g.sourceId)) {
    return { reason: "not-a-lake-source", detail: "Only the Defender for Cloud export and the Activity Log are routed to Cribl Lake from here." };
  }
  if (g.deploymentType !== "cloud") {
    return {
      reason: "not-cloud",
      detail: "Cribl Lake is available on Cribl.Cloud only, and this leader is not declared as Cribl.Cloud, so the route to Lake cannot be created here.",
    };
  }
  if (g.criblSource === null) {
    return { reason: "no-cribl-source", detail: "Create the Cribl source first: the route sends that source's events to Lake." };
  }
  if (g.criblSource.inputType !== "eventhub") {
    return { reason: "not-eventhub", detail: `The recorded Cribl source is ${g.criblSource.inputType}, not an Event Hubs source, so no route is offered.` };
  }
  return null;
}

/** Whether the app's KV record shows it wrote the unroll pipeline in this group. */
export function pipelineRecorded(
  records: Readonly<Partial<Record<OnboardingSourceId, LakeRouteRecord>>>,
  groupId: string,
): boolean {
  return Object.values(records).some((r) => r !== undefined && r.groupId === groupId && r.pipelineId === UNROLL_PIPELINE_ID);
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlanLakeRouteInput {
  readonly sourceId: OnboardingSourceId;
  /** progress.criblSources[sourceId]: the input the route reads from. */
  readonly criblSource: CriblSourceRecord | null;
  /** progress.criblLakeRoutes: ownership evidence for the pipeline, and an earlier route. */
  readonly lakeRoutes: Readonly<Partial<Record<OnboardingSourceId, LakeRouteRecord>>>;
  readonly deploymentType: "cloud" | "onprem" | undefined;
  /** Where the route goes in the table: the operator's pick (default top). */
  readonly position: RoutePosition;
}

export type ObjectAction = "create" | "reuse";

/** Everything the confirm names and the apply needs. */
export interface ReadyLakeRoute {
  readonly sourceId: LakeRouteSourceId;
  readonly groupId: string;
  readonly inputId: string;
  readonly dataset: { readonly id: string; readonly action: ObjectAction };
  readonly pipeline: { readonly id: string; readonly action: ObjectAction };
  readonly route: NewRoute;
  /** route-insert's plan: table snapshot, index, shadowedBy, uncheckable, scope, commit files. */
  readonly insert: ReadyRouteInsert;
}

export type PlanLakeRouteRefusalReason =
  | LakeRouteGateReason
  | "datasets-unreadable"
  | "pipelines-unreadable"
  | "pipeline-foreign"
  | "pipeline-differs"
  | PlanRouteInsertRefusalReason;

export type PlanLakeRouteResult =
  | { readonly kind: "ready"; readonly ready: ReadyLakeRoute }
  /** The app's own route for this source is already in the table: nothing to do. */
  | { readonly kind: "already-applied"; readonly routeId: string; readonly detail: string; readonly table?: RoutesTableSnapshot }
  | {
      readonly kind: "refused";
      readonly reason: PlanLakeRouteRefusalReason;
      readonly detail: string;
      readonly conflicts?: readonly RouteConflict[];
      readonly uncheckable?: readonly RouteRowSnapshot[];
      readonly differences?: readonly FieldDifference[];
      /** The routing table, when it was read: the position picker can still show it. */
      readonly table?: RoutesTableSnapshot;
    };

function groupRequest(cribl: CriblClient, groupId: string): Request {
  return criblRequestFor(cribl, groupId, { timeoutMsFor: commitDeployTimeouts(ROUTE_INSERT_COMMIT_TIMEOUT_MS) });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function httpDetail(what: string, r: ApiResponse): string {
  if (r.status === 0) {
    const err = (r.body as { error?: unknown } | null)?.error;
    return `${what}: no response (${typeof err === "string" ? err : "transport failure"})`;
  }
  return `${what}: HTTP ${r.status}`;
}

/** GET the leader's Lake datasets, for one id. Never throws. */
async function readDataset(request: Request, datasetId: string): Promise<DatasetPresence> {
  let r: ApiResponse;
  try {
    r = await request("GET", "/products/lake/lakes/default/datasets");
  } catch (error) {
    return { kind: "unknown", detail: `the Lake dataset listing got no answer (${errorText(error)})` };
  }
  if (!isOk(r.status)) return { kind: "unknown", detail: httpDetail("the Lake dataset listing", r) };
  return datasetPresence(r.body, datasetId);
}

/** GET the group's pipelines and classify the unroll pipeline. Never throws. */
async function readPipeline(request: Request, recorded: boolean): Promise<{ verdict: PipelineVerdict; body: unknown }> {
  let r: ApiResponse;
  try {
    r = await request("GET", "/pipelines");
  } catch (error) {
    return { verdict: { kind: "unknown", detail: `the pipelines listing got no answer (${errorText(error)})` }, body: null };
  }
  if (!isOk(r.status)) return { verdict: { kind: "unknown", detail: httpDetail("the pipelines listing", r) }, body: null };
  return { verdict: classifyUnrollPipeline(findPipeline(r.body, UNROLL_PIPELINE_ID), recorded), body: r.body };
}

function commitMessageFor(sourceId: LakeRouteSourceId): string {
  const s = LAKE_ROUTE_SOURCES[sourceId];
  return `${LAKE_ROUTE_LOG_PREFIX}: ${s.label} to Cribl Lake dataset ${s.datasetId}`;
}

/** PLAN: read-only. Never writes, never throws for an HTTP answer. */
export async function planLakeRoute(ports: LakeRoutePorts, input: PlanLakeRouteInput): Promise<PlanLakeRouteResult> {
  const gate = lakeRouteGate(input);
  if (gate !== null) return { kind: "refused", reason: gate.reason, detail: gate.detail };
  // The gate proved both; narrowed here for the types.
  const sourceId = input.sourceId as LakeRouteSourceId;
  const criblSource = input.criblSource as CriblSourceRecord;
  const { groupId, inputId } = criblSource;
  const source = LAKE_ROUTE_SOURCES[sourceId];
  const request = groupRequest(ports.cribl, groupId);
  const refuse = (
    reason: PlanLakeRouteRefusalReason,
    detail: string,
    extra: Omit<Extract<PlanLakeRouteResult, { kind: "refused" }>, "kind" | "reason" | "detail"> = {},
  ): PlanLakeRouteResult => {
    ports.logger?.warn(`${LAKE_ROUTE_LOG_PREFIX} plan refused`, { groupId, sourceId, reason });
    return { kind: "refused", reason, detail, ...extra };
  };

  // 1. The dataset.
  const dataset = await readDataset(request, source.datasetId);
  if (dataset.kind === "unknown") {
    return refuse("datasets-unreadable", `Whether Cribl Lake dataset ${source.datasetId} exists could not be read (${dataset.detail}). Nothing was changed.`);
  }

  // 2. The unroll pipeline.
  const recorded = pipelineRecorded(input.lakeRoutes, groupId);
  const { verdict } = await readPipeline(request, recorded);
  switch (verdict.kind) {
    case "unknown":
      return refuse("pipelines-unreadable", `Whether pipeline ${UNROLL_PIPELINE_ID} exists could not be read (${verdict.detail}). Nothing was changed.`);
    case "foreign":
      return refuse(
        "pipeline-foreign",
        `Worker group ${groupId} already has a pipeline ${UNROLL_PIPELINE_ID} that this app cannot prove it created (${verdict.missing.join("; ")}). The app does not use or change it. Rename or remove it in Cribl, or ask its owner.`,
      );
    case "differs":
      return refuse(
        "pipeline-differs",
        `Pipeline ${UNROLL_PIPELINE_ID} was created by this app but has been changed since (${verdict.differences.map(describeDifference).join("; ")}). The app does not rewrite it; restore it or remove it in Cribl first.`,
        { differences: verdict.differences },
      );
    case "create":
    case "reuse":
      break;
  }
  const pipelineAction: ObjectAction = verdict.kind;

  // 3. The route, through the shared writer.
  const route = buildLakeRoute(sourceId, inputId);
  const planned = await planRouteInsert(ports, {
    groupId,
    input: { type: "eventhub", id: inputId },
    routes: [route],
    position: input.position,
    commitMessage: commitMessageFor(sourceId),
    ...(pipelineAction === "create" ? { extraCommitMarkers: [pipelineCommitMarker(UNROLL_PIPELINE_ID)] } : {}),
  });
  if (planned.kind === "refused") {
    // The app's own route, recorded and still there: nothing to do.
    const ownRoute = input.lakeRoutes[sourceId]?.routeId;
    if (
      planned.reason === "conflicts" &&
      ownRoute === route.id &&
      (planned.conflicts ?? []).length > 0 &&
      (planned.conflicts ?? []).every((c) => c.existing.id === route.id)
    ) {
      return {
        kind: "already-applied",
        routeId: route.id,
        detail: `This app's route ${route.id} already sends ${source.label} to Cribl Lake dataset ${source.datasetId}. Nothing to do.`,
        ...(planned.table !== undefined ? { table: planned.table } : {}),
      };
    }
    return refuse(planned.reason, planned.detail, {
      ...(planned.conflicts !== undefined ? { conflicts: planned.conflicts } : {}),
      ...(planned.uncheckable !== undefined ? { uncheckable: planned.uncheckable } : {}),
      ...(planned.table !== undefined ? { table: planned.table } : {}),
    });
  }

  ports.logger?.info(`${LAKE_ROUTE_LOG_PREFIX} planned`, { groupId, sourceId, dataset: dataset.kind, pipeline: pipelineAction });
  return {
    kind: "ready",
    ready: {
      sourceId,
      groupId,
      inputId,
      dataset: { id: source.datasetId, action: dataset.kind === "present" ? "reuse" : "create" },
      pipeline: { id: UNROLL_PIPELINE_ID, action: pipelineAction },
      route,
      insert: planned.ready,
    },
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** What happened to one object. */
export type DatasetStep = "created" | "existed" | "not-reached" | "failed";
export type PipelineStep = "created" | "reused" | "created-not-verified" | "not-reached" | "failed";

export type ApplyLakeRouteStage = "scope" | "dataset" | "pipeline" | "route";

export interface ApplyLakeRouteOutcome {
  /**
   *   deployed  every step done; the route is committed and deployed
   *   void      the confirm no longer describes what would be written: plan
   *             again (never retried)
   *   stopped   a step failed or refused; later steps did not run
   */
  readonly kind: "deployed" | "void" | "stopped";
  /** The step that stopped or voided it; null when deployed. */
  readonly stage: ApplyLakeRouteStage | null;
  readonly dataset: DatasetStep;
  readonly pipeline: PipelineStep;
  /** route-insert's own outcome, when it ran. */
  readonly route: ApplyRouteInsertOutcome | null;
  /** Worded for the operator: what was created, what stopped, and why. */
  readonly detail: string;
  /** What to record in the progress document, or null when nothing was created or proved. */
  readonly record: LakeRouteRecord | null;
}

/** route-insert outcomes in which the routes PATCH was applied (whatever happened to the commit). */
const ROUTE_WRITTEN: ReadonlySet<ApplyRouteInsertOutcome["kind"]> = new Set<ApplyRouteInsertOutcome["kind"]>([
  "written-not-verified",
  "commit-sequence-failed",
  "deployed",
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
]);

/** Whether a route-insert outcome means the route is in the table (possibly uncommitted). */
export function routeWritten(outcome: ApplyRouteInsertOutcome): boolean {
  return ROUTE_WRITTEN.has(outcome.kind);
}

function datasetPhrase(step: DatasetStep, id: string): string {
  switch (step) {
    case "created":
      return `Cribl Lake dataset ${id} was created.`;
    case "existed":
      return `Cribl Lake dataset ${id} already existed and is used as it is.`;
    case "failed":
    case "not-reached":
      return `Cribl Lake dataset ${id} was not created.`;
  }
}

function pipelinePhrase(step: PipelineStep, id: string): string {
  switch (step) {
    case "created":
      return `Pipeline ${id} was created.`;
    case "reused":
      return `Pipeline ${id} (already this app's) is used as it is.`;
    case "created-not-verified":
      return `Pipeline ${id} was created but its read-back did not match what was sent; it is NOT committed. Check it in Cribl.`;
    case "failed":
    case "not-reached":
      return `Pipeline ${id} was not created.`;
  }
}

/**
 * APPLY: only after the operator confirmed `ready`. Never throws for an HTTP
 * answer; a void is re-planned by the caller, never retried.
 */
export async function applyLakeRoute(ports: LakeRoutePorts, ready: ReadyLakeRoute): Promise<ApplyLakeRouteOutcome> {
  const { groupId, sourceId } = ready;
  const grouped = groupRequest(ports.cribl, groupId);
  const request = ports.onCommitStep ? observeCommitDeploy(grouped, ports.onCommitStep) : grouped;
  let dataset: DatasetStep = "not-reached";
  let pipeline: PipelineStep = "not-reached";

  const record = (routeId: string | null): LakeRouteRecord | null => {
    const pipelineId = pipeline === "created" || pipeline === "reused" || pipeline === "created-not-verified" ? ready.pipeline.id : null;
    if (dataset !== "created" && pipelineId === null && routeId === null) return null;
    return { groupId, datasetId: ready.dataset.id, pipelineId, routeId };
  };
  const end = (
    kind: ApplyLakeRouteOutcome["kind"],
    stage: ApplyLakeRouteStage | null,
    why: string,
    route: ApplyRouteInsertOutcome | null = null,
  ): ApplyLakeRouteOutcome => {
    const routeId = route !== null && routeWritten(route) ? ready.route.id : null;
    const parts = [datasetPhrase(dataset, ready.dataset.id), pipelinePhrase(pipeline, ready.pipeline.id)];
    // A pipeline created here is committed only with the route; say so when the route did not get there.
    if (pipeline === "created" && kind !== "deployed" && !(route !== null && routeWritten(route))) {
      parts.push("The new pipeline is not committed: it stays pending in the worker group.");
    }
    parts.push(why);
    const outcome: ApplyLakeRouteOutcome = { kind, stage, dataset, pipeline, route, detail: parts.join(" "), record: record(routeId) };
    const log = { groupId, sourceId, stage, dataset, pipeline, route: route?.kind ?? null };
    if (kind === "deployed") ports.logger?.info(`${LAKE_ROUTE_LOG_PREFIX} deployed`, log);
    else ports.logger?.warn(`${LAKE_ROUTE_LOG_PREFIX} ${kind}`, log);
    return outcome;
  };

  // 0. The commit the confirm described must not have grown, BEFORE any write.
  const markers = ready.insert.commitMarkers ?? [];
  let pending: string[] | null;
  try {
    pending = await pendingFiles(request);
  } catch {
    pending = null;
  }
  if (pending === null) {
    return end("stopped", "scope", "Cribl's pending-change status could not be read, so what the commit would carry is unknown. Nothing was written.");
  }
  const scope = commitScope(pending, groupId, markers);
  if (scope.unplaced.length > 0) {
    return end("stopped", "scope", `Pending changes could not be placed in a worker group (${scope.unplaced.join(", ")}). Nothing was written; commit or discard them in Cribl first.`);
  }
  if (commitScopeGrew(ready.insert.scope, scope)) {
    return end("void", "scope", `Since the confirm, more uncommitted work appeared in the files this commit carries (${scope.alreadyDirty.join(", ")}). Nothing was written; check again and confirm the new scope.`);
  }

  // 1. The Lake dataset (leader). Create only when absent; 409 = exists.
  const datasetBefore = await readDataset(request, ready.dataset.id);
  if (datasetBefore.kind === "unknown") {
    dataset = "failed";
    return end("stopped", "dataset", `The Lake dataset listing could not be re-read (${datasetBefore.detail}). Nothing was written.`);
  }
  if (datasetBefore.kind === "present") {
    dataset = "existed";
  } else {
    let post: ApiResponse;
    try {
      post = await request("POST", "/products/lake/lakes/default/datasets", { body: buildLakeDatasetBody(sourceId) });
    } catch (error) {
      dataset = "failed";
      return end("stopped", "dataset", `Creating Cribl Lake dataset ${ready.dataset.id} got no answer (${errorText(error)}); whether it exists is unknown. Nothing else was written.`);
    }
    if (post.status === 409) {
      dataset = "existed";
    } else if (!isOk(post.status)) {
      dataset = "failed";
      return end("stopped", "dataset", `${httpDetail(`Creating Cribl Lake dataset ${ready.dataset.id} was refused`, post)}. Nothing else was written.`);
    } else {
      const after = await readDataset(request, ready.dataset.id);
      if (after.kind !== "present") {
        dataset = "failed";
        return end(
          "stopped",
          "dataset",
          `Cribl answered the dataset create with HTTP ${post.status}, but the dataset is not listed afterwards (${after.kind === "unknown" ? after.detail : "absent"}). Nothing else was written; check Cribl Lake.`,
        );
      }
      dataset = "created";
    }
  }

  // 2. The unroll pipeline (group). Re-classified on a fresh read.
  const recordedNow = ready.pipeline.action === "reuse";
  const fresh = await readPipeline(request, recordedNow);
  if (ready.pipeline.action === "reuse") {
    if (fresh.verdict.kind !== "reuse") {
      pipeline = "failed";
      return end("stopped", "pipeline", `Pipeline ${ready.pipeline.id} changed since the confirm (${fresh.verdict.kind}). The route was not written.`);
    }
    pipeline = "reused";
  } else {
    if (fresh.verdict.kind !== "create") {
      pipeline = "failed";
      const why = fresh.verdict.kind === "unknown" ? `could not be re-read (${fresh.verdict.detail})` : "appeared since the confirm";
      return end("stopped", "pipeline", `Pipeline ${ready.pipeline.id} ${why}; it was not created and the route was not written.`);
    }
    const body = buildUnrollPipelineBody();
    let post: ApiResponse;
    try {
      post = await request("POST", "/pipelines", { body });
    } catch (error) {
      pipeline = "failed";
      return end("stopped", "pipeline", `Creating pipeline ${ready.pipeline.id} got no answer (${errorText(error)}); whether it exists is unknown. The route was not written.`);
    }
    if (!isOk(post.status)) {
      pipeline = "failed";
      return end("stopped", "pipeline", `${httpDetail(`Creating pipeline ${ready.pipeline.id} was refused`, post)}. The route was not written.`);
    }
    let back: ApiResponse | null = null;
    try {
      back = await request("GET", "/pipelines");
    } catch {
      back = null;
    }
    const stored = back !== null && isOk(back.status) ? findPipeline(back.body, ready.pipeline.id) : null;
    const differences = stored?.kind === "found" ? subsetDifferences(body, stored.pipeline) : null;
    if (differences === null || differences.length > 0) {
      pipeline = "created-not-verified";
      const why =
        differences === null
          ? "the pipelines listing could not be read back"
          : differences.map(describeDifference).join("; ");
      return end("stopped", "pipeline", `The pipeline read-back did not confirm the write (${why}). The route was not written and nothing was committed.`);
    }
    pipeline = "created";
  }

  // 3. The route: route-insert re-reads, writes, verifies, commits (routes
  // file + the pipeline's files) and deploys. The pipeline this apply just
  // created is the caller's own pending work, not scope growth.
  const insert = await applyRouteInsert(ports, ready.insert, {
    createdBeforeInsert: pipeline === "created" ? [pipelineCommitMarker(ready.pipeline.id)] : [],
  });
  if (insert.kind === "deployed") return end("deployed", null, `Route ${ready.route.id}: ${insert.detail}`, insert);
  if (insert.kind === "void") return end("void", "route", `Route ${ready.route.id} was not written: ${insert.detail}`, insert);
  return end(
    "stopped",
    "route",
    routeWritten(insert) ? `Route ${ready.route.id}: ${insert.detail}` : `Route ${ready.route.id} was not written: ${insert.detail}`,
    insert,
  );
}
