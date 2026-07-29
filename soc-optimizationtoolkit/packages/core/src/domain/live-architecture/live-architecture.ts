/**
 * live-architecture - the REAL configured flow of a Cribl Stream worker
 * group as a PatternDiagram (2026-07-29 user direction: "showcase what
 * already exists related to an Azure source or destination"). The usecase
 * fetches six config sections per group; EVERYTHING else - tolerant
 * parsing, flow assembly, Azure filtering, per-node info - happens here so
 * it is fully unit-testable.
 *
 * STAGE MODEL (the user's seven stages): per input `in -> breaker(s) ->
 * pre-processing pipeline -> Routes`; the routing table is ONE hub node
 * (all events enter one ordered table - per-route ingress edges would be
 * O(inputs x routes) spaghetti); per route `Routes -> pack | pipeline |
 * direct -> post-processing pipeline -> output`. One node per DISTINCT
 * config object: a ruleset shared by three inputs is one fan-in node - the
 * diagram shows what exists and what references what, not per-event
 * multiplicity.
 *
 * HONESTY RULES: disabled elements are skipped and NOTED, never silently
 * dropped; unrecognized route filters over-approximate to "any input" with
 * a note; non-final routes are labeled "(copy)"; every degradation of the
 * snapshot (failed section, dangling reference) lands in notes[].
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type {
  DiagramEdge,
  DiagramNode,
  DiagramNodeInfo,
  EdgeCostTier,
  PatternDiagram,
} from "../architecture-patterns";

const CRIBL = "https://docs.cribl.io";
const PACKS = "https://packs.cribl.io";

// ---------------------------------------------------------------------------
// Snapshot types (raw sections in, exactly as CriblClient.request resolved)
// ---------------------------------------------------------------------------

/** One raw section response; body is the ALREADY-PARSED JSON (unknown). */
export interface LiveSnapshotSection {
  status: number;
  body: unknown;
}

/**
 * The six raw GET responses for one worker group. A section is undefined
 * when the request REJECTED (transport failure); HTTP errors arrive with
 * their status/body.
 */
export interface LiveArchitectureSnapshot {
  groupId: string;
  /** GET /system/inputs */
  inputs?: LiveSnapshotSection;
  /** GET /system/outputs */
  outputs?: LiveSnapshotSection;
  /** GET /routes */
  routes?: LiveSnapshotSection;
  /** GET /pipelines */
  pipelines?: LiveSnapshotSection;
  /** GET /lib/breakers */
  breakers?: LiveSnapshotSection;
  /** GET /packs */
  packs?: LiveSnapshotSection;
}

export interface BuildLiveDiagramOptions {
  /** Keep only flows whose input OR output is Azure-typed. */
  azureOnly: boolean;
}

export interface LiveDiagramResult {
  diagram: PatternDiagram;
  /** User-visible caveats, deduped, stable order. Empty = clean snapshot. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Normalized shapes (exported for tests)
// ---------------------------------------------------------------------------

export interface LiveInput {
  id: string;
  type: string;
  disabled: boolean;
  /** Pre-processing pipeline id, when configured. */
  pipeline?: string;
  breakerRulesets: readonly string[];
  conf: Record<string, unknown>;
}

export interface LiveOutput {
  id: string;
  type: string;
  /** Post-processing pipeline id, when configured. */
  pipeline?: string;
  /** Set when type === "default": the real output it points at. */
  defaultId?: string;
  conf: Record<string, unknown>;
}

export interface LiveRoute {
  id: string;
  name: string;
  filter?: string;
  pipeline?: string;
  output?: string;
  final: boolean;
  disabled: boolean;
}

export interface LivePipeline {
  id: string;
  functionCount: number;
  disabledFunctionCount: number;
  /** The first few function ids, for the purpose line. */
  functionIds: readonly string[];
}

export interface LiveBreaker {
  id: string;
  description?: string;
  ruleCount: number;
}

export interface LivePack {
  id: string;
  displayName?: string;
  version?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Small pure helpers (individually pinned)
// ---------------------------------------------------------------------------

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The route filter's consumed inputs, parsed from the cheap known forms. */
export type RouteFilterInputs =
  | { kind: "inputs"; ids: readonly string[] }
  | { kind: "all" }
  | { kind: "unparsed" };

/**
 * Parse the filter forms this app (and common configs) write:
 * `__inputId=='x'` / `__inputId==="x"`, `['a','b'].includes(__inputId)`,
 * missing or `true` = all inputs; anything else = unparsed (treated as all,
 * with a note - honest over-approximation).
 */
export function parseRouteFilterInputs(filter: string | undefined): RouteFilterInputs {
  const trimmed = (filter ?? "").trim();
  if (trimmed === "" || trimmed === "true") {
    return { kind: "all" };
  }
  const single = /^__inputId\s*===?\s*['"]([^'"]+)['"]$/.exec(trimmed);
  if (single !== null) {
    return { kind: "inputs", ids: [single[1]] };
  }
  const list = /^\[([^\]]+)\]\.includes\(\s*__inputId\s*\)$/.exec(trimmed);
  if (list !== null) {
    const ids = [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (ids.length > 0) {
      return { kind: "inputs", ids };
    }
  }
  return { kind: "unparsed" };
}

/** Is a Cribl input/output TYPE Azure-related? (prefix rule + known names) */
export function isAzureCriblType(kind: "input" | "output", type: string): boolean {
  const t = type.toLowerCase();
  if (t.startsWith("azure")) {
    return true;
  }
  if (kind === "input") {
    return t === "eventhub" || t.startsWith("office365");
  }
  return t.startsWith("sentinel");
}

/** Azure check for inputs, including collection inputs over Azure collectors. */
export function isAzureInput(input: Pick<LiveInput, "type" | "conf">): boolean {
  if (isAzureCriblType("input", input.type)) {
    return true;
  }
  if (input.type.toLowerCase() === "collection") {
    const collectorType = asString(prop(prop(input.conf, "collector"), "type"));
    return collectorType !== "" && isAzureCriblType("input", collectorType);
  }
  return false;
}

/** Billing tier of the edge INTO an output (same rule the catalog pins). */
export function outputCostTier(type: string): EdgeCostTier | undefined {
  const t = type.toLowerCase();
  if (t === "sentinel" || t === "azure_logs") {
    return "premium";
  }
  if (t.startsWith("azure") || t === "cribl_lake" || t === "dataset") {
    return "economical";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tolerant section parsing
// ---------------------------------------------------------------------------

/** Extract the item list from an `array | {items} | {data}` envelope. */
function envelopeItems(body: unknown): unknown[] | null {
  if (Array.isArray(body)) {
    return body;
  }
  const items = prop(body, "items") ?? prop(body, "data");
  return Array.isArray(items) ? items : null;
}

/** Parse one section; failures yield [] plus ONE note. */
function parseSection(
  section: LiveSnapshotSection | undefined,
  name: string,
  omitted: string,
  notes: string[],
): unknown[] {
  if (section === undefined) {
    notes.push(`${name} could not be fetched; ${omitted} omitted.`);
    return [];
  }
  if (section.status < 200 || section.status >= 300) {
    notes.push(`${name} returned HTTP ${section.status}; ${omitted} omitted.`);
    return [];
  }
  const items = envelopeItems(section.body);
  if (items === null) {
    notes.push(`${name} response not recognized; ${omitted} omitted.`);
    return [];
  }
  return items;
}

/** The /routes body: a routes-table object, possibly wrapped in an envelope. */
function parseRoutesSection(
  section: LiveSnapshotSection | undefined,
  notes: string[],
): LiveRoute[] {
  if (section === undefined) {
    notes.push("Routes could not be fetched; the routing stage is omitted.");
    return [];
  }
  if (section.status < 200 || section.status >= 300) {
    notes.push(`Routes returned HTTP ${section.status}; the routing stage is omitted.`);
    return [];
  }
  // Accept {routes:[...]}, {items:[{routes:[...]}]}, or a bare array.
  let raw: unknown = prop(section.body, "routes");
  if (!Array.isArray(raw)) {
    const items = envelopeItems(section.body);
    if (items !== null && items.length > 0) {
      const first = prop(items[0], "routes");
      raw = Array.isArray(first) ? first : items;
    }
  }
  if (!Array.isArray(raw)) {
    notes.push("Routes response not recognized; the routing stage is omitted.");
    return [];
  }
  const routes: LiveRoute[] = [];
  for (const item of raw) {
    const id = asString(prop(item, "id"));
    if (id === "") {
      continue;
    }
    const pipeline = asString(prop(item, "pipeline"));
    const output = asString(prop(item, "output"));
    const filter = asString(prop(item, "filter"));
    routes.push({
      id,
      name: asString(prop(item, "name")) || id,
      ...(filter !== "" ? { filter } : {}),
      ...(pipeline !== "" ? { pipeline } : {}),
      ...(output !== "" ? { output } : {}),
      final: prop(item, "final") !== false,
      disabled: prop(item, "disabled") === true,
    });
  }
  return routes;
}

function normalizeInput(item: unknown): LiveInput | null {
  const id = asString(prop(item, "id"));
  if (id === "") {
    return null;
  }
  const pipeline = asString(prop(item, "pipeline"));
  const rulesets = prop(item, "breakerRulesets");
  return {
    id,
    type: asString(prop(item, "type")) || "unknown",
    disabled: prop(item, "disabled") === true,
    ...(pipeline !== "" ? { pipeline } : {}),
    breakerRulesets: Array.isArray(rulesets)
      ? rulesets.filter((r): r is string => typeof r === "string" && r !== "")
      : [],
    conf: asRecord(item),
  };
}

function normalizeOutput(item: unknown): LiveOutput | null {
  const id = asString(prop(item, "id"));
  if (id === "") {
    return null;
  }
  const pipeline = asString(prop(item, "pipeline"));
  const defaultId =
    asString(prop(item, "defaultId")) || asString(prop(prop(item, "conf"), "defaultId"));
  return {
    id,
    type: asString(prop(item, "type")) || "unknown",
    ...(pipeline !== "" ? { pipeline } : {}),
    ...(defaultId !== "" ? { defaultId } : {}),
    conf: asRecord(item),
  };
}

function normalizePipeline(item: unknown): LivePipeline | null {
  const id = asString(prop(item, "id"));
  if (id === "") {
    return null;
  }
  const functions = prop(prop(item, "conf"), "functions");
  const list = Array.isArray(functions) ? functions : [];
  return {
    id,
    functionCount: list.length,
    disabledFunctionCount: list.filter((f) => prop(f, "disabled") === true).length,
    functionIds: list
      .slice(0, 3)
      .map((f) => asString(prop(f, "id")))
      .filter((f) => f !== ""),
  };
}

function normalizeBreaker(item: unknown): LiveBreaker | null {
  const id = asString(prop(item, "id"));
  if (id === "") {
    return null;
  }
  const rules = prop(item, "rules");
  const description = asString(prop(item, "description"));
  return {
    id,
    ...(description !== "" ? { description } : {}),
    ruleCount: Array.isArray(rules) ? rules.length : 0,
  };
}

function normalizePack(item: unknown): LivePack | null {
  const id = asString(prop(item, "id")) || asString(prop(item, "name"));
  if (id === "") {
    return null;
  }
  const displayName = asString(prop(item, "displayName"));
  const version = asString(prop(item, "version"));
  const description = asString(prop(item, "description"));
  return {
    id,
    ...(displayName !== "" ? { displayName } : {}),
    ...(version !== "" ? { version } : {}),
    ...(description !== "" ? { description } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-node info composition
// ---------------------------------------------------------------------------

/** docs.cribl.io slugs for KNOWN types only - everything else falls back. */
const INPUT_DOC_SLUGS: Record<string, string> = {
  eventhub: "/stream/sources-azure-event-hubs/",
  azure_blob: "/stream/sources-azure-blob/",
  syslog: "/stream/sources-syslog/",
};

const OUTPUT_DOC_SLUGS: Record<string, string> = {
  sentinel: "/stream/destinations-sentinel/",
  azure_data_explorer: "/stream/destinations-azure-data-explorer/",
  azure_blob: "/stream/destinations-azure-blob/",
  azure_eventhub: "/stream/destinations-azure-event-hubs/",
};

function inputInfo(input: LiveInput): DiagramNodeInfo {
  const details: string[] = [`Live '${input.type}' source '${input.id}'.`];
  const conf = input.conf;
  if (input.type === "collection") {
    const collectorType = asString(prop(prop(conf, "collector"), "type"));
    const schedule = asString(prop(conf, "schedule")) || asString(prop(prop(conf, "schedule"), "cronSchedule"));
    if (collectorType !== "") {
      details.push(`Scheduled '${collectorType}' collector${schedule !== "" ? ` (${schedule})` : ""}.`);
    }
  }
  const container = asString(prop(conf, "containerName"));
  if (container !== "") {
    details.push(`Container '${container}'.`);
  }
  if (input.breakerRulesets.length > 0) {
    details.push(`Event breaker ruleset(s): ${input.breakerRulesets.join(", ")}.`);
  }
  if (input.pipeline !== undefined) {
    details.push(`Pre-processed by '${input.pipeline}'.`);
  }
  const slug = INPUT_DOC_SLUGS[input.type.toLowerCase()];
  return {
    purpose: details.join(" "),
    docs: [
      slug !== undefined
        ? { label: `Cribl ${input.type} source`, url: CRIBL + slug }
        : { label: "Cribl Stream sources", url: CRIBL + "/stream/sources/" },
    ],
  };
}

function outputInfo(output: LiveOutput): DiagramNodeInfo {
  const details: string[] = [`Live '${output.type}' destination '${output.id}'.`];
  if (output.pipeline !== undefined) {
    details.push(`Post-processed by '${output.pipeline}'.`);
  }
  const slug = OUTPUT_DOC_SLUGS[output.type.toLowerCase()];
  return {
    purpose: details.join(" "),
    docs: [
      slug !== undefined
        ? { label: `Cribl ${output.type} destination`, url: CRIBL + slug }
        : { label: "Cribl Stream destinations", url: CRIBL + "/stream/destinations/" },
    ],
  };
}

function pipelineInfo(kind: string, id: string, pipeline: LivePipeline | undefined): DiagramNodeInfo {
  const purpose =
    pipeline !== undefined
      ? `${kind} pipeline '${id}': ${pipeline.functionCount} function(s)` +
        (pipeline.disabledFunctionCount > 0
          ? ` (${pipeline.disabledFunctionCount} disabled)`
          : "") +
        (pipeline.functionIds.length > 0
          ? `. Starts with: ${pipeline.functionIds.join(", ")}.`
          : ".")
      : `Referenced ${kind.toLowerCase()} pipeline '${id}' (details unavailable).`;
  return {
    purpose,
    docs: [{ label: "Cribl pipelines", url: CRIBL + "/stream/pipelines/" }],
  };
}

function breakerInfo(id: string, breaker: LiveBreaker | undefined): DiagramNodeInfo {
  return {
    purpose:
      breaker !== undefined
        ? `Event breaker ruleset '${id}': ${breaker.ruleCount} rule(s).` +
          (breaker.description !== undefined ? ` ${breaker.description}` : "")
        : `Referenced event breaker ruleset '${id}' (details unavailable).`,
    docs: [{ label: "Cribl event breakers", url: CRIBL + "/stream/event-breakers/" }],
  };
}

function packInfo(name: string, pack: LivePack | undefined): DiagramNodeInfo {
  return {
    purpose:
      pack !== undefined
        ? `Installed pack '${pack.displayName ?? name}'` +
          (pack.version !== undefined ? ` v${pack.version}` : "") +
          (pack.description !== undefined ? `. ${pack.description}` : ".")
        : `Route references pack '${name}', which is not in the installed pack list.`,
    docs: [
      { label: "Cribl packs", url: CRIBL + "/stream/packs/" },
      { label: "Pack dispensary", url: PACKS + "/" },
    ],
  };
}

function routesHubInfo(groupId: string, routes: readonly LiveRoute[]): DiagramNodeInfo {
  const lines = routes
    .slice(0, 8)
    .map((r, i) => `${i + 1}. ${r.name} -> ${r.output ?? "default"}`);
  const more = routes.length > 8 ? ` (+${routes.length - 8} more)` : "";
  return {
    purpose:
      `Routing table for worker group '${groupId}': ${routes.length} route(s), ` +
      `evaluated top-down. ${lines.join("; ")}${more}`,
    docs: [{ label: "Cribl routes", url: CRIBL + "/stream/routes/" }],
  };
}

// ---------------------------------------------------------------------------
// buildLiveDiagram
// ---------------------------------------------------------------------------

/** A flow triple: which input reaches which output through which route. */
interface FlowTriple {
  input: LiveInput | null;
  route: LiveRoute;
  output: LiveOutput | null;
}

function truncateIds(ids: readonly string[]): string {
  return ids.length <= 5
    ? ids.join(", ")
    : `${ids.slice(0, 5).join(", ")} +${ids.length - 5} more`;
}

/** Build the live diagram from a snapshot. Never throws. */
export function buildLiveDiagram(
  snapshot: LiveArchitectureSnapshot,
  options: BuildLiveDiagramOptions,
): LiveDiagramResult {
  const notes: string[] = [];

  // --- 1. Parse every section tolerantly -----------------------------------
  const inputsAvailable = snapshot.inputs !== undefined;
  const allInputs = parseSection(snapshot.inputs, "Sources", "the source stage is", notes)
    .map(normalizeInput)
    .filter((i): i is LiveInput => i !== null);
  const allOutputs = parseSection(
    snapshot.outputs,
    "Destinations",
    "the destination stage is",
    notes,
  )
    .map(normalizeOutput)
    .filter((o): o is LiveOutput => o !== null);
  const allRoutes = parseRoutesSection(snapshot.routes, notes);
  const pipelines = parseSection(snapshot.pipelines, "Pipelines", "pipeline details are", notes)
    .map(normalizePipeline)
    .filter((p): p is LivePipeline => p !== null);
  const breakers = parseSection(
    snapshot.breakers,
    "Event breakers",
    "breaker details are",
    notes,
  )
    .map(normalizeBreaker)
    .filter((b): b is LiveBreaker => b !== null);
  const packs = parseSection(snapshot.packs, "Packs", "pack details are", notes)
    .map(normalizePack)
    .filter((p): p is LivePack => p !== null);

  const pipelineById = new Map(pipelines.map((p) => [p.id, p]));
  const breakerById = new Map(breakers.map((b) => [b.id, b]));
  const packById = new Map(packs.map((p) => [p.id, p]));
  const outputById = new Map(allOutputs.map((o) => [o.id, o]));
  const inputById = new Map(allInputs.map((i) => [i.id, i]));

  // --- 2. Disabled skips ----------------------------------------------------
  const disabledInputs = allInputs.filter((i) => i.disabled);
  const inputs = allInputs.filter((i) => !i.disabled);
  if (disabledInputs.length > 0) {
    notes.push(
      `Skipped ${disabledInputs.length} disabled input(s): ` +
        `${truncateIds(disabledInputs.map((i) => i.id))}.`,
    );
  }
  const disabledRoutes = allRoutes.filter((r) => r.disabled);
  const routes = allRoutes.filter((r) => !r.disabled);
  if (disabledRoutes.length > 0) {
    notes.push(`Skipped ${disabledRoutes.length} disabled route(s).`);
  }

  // --- 3. Output resolution (the "default" indirection) ---------------------
  const defaultOutput = allOutputs.find((o) => o.type === "default" || o.id === "default");
  const resolveOutput = (ref: string | undefined): LiveOutput | null => {
    const target = ref ?? "default";
    if (target === "default") {
      if (defaultOutput?.defaultId !== undefined) {
        return outputById.get(defaultOutput.defaultId) ?? null;
      }
      return null;
    }
    return outputById.get(target) ?? null;
  };

  // --- 4. Triples ------------------------------------------------------------
  const triples: FlowTriple[] = [];
  const unparsedFilterRoutes: string[] = [];
  const unknownInputRefs: string[] = [];
  const matchedInputIds = new Set<string>();
  let allFiltersSpecific = true;
  for (const route of routes) {
    const parsed = parseRouteFilterInputs(route.filter);
    let consumed: Array<LiveInput | null>;
    if (parsed.kind === "inputs") {
      consumed = [];
      for (const id of parsed.ids) {
        const input = inputById.get(id);
        if (input === undefined) {
          if (inputsAvailable) {
            unknownInputRefs.push(`${route.name}: ${id}`);
          }
          continue;
        }
        if (!input.disabled) {
          consumed.push(input);
        }
      }
      if (consumed.length === 0) {
        consumed = [null];
      }
    } else {
      allFiltersSpecific = false;
      if (parsed.kind === "unparsed") {
        unparsedFilterRoutes.push(route.name);
      }
      consumed = inputs.length > 0 ? inputs : [null];
    }
    const output = resolveOutput(route.output);
    for (const input of consumed) {
      if (input !== null) {
        matchedInputIds.add(input.id);
      }
      triples.push({ input, route, output });
    }
  }
  for (const name of unparsedFilterRoutes.slice(0, 5)) {
    notes.push(`Route '${name}': filter not recognized; assuming it can match any input.`);
  }
  if (unknownInputRefs.length > 0) {
    notes.push(
      `Route filter(s) name unknown input id(s): ${truncateIds(unknownInputRefs)}.`,
    );
  }
  const danglingOutputs = routes.filter(
    (r) => r.output !== undefined && r.output !== "default" && !outputById.has(r.output),
  );
  if (danglingOutputs.length > 0 && snapshot.outputs !== undefined) {
    notes.push(
      `Route(s) reference unknown output(s): ` +
        `${truncateIds(danglingOutputs.map((r) => `${r.name}: ${r.output ?? ""}`))}.`,
    );
  }
  if (
    routes.some((r) => (r.output ?? "default") === "default") &&
    defaultOutput?.defaultId === undefined &&
    snapshot.outputs !== undefined
  ) {
    notes.push("The 'default' output could not be resolved to a real destination.");
  }

  // --- 5. Azure filter -------------------------------------------------------
  const keep = (triple: FlowTriple): boolean => {
    if (!options.azureOnly) {
      return true;
    }
    const inputAzure = triple.input !== null && isAzureInput(triple.input);
    const outputAzure =
      triple.output !== null && isAzureCriblType("output", triple.output.type);
    return inputAzure || outputAzure;
  };
  const kept = triples.filter(keep);
  if (options.azureOnly && kept.length < triples.length) {
    const keptInputs = new Set(
      kept.filter((t) => t.input !== null).map((t) => t.input!.id),
    );
    const keptOutputs = new Set(
      kept.filter((t) => t.output !== null).map((t) => t.output!.id),
    );
    notes.push(
      `Azure filter: showing ${keptInputs.size} of ${inputs.length} input(s) and ` +
        `${keptOutputs.size} of ${allOutputs.length} output(s).`,
    );
  }

  // --- 6. Emit nodes and edges ----------------------------------------------
  const nodes = new Map<string, DiagramNode>();
  const edges = new Map<string, DiagramEdge>();
  const addNode = (node: DiagramNode): void => {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  };
  const addEdge = (edge: DiagramEdge): void => {
    const key = `${edge.from}>${edge.to}`;
    const existing = edges.get(key);
    if (existing === undefined) {
      edges.set(key, edge);
      return;
    }
    // Shared edge: aggregate route-name labels (2 names, then +N).
    if (edge.label !== undefined && edge.label !== existing.label) {
      const parts = (existing.label ?? "").split(", ");
      const plusMatch = /^\+(\d+)$/.exec(parts[parts.length - 1] ?? "");
      if (plusMatch !== null) {
        parts[parts.length - 1] = `+${Number(plusMatch[1]) + 1}`;
      } else if (parts.filter((p) => p !== "").length >= 2) {
        parts.push("+1");
      } else if (existing.label !== undefined && existing.label !== "") {
        parts.push(edge.label);
      } else {
        parts[0] = edge.label;
      }
      edges.set(key, { ...existing, label: parts.filter((p) => p !== "").join(", ") });
    }
  };

  const hubNeeded = kept.length > 0;
  if (hubNeeded) {
    addNode({
      id: "routes",
      label: "Routes",
      tier: "cribl",
      info: routesHubInfo(snapshot.groupId, routes),
    });
  }

  // Source side: in -> brk* -> pre? -> routes.
  for (const triple of kept) {
    const input = triple.input;
    if (input === null) {
      continue;
    }
    const inputNodeId = `in:${input.id}`;
    addNode({
      id: inputNodeId,
      label: input.id,
      tier: "source",
      info: inputInfo(input),
    });
    let previous = inputNodeId;
    for (const ruleset of input.breakerRulesets) {
      const breakerNodeId = `brk:${ruleset}`;
      addNode({
        id: breakerNodeId,
        label: ruleset,
        tier: "cribl",
        info: breakerInfo(ruleset, breakerById.get(ruleset)),
      });
      addEdge({ from: previous, to: breakerNodeId });
      previous = breakerNodeId;
    }
    if (input.pipeline !== undefined) {
      const preNodeId = `pre:${input.pipeline}`;
      addNode({
        id: preNodeId,
        label: input.pipeline,
        tier: "cribl",
        info: pipelineInfo("Pre-processing", input.pipeline, pipelineById.get(input.pipeline)),
      });
      addEdge({ from: previous, to: preNodeId });
      previous = preNodeId;
    }
    addEdge({ from: previous, to: "routes" });
  }

  // Egress side: routes -> (pack | pipe | direct) -> post? -> out.
  const keptRoutes = new Map<string, FlowTriple>();
  for (const triple of kept) {
    if (!keptRoutes.has(triple.route.id)) {
      keptRoutes.set(triple.route.id, triple);
    }
  }
  for (const triple of keptRoutes.values()) {
    const route = triple.route;
    const routeLabel = route.final ? route.name : `${route.name} (copy)`;
    let previous = "routes";

    const pipelineRef = route.pipeline ?? "passthru";
    if (pipelineRef.startsWith("pack:")) {
      const packName = pipelineRef.slice("pack:".length);
      const packNodeId = `pack:${packName}`;
      addNode({
        id: packNodeId,
        label: packName,
        tier: "cribl",
        info: packInfo(packName, packById.get(packName)),
      });
      addEdge({ from: previous, to: packNodeId, label: routeLabel });
      previous = packNodeId;
    } else if (pipelineRef !== "passthru" && pipelineRef !== "") {
      const pipeNodeId = `pipe:${pipelineRef}`;
      addNode({
        id: pipeNodeId,
        label: pipelineRef,
        tier: "cribl",
        info: pipelineInfo("Route", pipelineRef, pipelineById.get(pipelineRef)),
      });
      addEdge({ from: previous, to: pipeNodeId, label: routeLabel });
      previous = pipeNodeId;
    }

    // Resolve the destination node (real, lake-synthesized, or placeholder).
    let outputNode: DiagramNode;
    let costType: string;
    if (triple.output !== null) {
      outputNode = {
        id: `out:${triple.output.id}`,
        label: triple.output.id,
        tier: "destination",
        info: outputInfo(triple.output),
      };
      costType = triple.output.type;
    } else if ((route.output ?? "").startsWith("cribl_lake:")) {
      const dataset = (route.output ?? "").slice("cribl_lake:".length);
      outputNode = {
        id: `out:${route.output}`,
        label: `Lake: ${dataset}`,
        tier: "destination",
        info: {
          purpose: `Cribl Lake dataset '${dataset}' (route output reference).`,
          docs: [{ label: "Cribl Lake docs", url: CRIBL + "/lake/" }],
        },
      };
      costType = "cribl_lake";
    } else {
      const ref = route.output ?? "default";
      outputNode = {
        id: `out:${ref}`,
        label: ref,
        tier: "destination",
        info: {
          purpose: `Route output '${ref}' could not be resolved to a configured destination.`,
          docs: [{ label: "Cribl Stream destinations", url: CRIBL + "/stream/destinations/" }],
        },
      };
      costType = "";
    }
    addNode(outputNode);

    if (triple.output?.pipeline !== undefined) {
      const postNodeId = `post:${triple.output.pipeline}`;
      addNode({
        id: postNodeId,
        label: triple.output.pipeline,
        tier: "cribl",
        info: pipelineInfo(
          "Post-processing",
          triple.output.pipeline,
          pipelineById.get(triple.output.pipeline),
        ),
      });
      addEdge({
        from: previous,
        to: postNodeId,
        ...(previous === "routes" ? { label: routeLabel } : {}),
      });
      previous = postNodeId;
    }

    const cost = outputCostTier(costType);
    addEdge({
      from: previous,
      to: outputNode.id,
      ...(previous === "routes" ? { label: routeLabel } : {}),
      ...(cost !== undefined ? { cost } : {}),
    });
  }

  // --- 7. Remaining notes ----------------------------------------------------
  const nonFinal = [...keptRoutes.values()]
    .filter((t) => !t.route.final)
    .map((t) => t.route.name);
  if (nonFinal.length > 0) {
    notes.push(
      `Non-final route(s) copy events and continue to later routes: ` +
        `${truncateIds(nonFinal)}.`,
    );
  }
  const packRefs = routes
    .map((r) => r.pipeline ?? "")
    .filter((p) => p.startsWith("pack:"))
    .map((p) => p.slice("pack:".length));
  const missingPacks = [...new Set(packRefs.filter((p) => !packById.has(p)))];
  if (missingPacks.length > 0 && snapshot.packs !== undefined) {
    notes.push(
      `Route(s) reference pack(s) not in the installed list: ${truncateIds(missingPacks)}.`,
    );
  }
  if (allFiltersSpecific && inputsAvailable) {
    const unmatched = inputs.filter((i) => !matchedInputIds.has(i.id));
    if (unmatched.length > 0) {
      notes.push(
        `Enabled input(s) matched by no route: ${truncateIds(unmatched.map((i) => i.id))}.`,
      );
    }
  }
  if (kept.length === 0) {
    notes.push(
      options.azureOnly
        ? `No Azure-related flows found in group '${snapshot.groupId}'.`
        : `No flows to draw in group '${snapshot.groupId}'.`,
    );
  }

  return {
    diagram: { nodes: [...nodes.values()], edges: [...edges.values()] },
    notes: [...new Set(notes)],
  };
}
