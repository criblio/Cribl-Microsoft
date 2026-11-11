/**
 * Route an onboarding source to Cribl Lake (AZR-35, first slice) - PURE.
 *
 * SCOPE. Exactly two onboarding sources: the Defender for Cloud export
 * (`defenderExport`, its alerts) and the Azure Activity Log (`activityLog`).
 * Both go to a CRIBL LAKE dataset, never to Sentinel: Sentinel gets each
 * through Microsoft's own data connector (the Defender for Cloud connector;
 * the Azure Activity connector, whose ingestion is free), so routing them
 * through Cribl into Log Analytics would only add cost. Cribl is for archive
 * and, in a later slice, other destinations. There is no Sentinel or _CL path
 * here on purpose (operator decision 2026-11-10, recorded on the card).
 *
 * WHAT THE APP CREATES, per source, each create-only:
 *   1. ONE Lake dataset per source ({@link LAKE_ROUTE_SOURCES} datasetId), on
 *      the leader. An existing dataset with that id is used as it is.
 *   2. ONE shared pipeline, {@link UNROLL_PIPELINE_ID}: a JSON Unroll on
 *      `records`, so the Azure diagnostic envelope `{"records":[...]}` becomes
 *      one event per record. Stamped with the kit's ownership stamp. Reused by
 *      the other source's route; an existing one the app cannot prove it
 *      created, or one whose body differs, is REFUSED (never rewritten).
 *   3. ONE route per source: filter exactly inputRouteFilter({type:'eventhub',
 *      id}) for the input the app created (progress.criblSources), pipeline
 *      the unroll pipeline, output the source's Lake dataset, final.
 *
 * NOT MEASURED LIVE (each said again where it is used):
 *   - the Lake output form `cribl_lake:<dataset>` in a route. The house uses it
 *     (guided-deploy/source-wiring.ts, Unit 20) and live-architecture draws it,
 *     but no capture shows a route of that form delivering to Lake. The lab
 *     that IS measured (docs/zscaler-lake-lab.md, 2026-08-25) used a
 *     `cribl_lake` DESTINATION with destPath = the dataset, not this form;
 *   - the pipeline create body (built from the bundled spec's Pipeline and
 *     PipelineFunctionJsonUnroll schemas, never sent to a real leader);
 *   - what the unrolled event looks like (whether the record lands at the top
 *     level or under `records`, and whether the Event Hub source has parsed
 *     the body into fields at all) - and whether the Defender export's body
 *     is a `records` envelope in the first place;
 *   - the dataset create body and the Lake dataset id rules: the spec gives
 *     `id` as a bare string with no pattern, so the ids below keep to the
 *     narrowest form (lowercase letter first, then lowercase letters, digits
 *     and underscores), which any stricter rule is expected to accept.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import { inputRouteFilter } from "../capture-filter/input-id";
import { criblEnvelopeItems, readProp } from "../cribl-api/envelope";
import { APP_ID } from "../cribl-secrets/secret-body";
import type { NewRoute } from "../routes-table";
import type { OnboardingSourceId } from "../onboarding-howto/sources";
import { proveOwnership, stampDescription } from "../../kit/config-writes/ownership";

/** The two sources this slice routes to Lake. */
export type LakeRouteSourceId = Extract<OnboardingSourceId, "defenderExport" | "activityLog">;

/** What the app creates for one source, and what the screen says about it. */
export interface LakeRouteSource {
  readonly sourceId: LakeRouteSourceId;
  /** Short name for the data, used in names and copy. */
  readonly label: string;
  /** The Lake dataset id the app creates (or reuses) for this source. */
  readonly datasetId: string;
  /** The route id (and the route's name). */
  readonly routeId: string;
  readonly routeName: string;
  /** Microsoft's native connector that brings this data into Sentinel. */
  readonly nativeConnector: string;
  /** The sentence the screen shows: Sentinel gets this through the native connector. */
  readonly nativeConnectorCopy: string;
}

/**
 * The fixed ids. Pure constants on purpose: an id is how the app finds its
 * own object again, so it must not depend on input. Lake dataset ids: the
 * narrowest form (see header), which the test pins.
 */
export const LAKE_ROUTE_SOURCES: Readonly<Record<LakeRouteSourceId, LakeRouteSource>> = {
  defenderExport: {
    sourceId: "defenderExport",
    label: "Defender for Cloud alerts",
    datasetId: "azure_defender_alerts",
    routeId: "azure_onb_defender_alerts_lake",
    routeName: "Azure onboarding: Defender for Cloud alerts to Cribl Lake",
    nativeConnector: "Microsoft Defender for Cloud data connector",
    nativeConnectorCopy:
      "Sentinel gets Defender for Cloud alerts through Microsoft's Defender for Cloud data connector, so this app does not send them to Sentinel. Routing them through Cribl is for keeping them in Cribl Lake (archive and search).",
  },
  activityLog: {
    sourceId: "activityLog",
    label: "Azure Activity Log",
    datasetId: "azure_activity_log",
    routeId: "azure_onb_activity_log_lake",
    routeName: "Azure onboarding: Activity Log to Cribl Lake",
    nativeConnector: "Azure Activity data connector",
    nativeConnectorCopy:
      "Sentinel gets the Azure Activity Log through Microsoft's Azure Activity data connector, whose ingestion is free, so this app never sends it to Log Analytics from Cribl. Routing it through Cribl is for keeping it in Cribl Lake (archive and search).",
  },
};

/** The one shared pipeline that unrolls `records[]`. */
export const UNROLL_PIPELINE_ID = "azure_onb_unroll_records";

/** The array the Azure diagnostic envelope carries its records in. */
export const UNROLL_PATH = "records";

/** The Lake this app writes datasets into (the spec's lakeId; Cribl.Cloud names its one Lake `default`). */
export const LAKE_ID = "default";

/** A Lake dataset id this app may create: lowercase letter first, then lowercase letters, digits, underscores. */
export const LAKE_DATASET_ID_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/** Whether `id` is one of the two sources this slice routes to Lake. */
export function isLakeRouteSource(id: string): id is LakeRouteSourceId {
  return id === "defenderExport" || id === "activityLog";
}

/**
 * The route output that addresses a Lake dataset. NOT MEASURED LIVE: the form
 * the house already writes (source-wiring.ts lakeRoute), not one a capture has
 * shown delivering.
 */
export function lakeOutputFor(datasetId: string): string {
  return `cribl_lake:${datasetId}`;
}

/** The group-relative commit marker for one pipeline's files (the kit's directory form). */
export function pipelineCommitMarker(pipelineId: string): string {
  return `local/cribl/pipelines/${pipelineId}/`;
}

/** The pipeline's description, stamped so the app can prove it created it. */
export const UNROLL_PIPELINE_DESCRIPTION = stampDescription(
  "Azure onboarding: one event per entry of the Azure diagnostic envelope's records array.",
  APP_ID,
);

/**
 * The POST /pipelines body, from the bundled spec: Pipeline `{id, conf}` with
 * conf.description and conf.functions; one PipelineFunctionJsonUnroll
 * `{id:'json_unroll', filter, conf:{path}}`. conf.name is left unset: the spec
 * says an empty name keeps each element under its original name. NOT MEASURED
 * LIVE: never sent to a real leader, and the unrolled event shape is unknown.
 */
export function buildUnrollPipelineBody(): {
  readonly id: string;
  readonly conf: { readonly description: string; readonly functions: readonly Record<string, unknown>[] };
} {
  return {
    id: UNROLL_PIPELINE_ID,
    conf: {
      description: UNROLL_PIPELINE_DESCRIPTION,
      functions: [
        {
          id: "json_unroll",
          filter: "true",
          description: "One event per record in records[]",
          conf: { path: UNROLL_PATH },
        },
      ],
    },
  };
}

/** The Lake dataset create body: the id and a stamped description; every other field is the server's default. */
export function buildLakeDatasetBody(sourceId: LakeRouteSourceId): { readonly id: string; readonly description: string } {
  const s = LAKE_ROUTE_SOURCES[sourceId];
  return {
    id: s.datasetId,
    description: stampDescription(`Azure onboarding: ${s.label}, routed by the SOC Optimization Toolkit.`, APP_ID),
  };
}

/** The route for one source's created input. */
export function buildLakeRoute(sourceId: LakeRouteSourceId, inputId: string): NewRoute {
  const s = LAKE_ROUTE_SOURCES[sourceId];
  return {
    id: s.routeId,
    name: s.routeName,
    filter: inputRouteFilter({ type: "eventhub", id: inputId }),
    pipeline: UNROLL_PIPELINE_ID,
    output: lakeOutputFor(s.datasetId),
    final: true,
    description: stampDescription(`${s.label} from Cribl source ${inputId} to Cribl Lake dataset ${s.datasetId}.`, APP_ID),
  };
}

// ---------------------------------------------------------------------------
// Reading what is already there
// ---------------------------------------------------------------------------

/** Whether a dataset listing holds the id, or could not be read as a listing. */
export type DatasetPresence =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly detail: string };

/**
 * A GET /products/lake/lakes/{lakeId}/datasets answer, for one id. A body
 * without an items array is `unknown`, never `absent` (inventory honesty).
 */
export function datasetPresence(body: unknown, datasetId: string): DatasetPresence {
  const items = criblEnvelopeItems(body);
  if (items === null) return { kind: "unknown", detail: "the Lake dataset listing carried no items array" };
  return items.some((it) => readProp(it, "id") === datasetId) ? { kind: "present" } : { kind: "absent" };
}

/** One field where an existing object differs from what the app would write. */
export interface FieldDifference {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The fields of `expected` that `actual` does not hold, by path. Only keys the
 * app writes are compared - a key the server adds (a default) is not a
 * difference - and arrays are compared element by element, with a different
 * length reported on the array itself.
 */
export function subsetDifferences(expected: unknown, actual: unknown, path = ""): FieldDifference[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return [{ path, expected: Array.isArray(expected) ? `${expected.length} entries` : expected, actual: Array.isArray(actual) ? `${actual.length} entries` : actual }];
    }
    return expected.flatMap((e, i) => subsetDifferences(e, actual[i], `${path}[${i}]`));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return [{ path, expected: "an object", actual }];
    return Object.keys(expected).flatMap((k) => subsetDifferences(expected[k], actual[k], path === "" ? k : `${path}.${k}`));
  }
  return Object.is(expected, actual) ? [] : [{ path, expected, actual }];
}

/** The pipeline object with `id`, out of a GET /pipelines listing, or why the listing is not one. */
export type PipelineLookup =
  | { readonly kind: "found"; readonly pipeline: Readonly<Record<string, unknown>> }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly detail: string };

export function findPipeline(body: unknown, pipelineId: string): PipelineLookup {
  const items = criblEnvelopeItems(body);
  if (items === null) return { kind: "unknown", detail: "the pipelines listing carried no items array" };
  const found = items.find((it) => readProp(it, "id") === pipelineId);
  return isRecord(found) ? { kind: "found", pipeline: found } : { kind: "absent" };
}

/** What to do about the unroll pipeline. */
export type PipelineVerdict =
  /** Not there: the apply creates it. */
  | { readonly kind: "create" }
  /** There, provably the app's, and holding exactly what the app would write: used as it is. */
  | { readonly kind: "reuse" }
  /** There, and the app cannot prove it created it: refused, never touched. */
  | { readonly kind: "foreign"; readonly missing: readonly string[] }
  /** The app's, but changed since: refused, never rewritten. */
  | { readonly kind: "differs"; readonly differences: readonly FieldDifference[] }
  | { readonly kind: "unknown"; readonly detail: string };

/**
 * Classify the unroll pipeline from a listing. Ownership is the kit's three
 * signals (proveOwnership): the id is one this app creates, the description
 * carries the stamp, and the app's KV record says it wrote it (`recorded`).
 */
export function classifyUnrollPipeline(lookup: PipelineLookup, recorded: boolean): PipelineVerdict {
  if (lookup.kind === "unknown") return { kind: "unknown", detail: lookup.detail };
  if (lookup.kind === "absent") return { kind: "create" };
  const description = readProp(readProp(lookup.pipeline, "conf"), "description");
  const proof = proveOwnership(APP_ID, {
    manifestIds: new Set([UNROLL_PIPELINE_ID]),
    object: { id: String(readProp(lookup.pipeline, "id")), description },
    recordedWrite: recorded,
  });
  if (!proof.mine) return { kind: "foreign", missing: proof.missing };
  const differences = subsetDifferences(buildUnrollPipelineBody(), lookup.pipeline);
  return differences.length === 0 ? { kind: "reuse" } : { kind: "differs", differences };
}

/** A field difference as a phrase: `conf.functions[0].conf.path is "x", the app writes "records"`. */
export function describeDifference(d: FieldDifference): string {
  return `${d.path === "" ? "the object" : d.path} is ${JSON.stringify(d.actual) ?? "absent"}, the app writes ${JSON.stringify(d.expected)}`;
}
