/**
 * route-insert - add routes to a worker group's routing table without touching
 * anyone else's (DBT-301). PLAN (read-only, before the confirm), then APPLY
 * (after the person approved the plan's diff). Shared: wire-source uses it with
 * position `top`; AZR-35 (route an onboarding input to Sentinel) reuses it with
 * an operator-chosen position.
 *
 * THE ENDPOINT. The bundled spec (cribl-openapi.json) has no PUT /routes. It
 * documents GET /routes (list), GET /routes/{id} (one table) and
 * PATCH /routes/{id}, whose description reads: "This endpoint does not support
 * partial updates. Cribl removes any omitted fields when updating the Routing
 * table ... Cribl also removes any omitted Routes". So the PATCH is a FULL
 * REPLACEMENT of the table object, and this module sends the whole table.
 *
 * PLAN, in order:
 *   1. GET /m/<g>/routes              - the listing; parseRoutesListing gives
 *                                       the table id (never assumed)
 *   2. insertRoutes (pure)            - position + conflicts -> the new array
 *   3. GET /m/<g>/routes/<tableId>    - the kit's planChange: the diff the
 *                                       confirm shows. A table whose routes
 *                                       differ from step 1's is refused
 *                                       ('table-moved'): plan again.
 *   4. GET /m/<g>/version/status      - the kit's commitScope; unplaced or
 *                                       unreadable refuses before any confirm
 *
 * APPLY, in order (no request between 6 and 7):
 *   5. GET /m/<g>/version/status      - commitScopeGrew -> void ('scope-grew')
 *   6. GET /m/<g>/routes/<tableId>    - the kit's writeApproved re-read; a diff
 *                                       other than the approved one is void;
 *                                       then the SYNCHRONOUS FreshCheck re-runs
 *                                       the conflict check on that re-read
 *   7. PATCH /m/<g>/routes/<tableId>  - the merged table, every key round-tripped
 *   8. GET /m/<g>/routes/<tableId>    - the kit's verifyStored; anything but
 *                                       stored is written-not-verified and is
 *                                       NEVER committed
 *   9. the kit's commitAndDeploy      - status, commit {message, files},
 *                                       status, HEAD, deploy (products, master
 *                                       on 404)
 *
 * Never throws for an HTTP outcome: every path ends in a named outcome. A
 * transport rejection is caught too, and says whether the PATCH had been sent.
 */

import {
  insertRoutes,
  parseRoutesListing,
  routeInsertFreshCheck,
  type NewRoute,
  type RouteConflict,
  type RouteInsertRequest,
  type RoutePosition,
  type RouteRowSnapshot,
} from "../../domain/routes-table";
import type { InputIdRef } from "../../domain/capture-filter";
import {
  commitAndDeploy,
  commitScope,
  commitScopeGrew,
  observeCommitDeploy,
  pendingFiles,
  type CommitDeployOutcome,
  type CommitDeployStep,
  type CommitScope,
} from "../../kit/config-writes/commitDeploy";
import {
  planChange,
  sameValue,
  verifyStored,
  writeApproved,
  type DiffRow,
  type WriteTarget,
} from "../../kit/config-writes/readModifyWrite";
import { isOk, type ApiResponse, type Request } from "../../kit/config-writes/transport";
import { commitDeployTimeouts, criblRequestFor } from "../../kit/cribl-request";
import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";

/**
 * The file a routes write dirties, relative to the group's directory.
 * NOT MEASURED LIVE: that PATCH /routes/{id} dirties exactly
 * `groups/<g>/local/cribl/pipelines/route.yml` is the kit's own example marker
 * (cribl-config-writes SKILL, "Markers are paths relative to the group
 * directory"), not a status read taken after a routes write on a real leader.
 * If the leader reports another path, commitAndDeploy answers
 * `nothing-to-commit` (the write stays uncommitted, and the outcome says so) -
 * it never commits a file it was not told about.
 */
export const ROUTE_COMMIT_MARKERS: readonly string[] = ["local/cribl/pipelines/route.yml"];

/** Longer wait for the commit and deploy calls (as create-cribl-source). */
export const ROUTE_INSERT_COMMIT_TIMEOUT_MS = 60_000;

/** The listing path, group-relative (sent as /m/<g>/routes; written as a literal at its call so the request scan reads it). */
export const ROUTES_LIST_PATH = "/routes";

/** The one-table path the kit reads and PATCHes. */
export function routesTablePath(groupId: string, tableId: string): string {
  return `/m/${encodeURIComponent(groupId)}/routes/${encodeURIComponent(tableId)}`;
}

/**
 * The write target for one routing table.
 *
 * `routes: replace` is safe HERE, although the list is shared: the new array is
 * built from the PLANNING read, and writeApproved re-reads the table after the
 * answer and compares diffs (sameDiff). If anyone changed, added, removed or
 * reordered a route since the plan, the re-read's `routes` differs from the
 * one the approved diff was computed against, so the diff differs and the
 * approval is VOID - nothing is written. Every OTHER key of the table object
 * (`id`, `groups`, `comments`, anything this app has never heard of) is not in
 * the change, so the kit's deepMerge carries it over from the fresh read:
 * under the documented full replacement a dropped key would be a deleted key.
 * `byId` would not do: an insert is an add at a position, which byId refuses
 * by design (it never appends or reorders a shared list).
 */
export function routesWriteTarget(groupId: string, tableId: string): WriteTarget {
  return {
    path: routesTablePath(groupId, tableId),
    method: "PATCH",
    arrays: { routes: { kind: "replace" } },
  };
}

export interface RouteInsertPorts {
  readonly cribl: CriblClient;
  readonly logger?: Logger;
  /**
   * Called with every commit-path status (reads included), so a shell's write
   * gate can latch a 401/403 under that step's policy path (the kit's
   * observeCommitDeploy). Optional; an observer never changes an outcome.
   */
  readonly onCommitStep?: (step: CommitDeployStep, method: string, path: string, status: number) => void;
}

export interface PlanRouteInsertInput extends RouteInsertRequest {
  readonly groupId: string;
  /** The commit message the apply uses. */
  readonly commitMessage: string;
}

/** The routing table as the confirm and a position picker show it. */
export interface RoutesTableSnapshot {
  readonly tableId: string;
  /** How many elements the routes array holds (rows this module can name may be fewer). */
  readonly routeCount: number;
  readonly rows: readonly RouteRowSnapshot[];
}

/** A plan the person can approve. Everything the apply needs, nothing secret. */
export interface ReadyRouteInsert {
  readonly groupId: string;
  readonly tableId: string;
  readonly input: InputIdRef;
  readonly position: RoutePosition;
  /** Where the first new route lands. */
  readonly index: number;
  readonly newRoutes: readonly NewRoute[];
  /** The whole routes array the write sends (the kit change `{routes}`). */
  readonly routes: readonly unknown[];
  /** The kit diff the person approves. */
  readonly diff: readonly DiffRow[];
  readonly table: RoutesTableSnapshot;
  readonly uncheckable: readonly RouteRowSnapshot[];
  readonly shadowedBy: readonly RouteRowSnapshot[];
  readonly scope: CommitScope;
  /** Every file the commit can carry, in the group's tree: an upper bound. */
  readonly commitFiles: readonly string[];
  readonly commitMessage: string;
}

export type PlanRouteInsertRefusalReason =
  | "routes-unreadable"
  | "unexpected-shape"
  | "no-routes"
  | "duplicate-new-id"
  | "filter-not-for-input"
  | "before-missing"
  | "conflicts"
  | "table-unreadable"
  | "table-moved"
  | "nothing-to-change"
  | "status-unknown"
  | "scope-unplaced";

export type PlanRouteInsertResult =
  | { readonly kind: "ready"; readonly ready: ReadyRouteInsert }
  | {
      readonly kind: "refused";
      readonly reason: PlanRouteInsertRefusalReason;
      readonly detail: string;
      /** Set for 'conflicts': each existing route that refuses the insert. */
      readonly conflicts?: readonly RouteConflict[];
      readonly uncheckable?: readonly RouteRowSnapshot[];
      /** The table, when it was read: a position picker can still show it. */
      readonly table?: RoutesTableSnapshot;
    };

/** The kit Request for one group, with the longer commit and deploy wait. */
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

/** The commit files a confirm names, as full paths under the group. */
export function routeCommitFiles(groupId: string): string[] {
  return ROUTE_COMMIT_MARKERS.map((m) => `groups/${groupId}/${m}`);
}

type ScopeRead =
  | { readonly kind: "ok"; readonly scope: CommitScope }
  | { readonly kind: "refused"; readonly reason: "status-unknown" | "scope-unplaced"; readonly detail: string };

async function readScope(request: Request, groupId: string): Promise<ScopeRead> {
  let pending: string[] | null;
  try {
    pending = await pendingFiles(request);
  } catch {
    pending = null;
  }
  if (pending === null) {
    return {
      kind: "refused",
      reason: "status-unknown",
      detail: "Cribl's pending-change status could not be read, so what a commit would carry is unknown. Nothing was changed.",
    };
  }
  const scope = commitScope(pending, groupId, ROUTE_COMMIT_MARKERS);
  if (scope.unplaced.length > 0) {
    return {
      kind: "refused",
      reason: "scope-unplaced",
      detail: `Pending changes could not be placed in a worker group (${scope.unplaced.join(", ")}), so the commit could not be scoped. Nothing was changed; commit or discard them in Cribl first.`,
    };
  }
  return { kind: "ok", scope };
}

function snapshot(tableId: string, routes: readonly unknown[], rows: readonly RouteRowSnapshot[]): RoutesTableSnapshot {
  return { tableId, routeCount: routes.length, rows };
}

/** PLAN: read-only. Never writes, never throws for an HTTP answer. */
export async function planRouteInsert(ports: RouteInsertPorts, input: PlanRouteInsertInput): Promise<PlanRouteInsertResult> {
  const { groupId } = input;
  const request = groupRequest(ports.cribl, groupId);
  const refuse = (
    reason: PlanRouteInsertRefusalReason,
    detail: string,
    extra: Omit<Extract<PlanRouteInsertResult, { kind: "refused" }>, "kind" | "reason" | "detail"> = {},
  ): PlanRouteInsertResult => {
    ports.logger?.warn("[route-insert] plan refused", { groupId, reason });
    return { kind: "refused", reason, detail, ...extra };
  };

  // 1. The listing: which table, and what it holds.
  let listed: ApiResponse;
  try {
    // Group-relative: the kit request is bound to groupId (/m/<g>/routes).
    listed = await request("GET", "/routes");
  } catch (error) {
    return refuse("routes-unreadable", `The routing table could not be read (${errorText(error)}). Nothing was changed.`);
  }
  if (!isOk(listed.status)) {
    return refuse("routes-unreadable", `${httpDetail("The routing table could not be read", listed)}. Nothing was changed.`);
  }
  const parsed = parseRoutesListing(listed.body);
  if (parsed.kind !== "table") {
    return refuse("unexpected-shape", `The routing table answer was not understood (${parsed.detail}), so nothing was changed.`);
  }
  const table = snapshot(parsed.tableId, parsed.routes, parsed.rows);

  // 2. Position and conflicts.
  const inserted = insertRoutes(parsed, input);
  if (inserted.kind === "refused") {
    const r = inserted.refusal;
    if (r.kind === "conflicts") {
      return refuse("conflicts", r.detail, { conflicts: r.conflicts, uncheckable: r.uncheckable, table });
    }
    return refuse(r.kind, r.detail, { table });
  }

  // 3. The kit's plan read of the one table, and the diff the confirm shows.
  const target = routesWriteTarget(groupId, parsed.tableId);
  const changes = { routes: inserted.routes };
  let plan;
  try {
    plan = await planChange(request, target, changes);
  } catch (error) {
    return refuse("table-unreadable", `Routing table ${parsed.tableId} could not be read (${errorText(error)}). Nothing was changed.`, { table });
  }
  if (plan.kind === "unreadable") {
    return refuse("table-unreadable", `${httpDetail(`Routing table ${parsed.tableId} could not be read`, plan.response)}. Nothing was changed.`, { table });
  }
  // The new array was built from step 1. If step 3 read different routes, the
  // diff would describe reverting someone's change: plan again instead.
  if (!sameValue(plan.before["routes"], parsed.routes)) {
    return refuse("table-moved", `Routing table ${parsed.tableId} changed while it was being read. Nothing was changed; check again.`, { table });
  }
  if (plan.kind === "nothing-to-do") {
    return refuse("nothing-to-change", "The routing table already holds exactly these routes; there is nothing to change.", { table });
  }

  // 4. What the commit would carry.
  const scope = await readScope(request, groupId);
  if (scope.kind === "refused") return refuse(scope.reason, scope.detail, { table });

  ports.logger?.info("[route-insert] planned", { groupId, tableId: parsed.tableId, index: inserted.index });
  return {
    kind: "ready",
    ready: {
      groupId,
      tableId: parsed.tableId,
      input: input.input,
      position: input.position,
      index: inserted.index,
      newRoutes: input.routes,
      routes: inserted.routes,
      diff: plan.diff,
      table,
      uncheckable: inserted.uncheckable,
      shadowedBy: inserted.shadowedBy,
      scope: scope.scope,
      commitFiles: routeCommitFiles(groupId),
      commitMessage: input.commitMessage,
    },
  };
}

/** Which check said the stored table is not what was sent. */
export type NotVerifiedCheck = "mismatch" | "missing-element" | "unreadable" | "read-failed";

/**
 * Every way an apply ends. Before the write: scope-refused, void,
 * already-applied, unreadable, refused-before-write, refused, transport-failed.
 * After it: written-not-verified (never committed), then every commitAndDeploy
 * outcome BY ITS OWN NAME (deployed, nothing-to-commit, status-unknown,
 * scope-unknown, newer-commit, head-unknown, committed-unknown-hash,
 * commit-failed, incomplete, unverified, deploy-failed), plus
 * commit-sequence-failed when a call in it rejected. Each carries `detail`,
 * worded for the operator.
 */
export type ApplyRouteInsertOutcome =
  | { readonly kind: "scope-refused"; readonly reason: "status-unknown" | "scope-unplaced"; readonly detail: string }
  | {
      readonly kind: "void";
      readonly cause: "scope-grew" | "table-moved";
      readonly detail: string;
      readonly approved?: readonly DiffRow[];
      readonly now?: readonly DiffRow[];
    }
  | { readonly kind: "already-applied"; readonly detail: string }
  | { readonly kind: "unreadable"; readonly status: number; readonly detail: string }
  | { readonly kind: "refused-before-write"; readonly detail: string }
  | { readonly kind: "refused"; readonly status: number; readonly detail: string }
  | { readonly kind: "transport-failed"; readonly writeSent: boolean; readonly detail: string }
  | { readonly kind: "written-not-verified"; readonly check: NotVerifiedCheck; readonly detail: string }
  | (CommitDeployOutcome & { readonly detail: string })
  | { readonly kind: "commit-sequence-failed"; readonly detail: string };

/** One commitAndDeploy outcome, worded. Written routes are named as written. */
export function commitOutcomeDetail(outcome: CommitDeployOutcome, groupId: string): string {
  switch (outcome.kind) {
    case "deployed":
      return `Committed ${outcome.hash} (${outcome.files.join(", ")}) and deployed it to worker group ${groupId}.`;
    case "nothing-to-commit":
      return "The routes were written, but Cribl reported no routes file as pending, so nothing was committed or deployed. Check the group's pending changes in Cribl.";
    case "status-unknown":
      return `The routes were written, but the pending-change status could not be read (HTTP ${outcome.response.status}); nothing was committed.`;
    case "scope-unknown":
      return `The routes were written, but pending changes could not be placed in a group (${outcome.unplaced.join(", ")}); nothing was committed.`;
    case "newer-commit":
      return `The routes were written and committed as ${outcome.hash}, but ${outcome.head} is newer; deploying would roll it back, so nothing was deployed.`;
    case "head-unknown":
      return `The routes were written and committed as ${outcome.hash}, but the newest commit could not be read (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "committed-unknown-hash":
      return "The routes were written; the commit call succeeded but named no commit, so nothing was deployed. Check the group's commit history in Cribl before retrying.";
    case "commit-failed":
      return `The routes were written, but the commit was refused (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "incomplete":
      return `The routes were written and committed as ${outcome.hash}, but ${outcome.leftBehind.join(", ")} is still pending; nothing was deployed.`;
    case "unverified":
      return `The routes were written and committed as ${outcome.hash}, but the status re-read failed (HTTP ${outcome.response.status}); nothing was deployed.`;
    case "deploy-failed":
      return `The routes were written and committed as ${outcome.hash}; the deploy via the ${outcome.route} path was refused (HTTP ${outcome.response.status}).`;
  }
}

/**
 * APPLY: only after the person approved `ready.diff`. Never throws for an HTTP
 * answer; a void is re-planned by the caller, never retried.
 */
export async function applyRouteInsert(ports: RouteInsertPorts, ready: ReadyRouteInsert): Promise<ApplyRouteInsertOutcome> {
  const { groupId, tableId } = ready;
  const log = { groupId, tableId };
  // Track whether the write left, so a rejection can say what may have happened.
  let writeSent = false;
  // Every commit-path status - the pre-write scope read included - reaches the
  // shell's gate (the kit's observeCommitDeploy only reacts to those steps).
  const grouped = groupRequest(ports.cribl, groupId);
  const base = ports.onCommitStep ? observeCommitDeploy(grouped, ports.onCommitStep) : grouped;
  const target = routesWriteTarget(groupId, tableId);
  const request: Request = (method, path, options) => {
    if (method === target.method && path === target.path) writeSent = true;
    return base(method, path, options);
  };
  const end = (outcome: ApplyRouteInsertOutcome): ApplyRouteInsertOutcome => {
    if (outcome.kind === "deployed") ports.logger?.info("[route-insert] deployed", { ...log, hash: outcome.hash });
    else ports.logger?.warn("[route-insert] apply ended", { ...log, kind: outcome.kind });
    return outcome;
  };

  // 5. The commit the confirm described must not have grown (a request of its
  // own, so it runs BEFORE the re-read).
  const scope = await readScope(request, groupId);
  if (scope.kind === "refused") return end({ kind: "scope-refused", reason: scope.reason, detail: scope.detail });
  if (commitScopeGrew(ready.scope, scope.scope)) {
    return end({
      kind: "void",
      cause: "scope-grew",
      detail: `Since the confirm, more uncommitted work appeared in the file this commit carries (${scope.scope.alreadyDirty.join(", ") || "could not tell which"}). Nothing was changed; check again and confirm the new scope.`,
    });
  }

  // 6-7. Re-read, compare diffs, synchronous conflict re-check, write.
  const changes = { routes: ready.routes };
  const freshCheck = routeInsertFreshCheck({ input: ready.input, routes: ready.newRoutes });
  let written;
  try {
    written = await writeApproved(request, target, changes, ready.diff, undefined, (fresh) => freshCheck(fresh));
  } catch (error) {
    return end({
      kind: "transport-failed",
      writeSent,
      detail: writeSent
        ? `The routes write got no answer (${errorText(error)}); whether Cribl applied it is unknown. Check routing table ${tableId} in Cribl before retrying.`
        : `Routing table ${tableId} could not be re-read (${errorText(error)}). Nothing was changed.`,
    });
  }
  switch (written.kind) {
    case "void":
      return end({
        kind: "void",
        cause: "table-moved",
        detail: written.missing ?? `Routing table ${tableId} changed since the confirm. Nothing was changed; check again and confirm what it would change now.`,
        approved: written.approved,
        now: written.now,
      });
    case "already-applied":
      return end({ kind: "already-applied", detail: `Routing table ${tableId} already holds exactly these routes; nothing was written, committed or deployed.` });
    case "unreadable":
      return end({
        kind: "unreadable",
        status: written.response.status,
        detail: `${httpDetail(`Routing table ${tableId} could not be re-read`, written.response)}. Nothing was changed.`,
      });
    case "refused-before-write":
      return end({ kind: "refused-before-write", detail: `${written.reason} Nothing was changed.` });
    case "refused":
      return end({
        kind: "refused",
        status: written.response.status,
        detail: `${httpDetail("Cribl refused the routes write", written.response)}. Nothing was changed.`,
      });
    case "written":
      break;
  }

  // 8. Read it back. Anything but stored is never committed.
  const stored = await verifyStored(request, target, changes);
  if (stored.kind !== "stored") {
    const why =
      stored.kind === "mismatch"
        ? `Cribl stored ${stored.mismatches.map((m) => m.path).join(", ")} differently from what was sent`
        : stored.kind === "missing-element"
          ? stored.message
          : stored.kind === "unreadable"
            ? httpDetail("the read-back failed", stored.response)
            : `the read-back got no answer (${errorText(stored.error)})`;
    return end({
      kind: "written-not-verified",
      check: stored.kind,
      detail: `The routes were written, but ${why}. Nothing was committed or deployed; check routing table ${tableId} in Cribl.`,
    });
  }

  // 9. Commit and deploy, the kit's sequence (observed through `request`).
  let outcome: CommitDeployOutcome;
  try {
    outcome = await commitAndDeploy(request, { group: groupId, markers: ROUTE_COMMIT_MARKERS, message: ready.commitMessage });
  } catch (error) {
    return end({
      kind: "commit-sequence-failed",
      detail: `The routes were written, but a call in the commit and deploy sequence got no answer (${errorText(error)}); check the group's pending changes in Cribl.`,
    });
  }
  return end({ ...outcome, detail: commitOutcomeDetail(outcome, groupId) });
}

