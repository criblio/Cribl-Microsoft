/**
 * live-architecture - the REAL configured flow of a Cribl Stream worker
 * group as a PatternDiagram (2026-07-29 user direction: "showcase what
 * already exists related to an Azure source or destination"). The usecase
 * fetches seven config sections per group; EVERYTHING else - tolerant
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
  DiagramDocLink,
  DiagramEdge,
  DiagramFact,
  DiagramNode,
  DiagramNodeInfo,
  DiagramRouteRow,
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
 * The seven raw GET responses for one worker group. A section is undefined
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
  /** GET /jobs - scheduled collectors are JOBS, not /system/inputs. */
  jobs?: LiveSnapshotSection;
  /**
   * Per-pack config reads (GET /p/{pack}/...): an all-inclusive pack carries
   * its OWN sources/routes/pipelines/destinations that group-level sections
   * never see (user question 2026-07-30). Keyed by pack id; a missing key =
   * the pack was not inspected (fetch cap or older usecase).
   */
  packDetails?: Readonly<Record<string, LivePackDetail>>;
}

/** One inspected pack's config sections (each raw, like the group's). */
export interface LivePackDetail {
  /** GET /p/{pack}/system/inputs */
  inputs?: LiveSnapshotSection;
  /** GET /p/{pack}/system/outputs */
  outputs?: LiveSnapshotSection;
  /** GET /p/{pack}/routes */
  routes?: LiveSnapshotSection;
  /** GET /p/{pack}/pipelines */
  pipelines?: LiveSnapshotSection;
}

export interface BuildLiveDiagramOptions {
  /** Keep only flows whose input OR output is Azure-typed. */
  azureOnly: boolean;
  /**
   * Focus on specific sources/destinations (user directive 2026-07-29):
   * when non-empty, only flows FROM a listed input id / INTO a listed
   * output reference survive - and each kept flow keeps everything
   * in-between (breakers, pipelines, the routing table, packs). Output
   * references match the configured output id, or the raw route reference
   * for synthesized nodes ("cribl_lake:{ds}", "default"). Both filters
   * compose with azureOnly.
   */
  focusSources?: readonly string[];
  focusOutputs?: readonly string[];
  /**
   * The flow-inventory selection (user direction 2026-07-30: inventory the
   * complete flows, let the user pick which to render). Keys come from the
   * result's flows[] list; empty/undefined = draw every flow. Composes
   * with azureOnly and the focus filters.
   */
  selectedFlows?: readonly string[];
  /**
   * Pack ids rendered EXPLODED (2026-07-30): the pack card fans out into
   * its internal routing table, pipelines, and destinations instead of
   * hiding them in the popover. Non-listed packs stay collapsed.
   */
  expandedPacks?: readonly string[];
  /**
   * Explode the group ROUTING TABLE (2026-07-30): each route draws as its
   * own node between the Routes hub and its pack/pipeline/destination,
   * carrying the filter and evaluation position in its popover. Collapsed
   * (default), routes stay edge labels off the single hub.
   */
  expandRoutes?: boolean;
  /**
   * Pack ids whose INTERNAL routing table explodes the same way (only
   * meaningful for packs already in expandedPacks - the pack hub node only
   * exists when the pack itself is exploded).
   */
  expandedPackRoutes?: readonly string[];
  /**
   * The Cribl leader UI base (origin plus any product prefix, e.g.
   * "https://main-org.cribl.cloud/stream" or "http://leader:9000"). When
   * set, every live node's info links to ITS page in the Cribl UI (user
   * directive 2026-07-29: navigate to the resource, not the docs) instead
   * of the generic documentation link.
   */
  uiBase?: string;
}

/**
 * Group-scoped Cribl UI pages, appended to `{uiBase}/m/{groupId}`. ONE map
 * so a drifted slug is a one-line fix. Extracted VERBATIM from the Cribl
 * 4.x SaaS UI bundle's route registry (2026-07-29 - the guessed menu-name
 * slugs 404ed): the nav enum is Inputs="inputs", Outputs="outputs",
 * Routes="routes", Pipelines="pipelines", Packs="p"; collectors render at
 * inputs/collectors; the Knowledge tab for breakers is "breakerrules".
 * Item pages confirmed by in-bundle templates: pipelines/{id}, p/{packId}.
 */
const UI_PAGES = {
  sources: "/inputs",
  collectors: "/inputs/collectors",
  destinations: "/outputs",
  routes: "/routes",
  pipelines: "/pipelines",
  breakers: "/knowledge/breakerrules",
  packs: "/p",
} as const;

/**
 * The leader UI base for a configured leader URL: trims, strips trailing
 * slashes, and appends the /stream product prefix for Cribl.Cloud
 * workspaces (on-prem leaders serve the Stream UI at the root). Blank or
 * malformed input yields undefined - the caller simply keeps doc links.
 */
export function criblUiBaseFromLeaderUrl(leaderUrl: string): string | undefined {
  const trimmed = leaderUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return undefined;
  }
  try {
    const host = new URL(trimmed).hostname;
    return host.endsWith(".cribl.cloud") ? `${trimmed}/stream` : trimmed;
  } catch {
    return undefined;
  }
}

/** Replace the generic doc links with the node's own Cribl UI page. */
function withResourceLink(
  info: DiagramNodeInfo,
  link: DiagramDocLink | null,
): DiagramNodeInfo {
  return link === null ? info : { ...info, docs: [link] };
}

export interface LiveDiagramResult {
  diagram: PatternDiagram;
  /** User-visible caveats, deduped, stable order. Empty = clean snapshot. */
  notes: string[];
  /**
   * The COMPLETE flow inventory (2026-07-30), independent of every filter:
   * one entry per group flow (input -> route -> destination) and one per
   * pack with embedded endpoints. The UI lists these for selection; keys
   * feed BuildLiveDiagramOptions.selectedFlows.
   */
  flows: LiveFlowSummary[];
}

/** One complete flow the group runs, as an inventory row. */
export interface LiveFlowSummary {
  /** Stable selection key: "g:{input}>{routeId}>{output}" or "p:{packId}". */
  key: string;
  /** Human line: source -> route (via pack/pipeline) -> destination. */
  label: string;
  /** True when the flow touches an Azure-typed endpoint. */
  azure: boolean;
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
  /**
   * The __inputId values this input's events carry - the id itself plus
   * variants like "collection:{jobId}" for scheduled collector jobs (route
   * filter attribution matches against these).
   */
  aliases: readonly string[];
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

/** One pipeline function, in evaluation order. */
export interface LivePipelineFunction {
  /** The function TYPE id (eval, serde, drop, ...). */
  id: string;
  disabled: boolean;
}

export interface LivePipeline {
  id: string;
  functionCount: number;
  disabledFunctionCount: number;
  /** Every function by type, in order (the popover lists them). */
  functions: readonly LivePipelineFunction[];
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
  | { kind: "prefix"; value: string }
  | { kind: "all" }
  | { kind: "unparsed" };

/**
 * Parse the filter forms this app (and common configs) write:
 * `__inputId=='x'` / `__inputId==="x"`, `['a','b'].includes(__inputId)`,
 * `__inputId.startsWith('collection:')`, missing or `true` = all inputs;
 * anything else = unparsed (treated as all, with a note - honest
 * over-approximation).
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
  const prefix = /^__inputId\.startsWith\(\s*['"]([^'"]+)['"]\s*\)$/.exec(trimmed);
  if (prefix !== null) {
    return { kind: "prefix", value: prefix[1] };
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

/**
 * Normalize one input (or collection JOB). Collection jobs nest the event
 * breaker and pre-processing settings under an `input` sub-object, so both
 * levels are read; jobs additionally answer to the `collection:{id}`
 * __inputId alias route filters match on.
 */
function normalizeInput(item: unknown, isJob: boolean): LiveInput | null {
  const id = asString(prop(item, "id"));
  if (id === "") {
    return null;
  }
  const nested = prop(item, "input");
  const pipeline = asString(prop(item, "pipeline")) || asString(prop(nested, "pipeline"));
  const topRulesets = prop(item, "breakerRulesets");
  const nestedRulesets = prop(nested, "breakerRulesets");
  const rulesets = Array.isArray(topRulesets) ? topRulesets : nestedRulesets;
  const type =
    asString(prop(item, "type")) ||
    (isJob ? "collection" : "unknown");
  return {
    id,
    type,
    disabled: prop(item, "disabled") === true,
    ...(pipeline !== "" ? { pipeline } : {}),
    breakerRulesets: Array.isArray(rulesets)
      ? rulesets.filter((r): r is string => typeof r === "string" && r !== "")
      : [],
    aliases: isJob || type === "collection" ? [id, `collection:${id}`] : [id],
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
    functions: list
      .map((f) => ({
        id: asString(prop(f, "id")),
        disabled: prop(f, "disabled") === true,
      }))
      .filter((f) => f.id !== ""),
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

// Every live popover presents STRUCTURED detail (user direction 2026-07-30:
// all visual "i" should present cleanly): a one-line purpose, labeled fact
// rows, and numbered step pills - never prose dumps.

function inputInfo(input: LiveInput): DiagramNodeInfo {
  const facts: DiagramFact[] = [{ label: "Type", value: input.type }];
  const conf = input.conf;
  if (input.type === "collection") {
    const collectorType = asString(prop(prop(conf, "collector"), "type"));
    if (collectorType !== "") {
      facts.push({ label: "Collector", value: collectorType });
    }
    const schedule =
      asString(prop(conf, "schedule")) ||
      asString(prop(prop(conf, "schedule"), "cronSchedule"));
    if (schedule !== "") {
      facts.push({ label: "Schedule", value: schedule });
    }
  }
  const container = asString(prop(conf, "containerName"));
  if (container !== "") {
    facts.push({ label: "Container", value: container });
  }
  if (input.breakerRulesets.length > 0) {
    facts.push({ label: "Event breakers", value: input.breakerRulesets.join(", ") });
  }
  if (input.pipeline !== undefined) {
    facts.push({ label: "Pre-processing", value: input.pipeline });
  }
  const slug = INPUT_DOC_SLUGS[input.type.toLowerCase()];
  return {
    purpose: `Live source '${input.id}'.`,
    facts,
    docs: [
      slug !== undefined
        ? { label: `Cribl ${input.type} source`, url: CRIBL + slug }
        : { label: "Cribl Stream sources", url: CRIBL + "/stream/sources/" },
    ],
  };
}

function outputInfo(output: LiveOutput): DiagramNodeInfo {
  const facts: DiagramFact[] = [{ label: "Type", value: output.type }];
  if (output.pipeline !== undefined) {
    facts.push({ label: "Post-processing", value: output.pipeline });
  }
  const slug = OUTPUT_DOC_SLUGS[output.type.toLowerCase()];
  return {
    purpose: `Live destination '${output.id}'.`,
    facts,
    docs: [
      slug !== undefined
        ? { label: `Cribl ${output.type} destination`, url: CRIBL + slug }
        : { label: "Cribl Stream destinations", url: CRIBL + "/stream/destinations/" },
    ],
  };
}

/**
 * A pipeline popover: one summary line plus the functions BY TYPE as
 * numbered step pills in evaluation order, disabled ones marked; capped so
 * a monster pipeline stays readable.
 */
function pipelineInfo(kind: string, id: string, pipeline: LivePipeline | undefined): DiagramNodeInfo {
  if (pipeline === undefined) {
    return {
      purpose: `Referenced ${kind.toLowerCase()} pipeline '${id}' (details unavailable).`,
      docs: [{ label: "Cribl pipelines", url: CRIBL + "/stream/pipelines/" }],
    };
  }
  const shown = pipeline.functions.slice(0, 15);
  return {
    purpose:
      `${kind} pipeline - ${pipeline.functionCount} function(s)` +
      (pipeline.disabledFunctionCount > 0
        ? ` (${pipeline.disabledFunctionCount} disabled)`
        : "") +
      "." +
      (pipeline.functions.length > shown.length
        ? ` Showing the first ${shown.length}.`
        : ""),
    steps: shown.map((f) => ({
      name: f.id,
      ...(f.disabled ? { disabled: true } : {}),
    })),
    docs: [{ label: "Cribl pipelines", url: CRIBL + "/stream/pipelines/" }],
  };
}

function breakerInfo(id: string, breaker: LiveBreaker | undefined): DiagramNodeInfo {
  return {
    purpose:
      breaker !== undefined
        ? (breaker.description ?? "Event breaker ruleset.")
        : `Referenced event breaker ruleset '${id}' (details unavailable).`,
    ...(breaker !== undefined
      ? { facts: [{ label: "Rules", value: String(breaker.ruleCount) }] }
      : {}),
    docs: [{ label: "Cribl event breakers", url: CRIBL + "/stream/event-breakers/" }],
  };
}

function packInfo(name: string, pack: LivePack | undefined): DiagramNodeInfo {
  if (pack === undefined) {
    return {
      purpose: `Route references pack '${name}', which is not in the installed pack list.`,
      docs: [
        { label: "Cribl packs", url: CRIBL + "/stream/packs/" },
        { label: "Pack dispensary", url: PACKS + "/" },
      ],
    };
  }
  return {
    purpose: pack.description ?? `Installed pack '${pack.displayName ?? name}'.`,
    facts: [
      { label: "Pack", value: pack.displayName ?? name },
      ...(pack.version !== undefined
        ? [{ label: "Version", value: pack.version }]
        : []),
    ],
    docs: [
      { label: "Cribl packs", url: CRIBL + "/stream/packs/" },
      { label: "Pack dispensary", url: PACKS + "/" },
    ],
  };
}

/**
 * One route as a VISUAL popover row (user direction 2026-07-30: mirror the
 * Cribl UI's route table scaled down - bubbles, not text). The filter rides
 * along for the hover tooltip only.
 */
function routeRow(route: LiveRoute, resolvedDefault: string | null): DiagramRouteRow {
  const pipelineRef = route.pipeline ?? "passthru";
  const pipeline = pipelineRef.startsWith("pack:")
    ? `pack ${pipelineRef.slice("pack:".length)}`
    : pipelineRef === ""
      ? "passthru"
      : pipelineRef;
  const target = route.output ?? "default";
  return {
    name: route.name,
    pipeline,
    destination:
      target === "default" && resolvedDefault !== null
        ? `default (${resolvedDefault})`
        : target,
    ...(route.filter !== undefined ? { filter: route.filter } : {}),
    ...(route.disabled ? { disabled: true } : {}),
    ...(route.final ? {} : { copy: true }),
  };
}

/**
 * An exploded ROUTE NODE's popover: position in the purpose line, then the
 * pipeline and destination as labeled fact rows - NOT the raw filter
 * expression (user report 2026-07-30: the filter dump was noise; it stays
 * one level up in the routing-table hub's popover rows).
 */
function routeEntryParts(
  route: LiveRoute,
  position: number,
  scope: string,
  resolvedDefault: string | null,
  disabled: boolean,
): { purpose: string; facts: DiagramFact[] } {
  const pipelineRef = route.pipeline ?? "passthru";
  const via = pipelineRef.startsWith("pack:")
    ? `pack ${pipelineRef.slice("pack:".length)}`
    : pipelineRef === "passthru" || pipelineRef === ""
      ? "passthru (no processing)"
      : pipelineRef;
  const target = route.output ?? "default";
  const dest =
    target === "default" && resolvedDefault !== null
      ? `default (${resolvedDefault})`
      : target;
  return {
    purpose:
      `${disabled ? "DISABLED route" : "Route"} - entry ${position + 1} of ` +
      `${scope}${route.final ? "" : ", non-final copy"}.` +
      (disabled ? " It processes nothing until re-enabled." : ""),
    facts: [
      { label: "Pipeline", value: via },
      { label: "Destination", value: dest },
    ],
  };
}

function routesHubInfo(
  groupId: string,
  routes: readonly LiveRoute[],
  resolvedDefault: string | null,
): DiagramNodeInfo {
  const shown = routes.slice(0, 12);
  return {
    purpose:
      `Routing table for worker group '${groupId}': ${routes.length} route(s), ` +
      `evaluated top-down. Hover a row for its filter.` +
      (routes.length > shown.length
        ? ` Showing the first ${shown.length}.`
        : ""),
    routes: shown.map((r) => routeRow(r, resolvedDefault)),
    docs: [{ label: "Cribl routes", url: CRIBL + "/stream/routes/" }],
  };
}

/**
 * The installed pack ids from a raw /packs response - the usecase uses this
 * to decide which per-pack detail sections to fetch. Tolerant like every
 * other section parse; failures yield [].
 */
export function installedPackIds(section: LiveSnapshotSection | undefined): string[] {
  if (section === undefined || section.status < 200 || section.status >= 300) {
    return [];
  }
  const items = envelopeItems(section.body) ?? [];
  return items
    .map(normalizePack)
    .filter((p): p is LivePack => p !== null)
    .map((p) => p.id);
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

  // Per-node "Open in Cribl" links (null when no UI base is configured).
  const uiBase = options.uiBase?.replace(/\/+$/, "") ?? "";
  const resourceLink = (page: string, label: string): DiagramDocLink | null =>
    uiBase === ""
      ? null
      : {
          label,
          url: `${uiBase}/m/${encodeURIComponent(snapshot.groupId)}${page}`,
        };

  // --- 1. Parse every section tolerantly -----------------------------------
  const inputsAvailable = snapshot.inputs !== undefined || snapshot.jobs !== undefined;
  const allInputs = [
    ...parseSection(snapshot.inputs, "Sources", "the source stage is", notes).map(
      (item) => normalizeInput(item, false),
    ),
    ...parseSection(
      snapshot.jobs,
      "Collector jobs",
      "scheduled collector sources are",
      notes,
    ).map((item) => normalizeInput(item, true)),
  ].filter((i): i is LiveInput => i !== null);
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
  // Route filters match __inputId, which for collector jobs is the
  // "collection:{id}" alias - resolve through every alias.
  const inputByAlias = new Map<string, LiveInput>();
  for (const input of allInputs) {
    for (const alias of input.aliases) {
      if (!inputByAlias.has(alias)) {
        inputByAlias.set(alias, input);
      }
    }
  }

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
        const input = inputByAlias.get(id) ?? inputById.get(id);
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
    } else if (parsed.kind === "prefix") {
      consumed = inputs.filter((i) =>
        i.aliases.some((alias) => alias.startsWith(parsed.value)),
      );
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

  // --- 5. Flow inventory, then the filters (focus -> selection -> Azure) ----
  const focusSources = new Set(options.focusSources ?? []);
  const focusOutputs = new Set(options.focusOutputs ?? []);
  const outputRef = (triple: FlowTriple): string =>
    triple.output !== null ? triple.output.id : triple.route.output ?? "default";
  const tripleAzure = (triple: FlowTriple): boolean =>
    (triple.input !== null && isAzureInput(triple.input)) ||
    (triple.output !== null && isAzureCriblType("output", triple.output.type));
  const flowKey = (triple: FlowTriple): string =>
    `g:${triple.input?.id ?? "*"}>${triple.route.id}>${outputRef(triple)}`;
  const routeVia = (route: LiveRoute): string => {
    const ref = route.pipeline ?? "passthru";
    if (ref.startsWith("pack:")) {
      return ` (pack ${ref.slice("pack:".length)})`;
    }
    return ref !== "passthru" && ref !== "" ? ` (pipeline ${ref})` : "";
  };
  // The COMPLETE inventory, computed before any filter (user direction
  // 2026-07-30: list every flow; the user picks which to render).
  const flows: LiveFlowSummary[] = [];
  const seenFlowKeys = new Set<string>();
  for (const triple of triples) {
    const key = flowKey(triple);
    if (seenFlowKeys.has(key)) {
      continue;
    }
    seenFlowKeys.add(key);
    flows.push({
      key,
      label:
        `${triple.input?.id ?? "(any input)"} -> ${triple.route.name}` +
        `${routeVia(triple.route)} -> ${outputRef(triple)}`,
      azure: tripleAzure(triple),
    });
  }

  const inFocus = (triple: FlowTriple): boolean => {
    if (
      focusSources.size > 0 &&
      (triple.input === null || !focusSources.has(triple.input.id))
    ) {
      return false;
    }
    return focusOutputs.size === 0 || focusOutputs.has(outputRef(triple));
  };
  const focused = triples.filter(inFocus);
  if (focusSources.size > 0 || focusOutputs.size > 0) {
    notes.push(
      `Focus: showing ${focused.length} of ${triples.length} flow(s) between ` +
        `the selected sources and destinations.`,
    );
  }

  const selectedFlowKeys = new Set(options.selectedFlows ?? []);
  const chosen =
    selectedFlowKeys.size === 0
      ? focused
      : focused.filter((t) => selectedFlowKeys.has(flowKey(t)));
  if (selectedFlowKeys.size > 0) {
    notes.push(
      `Flow selection: ${chosen.length} of ${focused.length} group flow(s) drawn.`,
    );
  }

  const kept = chosen.filter((t) => !options.azureOnly || tripleAzure(t));
  if (options.azureOnly && kept.length < chosen.length) {
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
  const routesExpanded = options.expandRoutes === true;
  if (hubNeeded) {
    addNode({
      id: "routes",
      label: "Routes",
      tier: "cribl",
      badge: "Routing table",
      info: withResourceLink(
        // ALL routes (disabled included, dimmed) - the popover mirrors the
        // real table, not just the flowing subset.
        routesHubInfo(snapshot.groupId, allRoutes, defaultOutput?.defaultId ?? null),
        resourceLink(UI_PAGES.routes, `Open Routes in Cribl (${snapshot.groupId})`),
      ),
      expandable: true,
      expanded: routesExpanded,
    });
  }

  // Source side: in -> brk* -> pre? -> routes.
  for (const triple of kept) {
    const input = triple.input;
    if (input === null) {
      continue;
    }
    const inputNodeId = `in:${input.id}`;
    const isCollector = input.type.toLowerCase() === "collection";
    addNode({
      id: inputNodeId,
      label: input.id,
      tier: "source",
      badge: `${input.type} source`,
      info: withResourceLink(
        inputInfo(input),
        resourceLink(
          isCollector ? UI_PAGES.collectors : UI_PAGES.sources,
          isCollector ? "Open Collectors in Cribl" : "Open Sources in Cribl",
        ),
      ),
    });
    let previous = inputNodeId;
    for (const ruleset of input.breakerRulesets) {
      const breakerNodeId = `brk:${ruleset}`;
      addNode({
        id: breakerNodeId,
        label: ruleset,
        tier: "cribl",
        badge: "Event breaker",
        info: withResourceLink(
          breakerInfo(ruleset, breakerById.get(ruleset)),
          resourceLink(UI_PAGES.breakers, "Open Event Breakers in Cribl"),
        ),
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
        badge: "Pre-processing",
        info: withResourceLink(
          pipelineInfo("Pre-processing", input.pipeline, pipelineById.get(input.pipeline)),
          resourceLink(
            `${UI_PAGES.pipelines}/${encodeURIComponent(input.pipeline)}`,
            "Open this pipeline in Cribl",
          ),
        ),
      });
      addEdge({ from: previous, to: preNodeId });
      previous = preNodeId;
    }
    addEdge({ from: previous, to: "routes" });
  }

  // Pack internals, pass 1 (user question 2026-07-30): parse each inspected
  // pack's embedded sources/destinations/routes/pipelines. The pack CARD
  // carries the internal routes/pipelines summary in its popover; embedded
  // endpoints chain THROUGH the pack node (pass 2, after egress). Parsed
  // here so the egress side's pack nodes pick up the enriched info too.
  interface PackInternals {
    inputs: LiveInput[];
    outputs: LiveOutput[];
    routes: LiveRoute[];
    pipelines: LivePipeline[];
    /** The pack card's label: the human display name, else the id. */
    displayName: string;
    azure: boolean;
  }
  const packInternals = new Map<string, PackInternals>();
  const packEnrichedInfo = new Map<string, DiagramNodeInfo>();
  const packDetails = snapshot.packDetails ?? {};
  for (const packId of Object.keys(packDetails)) {
    const detail = packDetails[packId];
    const silent: string[] = [];
    const packInputs = parseSection(
      detail.inputs,
      `Pack '${packId}' sources`,
      "the pack's embedded sources are",
      notes,
    )
      .map((item) => normalizeInput(item, false))
      .filter((i): i is LiveInput => i !== null)
      .filter((i) => !i.disabled);
    const packOutputs = parseSection(
      detail.outputs,
      `Pack '${packId}' destinations`,
      "the pack's embedded destinations are",
      notes,
    )
      .map(normalizeOutput)
      .filter((o): o is LiveOutput => o !== null);
    const internals: PackInternals = {
      inputs: packInputs,
      outputs: packOutputs,
      // Internal routes/pipelines draw only when exploded - parse silently.
      routes:
        detail.routes === undefined ? [] : parseRoutesSection(detail.routes, silent),
      pipelines:
        detail.pipelines === undefined
          ? []
          : parseSection(detail.pipelines, "", "", silent)
              .map(normalizePipeline)
              .filter((p): p is LivePipeline => p !== null),
      displayName: packById.get(packId)?.displayName ?? packId,
      azure:
        packInputs.some(isAzureInput) ||
        packOutputs.some((o) => isAzureCriblType("output", o.type)),
    };
    packInternals.set(packId, internals);
    if (internals.inputs.length > 0 || internals.outputs.length > 0) {
      flows.push({
        key: `p:${packId}`,
        label:
          `Pack ${internals.displayName}: ` +
          `${internals.inputs.map((i) => i.id).join(", ") || "(no sources)"} -> ` +
          `${internals.outputs.map((o) => o.id).join(", ") || "(no destinations)"}`,
        azure: internals.azure,
      });
    }
    const base = packInfo(packId, packById.get(packId));
    const extraFacts: DiagramFact[] = [];
    if (internals.inputs.length > 0) {
      extraFacts.push({
        label: "Embedded sources",
        value: internals.inputs.map((i) => `${i.id} (${i.type})`).join(", "),
      });
    }
    if (internals.outputs.length > 0) {
      extraFacts.push({
        label: "Embedded destinations",
        value: internals.outputs.map((o) => `${o.id} (${o.type})`).join(", "),
      });
    }
    if (internals.pipelines.length > 0) {
      extraFacts.push({
        label: "Pack pipelines",
        value: String(internals.pipelines.length),
      });
    }
    packEnrichedInfo.set(packId, {
      ...base,
      ...(extraFacts.length > 0
        ? { facts: [...(base.facts ?? []), ...extraFacts] }
        : {}),
      ...(internals.routes.length > 0
        ? { routes: internals.routes.slice(0, 12).map((r) => routeRow(r, null)) }
        : {}),
    });
  }

  // Egress side: routes -> (pack | pipe | direct) -> post? -> out.
  const keptRoutes = new Map<string, FlowTriple>();
  for (const triple of kept) {
    if (!keptRoutes.has(triple.route.id)) {
      keptRoutes.set(triple.route.id, triple);
    }
  }
  const positionByRouteId = new Map(allRoutes.map((r, i) => [r.id, i]));
  const routeEntryInfo = (route: LiveRoute, disabled: boolean): DiagramNodeInfo =>
    withResourceLink(
      {
        ...routeEntryParts(
          route,
          positionByRouteId.get(route.id) ?? 0,
          "the routing table",
          defaultOutput?.defaultId ?? null,
          disabled,
        ),
        docs: [{ label: "Cribl routes", url: CRIBL + "/stream/routes/" }],
      },
      resourceLink(UI_PAGES.routes, `Open Routes in Cribl (${snapshot.groupId})`),
    );
  for (const triple of keptRoutes.values()) {
    const route = triple.route;
    const routeLabel = route.final ? route.name : `${route.name} (copy)`;
    let previous = "routes";
    if (routesExpanded) {
      // Exploded routing table: the route is its OWN node; downstream edges
      // drop the route-name labels the node now carries.
      const routeNodeId = `route:${route.id}`;
      addNode({
        id: routeNodeId,
        label: routeLabel,
        tier: "cribl",
        badge: "Route",
        info: routeEntryInfo(route, false),
      });
      addEdge({ from: "routes", to: routeNodeId });
      previous = routeNodeId;
    }

    const pipelineRef = route.pipeline ?? "passthru";
    if (pipelineRef.startsWith("pack:")) {
      const packName = pipelineRef.slice("pack:".length);
      const packNodeId = `pack:${packName}`;
      addNode({
        id: packNodeId,
        label: packById.get(packName)?.displayName ?? packName,
        tier: "cribl",
        badge: "Pack",
        info: withResourceLink(
          packEnrichedInfo.get(packName) ?? packInfo(packName, packById.get(packName)),
          resourceLink(
            `${UI_PAGES.packs}/${encodeURIComponent(packName)}`,
            "Open this pack in Cribl",
          ),
        ),
      });
      addEdge({
        from: previous,
        to: packNodeId,
        ...(previous === "routes" ? { label: routeLabel } : {}),
      });
      previous = packNodeId;
    } else if (pipelineRef !== "passthru" && pipelineRef !== "") {
      const pipeNodeId = `pipe:${pipelineRef}`;
      addNode({
        id: pipeNodeId,
        label: pipelineRef,
        tier: "cribl",
        badge: "Pipeline",
        info: withResourceLink(
          pipelineInfo("Route", pipelineRef, pipelineById.get(pipelineRef)),
          resourceLink(
            `${UI_PAGES.pipelines}/${encodeURIComponent(pipelineRef)}`,
            "Open this pipeline in Cribl",
          ),
        ),
      });
      addEdge({
        from: previous,
        to: pipeNodeId,
        ...(previous === "routes" ? { label: routeLabel } : {}),
      });
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
        badge: `${triple.output.type} destination`,
        info: withResourceLink(
          outputInfo(triple.output),
          resourceLink(UI_PAGES.destinations, "Open Destinations in Cribl"),
        ),
      };
      costType = triple.output.type;
    } else if ((route.output ?? "").startsWith("cribl_lake:")) {
      const dataset = (route.output ?? "").slice("cribl_lake:".length);
      outputNode = {
        id: `out:${route.output}`,
        label: `Lake: ${dataset}`,
        tier: "destination",
        badge: "Cribl Lake",
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
        badge: "Destination",
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
        badge: "Post-processing",
        info: withResourceLink(
          pipelineInfo(
            "Post-processing",
            triple.output.pipeline,
            pipelineById.get(triple.output.pipeline),
          ),
          resourceLink(
            `${UI_PAGES.pipelines}/${encodeURIComponent(triple.output.pipeline)}`,
            "Open this pipeline in Cribl",
          ),
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

  // Exploded routing table also shows what is switched OFF (user directive
  // 2026-07-30): each disabled route draws as a SUBDUED node off the hub -
  // present in the config, processing nothing - without pulling its
  // pack/pipeline/destination chain into the drawing. Skipped when a flow
  // selection is active (the user asked for specific flows).
  if (routesExpanded && hubNeeded && selectedFlowKeys.size === 0) {
    for (const route of disabledRoutes) {
      const routeNodeId = `route:${route.id}`;
      addNode({
        id: routeNodeId,
        label: `${route.name} (disabled)`,
        tier: "cribl",
        badge: "Route (disabled)",
        muted: true,
        info: routeEntryInfo(route, true),
      });
      addEdge({ from: "routes", to: routeNodeId, muted: true });
    }
  }

  // Pack internals, pass 2: draw each inspected pack's embedded endpoints
  // through the pack card (labeled by the pack's DISPLAY NAME, user report
  // 2026-07-30). The pack is the flow unit for the Azure filter and the
  // flow-inventory selection; the focus filters address embedded endpoints
  // as "{pack}/{id}". An EXPLODED pack (expandedPacks) fans out into its
  // internal routing table, pipelines, and destinations.
  const expandedPackIds = new Set(options.expandedPacks ?? []);
  const expandedPackRouteIds = new Set(options.expandedPackRoutes ?? []);
  let packFlowsDrawn = false;
  const azureSkippedPacks: string[] = [];
  for (const [packId, internals] of packInternals) {
    if (internals.inputs.length === 0 && internals.outputs.length === 0) {
      continue;
    }
    if (selectedFlowKeys.size > 0 && !selectedFlowKeys.has(`p:${packId}`)) {
      continue;
    }
    if (options.azureOnly && !internals.azure) {
      azureSkippedPacks.push(packId);
      continue;
    }
    const drawIns = internals.inputs.filter(
      (i) => focusSources.size === 0 || focusSources.has(`${packId}/${i.id}`),
    );
    const drawOuts = internals.outputs.filter(
      (o) => focusOutputs.size === 0 || focusOutputs.has(`${packId}/${o.id}`),
    );
    if (
      (focusSources.size > 0 && drawIns.length === 0 && internals.inputs.length > 0) ||
      (focusOutputs.size > 0 && drawOuts.length === 0 && internals.outputs.length > 0)
    ) {
      continue;
    }
    const expanded = expandedPackIds.has(packId);
    const packNodeId = `pack:${packId}`;
    const packResource = resourceLink(
      `${UI_PAGES.packs}/${encodeURIComponent(packId)}`,
      "Open this pack in Cribl",
    );
    addNode({
      id: packNodeId,
      label: internals.displayName,
      tier: "cribl",
      badge: "Pack",
      info: withResourceLink(
        packEnrichedInfo.get(packId) ?? packInfo(packId, packById.get(packId)),
        packResource,
      ),
      expandable: true,
      expanded,
    });
    for (const input of drawIns) {
      const nodeId = `in:${packId}/${input.id}`;
      addNode({
        id: nodeId,
        label: input.id,
        tier: "source",
        badge: `${input.type} source`,
        info: withResourceLink(inputInfo(input), packResource),
      });
      addEdge({ from: nodeId, to: packNodeId, label: "pack source" });
    }

    const emitOutputNode = (output: LiveOutput): string => {
      const nodeId = `out:${packId}/${output.id}`;
      addNode({
        id: nodeId,
        label: output.id,
        tier: "destination",
        badge: `${output.type} destination`,
        info: withResourceLink(outputInfo(output), packResource),
      });
      return nodeId;
    };

    if (!expanded) {
      for (const output of drawOuts) {
        const cost = outputCostTier(output.type);
        addEdge({
          from: packNodeId,
          to: emitOutputNode(output),
          ...(cost !== undefined ? { cost } : {}),
        });
      }
    } else {
      // Exploded: pack -> internal routing table -> pipeline -> destination.
      // The internal table explodes ONE level further (expandedPackRoutes,
      // user report 2026-07-30: the Pack routes node had no explode button):
      // each internal route becomes its own node, disabled ones subdued.
      const hubId = `routes:${packId}`;
      const packRoutesExpanded = expandedPackRouteIds.has(packId);
      const packRoutePosition = new Map(internals.routes.map((r, i) => [r.id, i]));
      const packRouteEntryInfo = (
        route: LiveRoute,
        disabled: boolean,
      ): DiagramNodeInfo =>
        withResourceLink(
          {
            ...routeEntryParts(
              route,
              packRoutePosition.get(route.id) ?? 0,
              `pack '${internals.displayName}' routes`,
              null,
              disabled,
            ),
            docs: [{ label: "Cribl routes", url: CRIBL + "/stream/routes/" }],
          },
          packResource,
        );
      addNode({
        id: hubId,
        label: "Pack routes",
        tier: "cribl",
        badge: "Routing table",
        info: withResourceLink(
          {
            purpose:
              `Routing table INSIDE pack '${internals.displayName}': ` +
              `${internals.routes.length} route(s), evaluated top-down. ` +
              `Hover a row for its filter.`,
            routes: internals.routes.slice(0, 12).map((r) => routeRow(r, null)),
            docs: [{ label: "Cribl routes", url: CRIBL + "/stream/routes/" }],
          },
          packResource,
        ),
        expandable: true,
        expanded: packRoutesExpanded,
      });
      addEdge({ from: packNodeId, to: hubId });
      const outById = new Map(drawOuts.map((o) => [o.id, o]));
      const referenced = new Set<string>();
      const packPipeById = new Map(internals.pipelines.map((p) => [p.id, p]));
      for (const route of internals.routes.filter((r) => !r.disabled)) {
        const routeLabel = route.final ? route.name : `${route.name} (copy)`;
        let previous = hubId;
        if (packRoutesExpanded) {
          const routeNodeId = `route:${packId}/${route.id}`;
          addNode({
            id: routeNodeId,
            label: routeLabel,
            tier: "cribl",
            badge: "Route",
            info: packRouteEntryInfo(route, false),
          });
          addEdge({ from: hubId, to: routeNodeId });
          previous = routeNodeId;
        }
        const pipelineRef = route.pipeline ?? "passthru";
        if (pipelineRef !== "passthru" && pipelineRef !== "") {
          const pipeNodeId = `pipe:${packId}/${pipelineRef}`;
          addNode({
            id: pipeNodeId,
            label: pipelineRef,
            tier: "cribl",
            badge: "Pack pipeline",
            info: withResourceLink(
              pipelineInfo("Pack", pipelineRef, packPipeById.get(pipelineRef)),
              packResource,
            ),
          });
          addEdge({
            from: previous,
            to: pipeNodeId,
            ...(previous === hubId ? { label: routeLabel } : {}),
          });
          previous = pipeNodeId;
        }
        const targetRef = route.output ?? "default";
        const target = outById.get(targetRef);
        if (target === undefined) {
          // Focus-excluded or unresolvable target: skip the leg, not the pack.
          continue;
        }
        referenced.add(target.id);
        const cost = outputCostTier(target.type);
        addEdge({
          from: previous,
          to: emitOutputNode(target),
          ...(previous === hubId ? { label: routeLabel } : {}),
          ...(cost !== undefined ? { cost } : {}),
        });
      }
      if (packRoutesExpanded) {
        for (const route of internals.routes.filter((r) => r.disabled)) {
          const routeNodeId = `route:${packId}/${route.id}`;
          addNode({
            id: routeNodeId,
            label: `${route.name} (disabled)`,
            tier: "cribl",
            badge: "Route (disabled)",
            muted: true,
            info: packRouteEntryInfo(route, true),
          });
          addEdge({ from: hubId, to: routeNodeId, muted: true });
        }
      }
      // Outputs no internal route references stay visible off the pack card.
      for (const output of drawOuts.filter((o) => !referenced.has(o.id))) {
        const cost = outputCostTier(output.type);
        addEdge({
          from: packNodeId,
          to: emitOutputNode(output),
          ...(cost !== undefined ? { cost } : {}),
        });
      }
    }
    if (drawIns.length > 0 || drawOuts.length > 0) {
      packFlowsDrawn = true;
      notes.push(
        `Pack '${internals.displayName}': ${drawIns.length} embedded source(s) and ` +
          `${drawOuts.length} embedded destination(s) drawn from the pack's own config.`,
      );
    }
  }
  if (azureSkippedPacks.length > 0) {
    notes.push(
      `Azure filter: skipped the embedded endpoints of ${azureSkippedPacks.length} ` +
        `non-Azure pack(s): ${truncateIds(azureSkippedPacks)}.`,
    );
  }
  if (snapshot.packDetails !== undefined && packs.length > Object.keys(packDetails).length) {
    notes.push(
      `Pack internals inspected for ${Object.keys(packDetails).length} of ` +
        `${packs.length} installed pack(s).`,
    );
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
  if (kept.length === 0 && !packFlowsDrawn) {
    notes.push(
      options.azureOnly
        ? `No Azure-related flows found in group '${snapshot.groupId}'.`
        : `No flows to draw in group '${snapshot.groupId}'.`,
    );
  }

  return {
    diagram: { nodes: [...nodes.values()], edges: [...edges.values()] },
    notes: [...new Set(notes)],
    flows,
  };
}
