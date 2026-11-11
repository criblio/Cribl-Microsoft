/**
 * wireSource - route a Cribl source through a deployed pack to Sentinel (and
 * optionally Cribl Lake), as a PLAN (read-only, before the confirm) and an
 * APPLY (after it). porting-plan Unit 20 task item 8; rebuilt for DBT-301.
 *
 * DBT-301. This used to GET /routes, read `body.routes`, prepend the app's
 * routes and PUT `{id, routes}` back. The leader answers the GET with
 * `{items:[{id, groups, routes:[...]}], count:1}` (measured live 2026-11-10),
 * so `body.routes` read as an empty table and the PUT would have deleted every
 * other route in the group and dropped `groups`. It also committed with no
 * file list and deployed whatever was committed, reporting failures as
 * warnings (DBT-149). The write now goes through the shared route-insert
 * writer (usecases/route-insert): the documented PATCH /routes/{id}, the
 * kit's read-modify-write with a void on drift, a read-back, and the kit's
 * scoped commitAndDeploy. This file only resolves the input and builds the
 * routes.
 *
 * THE ROUTE ORDER SEMANTICS stay in the pure planner (source-wiring.ts, where
 * they are pinned): the plan's routes are inserted at the TOP of the table in
 * plan evaluation order, so a Lake route (non-final) sits directly above the
 * final Sentinel route.
 *
 * THE INPUT TYPE. The route filter is `<type>:<id>` (inputRouteFilter); a bare
 * id matches nothing live. The operator types the source id as before (or
 * `<type>:<id>`); the plan reads the group's inputs list and takes the type
 * from the input Cribl holds. A typed type that disagrees with Cribl's, or an
 * id the list does not show, refuses - the app never guesses a type.
 *
 * PLAN: GET /m/<g>/system/inputs, then route-insert's plan (GET routes, GET
 * routes/<table>, GET version/status). APPLY: the Lake dataset create first
 * (unchanged: POST /system/lake/datasets, 409 is success), then route-insert's
 * apply. Deploys exactly the group the routes were written to.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import { criblEnvelopeItems } from "../../domain/cribl-api/envelope";
import { normalizeInput } from "../../domain/live-architecture/live-architecture";
import type { InputIdRef } from "../../domain/capture-filter";
import type { NewRoute } from "../../domain/routes-table";
import {
  applyRouteInsert,
  planRouteInsert,
  type ApplyRouteInsertOutcome,
  type PlanRouteInsertResult,
  type ReadyRouteInsert,
  type RouteInsertPorts,
} from "../route-insert";
import { planSourceWiring, type LakeFederation, type RouteEntry } from "./source-wiring";
import { is2xx } from "../arm-http";

/** The leader-level Lake dataset create (no /m/ prefix), unchanged. */
export const LAKE_DATASETS_API_PATH = "/system/lake/datasets";
/** The group's inputs list the plan resolves the source's type from. */
export const WIRE_INPUTS_API_PATH = "/system/inputs";

/** The ports {@link planWireSource} and {@link applyWireSource} use. */
export interface WireSourcePorts {
  cribl: CriblClient;
  logger?: Logger;
  onCommitStep?: RouteInsertPorts["onCommitStep"];
}

export interface PlanWireSourceInput {
  /** The worker group whose routing table gets the routes, and which is deployed. */
  groupId: string;
  /** The source as the operator typed it: `<id>` or `<type>:<id>`. */
  source: string;
  packName: string;
  lake?: LakeFederation;
}

/** A wiring the person can approve. */
export interface ReadyWireSource {
  readonly input: InputIdRef;
  /** The filter every new route carries. */
  readonly filter: string;
  /** The routes in evaluation order (Lake first when present). */
  readonly routes: readonly RouteEntry[];
  /** The Lake dataset the apply creates first, or null. */
  readonly createDataset: string | null;
  readonly insert: ReadyRouteInsert;
}

export type WireSourceRefusalReason =
  | "no-group"
  | "bad-source"
  | "inputs-unreadable"
  | "input-not-visible"
  | "input-type-unknown"
  | "input-type-mismatch";

export type PlanWireSourceResult =
  | { readonly kind: "ready"; readonly ready: ReadyWireSource }
  | { readonly kind: "refused"; readonly reason: WireSourceRefusalReason; readonly detail: string }
  /** route-insert refused (conflicts, unexpected shape, scope, ...): its result as is. */
  | { readonly kind: "insert-refused"; readonly result: Extract<PlanRouteInsertResult, { kind: "refused" }> };

/** The Lake create, reported on its own: it is a leader object, outside the group commit. */
export type LakeDatasetResult =
  | { readonly kind: "not-needed" }
  | { readonly kind: "created-or-exists"; readonly dataset: string; readonly status: number }
  | { readonly kind: "failed"; readonly dataset: string; readonly detail: string };

export interface ApplyWireSourceResult {
  readonly dataset: LakeDatasetResult;
  readonly insert: ApplyRouteInsertOutcome;
}

/** Split what the operator typed: `<type>:<id>` or a bare `<id>`. */
export function parseSourceEntry(raw: string): { id: string; type: string | null } | null {
  const text = raw.trim();
  if (text === "") return null;
  const colon = text.indexOf(":");
  if (colon < 0) return { id: text, type: null };
  const type = text.slice(0, colon).trim();
  const id = text.slice(colon + 1).trim();
  if (type === "" || id === "" || id.includes(":")) return null;
  return { id, type };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/** Resolve the typed source against the group's inputs list. */
async function resolveInput(
  cribl: CriblClient,
  groupId: string,
  raw: string,
): Promise<{ kind: "ok"; ref: InputIdRef } | { kind: "refused"; reason: WireSourceRefusalReason; detail: string }> {
  const entry = parseSourceEntry(raw);
  if (entry === null) {
    return { kind: "refused", reason: "bad-source", detail: `"${raw.trim()}" is not a source id. Enter the input's id, or <type>:<id>.` };
  }
  let body: unknown;
  try {
    const r = await cribl.request({ method: "GET", path: WIRE_INPUTS_API_PATH, groupId });
    if (!is2xx(r.status)) {
      return {
        kind: "refused",
        reason: "inputs-unreadable",
        detail: `Worker group ${groupId}'s sources could not be read (HTTP ${r.status}), so the source's type is unknown. Nothing was changed.`,
      };
    }
    body = r.body;
  } catch (error) {
    return {
      kind: "refused",
      reason: "inputs-unreadable",
      detail: `Worker group ${groupId}'s sources could not be read (${errorText(error)}), so the source's type is unknown. Nothing was changed.`,
    };
  }
  const items = criblEnvelopeItems(body);
  if (items === null) {
    return {
      kind: "refused",
      reason: "inputs-unreadable",
      detail: `Worker group ${groupId}'s sources answer was not a list, so the source's type is unknown. Nothing was changed.`,
    };
  }
  const found = items.map((item) => normalizeInput(item, false)).find((input) => input !== null && input.id === entry.id);
  if (found === undefined || found === null) {
    // Inventory honesty: a list this app reads may be filtered by its access.
    return {
      kind: "refused",
      reason: "input-not-visible",
      detail: `No source with id ${entry.id} is visible in worker group ${groupId} (it may not exist there, or this app may not be allowed to see it). Nothing was changed.`,
    };
  }
  if (found.type === "" || found.type === "unknown") {
    return {
      kind: "refused",
      reason: "input-type-unknown",
      detail: `Source ${entry.id} in worker group ${groupId} has no type Cribl reports, so its route filter cannot be written. Nothing was changed.`,
    };
  }
  if (entry.type !== null && entry.type !== found.type) {
    return {
      kind: "refused",
      reason: "input-type-mismatch",
      detail: `Source ${entry.id} in worker group ${groupId} is of type ${found.type}, not ${entry.type}. Nothing was changed.`,
    };
  }
  return { kind: "ok", ref: { type: found.type, id: found.id } };
}

/** The pure planner's route as the writer's NewRoute (drops `position`). */
function asNewRoute(route: RouteEntry & { position: number }): RouteEntry {
  const { position: _position, ...entry } = route;
  void _position;
  return entry;
}

/** PLAN: read-only. Never writes; never throws for an HTTP answer. */
export async function planWireSource(ports: WireSourcePorts, input: PlanWireSourceInput): Promise<PlanWireSourceResult> {
  const groupId = input.groupId.trim();
  if (groupId === "") return { kind: "refused", reason: "no-group", detail: "Select a worker group first. Nothing was changed." };
  const resolved = await resolveInput(ports.cribl, groupId, input.source);
  if (resolved.kind === "refused") return resolved;

  const wiring = planSourceWiring({
    sourceId: resolved.ref.id,
    sourceType: resolved.ref.type,
    packName: input.packName,
    ...(input.lake !== undefined ? { lake: input.lake } : {}),
  });
  const routes = wiring.routes.map(asNewRoute);
  const newRoutes: readonly NewRoute[] = routes;
  const planned = await planRouteInsert(ports, {
    groupId,
    input: resolved.ref,
    routes: newRoutes,
    // The order contract: the plan's routes, in plan order, ahead of every
    // existing route (the legacy successive unshift).
    position: { kind: "top" },
    commitMessage: wiring.commitMessage,
  });
  if (planned.kind === "refused") return { kind: "insert-refused", result: planned };
  return {
    kind: "ready",
    ready: { input: resolved.ref, filter: wiring.filter, routes, createDataset: wiring.createDataset, insert: planned.ready },
  };
}

/**
 * APPLY: only after the person approved the plan. The Lake dataset (a leader
 * object outside the group commit) is created first, as before; then the
 * route-insert apply re-checks, writes, verifies, commits and deploys.
 */
export async function applyWireSource(ports: WireSourcePorts, ready: ReadyWireSource): Promise<ApplyWireSourceResult> {
  let dataset: LakeDatasetResult = { kind: "not-needed" };
  if (ready.createDataset !== null) {
    const id = ready.createDataset;
    try {
      const r = await ports.cribl.request({ method: "POST", path: LAKE_DATASETS_API_PATH, body: { id } });
      dataset =
        is2xx(r.status) || r.status === 409
          ? { kind: "created-or-exists", dataset: id, status: r.status }
          : { kind: "failed", dataset: id, detail: `Creating Cribl Lake dataset ${id} was refused (HTTP ${r.status}).` };
    } catch (error) {
      dataset = { kind: "failed", dataset: id, detail: `Creating Cribl Lake dataset ${id} got no answer (${errorText(error)}).` };
    }
  }
  const insert = await applyRouteInsert(ports, ready.insert);
  return { dataset, insert };
}
