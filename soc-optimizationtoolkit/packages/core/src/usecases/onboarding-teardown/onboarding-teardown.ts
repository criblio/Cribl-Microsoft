/**
 * onboarding-teardown (AZR-105): REMOVE what the Azure Native Source
 * Onboarding screen created in Cribl for one source - its Lake route, the
 * shared unroll pipeline when nothing else uses it, the Cribl source and its
 * secret, and (only on explicit opt-in) its Lake dataset. PLAN (read-only,
 * before the confirm), then APPLY (after it). The pure verdicts are
 * domain/onboarding-teardown; this module does the IO.
 *
 * PLAN, in order (GETs only):
 *   1. GET /m/<g>/system/inputs          - always
 *   2. GET /m/<g>/routes                 - always: which table, what it holds
 *   3. GET /m/<g>/system/secrets/<id>    - when a Cribl source is recorded
 *   4. GET /m/<g>/pipelines              - when a pipeline is recorded
 *   5. GET /products/lake/lakes/default/datasets - only with the dataset opt-in
 *   6. the pure planCriblTeardown        - a verdict per object, in teardown order
 *   7. the kit's planChange on the routing table (when the route goes): the
 *      diff the confirm shows, from the same table as step 2 (a table that
 *      moved in between refuses 'table-moved')
 *   8. GET /m/<g>/version/status         - the kit's commitScope over the
 *      markers of every object that goes; unplaced or unreadable refuses
 *
 * APPLY, in order; each step re-reads what its verdict depends on right
 * before its write, and a step whose fresh verdict is no longer `delete` stops
 * the run ('changed'), except a fresh `already-gone`, which is success:
 *   0. GET /version/status               - commitScopeGrew -> void, before any write
 *   1. route    - the kit's writeApproved on the routing table (re-read, diff
 *                 compare, a synchronous FreshCheck that the route still
 *                 carries the app's stamp, PATCH the whole table), then
 *                 verifyStored; anything but stored stops, never committed
 *   2. pipeline - re-read inputs, routes, pipelines; DELETE /m/<g>/pipelines/<id>
 *   3. input    - re-read inputs, routes; DELETE /m/<g>/system/inputs/<id>
 *   4. secret   - re-read inputs, secret; DELETE /m/<g>/system/secrets/<id>
 *   5. the kit's commitAndDeploy over the markers of the objects REMOVED -
 *      also after a stop, so a confirmed removal is never left pending for
 *      someone else's commit to carry
 *   6. dataset  - only after step 5 deployed (the deployed route named it
 *                 until then): re-read routes, datasets; DELETE
 *                 /products/lake/lakes/default/datasets/<id> (leader)
 *
 * REVIEW FIXES (before merge). The plan also reads destinations
 * (/system/outputs) and collectors (/jobs) for the in-use checks and, for the
 * dataset, every other worker group's routes and destinations. "Gone" (records
 * cleared, the dataset deleted) needs the group SETTLED (settledCheck):
 * nothing pending in the files of any object this source claims gone, and the
 * workers on HEAD. The commit carries ONLY the files of objects this run
 * removed - never a kept object's, and never a pending file the app cannot
 * attribute: those files are shared (inputs.yml, route.yml, the secrets file,
 * a pipeline directory), and a dirty one may be another admin's half-done
 * work. An unattributable pending file makes the run unsettled with an honest
 * reason (commit or discard it in Cribl, then check again); it is never
 * committed. A run that removed something and then found nothing to commit is
 * unsettled too (its files escaped the unmeasured markers).
 *
 * A DELETE answered 404 is already gone (success). A 401/403 stops and says
 * it was refused for permission (`denied`). Every kit outcome is kept by name.
 * Never throws for an HTTP answer.
 *
 * NOT MEASURED LIVE: no DELETE here has been sent to a real leader. Which
 * files a pipeline / input / secret DELETE leaves pending (the markers are
 * the create path's, also unmeasured), whether Cribl refuses deleting a secret
 * an input still names, and the Lake dataset DELETE's answer to an id that is
 * gone are all on the card's live list.
 */

import {
  COMMIT_MARKERS,
} from "../../domain/cribl-onboarding-source/classify-existing";
import { pipelineCommitMarker } from "../../domain/onboarding-lake-route/lake-route";
import type { CriblSourceRecord, LakeRouteRecord } from "../../domain/onboarding-howto/progress-document";
import type { OnboardingSourceId } from "../../domain/onboarding-howto/sources";
import { parseRoutesListing } from "../../domain/routes-table";
import {
  isDenied,
  planCriblTeardown,
  recordsAfterTeardown,
  teardownGroup,
  teardownReadsNeeded,
  type CriblTeardownInput,
  type CriblTeardownReads,
  type CriblTeardownRefusalReason,
  type OtherGroupRead,
  type OtherGroupsRead,
  type TeardownObjectKind,
  type TeardownRead,
  type TeardownStep,
  type TeardownStepResult,
} from "../../domain/onboarding-teardown/teardown-plan";
import { stampFor } from "../../kit/config-writes/ownership";
import {
  commitAndDeploy,
  commitScope,
  commitScopeGrew,
  deployedVersion,
  observeCommitDeploy,
  pendingFiles,
  placePending,
  sameCommit,
  type CommitDeployOutcome,
  type CommitScope,
} from "../../kit/config-writes/commitDeploy";
import { planChange, sameValue, verifyStored, writeApproved, type DiffRow } from "../../kit/config-writes/readModifyWrite";
import { isOk, type ApiResponse, type Request } from "../../kit/config-writes/transport";
import { commitDeployTimeouts, criblRequestFor } from "../../kit/cribl-request";
import { APP_ID } from "../../domain/cribl-secrets/secret-body";
import type { CriblClient, CriblGroupSummary } from "../../ports/cribl-client";
import { listingRows, listingWasRead, type Listing } from "../../domain/inventory-listing/inventory-listing";
import type { Logger } from "../../ports/logger";
import {
  ROUTE_COMMIT_MARKERS,
  routesWriteTarget,
  type RouteInsertPorts,
} from "../route-insert";

/** Every log line this usecase writes starts with this. */
export const TEARDOWN_LOG_PREFIX = "azure-onboarding: teardown";

/** The longer wait for the commit and deploy calls (as create-cribl-source). */
export const TEARDOWN_COMMIT_TIMEOUT_MS = 60_000;

export interface TeardownPorts {
  readonly cribl: CriblClient;
  readonly logger?: Logger;
  /** As route-insert's: every commit-path status, for the shell's write gate. */
  readonly onCommitStep?: RouteInsertPorts["onCommitStep"];
}

function groupRequest(cribl: CriblClient, groupId: string): Request {
  return criblRequestFor(cribl, groupId, { timeoutMsFor: commitDeployTimeouts(TEARDOWN_COMMIT_TIMEOUT_MS) });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

async function safeCall(request: Request, method: string, path: string): Promise<ApiResponse> {
  try {
    return await request(method, path);
  } catch (error) {
    return { status: 0, body: { error: errorText(error) } };
  }
}

function httpDetail(what: string, r: ApiResponse): string {
  if (r.status === 0) {
    const err = (r.body as { error?: unknown } | null)?.error;
    return `${what}: no response (${typeof err === "string" ? err : "transport failure"})`;
  }
  return `${what}: HTTP ${r.status}`;
}

function refusedRead(what: string, r: ApiResponse): TeardownRead {
  return { state: "refused", status: r.status, detail: httpDetail(what, r) };
}

function itemsOf(r: ApiResponse, what: string): TeardownRead {
  if (!isOk(r.status)) return refusedRead(what, r);
  const items = (r.body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { state: "refused", status: r.status, detail: `${what} answered without an items array` };
  return { state: "read", items };
}

/** The routing table as a teardown reads it: the routes array plus the table id. */
interface RoutesRead {
  readonly read: TeardownRead;
  readonly tableId: string | null;
  readonly routes: readonly unknown[];
}

async function readRoutes(request: Request): Promise<RoutesRead> {
  const r = await safeCall(request, "GET", "/routes");
  if (!isOk(r.status)) return { read: refusedRead("the routing table", r), tableId: null, routes: [] };
  const parsed = parseRoutesListing(r.body);
  if (parsed.kind !== "table") return { read: { state: "refused", status: r.status, detail: `the routing table was not understood (${parsed.detail})` }, tableId: null, routes: [] };
  return { read: { state: "read", items: parsed.routes }, tableId: parsed.tableId, routes: parsed.routes };
}

async function readInputs(request: Request): Promise<TeardownRead> {
  return itemsOf(await safeCall(request, "GET", "/system/inputs"), "the sources list");
}

async function readSecret(request: Request, secretId: string): Promise<TeardownRead> {
  const r = await safeCall(request, "GET", `/system/secrets/${encodeURIComponent(secretId)}`);
  if (r.status === 404) return { state: "read", items: [] };
  return itemsOf(r, "the secret read");
}

async function readPipelines(request: Request): Promise<TeardownRead> {
  return itemsOf(await safeCall(request, "GET", "/pipelines"), "the pipelines list");
}

async function readDatasets(request: Request): Promise<TeardownRead> {
  return itemsOf(await safeCall(request, "GET", "/products/lake/lakes/default/datasets"), "the Lake dataset list");
}

async function readOutputs(request: Request): Promise<TeardownRead> {
  return itemsOf(await safeCall(request, "GET", "/system/outputs"), "the destinations list");
}

async function readJobs(request: Request): Promise<TeardownRead> {
  return itemsOf(await safeCall(request, "GET", "/jobs"), "the collectors list");
}

/**
 * Group products that hold no Stream routes or destinations, so are not read
 * for the dataset check. Inferred from the spec's ConfigGroup `type` enum, not
 * measured: a Search, local Search, Lake access or Outpost group has no
 * routing table to send to Lake from.
 */
const NO_ROUTES_PRODUCTS: ReadonlySet<string> = new Set(["search", "local_search", "lake_access", "outpost"]);

/**
 * Every other worker group's routes and destinations (for the Lake dataset,
 * which any group can send to). Refused when the group list, or any one
 * group's routes or destinations, cannot be read: the dataset is then kept.
 */
async function readOtherGroups(cribl: CriblClient, groupId: string): Promise<OtherGroupsRead> {
  let listing: Listing<CriblGroupSummary>;
  try {
    listing = await cribl.listGroups();
  } catch (error) {
    return { state: "refused", status: 0, detail: `the worker group list could not be read (${errorText(error)})` };
  }
  if (!listingWasRead(listing)) {
    return { state: "refused", status: 0, detail: "the worker group list came back empty, so which groups exist is unknown" };
  }
  const groups: OtherGroupRead[] = [];
  for (const g of listingRows(listing)) {
    if (g.id === groupId || NO_ROUTES_PRODUCTS.has((g.product ?? "").toLowerCase())) continue;
    const other = criblRequestFor(cribl, g.id);
    const routes = await readRoutes(other);
    if (routes.read.state === "refused") return { state: "refused", status: routes.read.status, detail: `worker group ${g.id}: ${routes.read.detail}` };
    const outputs = await readOutputs(other);
    if (outputs.state === "refused") return { state: "refused", status: outputs.status, detail: `worker group ${g.id}: ${outputs.detail}` };
    groups.push({ groupId: g.id, routes: routes.routes, outputs: outputs.items });
  }
  return { state: "read", groups };
}

/**
 * Every read a plan of `input` needs, in the order the header lists. The
 * other groups (many GETs) are read only when `others` is set: in the plan,
 * and right before the dataset's DELETE.
 */
async function readAll(
  cribl: CriblClient,
  request: Request,
  input: CriblTeardownInput,
  others = true,
): Promise<{ reads: CriblTeardownReads; routes: RoutesRead }> {
  const need = teardownReadsNeeded(input);
  const groupId = teardownGroup(input);
  const inputs = await readInputs(request);
  const routes = await readRoutes(request);
  const secret = need.secret && input.criblSource !== null ? await readSecret(request, input.criblSource.secretId) : null;
  const pipelines = need.pipelines ? await readPipelines(request) : null;
  const datasets = need.datasets ? await readDatasets(request) : null;
  const outputs = need.outputs ? await readOutputs(request) : null;
  const jobs = need.jobs ? await readJobs(request) : null;
  const otherGroups = need.otherGroups && others && "groupId" in groupId ? await readOtherGroups(cribl, groupId.groupId) : null;
  return { reads: { inputs, routes: routes.read, secret, pipelines, datasets, outputs, jobs, otherGroups }, routes };
}

/**
 * Whether the group is SETTLED: the workers run the newest commit (deployed
 * configVersion matches HEAD). Called once nothing of this source is pending.
 * A removal that was committed but never deployed is still live on the
 * workers, so its object is not yet gone.
 *
 * UNMEASURED: whether /m/<g>/version history is per group or leader-wide. If
 * it is leader-wide, another group's later commit makes HEAD differ from this
 * group's configVersion and the check never settles - the safe direction.
 */
async function groupSettled(request: Request, groupId: string): Promise<{ readonly settled: boolean; readonly detail: string }> {
  const head = await safeCall(request, "GET", "/version?offset=0&limit=1");
  const items = isOk(head.status) ? (head.body as { items?: unknown } | null)?.items : undefined;
  const hash = Array.isArray(items) ? (items[0] as { hash?: unknown } | undefined)?.hash : undefined;
  if (typeof hash !== "string" || hash === "") {
    return { settled: false, detail: `The newest commit of worker group ${groupId} could not be read, so whether earlier removals are deployed is unknown.` };
  }
  let deployed: string | null;
  try {
    deployed = await deployedVersion(request, groupId);
  } catch {
    deployed = null;
  }
  if (deployed === null) {
    return { settled: false, detail: `The version worker group ${groupId} runs could not be read, so whether earlier removals are deployed is unknown.` };
  }
  if (!sameCommit(deployed, hash)) {
    return {
      settled: false,
      detail: `Worker group ${groupId} runs ${deployed}, not its newest commit ${hash}, so earlier removals may not be live yet. Deploy the group in Cribl, then check again.`,
    };
  }
  return { settled: true, detail: `Worker group ${groupId} runs its newest commit ${hash}.` };
}

/**
 * Settled = nothing pending in the files of the objects this source claims
 * gone (`watch`), and the workers run HEAD. A pending file there is NOT
 * assumed to be this app's: it may be another admin's work in the same shared
 * file, so it is named and left alone.
 */
async function settledCheck(request: Request, groupId: string, watch: readonly string[]): Promise<{ readonly settled: boolean; readonly detail: string }> {
  if (watch.length === 0) return { settled: true, detail: "" };
  let pending: string[] | null;
  try {
    pending = await pendingFiles(request);
  } catch {
    pending = null;
  }
  if (pending === null) {
    return { settled: false, detail: `Cribl's pending-change status for worker group ${groupId} could not be read, so whether the removals are live is unknown.` };
  }
  const placed = placePending(pending, groupId, watch);
  const dirty = [...placed.mine, ...placed.unplaced];
  if (dirty.length > 0) {
    return {
      settled: false,
      detail:
        `Worker group ${groupId} has uncommitted changes in ${dirty.join(", ")}. They may be an earlier removal by this app or someone else's work, ` +
        "and the app does not commit changes it did not make in this run. Commit or discard them in Cribl, then check again.",
    };
  }
  return groupSettled(request, groupId);
}

/** The group-relative commit markers of the objects that go. */
export function teardownCommitMarkers(kinds: readonly TeardownObjectKind[], pipelineId: string | null): string[] {
  const out: string[] = [];
  if (kinds.includes("route")) out.push(...ROUTE_COMMIT_MARKERS);
  if (kinds.includes("pipeline") && pipelineId !== null) out.push(pipelineCommitMarker(pipelineId));
  if (kinds.includes("input") || kinds.includes("secret")) out.push(...COMMIT_MARKERS);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlanTeardownInput extends CriblTeardownInput {}

/** Everything the confirm names and the apply needs. */
export interface ReadyTeardown {
  readonly input: PlanTeardownInput;
  readonly groupId: string;
  /** Every candidate with its verdict, in execution order. */
  readonly steps: readonly TeardownStep[];
  /** The routing-table write, when the route goes: the whole array to send and the diff approved. */
  readonly routeWrite: { readonly tableId: string; readonly routes: readonly unknown[]; readonly diff: readonly DiffRow[] } | null;
  readonly scope: CommitScope;
  /** The markers of the objects this run deletes: the only files its commit can carry. */
  readonly markers: readonly string[];
  /**
   * The markers of every object this source claims gone (deleted now, or
   * already gone). Read after the commit: anything still pending there makes
   * the run unsettled. Never committed unless it is also in `markers`.
   */
  readonly watchMarkers: readonly string[];
  /** Every file the commit can carry, in the group's tree (an upper bound). */
  readonly commitFiles: readonly string[];
}

export type PlanTeardownRefusalReason =
  | CriblTeardownRefusalReason
  | "table-unreadable"
  | "table-moved"
  | "status-unknown"
  | "scope-unplaced";

export type PlanTeardownResult =
  | { readonly kind: "ready"; readonly ready: ReadyTeardown }
  /**
   * Nothing to send: every object is already gone or kept. `records` is what
   * the app's records should become (an already-gone object's record goes).
   */
  | {
      readonly kind: "nothing-to-remove";
      readonly groupId: string;
      readonly steps: readonly TeardownStep[];
      readonly records: { readonly criblSource: CriblSourceRecord | null; readonly lakeRoute: LakeRouteRecord | null };
      /**
       * Set when the group is not settled (it does not run its newest commit,
       * or that could not be read): already-gone objects keep their records,
       * and this says why.
       */
      readonly unsettled?: string;
    }
  | { readonly kind: "refused"; readonly reason: PlanTeardownRefusalReason; readonly detail: string; readonly denied?: true };

function deletes(steps: readonly TeardownStep[]): TeardownObjectKind[] {
  return steps.filter((s) => s.verdict.kind === "delete").map((s) => s.kind);
}

function resultsFromVerdicts(steps: readonly TeardownStep[]): Partial<Record<TeardownObjectKind, TeardownStepResult>> {
  const out: Partial<Record<TeardownObjectKind, TeardownStepResult>> = {};
  for (const s of steps) out[s.kind] = s.verdict.kind === "already-gone" ? "already-gone" : "kept";
  return out;
}

async function scopeFor(request: Request, groupId: string, markers: readonly string[]): Promise<{ kind: "ok"; scope: CommitScope } | { kind: "refused"; reason: "status-unknown" | "scope-unplaced"; detail: string }> {
  let pending: string[] | null;
  try {
    pending = await pendingFiles(request);
  } catch {
    pending = null;
  }
  if (pending === null) {
    return { kind: "refused", reason: "status-unknown", detail: "Cribl's pending-change status could not be read, so what the commit would carry is unknown. Nothing was changed." };
  }
  const scope = commitScope(pending, groupId, markers);
  if (scope.unplaced.length > 0) {
    return {
      kind: "refused",
      reason: "scope-unplaced",
      detail: `Pending changes could not be placed in a worker group (${scope.unplaced.join(", ")}). Nothing was changed; commit or discard them in Cribl first.`,
    };
  }
  return { kind: "ok", scope };
}

/** PLAN: read-only. Never writes, never throws for an HTTP answer. */
export async function planSourceTeardown(ports: TeardownPorts, input: PlanTeardownInput): Promise<PlanTeardownResult> {
  const group = teardownGroup(input);
  if ("refused" in group) return { kind: "refused", reason: group.refused, detail: group.detail };
  const { groupId } = group;
  const request = groupRequest(ports.cribl, groupId);
  const refuse = (reason: PlanTeardownRefusalReason, detail: string, denied = false): PlanTeardownResult => {
    ports.logger?.warn(`${TEARDOWN_LOG_PREFIX} plan refused`, { groupId, sourceId: input.sourceId, reason });
    return { kind: "refused", reason, detail, ...(denied ? { denied: true as const } : {}) };
  };

  const { reads, routes } = await readAll(ports.cribl, request, input);
  const plan = planCriblTeardown(input, reads);
  if (plan.kind === "refused") return refuse(plan.reason, plan.detail, plan.denied === true);

  const goes = deletes(plan.steps);
  const pipelineId = input.lakeRoute?.pipelineId ?? null;
  // The commit carries only the files of what this run deletes; a kept
  // object's files are never in it.
  const markers = teardownCommitMarkers(goes.filter((k) => k !== "dataset"), pipelineId);
  // What must be clean (and live) before anything this source claims gone is.
  const watchMarkers = teardownCommitMarkers(
    plan.steps.filter((s) => s.kind !== "dataset" && s.verdict.kind !== "keep").map((s) => s.kind),
    pipelineId,
  );
  let scope: CommitScope = { alreadyDirty: [], elsewhere: [], unplaced: [], unknown: false };
  if (markers.length > 0) {
    const read = await scopeFor(request, groupId, markers);
    if (read.kind === "refused") return refuse(read.reason, read.detail);
    scope = read.scope;
  }

  if (goes.length === 0) {
    // Nothing to send. Gone counts only when nothing is pending in those
    // objects' files and the workers run HEAD; a pending file is never
    // committed here, because the app cannot tell whose it is.
    const settled = await settledCheck(request, groupId, watchMarkers);
    ports.logger?.info(`${TEARDOWN_LOG_PREFIX} nothing to remove`, { groupId, sourceId: input.sourceId, settled: settled.settled });
    return {
      kind: "nothing-to-remove",
      groupId,
      steps: plan.steps,
      records: recordsAfterTeardown({
        criblSource: input.criblSource,
        lakeRoute: input.lakeRoute,
        results: resultsFromVerdicts(plan.steps),
        committed: settled.settled,
      }),
      ...(settled.settled ? {} : { unsettled: settled.detail }),
    };
  }

  // The routing-table write, against the same table the verdicts read.
  let routeWrite: ReadyTeardown["routeWrite"] = null;
  const routeStep = plan.steps.find((s) => s.kind === "route" && s.verdict.kind === "delete");
  if (routeStep !== undefined && routes.tableId !== null) {
    const without = routes.routes.filter((r) => !(typeof r === "object" && r !== null && (r as Record<string, unknown>)["id"] === routeStep.id));
    const target = routesWriteTarget(groupId, routes.tableId);
    let planned;
    try {
      planned = await planChange(request, target, { routes: without });
    } catch (error) {
      return refuse("table-unreadable", `Routing table ${routes.tableId} could not be read (${errorText(error)}). Nothing was changed.`);
    }
    if (planned.kind === "unreadable") {
      return refuse("table-unreadable", `${httpDetail(`Routing table ${routes.tableId} could not be read`, planned.response)}. Nothing was changed.`, isDenied(planned.response.status));
    }
    if (!sameValue(planned.before["routes"], routes.routes) || planned.kind === "nothing-to-do") {
      return refuse("table-moved", `Routing table ${routes.tableId} changed while it was being read. Nothing was changed; check again.`);
    }
    routeWrite = { tableId: routes.tableId, routes: without, diff: planned.diff };
  }

  ports.logger?.info(`${TEARDOWN_LOG_PREFIX} planned`, { groupId, sourceId: input.sourceId, goes: goes.join(",") });
  return {
    kind: "ready",
    ready: {
      input,
      groupId,
      steps: plan.steps,
      routeWrite,
      scope,
      markers,
      watchMarkers,
      commitFiles: markers.map((m) => `groups/${groupId}/${m}`),
    },
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface TeardownStepOutcome {
  readonly kind: TeardownObjectKind;
  readonly id: string;
  readonly result: TeardownStepResult;
  /** Worded for the operator. */
  readonly detail: string;
  /** Set when Cribl refused the step with 401 or 403. */
  readonly denied?: true;
}

export type TeardownCommitResult =
  | { readonly kind: "not-needed" }
  | { readonly kind: "commit-sequence-failed"; readonly detail: string }
  /** Nothing of this source was pending, but the workers do not run the newest commit (or that could not be read). */
  | { readonly kind: "unsettled"; readonly detail: string }
  | (CommitDeployOutcome & { readonly detail: string });

export interface ApplyTeardownOutcome {
  /**
   *   removed  every object the confirm named went (or was already gone),
   *            and the group change was committed and deployed
   *   void     the confirm no longer describes the commit: nothing written
   *   stopped  a step stopped; later steps did not run (what ran is named)
   */
  readonly kind: "removed" | "void" | "stopped";
  readonly steps: readonly TeardownStepOutcome[];
  readonly commit: TeardownCommitResult;
  /** What the app's records should become. */
  readonly records: { readonly criblSource: CriblSourceRecord | null; readonly lakeRoute: LakeRouteRecord | null };
  readonly detail: string;
}

/** One commitAndDeploy outcome after a teardown, worded. */
export function teardownCommitDetail(outcome: CommitDeployOutcome, groupId: string, subject = "The removals were"): string {
  switch (outcome.kind) {
    case "deployed":
      return `Committed ${outcome.hash} (${outcome.files.join(", ")}) and deployed it to worker group ${groupId}.`;
    case "nothing-to-commit":
      return `${subject} made, but Cribl reported none of their files as pending, so nothing was committed or deployed. Check the group's pending changes in Cribl.`;
    case "status-unknown":
      return `${subject} made, but the pending-change status could not be read (HTTP ${outcome.response.status}); nothing was committed.`;
    case "scope-unknown":
      return `${subject} made, but pending changes could not be placed in a group (${outcome.unplaced.join(", ")}); nothing was committed.`;
    case "newer-commit":
      return `${subject} committed as ${outcome.hash}, but ${outcome.head} is newer; deploying would roll it back, so nothing was deployed.`;
    case "head-unknown":
      return `${subject} committed as ${outcome.hash}, but the newest commit could not be read (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "committed-unknown-hash":
      return `${subject} made; the commit call succeeded but named no commit, so nothing was deployed. Check the group's commit history in Cribl before retrying.`;
    case "commit-failed":
      return `${subject} made, but the commit was refused (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "incomplete":
      return `${subject} committed as ${outcome.hash}, but ${outcome.leftBehind.join(", ")} is still pending; nothing was deployed.`;
    case "unverified":
      return `${subject} committed as ${outcome.hash}, but the status re-read failed (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "deploy-failed":
      return `${subject} committed as ${outcome.hash}; the deploy via the ${outcome.route} path was refused (HTTP ${outcome.response.status}).`;
  }
}

function stepWord(kind: TeardownObjectKind): string {
  switch (kind) {
    case "route":
      return "Route";
    case "pipeline":
      return "Pipeline";
    case "input":
      return "Cribl source";
    case "secret":
      return "Secret";
    case "dataset":
      return "Cribl Lake dataset";
  }
}

/** Send one DELETE (literal paths, so the request scan reads each). */
async function sendDelete(request: Request, kind: Exclude<TeardownObjectKind, "route">, id: string): Promise<ApiResponse> {
  const enc = encodeURIComponent(id);
  switch (kind) {
    case "pipeline":
      return safeCall(request, "DELETE", `/pipelines/${enc}`);
    case "input":
      return safeCall(request, "DELETE", `/system/inputs/${enc}`);
    case "secret":
      return safeCall(request, "DELETE", `/system/secrets/${enc}`);
    case "dataset":
      return safeCall(request, "DELETE", `/products/lake/lakes/default/datasets/${enc}`);
  }
}

/**
 * APPLY: only after the operator confirmed `ready`. Never throws for an HTTP
 * answer; a void is re-planned by the caller, never retried.
 */
export async function applySourceTeardown(ports: TeardownPorts, ready: ReadyTeardown): Promise<ApplyTeardownOutcome> {
  const { groupId, input } = ready;
  const grouped = groupRequest(ports.cribl, groupId);
  const request = ports.onCommitStep ? observeCommitDeploy(grouped, ports.onCommitStep) : grouped;
  const outcomes = new Map<TeardownObjectKind, TeardownStepOutcome>();
  for (const s of ready.steps) {
    outcomes.set(s.kind, {
      kind: s.kind,
      id: s.id,
      result: s.verdict.kind === "already-gone" ? "already-gone" : s.verdict.kind === "keep" ? "kept" : "not-reached",
      detail: s.verdict.kind === "keep" ? s.verdict.detail : s.verdict.kind === "already-gone" ? "Already gone." : "Not reached.",
    });
  }
  const set = (kind: TeardownObjectKind, result: TeardownStepResult, detail: string, denied = false): void => {
    const prev = outcomes.get(kind);
    if (prev === undefined) return;
    outcomes.set(kind, { kind, id: prev.id, result, detail, ...(denied ? { denied: true as const } : {}) });
  };
  let commit: TeardownCommitResult = { kind: "not-needed" };
  // True only once the group is known to run a commit without this source's pending changes.
  let settled = false;
  const finish = (kind: ApplyTeardownOutcome["kind"], why: string): ApplyTeardownOutcome => {
    const steps = ready.steps.map((s) => outcomes.get(s.kind) as TeardownStepOutcome);
    const results: Partial<Record<TeardownObjectKind, TeardownStepResult>> = {};
    for (const s of steps) results[s.kind] = s.result;
    const records = recordsAfterTeardown({ criblSource: input.criblSource, lakeRoute: input.lakeRoute, results, committed: settled });
    const outcome: ApplyTeardownOutcome = { kind, steps, commit, records, detail: why };
    const log = { groupId, sourceId: input.sourceId, results: steps.map((s) => `${s.kind}:${s.result}`).join(","), commit: commit.kind };
    if (kind === "removed") ports.logger?.info(`${TEARDOWN_LOG_PREFIX} removed`, log);
    else ports.logger?.warn(`${TEARDOWN_LOG_PREFIX} ${kind}`, log);
    return outcome;
  };

  // 0. The commit the confirm described must not have grown, BEFORE any write.
  if (ready.markers.length > 0) {
    const scope = await scopeFor(request, groupId, ready.markers);
    if (scope.kind === "refused") return finish("stopped", scope.detail);
    if (commitScopeGrew(ready.scope, scope.scope)) {
      return finish(
        "void",
        `Since the confirm, more uncommitted work appeared in the files this commit carries (${scope.scope.alreadyDirty.join(", ") || "could not tell which"}). Nothing was changed; check again and confirm the new scope.`,
      );
    }
  }

  const removedGroup: TeardownObjectKind[] = [];
  let stopped: string | null = null;
  let voided = false;

  /** Re-read and re-plan, then this kind's fresh verdict. */
  const freshVerdict = async (kind: TeardownObjectKind) => {
    const { reads } = await readAll(ports.cribl, request, input, kind === "dataset");
    const plan = planCriblTeardown(input, reads);
    if (plan.kind === "refused") return { kind: "refused" as const, detail: plan.detail, denied: plan.denied === true };
    const step = plan.steps.find((s) => s.kind === kind);
    return step === undefined ? { kind: "refused" as const, detail: "it is no longer in this app's records", denied: false } : { kind: "step" as const, step };
  };

  const runDelete = async (kind: Exclude<TeardownObjectKind, "route">, id: string): Promise<boolean> => {
    const fresh = await freshVerdict(kind);
    if (fresh.kind === "refused") {
      set(kind, "failed", `${stepWord(kind)} ${id} was not removed: ${fresh.detail}`, fresh.denied);
      stopped = `${stepWord(kind)} ${id}: ${fresh.detail}`;
      return false;
    }
    const v = fresh.step.verdict;
    if (v.kind === "already-gone") {
      set(kind, "already-gone", `${stepWord(kind)} ${id} was already gone.`);
      return true;
    }
    if (v.kind === "keep") {
      set(kind, "kept", `${stepWord(kind)} ${id} changed since the confirm and was kept: ${v.detail}`, v.denied === true);
      stopped = `${stepWord(kind)} ${id} changed since the confirm. ${v.detail}`;
      voided = true;
      return false;
    }
    const r = await sendDelete(request, kind, id);
    if (r.status === 404 || isOk(r.status)) {
      set(kind, r.status === 404 ? "already-gone" : "removed", r.status === 404 ? `${stepWord(kind)} ${id} was already gone.` : `${stepWord(kind)} ${id} was removed.`);
      return true;
    }
    const denied = isDenied(r.status);
    const why = denied
      ? `Cribl refused removing ${stepWord(kind).toLowerCase()} ${id} (HTTP ${r.status}): this account may lack the permission. It was not removed.`
      : `${httpDetail(`Removing ${stepWord(kind).toLowerCase()} ${id} failed`, r)}. Whether it is gone is unknown; check Cribl.`;
    set(kind, "failed", why, denied);
    stopped = why;
    return false;
  };

  // 1-4. The group objects, in the plan's order.
  for (const step of ready.steps) {
    if (step.kind === "dataset" || step.verdict.kind !== "delete") continue;
    if (step.kind === "route") {
      const rw = ready.routeWrite;
      if (rw === null) {
        set("route", "failed", `Route ${step.id}: the plan carried no routing-table write.`);
        stopped = `Route ${step.id}: the plan carried no routing-table write.`;
        break;
      }
      const target = routesWriteTarget(groupId, rw.tableId);
      const stamp = stampFor(APP_ID);
      // Synchronous: the route about to go must still carry the app's stamp.
      const freshCheck = (fresh: Record<string, unknown>): string | null => {
        const rows = Array.isArray(fresh["routes"]) ? (fresh["routes"] as unknown[]) : [];
        const row = rows.find((r) => typeof r === "object" && r !== null && (r as Record<string, unknown>)["id"] === step.id) as Record<string, unknown> | undefined;
        if (row === undefined) return null; // gone already: the diff compare says so
        return typeof row["description"] === "string" && row["description"].includes(stamp)
          ? null
          : `Route ${step.id} no longer carries this app's stamp, so it was kept.`;
      };
      let written;
      try {
        written = await writeApproved(request, target, { routes: rw.routes }, rw.diff, undefined, (fresh) => freshCheck(fresh));
      } catch (error) {
        set("route", "failed", `The routes write for ${step.id} got no answer (${errorText(error)}); whether it applied is unknown. Check routing table ${rw.tableId}.`);
        stopped = `Route ${step.id}: no answer.`;
        break;
      }
      if (written.kind === "void") {
        set("route", "kept", `Routing table ${rw.tableId} changed since the confirm; route ${step.id} was kept.`);
        stopped = `Routing table ${rw.tableId} changed since the confirm. Nothing was removed; check again.`;
        voided = true;
        break;
      }
      if (written.kind === "already-applied") {
        set("route", "already-gone", `Route ${step.id} was already gone.`);
        continue;
      }
      if (written.kind !== "written") {
        const status = written.kind === "unreadable" || written.kind === "refused" ? written.response.status : 0;
        const denied = isDenied(status);
        const why =
          written.kind === "refused-before-write"
            ? written.reason
            : denied
              ? `Cribl refused the routes write (HTTP ${status}): this account may lack the permission. Route ${step.id} was not removed.`
              : `The routes write for ${step.id} did not go through (${written.kind}${status ? `, HTTP ${status}` : ""}). Route ${step.id} was not removed.`;
        set("route", written.kind === "refused-before-write" ? "kept" : "failed", why, denied);
        stopped = why;
        break;
      }
      const stored = await verifyStored(request, target, { routes: rw.routes });
      if (stored.kind !== "stored") {
        const why = `The routes write for ${step.id} was sent, but the read-back did not confirm it (${stored.kind}). Nothing was committed; check routing table ${rw.tableId} in Cribl.`;
        set("route", "failed", why);
        stopped = why;
        // Written but not verified: never committed (kit rule).
        return finish("stopped", why);
      }
      set("route", "removed", `Route ${step.id} was removed from routing table ${rw.tableId}.`);
      removedGroup.push("route");
      continue;
    }
    const ok = await runDelete(step.kind, step.id);
    if (outcomes.get(step.kind)?.result === "removed") removedGroup.push(step.kind);
    if (!ok) break;
  }

  if (voided && removedGroup.length === 0) return finish("void", stopped ?? "Changed since the confirm; nothing was removed.");

  // 5. Commit and deploy (also after a stop) ONLY the files of what this run
  // removed. Then settled: nothing pending in the files of anything this
  // source claims gone, and the workers on HEAD.
  let commitOk = true;
  if (removedGroup.length > 0) {
    commitOk = false;
    const markers = teardownCommitMarkers(removedGroup, input.lakeRoute?.pipelineId ?? null);
    const what = removedGroup.map((k) => `${k} ${outcomes.get(k)?.id ?? ""}`).join(", ");
    try {
      const outcome = await commitAndDeploy(request, { group: groupId, markers, message: `${TEARDOWN_LOG_PREFIX}: remove ${what} (${input.sourceId})` });
      if (outcome.kind === "deployed") {
        commitOk = true;
        commit = { ...outcome, detail: teardownCommitDetail(outcome, groupId) };
      } else if (outcome.kind === "nothing-to-commit") {
        // This run deleted something, yet none of its files is pending: they
        // escaped the (unmeasured) markers, so the removals are not committed
        // and the workers still run the old config.
        commit = {
          kind: "unsettled",
          detail: `The removals were made, but Cribl reported none of their files as pending under the paths this app expects, so nothing was committed and they are not live. Check worker group ${groupId}'s pending changes in Cribl.`,
        };
      } else {
        commit = { ...outcome, detail: teardownCommitDetail(outcome, groupId) };
      }
    } catch (error) {
      commit = {
        kind: "commit-sequence-failed",
        detail: `A call in the commit and deploy sequence got no answer (${errorText(error)}); check the group's pending changes in Cribl.`,
      };
    }
  }
  if (commitOk) {
    const check = await settledCheck(request, groupId, ready.watchMarkers);
    settled = check.settled;
    if (!check.settled) {
      commit = commit.kind === "deployed" ? { ...commit, detail: `${commit.detail} ${check.detail}` } : { kind: "unsettled", detail: check.detail };
    }
  }
  const groupDeployed = settled;

  // 6. The dataset, only after the group change is live.
  const datasetStep = ready.steps.find((s) => s.kind === "dataset");
  if (datasetStep !== undefined && datasetStep.verdict.kind === "delete") {
    if (stopped !== null) {
      set("dataset", "not-reached", `Cribl Lake dataset ${datasetStep.id} was kept: an earlier step stopped.`);
    } else if (!groupDeployed) {
      set("dataset", "not-reached", `Cribl Lake dataset ${datasetStep.id} was kept: the route change was not deployed, so a deployed route may still send to it.`);
    } else {
      await runDelete("dataset", datasetStep.id);
    }
  }

  const all = ready.steps.map((s) => outcomes.get(s.kind) as TeardownStepOutcome);
  const planned = all.filter((_s, i) => ready.steps[i]?.verdict.kind === "delete");
  const complete = planned.every((s) => s.result === "removed" || s.result === "already-gone") && groupDeployed && stopped === null;
  // Every planned object's own line, then what happened to the commit.
  const parts = [...planned.map((s) => s.detail), ...(commit.kind === "not-needed" ? [] : [commit.detail])];
  if (complete) return finish("removed", parts.join(" "));
  return finish(voided && removedGroup.length === 0 ? "void" : "stopped", parts.join(" "));
}

/** Every source id that has a record the teardown could act on. */
export function teardownSourceIds(
  criblSources: Readonly<Partial<Record<OnboardingSourceId, CriblSourceRecord>>>,
  lakeRoutes: Readonly<Partial<Record<OnboardingSourceId, LakeRouteRecord>>>,
): OnboardingSourceId[] {
  const ids = new Set<OnboardingSourceId>();
  for (const [k, v] of Object.entries(criblSources)) if (v !== undefined) ids.add(k as OnboardingSourceId);
  for (const [k, v] of Object.entries(lakeRoutes)) if (v !== undefined) ids.add(k as OnboardingSourceId);
  return [...ids].sort();
}
