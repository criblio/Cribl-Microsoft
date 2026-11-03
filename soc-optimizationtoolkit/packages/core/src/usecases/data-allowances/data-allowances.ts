/**
 * data-allowances (MIG-14) - run every read behind the Data Volume Inventory's
 * allowance cards and assemble ONE result the UI renders: per grant, the
 * eligible volume, the benefit Microsoft applied, the granted figure and the
 * cross-check between them (spec: docs/features/inventory-data-allowances.md).
 *
 * UNKNOWN IS NOT ZERO (docs/inventory-standard.md, binding). Only a failed
 * `Operation` read for the target workspace throws - without Microsoft's own
 * record of the benefit there is nothing honest to show, and the caller shows
 * an error line while the inventory stays. Every other failure lands in the
 * result as a stated gap: a subscription whose pricings are refused is
 * "not-read" (never "off"), a refused Graph read is `denied` (never "no
 * licences"), a refused table-plan read leaves every plan null (never
 * "Analytics"), and a failed eligible-volume, Heartbeat or Resource Graph read
 * is named in `gaps`. A PARTIAL answer is treated like a failed one for
 * completeness: a partial benefit read makes Used a lower bound
 * (`usedIsFloor`), a partial Heartbeat read floors the Servers P2 figure, and
 * neither is cross-checked.
 *
 * Pure orchestration over the AzureManagement and GraphDirectory ports: no
 * clock (`readAt` is injected), no timers. Calls are sequential on purpose;
 * the Cribl proxy budget is 100 requests a minute.
 */

import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { GraphDirectory } from "../../ports/graph-directory";
import type { Logger } from "../../ports/logger";
import { httpErrorText, is2xx } from "../arm-http";
import { RESOURCE_GRAPH_API_VERSION } from "../../domain/eventhub-discovery";
import { buildPricingsListRequest, parsePricings } from "../../domain/defender-export/defender-plans";
import type { PricingsRead } from "../../domain/defender-export/defender-plans";
import {
  allowanceFor,
  criblWritable,
  eligibleTables,
} from "../../domain/data-allowances/allowance-catalog";
import { SERVERS_MB_PER_MACHINE_PER_DAY } from "../../domain/data-allowances/allowance-catalog";
import type { GrantId } from "../../domain/data-allowances/allowance-catalog";
import {
  BENEFIT_QUERY,
  eligibleDailyQuery,
  foldGrantUsage,
  parseBenefitRows,
} from "../../domain/data-allowances/benefit-usage";
import type { GrantUsage } from "../../domain/data-allowances/benefit-usage";
import {
  crossCheck,
  e5Granted,
  median,
  parseSubscribedSkus,
  serversGranted,
} from "../../domain/data-allowances/granted";
import type { CrossCheck, ServersSubscriptionRow } from "../../domain/data-allowances/granted";
import { INVENTORY_WINDOW_DAYS } from "../../domain/workspace-inventory";
import { WINDOW_FILTER } from "../../domain/workspace-inventory/workspace-inventory";
import { runWorkspaceQuery } from "../workspace-inventory/workspace-inventory";
import type { WorkspaceInventory } from "../workspace-inventory/workspace-inventory";

/** api-version of the workspace table list (`GET {workspaceId}/tables`). */
const TABLES_API_VERSION = "2022-10-01";

/**
 * Which machines reported on each day of the window, and from which
 * subscription. Per day, because the Servers P2 grant is 500 MB per machine
 * PER DAY: a window-wide distinct count would credit a short-lived machine
 * with thirty days of grant.
 */
export const HEARTBEAT_QUERY = [
  "Heartbeat",
  `| where ${WINDOW_FILTER}`,
  "| summarize by Day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd'), Computer,",
  "    SubscriptionId = tostring(_SubscriptionId)",
].join("\n");

/** How many machines each subscription holds (Azure VMs and Arc machines). */
const MACHINES_QUERY =
  "resources | where type in~ ('microsoft.compute/virtualmachines', 'microsoft.hybridcompute/machines') | summarize Machines = count() by subscriptionId";

const GRAPH_CALL =
  "GET /v1.0/subscribedSkus?$select=skuId,skuPartNumber,capabilityStatus,prepaidUnits,consumedUnits,appliesTo";
const PRICINGS_CALL = "GET /subscriptions/{subscriptionId}/providers/Microsoft.Security/pricings";

/** Every table either grant covers that is not Free (Free wins), once each. */
const ELIGIBLE_TABLE_NAMES: readonly string[] = [
  ...new Set([...eligibleTables("e5"), ...eligibleTables("servers-p2")]),
].filter((t) => allowanceFor(t).kind === "grant");

export type LicenceRead =
  | { kind: "read"; e5: ReturnType<typeof e5Granted>; readAt: string }
  | { kind: "denied"; detail: string }
  | { kind: "not-bound" };

export interface GrantView {
  grant: GrantId;
  usage: GrantUsage;
  /** Null when the granted figure could not be established (never 0 for unknown). */
  grantedMB: number | null;
  /**
   * False when the eligible-volume read failed or was partial: `usage`
   * eligible figures and `eligibleTables` are then unknown, not zero.
   */
  eligibleKnown: boolean;
  /** True when `grantedMB` is "at least" - a lower bound, not the figure. */
  grantedIsFloor: boolean;
  crossCheck: CrossCheck;
  eligibleTables: Array<{
    table: string;
    eligibleDailyMB: number;
    /** The workspace table plan; null when the plans were not read. */
    plan: string | null;
    criblWritable: "yes" | "no" | "unknown";
  }>;
}

export interface DataAllowances {
  attribution: "per-grant" | "pooled";
  grants: GrantView[];
  /** Total eligible vs total applied; set only when attribution is "pooled". */
  pooled: GrantUsage | null;
  /**
   * False when the eligible-volume read failed or was partial in any workspace
   * read. Eligible sums (`pooled` and every grant's) are then unknown, not
   * zero - and `grants` may be empty because nothing eligible was seen.
   */
  eligibleKnown: boolean;
  afterAllowancesDailyMB: number;
  /**
   * True when eligible, used and after-allowances sums are lower bounds: a
   * workspace was not read (tenant) or the Usage answer was partial (workspace).
   */
  sumsAreFloors: boolean;
  /**
   * True when an `Operation` (benefit) answer was partial: Used is a lower
   * bound, so Over and after-allowances are not exact (the true figures could
   * be lower) and no cross-check is run.
   */
  usedIsFloor: boolean;
  licences: LicenceRead;
  servers: {
    rows: ServersSubscriptionRow[];
    unattributedMachines: number;
    /**
     * False when a Heartbeat read failed or was partial: an empty `rows` then
     * means the machines were not read, never that there are none.
     */
    heartbeatComplete: boolean;
  };
  scope:
    | { kind: "workspace"; sentinelWorkspaces: number | null }
    | {
        kind: "tenant";
        workspaces: string[];
        notRead: Array<{ id: string; error: string }>;
      };
  /** The exact queries and calls behind the numbers, for the info affordances. */
  queries: {
    benefit: string;
    eligible: string;
    heartbeat: string;
    machines: string;
    graph: string;
    pricings: string;
    /** Null in a tenant comparison, which makes no tables call. */
    tables: string | null;
  };
  /** Reads that failed but did not stop the result; each is stated, never a zero. */
  gaps: string[];
}

export interface DataAllowancesOptions {
  logger?: Logger;
  onProgress?: (step: string) => void;
  /** ISO time of the read; core reads no clock. */
  readAt: string;
}

export interface CompareTenantOptions extends DataAllowancesOptions {
  /**
   * True when workspace discovery could not see every workspace (a failed
   * subscription, or a Sentinel state it could not determine). The sums are
   * then lower bounds even though every named workspace was read.
   */
  discoveryIncomplete?: boolean;
}

type Row = Record<string, unknown>;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface WorkspaceReads {
  benefitRows: Row[];
  /** False when the benefit (Operation) answer came back partial. */
  benefitComplete: boolean;
  eligibleRows: Row[] | null;
  /** False when the eligible read failed or came back partial. */
  eligibleComplete: boolean;
  heartbeatRows: Row[] | null;
  /** False when the Heartbeat read failed or came back partial. */
  heartbeatComplete: boolean;
}

/** The three workspace queries. Benefit failure throws; the others become gaps. */
async function readWorkspace(
  azure: AzureManagement,
  workspaceId: string,
  label: string,
  gaps: string[],
  opts: DataAllowancesOptions,
): Promise<WorkspaceReads> {
  opts.onProgress?.(`Reading the benefit Microsoft applied${label}`);
  const benefit = await runWorkspaceQuery(
    azure,
    workspaceId,
    BENEFIT_QUERY,
    "read the data allowance benefit (Operation)",
  );
  if (benefit.warning !== null) {
    gaps.push(`The benefit read${label} was partial: ${benefit.warning}`);
  }

  opts.onProgress?.(`Reading eligible volume${label}`);
  let eligibleRows: Row[] | null = null;
  let eligibleComplete = false;
  try {
    const eligible = await runWorkspaceQuery(
      azure,
      workspaceId,
      eligibleDailyQuery(ELIGIBLE_TABLE_NAMES),
      "read eligible volume (Usage)",
    );
    eligibleRows = eligible.rows;
    eligibleComplete = eligible.warning === null;
    if (eligible.warning !== null) {
      gaps.push(`The eligible volume read${label} was partial: ${eligible.warning}`);
    }
  } catch (error) {
    gaps.push(`Eligible volume${label} was not read: ${errorText(error)}`);
  }

  opts.onProgress?.(`Reading reporting machines${label}`);
  let heartbeatRows: Row[] | null = null;
  let heartbeatComplete = false;
  try {
    const hb = await runWorkspaceQuery(azure, workspaceId, HEARTBEAT_QUERY, "read reporting machines (Heartbeat)");
    heartbeatRows = hb.rows;
    heartbeatComplete = hb.warning === null;
    if (hb.warning !== null) {
      gaps.push(`The reporting machines read${label} was partial: ${hb.warning}`);
    }
  } catch (error) {
    gaps.push(`Reporting machines${label} were not read: ${errorText(error)}`);
  }
  return {
    benefitRows: benefit.rows,
    benefitComplete: benefit.warning === null,
    eligibleRows,
    eligibleComplete,
    heartbeatRows,
    heartbeatComplete,
  };
}

/** table (lower-case) -> plan, or null when the list was refused or unreadable. */
async function readTablePlans(
  azure: AzureManagement,
  workspaceId: string,
  gaps: string[],
): Promise<Map<string, string> | null> {
  try {
    const response = await azure.request({
      method: "GET",
      path: `${workspaceId}/tables`,
      apiVersion: TABLES_API_VERSION,
    });
    if (!is2xx(response.status)) {
      throw new Error(httpErrorText("read table plans", response.status, response.body));
    }
    const value = (response.body as { value?: unknown } | null)?.value;
    if (!Array.isArray(value)) throw new Error("the table list had no value array");
    const plans = new Map<string, string>();
    for (const item of value as Array<{ name?: unknown; properties?: { plan?: unknown } }>) {
      const name = typeof item?.name === "string" ? item.name : "";
      const plan = item?.properties?.plan;
      if (name !== "" && typeof plan === "string" && plan !== "") plans.set(name.toLowerCase(), plan);
    }
    return plans;
  } catch (error) {
    gaps.push(`Table plans were not read: ${errorText(error)}`);
    return null;
  }
}

async function readLicences(
  graph: GraphDirectory | undefined,
  readAt: string,
): Promise<LicenceRead> {
  if (graph === undefined) return { kind: "not-bound" };
  try {
    const result = await graph.readSubscribedSkus();
    if (result.kind === "denied") return { kind: "denied", detail: result.detail };
    return { kind: "read", e5: e5Granted(parseSubscribedSkus(result.body)), readAt };
  } catch (error) {
    return { kind: "denied", detail: errorText(error) };
  }
}

function planOf(read: PricingsRead): ServersSubscriptionRow["plan"] {
  const vm = [...read.enabled, ...read.disabled].find((p) => p.name === "VirtualMachines");
  // A full list without the Servers entry says nothing about Servers: not-read.
  if (vm === undefined) return "not-read";
  if (!read.enabled.includes(vm)) return "off";
  const sub = vm.subPlan.toUpperCase();
  return sub === "P1" || sub === "P2" ? sub : "not-read";
}

interface MachineKey {
  subscription: string;
  computer: string;
  day: string;
}

interface ServersRead {
  rows: ServersSubscriptionRow[];
  unattributedMachines: number;
  /** subscription -> day -> machines that reported that day. */
  byDay: Map<string, Map<string, number>>;
}

async function readServers(
  azure: AzureManagement,
  machines: readonly MachineKey[],
  gaps: string[],
  opts: DataAllowancesOptions,
): Promise<ServersRead> {
  const byDay = new Map<string, Map<string, number>>();
  const unattributed = new Set<string>();
  for (const m of machines) {
    if (m.subscription === "") {
      unattributed.add(m.computer);
      continue;
    }
    const days = byDay.get(m.subscription) ?? new Map<string, number>();
    days.set(m.day, (days.get(m.day) ?? 0) + 1);
    byDay.set(m.subscription, days);
  }
  const subs = [...byDay.keys()];
  if (subs.length === 0) return { rows: [], unattributedMachines: unattributed.size, byDay };

  const plans = new Map<string, ServersSubscriptionRow["plan"]>();
  for (const [index, sub] of subs.entries()) {
    opts.onProgress?.(`Reading Defender plans (${index + 1} of ${subs.length})`);
    try {
      const response = await azure.request(buildPricingsListRequest(sub));
      const parsed = parsePricings(response);
      plans.set(sub, parsed.kind === "read" ? planOf(parsed) : "not-read");
    } catch {
      plans.set(sub, "not-read");
    }
  }

  opts.onProgress?.("Counting machines in each subscription");
  const inSubscription = new Map<string, number>();
  let graphRead = false;
  try {
    // One POST for every subscription seen; resourceGraphRequest takes one.
    const request: AzureManagementRequest = {
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
      apiVersion: RESOURCE_GRAPH_API_VERSION,
      body: { subscriptions: subs, query: MACHINES_QUERY },
    };
    const response = await azure.request(request);
    if (!is2xx(response.status)) {
      throw new Error(httpErrorText("count machines (Resource Graph)", response.status, response.body));
    }
    const data = (response.body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new Error("the Resource Graph answer had no rows array");
    for (const row of data as Row[]) {
      const id = typeof row?.subscriptionId === "string" ? row.subscriptionId.toLowerCase() : "";
      const count = Number(row?.Machines);
      if (id !== "" && Number.isFinite(count)) inSubscription.set(id, count);
    }
    graphRead = true;
  } catch (error) {
    gaps.push(`Machines per subscription were not counted: ${errorText(error)}`);
  }

  const rows = subs.map(
    (sub): ServersSubscriptionRow => ({
      subscriptionId: sub,
      plan: plans.get(sub) ?? "not-read",
      // A subscription Resource Graph does not return is not visible, not empty:
      // it holds at least the machines that reported here.
      machinesInSubscription: graphRead ? (inSubscription.get(sub) ?? null) : null,
      // Machine-days over the window, as a daily average: the grant is per day.
      machinesReportingHere:
        [...byDay.get(sub)!.values()].reduce((sum, n) => sum + n, 0) / INVENTORY_WINDOW_DAYS,
    }),
  );
  return { rows, unattributedMachines: unattributed.size, byDay };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Assembly {
  reads: readonly WorkspaceReads[];
  billableDailyAverageMB: number;
  licences: LicenceRead;
  servers: ServersRead;
  heartbeatComplete: boolean;
  /** Why no cross-check can be run, when something other than the data says so. */
  workspaceSkipReason: string | null;
  /** Why the E5 cross-check alone cannot be run (the grant is tenant-wide and shared). */
  e5SkipReason: string | null;
  /** Why the Servers P2 cross-check alone cannot be run (tenant: capped per workspace). */
  serversSkipReason: string | null;
  plans: Map<string, string> | null;
  /** Some workspaces were not read: the Servers machine count is a floor. */
  floorServers: boolean;
}

function dayMap(): Map<string, number> {
  return new Map();
}
function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function assemble(
  input: Assembly,
): Pick<
  DataAllowances,
  "attribution" | "grants" | "pooled" | "eligibleKnown" | "afterAllowancesDailyMB" | "usedIsFloor"
> {
  const benefit = parseBenefitRows(input.reads.flatMap((r) => r.benefitRows));
  const eligibleByDay = new Map<GrantId, Map<string, number>>([
    ["e5", dayMap()],
    ["servers-p2", dayMap()],
  ]);
  const eligibleByTable = new Map<GrantId, Map<string, { table: string; mb: number }>>([
    ["e5", new Map()],
    ["servers-p2", new Map()],
  ]);
  for (const read of input.reads) {
    for (const row of read.eligibleRows ?? []) {
      const table = String(row.DataType ?? "");
      const day = String(row.Day ?? "");
      const mb = Number(row.EligibleMB);
      const tag = allowanceFor(table);
      if (tag.kind !== "grant" || day === "" || !Number.isFinite(mb)) continue;
      add(eligibleByDay.get(tag.grant)!, day, mb);
      const tables = eligibleByTable.get(tag.grant)!;
      const key = table.toLowerCase();
      tables.set(key, { table, mb: (tables.get(key)?.mb ?? 0) + mb });
    }
  }

  const eligibleKnown = input.reads.length > 0 && input.reads.every((r) => r.eligibleComplete);
  const benefitComplete = input.reads.every((r) => r.benefitComplete);
  const pooledMode = benefit.attribution === "pooled";
  const usedByGrant = new Map<GrantId, Map<string, number>>([
    ["e5", dayMap()],
    ["servers-p2", dayMap()],
  ]);
  const usedPooled = dayMap();
  for (const d of benefit.days) {
    if (d.grant === "pooled") add(usedPooled, d.day, d.usedMB);
    else add(usedByGrant.get(d.grant)!, d.day, d.usedMB);
  }

  const skipReason = (grant: GrantId): string | null => {
    if (!eligibleKnown) return "Cross-check skipped: eligible volume not read (or only partly read).";
    if (!benefitComplete) {
      return "Cross-check skipped: the benefit read (Operation) was partial, so the applied figures are incomplete.";
    }
    if (pooledMode) {
      return `Cross-check skipped: the benefit type(s) ${benefit.unmatchedTypes.join(", ")} could not be attributed to a grant, so the benefit applied is only known in total.`;
    }
    if (input.workspaceSkipReason !== null) return input.workspaceSkipReason;
    if (grant === "e5" && input.e5SkipReason !== null) return input.e5SkipReason;
    return grant === "e5" && input.licences.kind !== "read"
      ? "Cross-check skipped: seat counts not read (LicenseAssignment.Read.All)."
      : null;
  };

  const grants: GrantView[] = [];
  for (const grant of ["e5", "servers-p2"] as const) {
    const usage = foldGrantUsage(
      eligibleByDay.get(grant)!,
      pooledMode ? new Map() : usedByGrant.get(grant)!,
    );
    // A grant appears when it has eligible volume or benefit applied in the window.
    if (usage.eligibleDailyMB <= 0 && usage.usedDailyMB <= 0) continue;

    let grantedMB: number | null;
    let grantedIsFloor: boolean;
    let check: CrossCheck;
    const skip = skipReason(grant);
    if (grant === "e5") {
      const licences = input.licences;
      if (licences.kind === "read") {
        grantedMB = licences.e5.grantedMB.assigned;
        // Qualifying-looking SKUs outside the matched list may add seats.
        grantedIsFloor = licences.e5.possiblyMissing > 0;
        check =
          skip !== null
            ? { kind: "skipped", reason: skip }
            : crossCheck(usage.cappedDays, [
                { basis: "assigned", mb: licences.e5.grantedMB.assigned },
                { basis: "purchased", mb: licences.e5.grantedMB.purchased },
              ]);
      } else {
        // The largest benefit Microsoft applied on one day is a lower bound.
        grantedMB = usage.maxUsedDayMB > 0 ? usage.maxUsedDayMB : null;
        grantedIsFloor = grantedMB !== null;
        check = { kind: "skipped", reason: skip ?? "Cross-check skipped: seat counts not read." };
      }
    } else {
      const rows = input.servers.rows;
      const allUnread = rows.length > 0 && rows.every((r) => r.plan === "not-read");
      if (rows.length === 0 || allUnread) {
        grantedMB = null;
        grantedIsFloor = false;
        check = {
          kind: "skipped",
          reason:
            skip ??
            (rows.length > 0
              ? "Cross-check skipped: no subscription's Defender plan could be read."
              : input.heartbeatComplete
                ? "Cross-check skipped: no reporting machines were found."
                : "Cross-check skipped: reporting machines were not read."),
        };
      } else {
        const served = serversGranted(rows, input.servers.unattributedMachines);
        // The card's figure is the per-day grant averaged over the window.
        grantedMB = served.grantedMB.reportingHere;
        grantedIsFloor = served.atLeast || !input.heartbeatComplete;
        const p2 = rows.filter((r) => r.plan === "P2").map((r) => r.subscriptionId);
        const grantedOn = (day: string): number =>
          p2.reduce((sum, sub) => sum + (input.servers.byDay.get(sub)?.get(day) ?? 0), 0) *
          SERVERS_MB_PER_MACHINE_PER_DAY;
        const serversSkip =
          skip ??
          (!input.heartbeatComplete
            ? "Cross-check skipped: reporting machines were only partly read, so the machine count is a floor."
            : input.serversSkipReason);
        check =
          serversSkip !== null
            ? { kind: "skipped", reason: serversSkip }
            : crossCheck(usage.cappedDays, [
                // Each capped day against THAT day's machines, not the window average.
                {
                  basis: "reporting-here",
                  mb: usage.cappedDays.length > 0 ? median(usage.cappedDays.map((d) => grantedOn(d.day))) : 0,
                },
                { basis: "in-subscription", mb: served.grantedMB.inSubscription ?? 0 },
              ]);
      }
    }
    // An unread workspace hides machines (Servers); the E5 seat count is tenant-wide.
    if (input.floorServers && grant === "servers-p2" && grantedMB !== null) grantedIsFloor = true;

    const tables = [...eligibleByTable.get(grant)!.values()]
      .filter((t) => t.mb > 0)
      .map((t) => ({
        table: t.table,
        eligibleDailyMB: t.mb / INVENTORY_WINDOW_DAYS,
        plan: input.plans?.get(t.table.toLowerCase()) ?? null,
        criblWritable: criblWritable(t.table),
      }))
      .sort((a, b) => b.eligibleDailyMB - a.eligibleDailyMB || a.table.localeCompare(b.table));
    grants.push({ grant, usage, eligibleKnown, grantedMB, grantedIsFloor, crossCheck: check, eligibleTables: tables });
  }

  let pooled: GrantUsage | null = null;
  let usedDailyMB: number;
  if (pooledMode) {
    const total = dayMap();
    for (const byDay of eligibleByDay.values()) for (const [d, mb] of byDay) add(total, d, mb);
    pooled = foldGrantUsage(total, usedPooled);
    usedDailyMB = pooled.usedDailyMB;
  } else {
    usedDailyMB = grants.reduce((sum, g) => sum + g.usage.usedDailyMB, 0);
  }
  return {
    attribution: benefit.attribution,
    grants,
    pooled,
    eligibleKnown,
    afterAllowancesDailyMB: Math.max(0, input.billableDailyAverageMB - usedDailyMB),
    usedIsFloor: !benefitComplete,
  };
}

function machinesOf(reads: readonly WorkspaceReads[]): MachineKey[] {
  const seen = new Set<string>();
  const out: MachineKey[] = [];
  for (const read of reads) {
    for (const row of read.heartbeatRows ?? []) {
      const computer = String(row.Computer ?? "");
      const subscription = String(row.SubscriptionId ?? "").toLowerCase();
      const day = typeof row.Day === "string" ? row.Day : "";
      if (computer === "" || day === "") continue;
      // A machine reporting to two workspaces on one day is one machine-day.
      const key = `${subscription}|${computer.toLowerCase()}|${day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subscription, computer: computer.toLowerCase(), day });
    }
  }
  return out;
}

/** The Servers read as the result carries it: the per-day map stays internal. */
function publicServers(servers: ServersRead, reads: readonly WorkspaceReads[]): DataAllowances["servers"] {
  return {
    rows: servers.rows,
    unattributedMachines: servers.unattributedMachines,
    heartbeatComplete: reads.length > 0 && reads.every((r) => r.heartbeatComplete),
  };
}

function queriesFor(workspaceId: string): DataAllowances["queries"] {
  return {
    benefit: BENEFIT_QUERY,
    eligible: eligibleDailyQuery(ELIGIBLE_TABLE_NAMES),
    heartbeat: HEARTBEAT_QUERY,
    machines: MACHINES_QUERY,
    graph: GRAPH_CALL,
    pricings: PRICINGS_CALL,
    tables: `${workspaceId}/tables`,
  };
}

// ---------------------------------------------------------------------------
// Public usecases
// ---------------------------------------------------------------------------

/**
 * The allowance cards for one inventoried workspace. Throws only when the
 * workspace's `Operation` read fails; everything else is a stated gap.
 */
export async function readDataAllowances(
  azure: AzureManagement,
  graph: GraphDirectory | undefined,
  workspaceId: string,
  inventory: WorkspaceInventory,
  opts: DataAllowancesOptions & { sentinelWorkspaces: number | null },
): Promise<DataAllowances> {
  const gaps: string[] = [];
  const reads = [await readWorkspace(azure, workspaceId, "", gaps, opts)];
  const machines = machinesOf(reads);
  const servers = await readServers(azure, machines, gaps, opts);
  opts.onProgress?.("Reading table plans");
  const plans = await readTablePlans(azure, workspaceId, gaps);
  opts.onProgress?.("Reading license seat counts");
  const licences = await readLicences(graph, opts.readAt);

  const n = opts.sentinelWorkspaces;
  // Only the E5 grant is tenant-wide; Servers P2 is granted per workspace.
  const e5SkipReason =
    n === null
      ? "Cross-check skipped: the number of Sentinel workspaces sharing these grants is unknown."
      : n > 1
        ? `Cross-check skipped: the grant is tenant-wide and shared across ${n} Sentinel workspaces, so one workspace's benefit cannot be compared with it.`
        : null;

  const result = assemble({
    reads,
    billableDailyAverageMB: inventory.totals.billableDailyAverageMB,
    licences,
    servers,
    heartbeatComplete: reads.every((r) => r.heartbeatComplete),
    workspaceSkipReason: null,
    e5SkipReason,
    serversSkipReason: null,
    plans,
    floorServers: false,
  });
  opts.logger?.info("data-allowances: read", {
    grants: result.grants.length,
    attribution: result.attribution,
    gaps: gaps.length,
  });
  return {
    ...result,
    sumsAreFloors: inventory.usageWarning !== null,
    licences,
    servers: publicServers(servers, reads),
    scope: { kind: "workspace", sentinelWorkspaces: n },
    queries: queriesFor(workspaceId),
    gaps,
  };
}

/**
 * The same cards summed over every named workspace, then cross-checked
 * tenant-wide. A workspace that cannot be read is listed in `scope.notRead`
 * and every sum becomes a floor. Table plans are not read here: they differ
 * per workspace, so every plan stays null rather than borrow one workspace's.
 */
export async function compareTenant(
  azure: AzureManagement,
  graph: GraphDirectory | undefined,
  workspaceIds: readonly string[],
  inventories: ReadonlyMap<string, WorkspaceInventory>,
  opts: CompareTenantOptions,
): Promise<DataAllowances> {
  const gaps: string[] = [];
  const reads: WorkspaceReads[] = [];
  let partialUsage = false;
  const notRead: Array<{ id: string; error: string }> = [];
  let billable = 0;
  for (const [index, id] of workspaceIds.entries()) {
    const label = ` (workspace ${index + 1} of ${workspaceIds.length})`;
    const inventory = inventories.get(id);
    if (inventory === undefined) {
      notRead.push({ id, error: "No inventory was read for this workspace." });
      continue;
    }
    try {
      reads.push(await readWorkspace(azure, id, label, gaps, opts));
      billable += inventory.totals.billableDailyAverageMB;
      if (inventory.usageWarning !== null) partialUsage = true;
    } catch (error) {
      notRead.push({ id, error: errorText(error) });
    }
  }
  const servers = await readServers(azure, machinesOf(reads), gaps, opts);
  opts.onProgress?.("Reading license seat counts");
  const licences = await readLicences(graph, opts.readAt);

  const discoveryIncomplete = opts.discoveryIncomplete === true;
  // Every cause of a floored sum: each also skips the cross-check and floors
  // the per-workspace-capped Servers granted figure (E5's seat count stays exact).
  const causes: string[] = [];
  if (notRead.length > 0) {
    causes.push(`${notRead.length} workspace${notRead.length === 1 ? " was" : "s were"} not read`);
  }
  if (partialUsage) causes.push("a workspace's Usage answer was partial");
  if (discoveryIncomplete) causes.push("workspace discovery could not see every workspace");
  const sumsAreFloors = causes.length > 0;
  const result = assemble({
    reads,
    billableDailyAverageMB: billable,
    licences,
    servers,
    heartbeatComplete: reads.every((r) => r.heartbeatComplete),
    workspaceSkipReason: sumsAreFloors
      ? `Cross-check skipped: the tenant sums are partial - ${causes.join("; ")}.`
      : null,
    e5SkipReason: null,
    // E5 is pooled tenant-wide; Servers P2 is capped per workspace, so a capped
    // day in the tenant sum can be one workspace running out, not the sum.
    serversSkipReason:
      "Cross-check skipped: the Servers P2 benefit is capped per workspace, so a tenant-wide daily sum cannot show any one workspace's cap. Run it on a single workspace.",
    plans: null,
    floorServers: sumsAreFloors,
  });
  gaps.push("Table plans are not read in a tenant comparison.");
  if (discoveryIncomplete) {
    gaps.push(
      "Workspace discovery was incomplete, so this comparison may be missing workspaces discovery could not see; the sums are lower bounds.",
    );
  }
  opts.logger?.info("data-allowances: tenant compared", {
    workspaces: workspaceIds.length,
    notRead: notRead.length,
    gaps: gaps.length,
  });
  return {
    ...result,
    sumsAreFloors,
    licences,
    servers: publicServers(servers, reads),
    scope: { kind: "tenant", workspaces: [...workspaceIds], notRead },
    queries: { ...queriesFor("{workspaceId}"), tables: null },
    gaps,
  };
}
