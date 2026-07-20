/**
 * The in-app AzureFlowLogs pack - roadmap Phase 4/5 convergence (VNF-08
 * breaker, VNF-09 preprocessing pipeline, VNF-11 collector job, VNF-13 pack
 * assembly redesigned in-browser).
 *
 * Assembles the legacy AzureFlowLogs pack (deprecated/Azure/dev/
 * Azure_vNet_FlowLogs, v0.0.3) from VERBATIM assets - the Azure_vNet_FlowLogs
 * event breaker and the Azure_vNet_FlowLogs_PreProcessing triple-unroll
 * pipeline - plus the scheduled blob collector job with the operator's REAL
 * values injected where the legacy shipped "<replace me>" placeholders. The
 * .crbl builds through the SAME PackTree/buildCrbl machinery every other pack
 * uses (deterministic, in-browser; VNF-13's "assemble in-browser" redesign).
 *
 * Deliberately OMITTED from the in-app pack, both documented in the catalog:
 * - VNF-10 Redis dedup pipeline: the legacy conf hardcodes a lab Redis
 *   endpoint and placeholder password; it needs parameterization before it
 *   can ship. The route.yml entry referencing it is dropped with it.
 * - VNF-12 sample captures: they carry real-looking subscription GUIDs and
 *   resource names (the catalog's scrub note); they ship after scrubbing.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto (builtAtMs is injected).
 */

import { PackTree, buildCrbl, crblFileName } from "../pack-assembly";
import {
  FLOWLOG_BREAKERS_YML,
  FLOWLOG_PACKAGE_JSON,
  FLOWLOG_PACK_YML,
  FLOWLOG_PREPROCESSING_CONF_YML,
} from "./flowlog-pack-assets";

/** The pack's identity (package.json, verbatim). */
export const FLOWLOG_PACK_NAME = "AzureFlowLogs";
export const FLOWLOG_PACK_VERSION = "0.0.3";

/** The Cribl text secret the collector references (legacy, verbatim). */
export const FLOWLOG_SECRET_NAME = "Azure_vNet_Flowlogs_Secret";

/** The collector job id inside the pack (legacy jobs.yml key, verbatim). */
export const FLOWLOG_JOB_ID = "Azure_vNet_FlowLogs_Hourly_v2";

/** Inputs for the parameterized collector job (the legacy placeholders). */
export interface FlowLogPackParams {
  /** The DEPLOYED storage account name (post-collision-suffix). */
  storageAccountName: string;
  /** Entra tenant id for the clientSecret auth. */
  tenantId: string;
  /** Entra application (client) id for the clientSecret auth. */
  clientId: string;
  /** The flow-log landing container; the Azure auto-created name by default. */
  containerName?: string;
  /**
   * Whether the hourly schedule starts enabled. The legacy pack shipped
   * DISABLED (its credentials were placeholders); with real values injected
   * the in-app default is enabled.
   */
  scheduleEnabled?: boolean;
}

/**
 * Render default/jobs.yml (VNF-11): the legacy scheduled collector VERBATIM
 * in structure - hourly at :15, relative -75m..-15m window, the
 * flowLogResourceID time-partitioned path, the pack's breaker + preprocessing
 * pipeline - with the operator's values in place of "<replace me>".
 */
export function renderFlowLogJobsYml(params: FlowLogPackParams): string {
  const containerName = params.containerName ?? "insights-logs-flowlogflowevent";
  const enabled = params.scheduleEnabled ?? true;
  return `${FLOWLOG_JOB_ID}:
  type: collection
  ttl: 4h
  ignoreGroupJobsLimit: false
  removeFields: []
  resumeOnBoot: false
  schedule:
    cronSchedule: 15 * * * *
    maxConcurrentRuns: 10
    skippable: false
    resumeMissed: true
    run:
      rescheduleDroppedTasks: true
      maxTaskReschedule: 1
      logLevel: info
      jobTimeout: "0"
      mode: run
      timeRangeType: relative
      timeWarning: {}
      expression: "true"
      minTaskSize: 1MB
      maxTaskSize: 10MB
      timestampTimezone: UTC
      earliest: -75m
      latest: -15m
    enabled: ${enabled}
  streamtags: []
  workerAffinity: false
  collector:
    conf:
      authType: clientSecret
      recurse: true
      includeMetadata: true
      includeTags: false
      maxBatchSize: 10
      parquetChunkSizeMB: 5
      parquetChunkDownloadTimeout: 600
      azureCloud: azure
      containerName: ${containerName}
      path: flowLogResourceID=/\${*}/\${*}/\${_time:y=%Y}/\${_time:m=%m}/\${_time:d=%d}/\${_time:h=%H}
      textSecret: ${FLOWLOG_SECRET_NAME}
      extractors: []
      clientId: ${params.clientId}
      tenantId: ${params.tenantId}
      storageAccountName: ${params.storageAccountName}
      clientTextSecret: ${FLOWLOG_SECRET_NAME}
    destructive: false
    type: azure_blob
    encoding: utf8
  input:
    type: collection
    staleChannelFlushMs: 10000
    sendToRoutes: true
    preprocess:
      disabled: true
    throttleRatePerSec: "0"
    breakerRulesets:
      - Azure_vNet_FlowLogs
    pipeline: Azure_vNet_FlowLogs_PreProcessing
  savedState: {}
  notifications: []
`;
}

/**
 * The pack's route table: the legacy default route only (the disabled Redis
 * dedup route is dropped with its omitted pipeline).
 */
export const FLOWLOG_ROUTE_YML = `id: default
groups: {}
comments: []
routes:
  - id: default
    name: default
    final: true
    disabled: false
    pipeline: main
    description: ""
    enableOutputExpression: false
    outputExpression: null
    filter: "true"
    clones: []
    output: default
`;

/** The assembled, installable pack. */
export interface AssembledFlowLogPack {
  /** The gzip .crbl bytes (deterministic for params + builtAtMs). */
  crbl: Uint8Array;
  /** The upload filename ({name}_{version}.crbl - the legacy namer). */
  crblFileName: string;
  /** The pack id the install ladder pins. */
  packName: string;
}

/**
 * Assemble the AzureFlowLogs .crbl in-browser: verbatim breaker, pipeline,
 * manifest, and logo plus the parameterized collector job. `builtAtMs` is the
 * SHELL-injected build instant (deterministic tar mtimes - a rebuild with the
 * same inputs is byte-identical).
 */
export function assembleFlowLogPack(
  params: FlowLogPackParams,
  builtAtMs: number,
): AssembledFlowLogPack {
  const tree = new PackTree();
  tree.set("package.json", FLOWLOG_PACKAGE_JSON);
  tree.set("default/pack.yml", FLOWLOG_PACK_YML);
  tree.set("default/breakers.yml", FLOWLOG_BREAKERS_YML);
  tree.set("default/jobs.yml", renderFlowLogJobsYml(params));
  tree.set("default/pipelines/route.yml", FLOWLOG_ROUTE_YML);
  tree.set(
    "default/pipelines/Azure_vNet_FlowLogs_PreProcessing/conf.yml",
    FLOWLOG_PREPROCESSING_CONF_YML,
  );
  const crbl = buildCrbl(tree.toTarEntries(), Math.floor(builtAtMs / 1000));
  return {
    crbl,
    crblFileName: crblFileName(FLOWLOG_PACK_NAME, FLOWLOG_PACK_VERSION),
    packName: FLOWLOG_PACK_NAME,
  };
}
