/**
 * Test fixtures for the Lake route panel and its state (AZR-35). The routing
 * table rows are the MEASURED listing's routes (core route-insert's
 * fake-routes-leader.test-util measuredTable), as snapshots.
 */

import type { ApplyLakeRouteOutcome, CriblSourceRecord, ReadyLakeRoute, RoutesTableSnapshot } from "@soc/core";

export const SOURCE: CriblSourceRecord = { groupId: "g1", inputId: "in_def", inputType: "eventhub", secretId: "s_def" };

export const TABLE: RoutesTableSnapshot = {
  tableId: "default",
  routeCount: 4,
  rows: [
    { id: "r_fw", name: "Firewall", filter: "__inputId.startsWith('syslog:in_fw:')", output: "splunk_out", pipeline: "fw_pipeline", final: true, disabled: false },
    { id: "r_okta", name: "Okta", filter: "__inputId.startsWith('http:in_okta:')", output: "s3_archive", pipeline: "passthru", final: false, disabled: false },
    { id: "r_complex", name: "Complex", filter: "sourcetype=='pan:traffic' && host.startsWith('fw')", output: "devnull", pipeline: "main", final: true, disabled: false },
    { id: "default", name: "default", filter: "true", output: "default", pipeline: "main", final: true, disabled: false },
  ],
};

const ROUTE = {
  id: "azure_onb_defender_alerts_lake",
  name: "Azure onboarding: Defender for Cloud alerts to Cribl Lake",
  filter: "__inputId=='eventhub:in_def'",
  pipeline: "azure_onb_unroll_records",
  output: "cribl_lake:azure_defender_alerts",
  final: true,
};

/** A plan at `index` with the given shadowing; dataset and pipeline both created. */
export function readyLake(over: { index?: number; shadowed?: boolean; dirty?: readonly string[] } = {}): ReadyLakeRoute {
  const index = over.index ?? 0;
  return {
    sourceId: "defenderExport",
    groupId: "g1",
    inputId: "in_def",
    dataset: { id: "azure_defender_alerts", action: "create" },
    pipeline: { id: "azure_onb_unroll_records", action: "create" },
    route: ROUTE,
    insert: {
      groupId: "g1",
      tableId: "default",
      input: { type: "eventhub", id: "in_def" },
      position: index === 0 ? { kind: "top" } : { kind: "end" },
      index,
      newRoutes: [ROUTE],
      routes: [],
      diff: [],
      table: TABLE,
      uncheckable: [TABLE.rows[2]!],
      shadowedBy: over.shadowed === true ? [TABLE.rows[3]!] : [],
      scope: { alreadyDirty: [...(over.dirty ?? [])], elsewhere: [], unplaced: [], unknown: false },
      commitFiles: ["groups/g1/local/cribl/pipelines/route.yml", "groups/g1/local/cribl/pipelines/azure_onb_unroll_records/"],
      commitMessage: "m",
      commitMarkers: ["local/cribl/pipelines/route.yml", "local/cribl/pipelines/azure_onb_unroll_records/"],
    },
  };
}

export const DEPLOYED: ApplyLakeRouteOutcome = {
  kind: "deployed",
  stage: null,
  dataset: "created",
  pipeline: "created",
  route: null,
  detail: "Cribl Lake dataset azure_defender_alerts was created. Pipeline azure_onb_unroll_records was created. Route azure_onb_defender_alerts_lake: Committed abc and deployed it.",
  record: { groupId: "g1", datasetId: "azure_defender_alerts", pipelineId: "azure_onb_unroll_records", routeId: "azure_onb_defender_alerts_lake" },
};
