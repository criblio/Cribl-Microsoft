/**
 * Pack scaffold - porting-plan Unit 19 (ENG-06/07), task item 2.
 *
 * Ported and REDESIGNED from legacy pack-builder.ts scaffoldPack (1644-2624).
 * The legacy function mutated `options.tables` through many field-resolution
 * branches AND wrote files to disk in the same pass. Unit 17 already extracted
 * the field resolution into the pure {@link PipelinePlan} planner; Unit 19 takes
 * a resolved plan plus the remaining analysis inputs and assembles an in-memory
 * {@link PackTree} - no mutation, no filesystem.
 *
 * NAMING CONTRACT (section 3 item 2, the primary defect this unit fixes): every
 * pipeline dir, reduction dir, route id, sample display name, and lookup file
 * name derives from the SINGLE {@link TablePlan.suffix} (Unit 17's
 * naming.pipelineSuffix). The legacy computed the suffix three different ways, so
 * a `route_*` route could reference a pipeline dir that did not exist. Here the
 * route emitter and the dir names read the same `table.pipelineName` /
 * `table.reductionPipelineId`, so they CANNOT diverge (pinned by scaffold.test).
 *
 * LAYOUT (section 3 item 5): `default/` holds pack.yml, breakers.yml,
 * outputs.yml, samples.yml, lookups.yml, pipelines/route.yml, and
 * pipelines/{Name}/conf.yml; `data/` holds sample JSON and lookup CSVs;
 * lookups.yml is at `default/`, NEVER `data/lookups/`. No report/side files are
 * written into the tree (the legacy gap-analysis .txt leak is designed out; the
 * tar builder also guards it).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random - the build
 * timestamp is a caller input (`builtAtMs`), so a rebuild is byte-stable.
 */

import type { MatchResult } from "../field-matcher";
import type {
  FieldMappingOverride,
  PipelinePlan,
  TablePlan,
} from "../pipeline-generation";
import {
  generatePipelineConfForPlan,
  generateReductionConfForPlan,
  generateRouteYml,
} from "../pipeline-generation";
import type {
  SentinelDestinationConfig,
  SentinelDestinationInput,
} from "../sentinel-destination";
import { buildSentinelDestination } from "../sentinel-destination";

import { generateBreakersYml } from "./breakers";
import { crblFileName, makeBuildRecord, type PackBuildRecord } from "./build-record";
import {
  generateLookupsYml,
  lookupFileName,
  lookupRowsFromMatch,
  lookupRowsFromOverrides,
  renderLookupCsv,
  LOOKUP_DATA_DIR,
} from "./lookups";
import { serializeSentinelOutputsYml } from "./outputs-yml";
import { buildPackageJson, renderPackageJson } from "./package-json";
import { PackTree } from "./pack-tree";
import {
  generateSampleFile,
  generateSamplesYml,
  type PackVendorSample,
  type SampleRegistryEntry,
  type SampleSourceField,
} from "./sample-file";
import { buildCrbl, toBytes } from "./tar";

/** Placeholder DCR immutable id when no real destination is deployed yet. */
const PLACEHOLDER_DCR_ID = "dcr-00000000000000000000000000000000";
/** Placeholder ingestion endpoint for the outputs.yml skeleton. */
const PLACEHOLDER_ENDPOINT = "https://UPDATE-DCE-ENDPOINT.logs.z1.ingest.monitor.azure.com";
/** Placeholder tenant/client identifiers for the outputs.yml skeleton. */
const PLACEHOLDER_TENANT_ID = "UPDATE-TENANT-ID";
const PLACEHOLDER_CLIENT_ID = "UPDATE-CLIENT-ID";

/** Synthetic events per sample file when a table has no real samples. */
const EVENTS_PER_SAMPLE = 5;

/** Per-table analysis inputs, aligned 1:1 by index with `plan.tables`. */
export interface TableAssemblyInput {
  /** Field MatchResult (Unit 13) - source of the lookup CSV rows. */
  matchResult?: MatchResult;
  /** User field overrides - when present, the lookup CSV uses these. */
  fieldOverrides?: FieldMappingOverride[];
  /** A real deployed destination; when absent the outputs.yml uses placeholders. */
  destination?: SentinelDestinationInput;
}

/** Input to {@link scaffoldPack}. */
export interface PackScaffoldInput {
  /** The resolved pipeline plan (Unit 17). */
  plan: PipelinePlan;
  /** Per-table analysis inputs aligned with plan.tables (optional). */
  tableInputs?: TableAssemblyInput[];
  /** Tagged vendor samples for sample-file + lookup generation. */
  vendorSamples?: PackVendorSample[];
  /** Deterministic build timestamp (ms) - samples.yml `created`. */
  builtAtMs: number;
  /** Fallback identity for the outputs.yml skeleton. */
  outputsDefaults?: { tenantId?: string; ingestionClientId?: string };
}

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** FNV-1a 32-bit hash (deterministic). */
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic 6-char base62 sample id (replaces legacy random ids). */
function deterministicSampleId(seed: string): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += B62[hash32(`${seed}#${i}`) % 62];
  }
  return out;
}

/** The sample display name for a table (single naming source, <=50 chars). */
function sampleDisplayName(plan: PipelinePlan, table: TablePlan): string {
  return `${plan.vendorPrefix}_${table.suffix}`.slice(0, 50);
}

/** The lookup CSV rows for a table, from overrides or the match result. */
function lookupRowsFor(input: TableAssemblyInput | undefined): string[][] {
  if (input?.fieldOverrides && input.fieldOverrides.length > 0) {
    return lookupRowsFromOverrides(input.fieldOverrides);
  }
  if (input?.matchResult) {
    return lookupRowsFromMatch(input.matchResult);
  }
  return [];
}

/** Build the Sentinel destination config for a table (real or placeholder). */
function destinationConfigFor(
  table: TablePlan,
  input: TableAssemblyInput | undefined,
  defaults: PackScaffoldInput["outputsDefaults"],
): SentinelDestinationConfig {
  const supplied = input?.destination;
  const dest: SentinelDestinationInput = supplied ?? {
    id: table.destinationId,
    dcrImmutableId: PLACEHOLDER_DCR_ID,
    ingestionEndpoint: PLACEHOLDER_ENDPOINT,
    streamName: table.streamName,
    tenantId: defaults?.tenantId || PLACEHOLDER_TENANT_ID,
    ingestionClientId: defaults?.ingestionClientId || PLACEHOLDER_CLIENT_ID,
  };
  return buildSentinelDestination(dest);
}

/**
 * Assemble the in-memory PackTree from a resolved plan + analysis inputs. Pure -
 * returns the tree; the caller serializes it via {@link buildCrbl} / delivers it
 * via the ArtifactSink.
 */
export function scaffoldPack(input: PackScaffoldInput): PackTree {
  const { plan, tableInputs = [], vendorSamples = [], builtAtMs } = input;
  const tree = new PackTree();

  // Manifest + static pack files.
  tree.set("package.json", renderPackageJson(buildPackageJson(plan)));
  tree.set("default/pack.yml", "allowGlobalAccess: true\n");
  tree.set("default/breakers.yml", generateBreakersYml(plan.solutionName));

  // Sample files + samples.yml registry.
  const sampleRegistry: SampleRegistryEntry[] = [];
  plan.tables.forEach((table, i) => {
    const sourceFields: SampleSourceField[] = table.fields.map((f) => ({
      source: f.source,
      target: f.target,
      type: f.type,
    }));
    const { events, rawCount } = generateSampleFile(
      plan.solutionName,
      table.sentinelTable,
      sourceFields,
      vendorSamples,
      EVENTS_PER_SAMPLE,
      table.logType,
    );
    const sampleId = deterministicSampleId(`${plan.packName}:${table.suffix}:${i}`);
    const content = JSON.stringify(events, null, 2);
    tree.set(`data/samples/${sampleId}.json`, content);
    sampleRegistry.push({
      sampleId,
      sampleName: `${sampleDisplayName(plan, table)}.json`,
      createdMs: builtAtMs,
      size: toBytes(content).length,
      numEvents: rawCount,
    });
  });
  tree.set("default/samples.yml", generateSamplesYml(sampleRegistry));

  // Pipelines: transform conf + reduction conf per table.
  plan.tables.forEach((table) => {
    tree.set(
      `default/pipelines/${table.pipelineName}/conf.yml`,
      generatePipelineConfForPlan(table, plan.solutionName),
    );
    tree.set(
      `default/pipelines/${table.reductionPipelineId}/conf.yml`,
      generateReductionConfForPlan(table, plan.solutionName),
    );
  });

  // route.yml (references every pipeline via the single-source suffix).
  tree.set("default/pipelines/route.yml", generateRouteYml(plan));

  // Lookup CSVs + lookups.yml registry (at default/, never data/lookups/).
  const lookupCsvNames: string[] = [];
  plan.tables.forEach((table, i) => {
    const csv = renderLookupCsv(lookupRowsFor(tableInputs[i]));
    if (csv === null) return;
    const fileName = lookupFileName(table.suffix);
    tree.set(`${LOOKUP_DATA_DIR}/${fileName}`, csv);
    if (!lookupCsvNames.includes(fileName)) lookupCsvNames.push(fileName);
  });
  const lookupsYml = generateLookupsYml(lookupCsvNames);
  if (lookupsYml !== null) tree.set("default/lookups.yml", lookupsYml);

  // outputs.yml via the existing sentinel-destination module (deduped by id).
  const configById = new Map<string, SentinelDestinationConfig>();
  plan.tables.forEach((table, i) => {
    const config = destinationConfigFor(table, tableInputs[i], input.outputsDefaults);
    if (!configById.has(config.id)) configById.set(config.id, config);
  });
  tree.set("default/outputs.yml", serializeSentinelOutputsYml([...configById.values()]));

  return tree;
}

/** The result of a full pack assembly. */
export interface AssembledPack {
  tree: PackTree;
  crbl: Uint8Array;
  crblFileName: string;
  record: PackBuildRecord;
}

/**
 * The one call shells make: scaffold the tree, serialize the deterministic
 * .crbl, and produce the persistable build record. The archive mtime is derived
 * from the caller's `builtAtMs` so the whole artifact is reproducible.
 */
export function assemblePack(input: PackScaffoldInput): AssembledPack {
  const tree = scaffoldPack(input);
  const mtimeSec = Math.floor(input.builtAtMs / 1000);
  const crbl = buildCrbl(tree.toTarEntries(), mtimeSec);
  const record = makeBuildRecord(input.plan, {
    builtAtMs: input.builtAtMs,
    crblSizeBytes: crbl.length,
    displayName: buildPackageJson(input.plan).displayName,
  });
  return {
    tree,
    crbl,
    crblFileName: crblFileName(input.plan.packName, input.plan.version),
    record,
  };
}
