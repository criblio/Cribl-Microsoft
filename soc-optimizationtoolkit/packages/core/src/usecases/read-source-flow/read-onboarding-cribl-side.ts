/**
 * read-onboarding-cribl-side (AZR-30, ADR 0007 D17): what the onboarding
 * diagram's Cribl side shows for each onboarding input - does the input exist
 * in the worker group, and which route consumes its events.
 *
 * READ ONLY: exactly two GETs against one worker group, GET /system/inputs and
 * GET /routes (the same reads as usecases/live-architecture/
 * fetch-live-architecture.ts SECTION_PATHS). Nothing is written: writing the
 * route is a follow-up story (BRD0 card A).
 *
 * Honesty (claude-kit standards/inventory-honesty.md): a refused, failed or
 * unrecognized inputs read makes EVERY input `unknown`, never `absent`; only a
 * complete, recognized list without the id is `absent`. The same rule holds
 * for routes: an unreadable routing table is `unknown`, never "not routed".
 *
 * Route evaluation follows Cribl's routing table semantics: enabled routes in
 * order, an event is matched by the first route whose filter is true, and it
 * continues past a matching route only when that route is NOT final (a copy).
 * Filters are read with live-architecture's parseRouteFilterInputs; a filter
 * that parser cannot evaluate, reached before a final match, makes the answer
 * `cannot-evaluate` - the app does not guess whether the events stop there.
 * The `__inputId` an input's events carry is `<type>:<id>` (the same form the
 * route filter this app writes uses; live-architecture.ts parseRouteFilterInputs).
 *
 * QuickConnect: an input with `sendToRoutes: false` bypasses the routing table
 * and sends to its `connections` instead (Cribl defaults sendToRoutes to true;
 * only an explicit false counts - the same reading as live-architecture.ts
 * normalizeInput). Such an input reads `quickconnect`, never a route walk. When
 * the input was not read as present (inputs read unknown, or the input absent),
 * the walk still runs but carries `assumesSendToRoutes: true`, so a caller
 * cannot present it as confirmed.
 *
 * A routes body is a routing table only when it carries a real `routes` array
 * ({routes:[...]} or {items:[{routes:[...]}]}). Anything else - including
 * {items:[]} and a table object without `routes` - is `unknown` unexpected-shape,
 * never an empty table and never a phantom route.
 *
 * Never throws. Pure orchestration over the CriblClient port.
 */

import type { CriblClient } from "../../ports/cribl-client";
import { criblEnvelopeItems, readProp } from "../../domain/cribl-api/envelope";
import { parseRouteFilterInputs } from "../../domain/live-architecture";

/** One onboarding input the diagram draws: its Cribl type and id. */
export interface OnboardingInputRef {
  /** 'eventhub' or 'azure_blob'. */
  type: string;
  id: string;
}

export type CriblSideUnknownReason = "denied" | "failed" | "unexpected-shape";

/** Is the input in the worker group? */
export type InputPresence =
  | {
      kind: "present";
      type: string;
      disabled: boolean;
      /** False only when the input explicitly says so (QuickConnect). */
      sendToRoutes: boolean;
      connections: QuickConnection[];
    }
  | { kind: "absent" }
  | { kind: "unknown"; reason: CriblSideUnknownReason; detail: string };

/** One QuickConnect connection on an input: where its events go instead of the routes. */
export interface QuickConnection {
  output: string;
  pipeline?: string;
}

/** One route that receives the input's events. */
export interface ConsumingRoute {
  id: string;
  name: string;
  filter: string;
  /** Undefined when the route names none (Cribl then uses its default). */
  pipeline?: string;
  output?: string;
  final: boolean;
}

/**
 * Set on a route walk when the input was not read as present, so whether it
 * sends to routes at all (vs QuickConnect) was assumed, not confirmed.
 */
export interface WalkAssumption {
  assumesSendToRoutes?: true;
}

/** Which route receives the input's events. */
export type RouteConsumption =
  /**
   * `routes` are every matching route in order; the LAST is the final one that
   * stops the events. Earlier entries are non-final copies.
   */
  | ({ kind: "consumes"; routes: ConsumingRoute[] } & WalkAssumption)
  /** A route the app cannot evaluate comes before any final match. */
  | ({ kind: "cannot-evaluate"; routeId: string; filter: string; copiesBefore: ConsumingRoute[] } & WalkAssumption)
  /** The whole table was read and no final route matches the input. */
  | ({ kind: "not-routed"; copies: ConsumingRoute[] } & WalkAssumption)
  /** The input bypasses the routing table (sendToRoutes false) and sends to these. */
  | { kind: "quickconnect"; connections: QuickConnection[] }
  | { kind: "unknown"; reason: CriblSideUnknownReason; detail: string };

export interface OnboardingCriblInputSide {
  inputId: string;
  inputType: string;
  input: InputPresence;
  route: RouteConsumption;
}

export interface OnboardingCriblSide {
  groupId: string;
  inputs: OnboardingCriblInputSide[];
  /** The calls made, for the (i) popover: method and group-relative path. */
  requests: Array<{ method: "GET"; path: string }>;
}

export const CRIBL_SIDE_PATHS = { inputs: "/system/inputs", routes: "/routes" } as const;

type Read =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "unknown"; reason: CriblSideUnknownReason; detail: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

function bodyText(body: unknown): string {
  return typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body ?? "").slice(0, 200);
}

async function get(cribl: CriblClient, groupId: string, path: string): Promise<Read> {
  try {
    const res = await cribl.request({ method: "GET", path, groupId });
    if (res.status === 401 || res.status === 403) {
      return { kind: "unknown", reason: "denied", detail: `HTTP ${res.status}: ${bodyText(res.body)}` };
    }
    if (res.status < 200 || res.status >= 300) {
      return { kind: "unknown", reason: "failed", detail: `HTTP ${res.status}: ${bodyText(res.body)}` };
    }
    return { kind: "ok", status: res.status, body: res.body };
  } catch (err) {
    return { kind: "unknown", reason: "failed", detail: errorText(err) };
  }
}

interface ListedInput {
  type: string;
  disabled: boolean;
  sendToRoutes: boolean;
  connections: QuickConnection[];
}

type InputsList =
  | { kind: "list"; byId: Map<string, ListedInput> }
  | { kind: "unknown"; reason: CriblSideUnknownReason; detail: string };

function parseInputs(read: Read): InputsList {
  if (read.kind === "unknown") return read;
  const items = criblEnvelopeItems(read.body);
  if (items === null) {
    return { kind: "unknown", reason: "unexpected-shape", detail: "the inputs response is not a list" };
  }
  const byId = new Map<string, ListedInput>();
  for (const item of items) {
    const id = readProp(item, "id");
    if (typeof id !== "string" || id === "") continue;
    const type = readProp(item, "type");
    const nested = readProp(item, "input");
    byId.set(id, {
      type: typeof type === "string" ? type : "",
      disabled: readProp(item, "disabled") === true,
      // Cribl defaults sendToRoutes to true; only an explicit false (what
      // QuickConnect writes) takes the input out of the routing table.
      sendToRoutes: (readProp(item, "sendToRoutes") ?? readProp(nested, "sendToRoutes")) !== false,
      connections: parseConnections(readProp(item, "connections") ?? readProp(nested, "connections")),
    });
  }
  return { kind: "list", byId };
}

function parseConnections(raw: unknown): QuickConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: QuickConnection[] = [];
  for (const entry of raw) {
    const output = readProp(entry, "output");
    if (typeof output !== "string" || output === "") continue;
    const pipeline = readProp(entry, "pipeline");
    out.push({ output, ...(typeof pipeline === "string" && pipeline !== "" ? { pipeline } : {}) });
  }
  return out;
}

export interface RouteRow extends ConsumingRoute {
  disabled: boolean;
}

export type RoutesTable =
  | { kind: "table"; routes: RouteRow[] }
  | { kind: "unknown"; reason: CriblSideUnknownReason; detail: string };

/**
 * A routing table only when the body carries a real `routes` array:
 * {routes:[...]} or {items:[{routes:[...]}]}. Envelope items are never read as
 * route rows themselves - {items:[]} or a table object without `routes` is not
 * a recognized table, so it is unknown rather than empty or a phantom route.
 */
function parseRoutes(read: Read): RoutesTable {
  if (read.kind === "unknown") return read;
  let raw: unknown = readProp(read.body, "routes");
  if (!Array.isArray(raw)) {
    const items = criblEnvelopeItems(read.body);
    raw = items !== null && items.length > 0 ? readProp(items[0], "routes") : undefined;
  }
  if (!Array.isArray(raw)) {
    return { kind: "unknown", reason: "unexpected-shape", detail: "the routes response is not a routing table" };
  }
  const routes: RouteRow[] = [];
  for (const item of raw) {
    const id = readProp(item, "id");
    if (typeof id !== "string" || id === "") continue;
    const name = readProp(item, "name");
    const filter = readProp(item, "filter");
    const pipeline = readProp(item, "pipeline");
    const output = readProp(item, "output");
    routes.push({
      id,
      name: typeof name === "string" && name !== "" ? name : id,
      filter: typeof filter === "string" ? filter : "",
      ...(typeof pipeline === "string" && pipeline !== "" ? { pipeline } : {}),
      ...(typeof output === "string" && output !== "" ? { output } : {}),
      final: readProp(item, "final") !== false,
      disabled: readProp(item, "disabled") === true,
    });
  }
  return { kind: "table", routes };
}

function strip(row: RouteRow): ConsumingRoute {
  const { disabled: _disabled, ...route } = row;
  return route;
}

/** Pure: walk the routing table for one input's `__inputId`. Exported for the tests. */
export function routeConsumption(table: RoutesTable, inputIdValue: string): RouteConsumption {
  if (table.kind === "unknown") return table;
  const matched: ConsumingRoute[] = [];
  for (const row of table.routes) {
    if (row.disabled) continue;
    const parsed = parseRouteFilterInputs(row.filter);
    if (parsed.kind === "unparsed") {
      return { kind: "cannot-evaluate", routeId: row.id, filter: row.filter, copiesBefore: matched };
    }
    const hit =
      parsed.kind === "all" ||
      (parsed.kind === "inputs" && parsed.ids.includes(inputIdValue)) ||
      (parsed.kind === "prefix" && inputIdValue.startsWith(parsed.value));
    if (!hit) continue;
    matched.push(strip(row));
    if (row.final) return { kind: "consumes", routes: matched };
  }
  return { kind: "not-routed", copies: matched };
}

/** Pure: QuickConnect beats the walk; a walk without a present input is marked assumed. */
function routeFor(input: InputPresence, table: RoutesTable, inputIdValue: string): RouteConsumption {
  if (input.kind === "present" && !input.sendToRoutes) {
    return { kind: "quickconnect", connections: input.connections };
  }
  const walked = routeConsumption(table, inputIdValue);
  if (input.kind === "present" || walked.kind === "unknown" || walked.kind === "quickconnect") return walked;
  return { ...walked, assumesSendToRoutes: true };
}

/** Read the Cribl side for the given onboarding inputs. Two GETs; never throws. */
export async function readOnboardingCriblSide(
  cribl: CriblClient,
  groupId: string,
  inputs: readonly OnboardingInputRef[],
): Promise<OnboardingCriblSide> {
  const requests: OnboardingCriblSide["requests"] = [
    { method: "GET", path: CRIBL_SIDE_PATHS.inputs },
    { method: "GET", path: CRIBL_SIDE_PATHS.routes },
  ];
  if (!groupId) {
    const none = { kind: "unknown" as const, reason: "failed" as const, detail: "no worker group selected; nothing was read" };
    return {
      groupId,
      requests: [],
      inputs: inputs.map((ref) => ({ inputId: ref.id, inputType: ref.type, input: none, route: none })),
    };
  }
  const [inputsRead, routesRead] = await Promise.all([
    get(cribl, groupId, CRIBL_SIDE_PATHS.inputs),
    get(cribl, groupId, CRIBL_SIDE_PATHS.routes),
  ]);
  const list = parseInputs(inputsRead);
  const table = parseRoutes(routesRead);
  return {
    groupId,
    requests,
    inputs: inputs.map((ref) => {
      let input: InputPresence;
      if (list.kind === "unknown") input = list;
      else {
        const found = list.byId.get(ref.id);
        input = found
          ? {
              kind: "present",
              type: found.type,
              disabled: found.disabled,
              sendToRoutes: found.sendToRoutes,
              connections: found.connections,
            }
          : { kind: "absent" };
      }
      return { inputId: ref.id, inputType: ref.type, input, route: routeFor(input, table, `${ref.type}:${ref.id}`) };
    }),
  };
}
