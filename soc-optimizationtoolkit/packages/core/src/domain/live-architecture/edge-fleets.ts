/**
 * edge-fleets - the Edge Fleet inventory for the Live view (user direction
 * 2026-07-30): one entry per fleet with the fleet's real flows (a flow per
 * source/destination through the fleet's routes) and, for every
 * cribl_tcp/cribl_http destination, WHICH Cribl Stream worker group the
 * data offloads to.
 *
 * The cribl_tcp/cribl_http output config carries only receiver HOSTS (the
 * OpenAPI OutputCriblTcp schema has host/hosts, no group field), so the
 * worker group is RESOLVED by matching those hosts against the leader's
 * worker inventory (/master/workers - each worker reports its group and
 * hostname). Unresolvable hosts stay visible as raw host lists - honest
 * over inferred.
 *
 * Pure: parsing and assembly only; the usecase fetches.
 */

import type { PatternDiagram } from "../architecture-patterns";
import {
  buildLiveDiagram,
  listLiveOutputs,
  type LiveArchitectureSnapshot,
  type LiveFlowSummary,
  type LiveOutput,
  type LiveSnapshotSection,
} from "./live-architecture";

const CRIBL = "https://docs.cribl.io";

/** One leader-registered worker/edge node, as far as the inventory needs. */
export interface WorkerRecord {
  hostname: string;
  group: string;
}

/**
 * Parse the raw /master/workers response tolerantly (array | items | data
 * envelopes; hostname under info.hostname or top-level host). Rows without
 * both a hostname and a group are skipped.
 */
export function parseWorkerInventory(
  section: LiveSnapshotSection | undefined,
): WorkerRecord[] {
  if (section === undefined || section.status < 200 || section.status >= 300) {
    return [];
  }
  const body = section.body as
    | { items?: unknown; data?: unknown }
    | unknown[]
    | null;
  const items = Array.isArray(body)
    ? body
    : Array.isArray((body as { items?: unknown })?.items)
      ? ((body as { items: unknown[] }).items)
      : Array.isArray((body as { data?: unknown })?.data)
        ? ((body as { data: unknown[] }).data)
        : [];
  const records: WorkerRecord[] = [];
  for (const item of items) {
    const row = item as {
      group?: unknown;
      host?: unknown;
      info?: { hostname?: unknown };
    };
    const group = typeof row.group === "string" ? row.group : "";
    const hostname =
      typeof row.info?.hostname === "string" && row.info.hostname !== ""
        ? row.info.hostname
        : typeof row.host === "string"
          ? row.host
          : "";
    if (group !== "" && hostname !== "") {
      records.push({ hostname, group });
    }
  }
  return records;
}

/** One fleet destination that ships data onward to Cribl Stream. */
export interface FleetOffload {
  outputId: string;
  outputType: string;
  /** The receiver hosts the output is configured with. */
  hosts: string[];
  /** The Stream worker group(s) those hosts belong to, when resolvable. */
  workerGroups: string[];
}

/** Hostname match: exact, or short-name vs FQDN in either direction. */
function hostMatches(configured: string, workerHost: string): boolean {
  const a = configured.toLowerCase();
  const b = workerHost.toLowerCase();
  return (
    a === b ||
    a === b.split(".")[0] ||
    b === a.split(".")[0] ||
    b.startsWith(`${a}.`) ||
    a.startsWith(`${b}.`)
  );
}

/** The receiver hosts a cribl_tcp/cribl_http output is configured with. */
function offloadHosts(output: LiveOutput): string[] {
  const conf = output.conf;
  const hosts: string[] = [];
  const single = conf["host"];
  if (typeof single === "string" && single !== "") {
    hosts.push(single);
  }
  const list = conf["hosts"];
  if (Array.isArray(list)) {
    for (const entry of list) {
      const host = (entry as { host?: unknown })?.host;
      if (typeof host === "string" && host !== "") {
        hosts.push(host);
      }
    }
  }
  return [...new Set(hosts)];
}

/** The fleet's Stream offload destinations, worker groups resolved. */
export function resolveOffloads(
  outputs: readonly LiveOutput[],
  workers: readonly WorkerRecord[],
): FleetOffload[] {
  return outputs
    .filter((o) => o.type.toLowerCase().startsWith("cribl_"))
    .map((output) => {
      const hosts = offloadHosts(output);
      const groups = new Set<string>();
      for (const host of hosts) {
        for (const worker of workers) {
          if (hostMatches(host, worker.hostname)) {
            groups.add(worker.group);
          }
        }
      }
      return {
        outputId: output.id,
        outputType: output.type,
        hosts,
        workerGroups: [...groups].sort(),
      };
    });
}

/** One fleet's complete inventory entry. */
export interface FleetInventory {
  fleetId: string;
  diagram: PatternDiagram;
  flows: LiveFlowSummary[];
  notes: string[];
  offloads: FleetOffload[];
}

/**
 * Build one fleet's inventory: the fleet's own flows (never Azure-filtered -
 * Edge collects everything) plus the resolved Stream offload targets. Every
 * resolved worker group joins the DIAGRAM as a downstream node so the flow
 * visibly ends at the group receiving the data.
 */
export function buildFleetInventory(
  fleetId: string,
  snapshot: LiveArchitectureSnapshot,
  workers: readonly WorkerRecord[],
  options?: { uiBase?: string },
): FleetInventory {
  const base = buildLiveDiagram(snapshot, {
    azureOnly: false,
    uiBase: options?.uiBase,
  });
  const offloads = resolveOffloads(listLiveOutputs(snapshot.outputs), workers);
  const nodes = base.diagram.nodes.map((node) => {
    const offload = offloads.find((o) => `out:${o.outputId}` === node.id);
    if (offload === undefined || node.info === undefined) {
      return node;
    }
    return {
      ...node,
      info: {
        ...node.info,
        facts: [
          ...(node.info.facts ?? []),
          {
            label: "Offloads to",
            value:
              offload.workerGroups.length > 0
                ? `Stream worker group ${offload.workerGroups.join(", ")}`
                : offload.hosts.join(", ") || "(no receivers configured)",
          },
        ],
      },
    };
  });
  const edges = [...base.diagram.edges];
  const uiBase = options?.uiBase?.replace(/\/+$/, "");
  for (const offload of offloads) {
    const outNodeId = `out:${offload.outputId}`;
    if (!nodes.some((n) => n.id === outNodeId)) {
      continue;
    }
    for (const group of offload.workerGroups) {
      const wgId = `wg:${group}`;
      if (!nodes.some((n) => n.id === wgId)) {
        nodes.push({
          id: wgId,
          label: `Stream worker group '${group}'`,
          tier: "cribl",
          badge: "Stream worker group",
          info: {
            purpose:
              `The Cribl Stream worker group receiving this fleet's offloaded ` +
              `data - resolved by matching the destination's receiver hosts ` +
              `against the leader's worker inventory.`,
            facts: [{ label: "Group", value: group }],
            docs: [
              uiBase !== undefined && uiBase !== ""
                ? {
                    label: `Open Routes in Cribl (${group})`,
                    url: `${uiBase}/m/${encodeURIComponent(group)}/routes`,
                  }
                : {
                    label: "Cribl distributed deployments",
                    url: CRIBL + "/stream/deploy-distributed/",
                  },
            ],
          },
        });
      }
      edges.push({ from: outNodeId, to: wgId, label: "offload" });
    }
  }
  const notes = [...base.notes];
  for (const offload of offloads) {
    if (offload.workerGroups.length === 0 && offload.hosts.length > 0) {
      notes.push(
        `Destination '${offload.outputId}': receiver host(s) ` +
          `${offload.hosts.join(", ")} matched no leader-registered worker - ` +
          `the offload worker group could not be resolved.`,
      );
    }
  }
  return {
    fleetId,
    diagram: { nodes, edges },
    flows: base.flows,
    notes,
    offloads,
  };
}
