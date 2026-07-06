/**
 * wireSource - apply the pure source-wiring plan through the CriblClient
 * (porting-plan Unit 20 task item 8, the post-deploy wiring action).
 *
 * The ROUTE ORDER SEMANTICS are decided in the PURE planner (source-wiring.ts,
 * where they are exhaustively pinned); this applier just executes the plan:
 *
 *   1. (Lake only) create the Cribl Lake dataset - 409/"exists" is success.
 *   2. GET the group's routes, PREPEND the plan's routes (in evaluation order,
 *      skipping ids that already exist), PUT the merged config back. Prepending
 *      in evaluation order reproduces the legacy successive-unshift result while
 *      keeping the order the pure plan guarantees (Lake non-final BEFORE the
 *      final Sentinel route).
 *   3. commit the group config, then deploy to every worker group.
 *
 * Endpoint paths are PINNED (porting-plan: no legacy multi-endpoint fallback
 * guessing arrays). Pure orchestration over the CriblClient port; no IO of its
 * own, no Date/crypto.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { PortHttpResponse } from "../../ports/http";
import {
  planSourceWiring,
  prependRoutes,
  type RouteEntry,
  type SourceWiringInput,
} from "./source-wiring";

/** Cribl API paths used by the wiring (pinned from the OpenAPI spec). */
export const ROUTES_API_PATH = "/routes";
export const LAKE_DATASETS_API_PATH = "/system/lake/datasets";
export const COMMIT_API_PATH = "/version/commit";
export const deployApiPath = (group: string): string =>
  `/master/groups/${group}/deploy`;

/** The ports {@link wireSource} uses. */
export interface WireSourcePorts {
  cribl: CriblClient;
}

/** The result of a wiring run. */
export interface WireSourceResult {
  /** The routes array PUT back to the group, in final evaluation order. */
  appliedRoutes: RouteEntry[];
  /** Whether a Lake dataset create was attempted. */
  datasetCreated: boolean;
  /** The commit hash returned, or null when nothing was committed. */
  committed: string | null;
  /** Worker groups the config was deployed to. */
  deployedGroups: string[];
  /** Non-fatal warnings (e.g. deploy failed on one group). */
  warnings: string[];
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Extract the routes array from a /routes GET body ({ id, routes } shape). */
function existingRoutesOf(body: unknown): Array<{ id?: string }> {
  const routes = prop(body, "routes");
  return Array.isArray(routes) ? (routes as Array<{ id?: string }>) : [];
}

/**
 * Wire a Cribl source to a deployed pack: create routes (Sentinel + optional
 * Lake) in the correct evaluation order, commit, and deploy. Rejects only on a
 * transport failure; API 4xx/5xx on commit/deploy are recorded as warnings so a
 * partial success still returns a usable result (the routes were applied).
 *
 * @throws Error when the plan is invalid (blank source/pack) or the routes GET/
 *   PUT fails (the wiring cannot proceed without applying the routes).
 */
export async function wireSource(
  ports: WireSourcePorts,
  input: SourceWiringInput,
): Promise<WireSourceResult> {
  const { cribl } = ports;
  const plan = planSourceWiring(input);
  const group = plan.deployGroups[0];
  if (group === undefined) {
    throw new Error("wireSource: at least one worker group is required");
  }
  const warnings: string[] = [];

  // 1. Lake dataset (create-if-new; 409 is success).
  let datasetCreated = false;
  if (plan.createDataset !== null) {
    const resp = await cribl.request({
      method: "POST",
      path: LAKE_DATASETS_API_PATH,
      body: { id: plan.createDataset },
    });
    if (is2xx(resp.status) || resp.status === 409) {
      datasetCreated = true;
    } else {
      warnings.push(`lake dataset create: HTTP ${resp.status}`);
    }
  }

  // 2. GET routes -> prepend plan routes -> PUT merged config.
  const getResp: PortHttpResponse = await cribl.request({
    method: "GET",
    path: ROUTES_API_PATH,
    groupId: group,
  });
  if (!is2xx(getResp.status)) {
    throw new Error(`wireSource: GET routes failed (HTTP ${getResp.status})`);
  }
  const existing = existingRoutesOf(getResp.body);
  const appliedRoutes = prependRoutes(existing, plan.routes);
  const configId =
    typeof prop(getResp.body, "id") === "string"
      ? (prop(getResp.body, "id") as string)
      : "default";
  const putResp = await cribl.request({
    method: "PUT",
    path: ROUTES_API_PATH,
    groupId: group,
    body: { id: configId, routes: appliedRoutes },
  });
  if (!is2xx(putResp.status)) {
    throw new Error(`wireSource: PUT routes failed (HTTP ${putResp.status})`);
  }

  // 3. Commit.
  let committed: string | null = null;
  const commitResp = await cribl.request({
    method: "POST",
    path: COMMIT_API_PATH,
    groupId: group,
    body: { message: plan.commitMessage },
  });
  if (is2xx(commitResp.status)) {
    const version = prop(commitResp.body, "version") ?? prop(commitResp.body, "commit");
    committed = typeof version === "string" ? version : "committed";
  } else {
    warnings.push(`commit: HTTP ${commitResp.status}`);
  }

  // 4. Deploy to every worker group.
  const deployedGroups: string[] = [];
  for (const g of plan.deployGroups) {
    const deployResp = await cribl.request({
      method: "PATCH",
      path: deployApiPath(g),
      body: committed !== null ? { version: committed } : {},
    });
    if (is2xx(deployResp.status)) {
      deployedGroups.push(g);
    } else {
      warnings.push(`deploy ${g}: HTTP ${deployResp.status}`);
    }
  }

  return { appliedRoutes, datasetCreated, committed, deployedGroups, warnings };
}
