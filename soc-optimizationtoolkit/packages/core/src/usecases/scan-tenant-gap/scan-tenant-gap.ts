/**
 * Scan one tenant for the logging gap dashboard (ADR 0009 decision 6) -
 * READ-ONLY BY CONSTRUCTION.
 *
 * For one connection profile: read the tenant's own How-to progress and
 * coverage selection and the app-wide tenant to Cribl mapping from KV, run
 * Validate for EVERY onboarding source through the tenant session (so the
 * reads go out under that tenant's credential and are proven to be its), and
 * confirm each Cribl source record against Cribl's input listing of the
 * record's worker group. The answer is one {@link GapCell} per source.
 *
 * WHAT IT NEVER DOES:
 * - write KV. The tenant documents are read with `store.load` under the
 *   tenant's key, never through loadTenantDocument, which migrates (writes)
 *   the legacy document; a legacy document not yet filed under any tenant is
 *   UNKNOWN here, not a first run. Once the tenant's own progress exists,
 *   the legacy key is still READ (readStrandedLegacyDocument, AZR-108) for
 *   Cribl source records an earlier app version saved there afterwards:
 *   they are reported as recorded by an earlier version and not adopted, and
 *   an unreadable legacy key makes a "not created" cell unknown. Nothing is
 *   adopted, claimed or merged;
 * - send an Azure request outside `ports.session`, or unpaced: the work's
 *   reads AND the session's own proof reads and token mints spend
 *   `ports.pacer`, which the caller makes once per run so its cap spans every
 *   tenant; once `options.signal` aborts, nothing more is sent;
 * - read a value it cannot understand as absent. A progress or coverage value
 *   that EXISTS but does not decode (truncated JSON, no identity) is unknown,
 *   never the empty first run that would paint every Cribl cell red;
 * - write to Azure or Cribl: Validate refuses anything but a GET, and the
 *   Cribl side is one GET /system/inputs per worker group.
 *
 * A tenant whose proof fails is unknown in EVERY cell, both indicators: the
 * batch that was meant to be this tenant's cannot be shown as anything. A run
 * that never started (no secret this session, the lease held by another tab)
 * leaves the Azure side unknown and still reads the Cribl side, which does not
 * go through the tenant's credential.
 *
 * Usecase layer: IO only through the ports; no clock (the caller stamps the
 * result with its own time).
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { CriblClient } from "../../ports/cribl-client";
import type { KvDocumentLoad, KvDocumentStore } from "../../ports/kv-document-store";
import type { Logger } from "../../ports/logger";
import type { RequestPacer } from "../../ports/request-pacer";
import type { TenantProfile, TenantSession } from "../../ports/tenant-session";
import {
  COVERAGE_SELECTION_KEY,
  readCoverageDocument,
} from "../../domain/coverage-model/coverage-selection";
import { coverageItem } from "../../domain/coverage-model";
import {
  ONBOARDING_PROGRESS_KEY,
  emptyProgress,
  progressFrom,
  readProgressDocument,
  strandedCriblSources,
  type OnboardingProgress,
} from "../../domain/onboarding-howto/progress-document";
import { readStrandedLegacyDocument, type StrandedLegacyRead } from "../tenant-documents";
import type { OnboardingSourceId } from "../../domain/onboarding-howto/sources";
import type { ExistingRead } from "../../domain/cribl-onboarding-source/classify-existing";
import {
  TENANT_CRIBL_MAPPING_KEY,
  readTenantCriblMapping,
  resolveTenantGroup,
  type TenantGroupResolution,
} from "../../domain/tenant-cribl-mapping";
import { isTenantMigrationMarker, normalizeTenantId, tenantDocumentKey } from "../../domain/tenancy";
import {
  GAP_SOURCES,
  azureGapIndicator,
  criblGapIndicator,
  rowUnknown,
  type GapCell,
  type GapIndicator,
  type LegacyCriblEvidence,
} from "../../domain/tenant-gap";
import { criblRequestFor } from "../../kit/cribl-request";
import { readInputs } from "../create-cribl-source/plan-cribl-source";
import { pacedThrough } from "../onboard-batch/onboard-batch";
import {
  planValidation,
  validateAzureOnboarding,
  type ValidationResult,
  type ValidationSignal,
} from "../validate-azure-onboarding";

/** A connection profile as the scan needs it; ConnectionProfile satisfies it. */
export interface TenantGapProfile extends TenantProfile {
  readonly config: TenantProfile["config"] & { readonly resourceGroup?: string };
}

export interface ScanTenantGapPorts {
  readonly session: TenantSession;
  /** The app KV store; read only. */
  readonly documents: KvDocumentStore;
  readonly cribl: CriblClient;
  /**
   * The request budget every Azure request of this scan spends - the work's
   * reads and the session's proof reads and mints. Make ONE per run (every
   * tenant of a "read all"), so its cap is the run's, not each tenant's.
   */
  readonly pacer: RequestPacer;
  readonly logger?: Logger;
}

export interface ScanTenantGapOptions {
  readonly signal?: ValidationSignal;
  /**
   * Cribl input listings already read in this scan, keyed by worker group, so
   * tenants sharing one group read it once. The caller owns its lifetime (one
   * map per "read all"); omitted, each call reads its own.
   */
  readonly criblInputs?: Map<string, Promise<ExistingRead>>;
  /** Validate's progress for this tenant: reads done of the planned first pages. */
  readonly onProgress?: (done: number, total: number) => void;
}

/** One tenant's row. */
export interface TenantGapRow {
  readonly profileId: string;
  readonly tenantId: string;
  readonly cells: readonly GapCell[];
  /**
   * Whether the Azure side was read and proven to be this tenant's: green when
   * it was, unknown with the reason otherwise. Never red.
   */
  readonly status: GapIndicator;
  /** Things the operator should know that are not about one cell. */
  readonly warnings: readonly string[];
  /** The Azure reads Validate planned for this tenant (first pages), for the (i). */
  readonly plannedReads: number;
  /**
   * True when the signal aborted before the scan finished: some answers are
   * missing, so this row must not replace an earlier complete one.
   */
  readonly cancelled: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NEVER_SENT: AzureManagement = {
  request: () => Promise.reject(new Error("no Azure read was planned")),
};

const CANCELLED_STATUS =
  "The read was cancelled before every check finished, so this is not a complete answer for this tenant.";

const CANNOT_READ = "it holds a value this app cannot read (it may be cut short or hand-edited)";

const NOT_FILED =
  "the earlier single-tenant copy of the onboarding progress has not been filed under a tenant yet. " +
  "Open Azure Native Source Onboarding once with the connection it belongs to active, then read again";

/**
 * Read `{base}.{tenant}` WITHOUT migrating. Absent stays absent only when the
 * legacy unscoped document is absent too, or already filed under a tenant (a
 * marker); a legacy document still waiting to be filed is unknown, because it
 * may be this tenant's.
 */
async function loadReadOnly(store: KvDocumentStore, base: string, tenantId: string): Promise<KvDocumentLoad> {
  const key = tenantDocumentKey(base, tenantId);
  if (key === null) return { kind: "unknown", reason: "the tenant id cannot form a storage key" };
  const scoped = await safeLoad(store, key);
  if (scoped.kind !== "absent") return scoped;
  const legacy = await safeLoad(store, base);
  if (legacy.kind === "unknown") {
    return { kind: "unknown", reason: `the earlier single-tenant copy could not be read (${legacy.reason})` };
  }
  if (legacy.kind === "absent" || isTenantMigrationMarker(legacy.value)) return scoped;
  return { kind: "unknown", reason: NOT_FILED };
}

async function safeLoad(store: KvDocumentStore, key: string): Promise<KvDocumentLoad> {
  try {
    return await store.load(key);
  } catch (err) {
    return { kind: "unknown", reason: errText(err) };
  }
}

function legacyUndecodableReason(doc: ReturnType<typeof readProgressDocument>): string {
  const why =
    doc.status === "foreign"
      ? "it holds a document this app did not write"
      : doc.status === "unreadable"
        ? "it was written by a release this one cannot read"
        : CANNOT_READ;
  return `the earlier single-tenant copy could not be read (${why})`;
}

/**
 * What the legacy key holds that this tenant's own progress does not, per
 * source (AZR-108). Read only when the tenant's own document was found: when
 * it is absent, {@link loadReadOnly} has already judged the legacy key. A
 * refused or failed read is unknown for every source, never "nothing there".
 */
async function legacyEvidence(
  store: KvDocumentStore,
  tenantId: string,
  progress: OnboardingProgress,
): Promise<{ bySource: Map<OnboardingSourceId, LegacyCriblEvidence>; warning: string | null }> {
  let read: StrandedLegacyRead;
  try {
    read = await readStrandedLegacyDocument(store, ONBOARDING_PROGRESS_KEY, tenantId);
  } catch (err) {
    read = { kind: "unknown", reason: `the earlier single-tenant copy could not be read (${errText(err)})` };
  }
  const bySource = new Map<OnboardingSourceId, LegacyCriblEvidence>();
  if (read.kind === "none") return { bySource, warning: null };
  // A legacy value that is there but does not decode (cut short, hand-edited,
  // another kind, a version this release cannot read) may still hold Cribl
  // sources an earlier version recorded: could-not-check, never "none".
  if (read.kind !== "unknown") {
    const doc = readProgressDocument({ kind: "value", value: read.value });
    if (doc.status !== "ok") read = { kind: "unknown", reason: legacyUndecodableReason(doc) };
  }
  if (read.kind === "unknown") {
    for (const s of GAP_SOURCES) bySource.set(s.id, { kind: "unknown", reason: read.reason });
    return {
      bySource,
      warning:
        `Cribl sources an earlier app version may have recorded for this tenant could not be checked (${read.reason}), ` +
        "so a source this app has no record of is unknown, not missing.",
    };
  }
  const attribution = read.kind === "stranded" ? "this-tenant" : "unattributed";
  const records = strandedCriblSources(progress, read.value);
  for (const r of records) bySource.set(r.sourceId, { kind: "record", record: r.record, attribution });
  if (records.length === 0) return { bySource, warning: null };
  const n = records.length;
  const owner = attribution === "this-tenant" ? "for this tenant" : "with no tenant named";
  return {
    bySource,
    warning:
      `${n} Cribl source ${n === 1 ? "record was" : "records were"} recorded by an earlier app version ${owner} ` +
      `and not adopted. ${n === 1 ? "It is" : "They are"} not counted here; review ${n === 1 ? "it" : "them"} on Azure Native Source Onboarding.`,
  };
}

function inputsFor(
  ports: ScanTenantGapPorts,
  cache: Map<string, Promise<ExistingRead>>,
  groupId: string,
): Promise<ExistingRead> {
  let read = cache.get(groupId);
  if (read === undefined) {
    read = readInputs(criblRequestFor(ports.cribl, groupId)).catch(
      (err: unknown): ExistingRead => ({ state: "refused", detail: errText(err) }),
    );
    cache.set(groupId, read);
  }
  return read;
}

/** Scan one tenant. Never rejects: every failure is an unknown indicator with its reason. */
export async function scanTenantGap(
  ports: ScanTenantGapPorts,
  profile: TenantGapProfile,
  options: ScanTenantGapOptions = {},
): Promise<TenantGapRow> {
  const tenantId = normalizeTenantId(profile.config.tenantId);
  const warnings: string[] = [];
  const row = (cells: readonly GapCell[], status: GapIndicator, plannedReads = 0): TenantGapRow => ({
    profileId: profile.id,
    tenantId,
    cells,
    status,
    warnings,
    plannedReads,
    cancelled: options.signal?.aborted === true,
  });

  if (tenantId === "") {
    const reason = "This connection has no tenant id, so there is no tenant to read.";
    return row(rowUnknown(reason), { state: "unknown", reason });
  }

  // 1. KV, read only.
  const [progressLoad, selectionLoad, mappingLoad] = await Promise.all([
    loadReadOnly(ports.documents, ONBOARDING_PROGRESS_KEY, tenantId),
    loadReadOnly(ports.documents, COVERAGE_SELECTION_KEY, tenantId),
    safeLoad(ports.documents, TENANT_CRIBL_MAPPING_KEY),
  ]);
  const progressDoc = readProgressDocument(progressLoad);
  // readProgressDocument also answers "absent" for a value that exists but
  // does not decode, so the editor can overwrite it. This scan only reads, so
  // only a load that found NOTHING is a first run.
  const undecodable = progressDoc.status === "absent" && progressLoad.kind === "value";
  const progress: OnboardingProgress | null = undecodable
    ? null
    : progressDoc.status === "absent"
      ? emptyProgress({
          subscriptionId: profile.config.subscriptionId,
          resourceGroup: profile.config.resourceGroup ?? "",
        })
      : progressFrom(progressDoc);
  if (progress === null) {
    const why =
      progressDoc.status === "read-unknown"
        ? progressDoc.reason
        : progressDoc.status === "foreign"
          ? "it holds a document this app did not write"
          : progressDoc.status === "absent"
            ? CANNOT_READ
            : "it was written by a release this one cannot read";
    const reason = `This tenant's onboarding progress could not be read (${why}), so neither its plan nor its Cribl sources are known.`;
    return row(rowUnknown(reason), { state: "unknown", reason });
  }

  let selectionUnknown: string | null = null;
  let subSelections: Readonly<Record<string, readonly string[]>> = {};
  if (selectionLoad.kind === "unknown") {
    selectionUnknown = selectionLoad.reason;
  } else {
    const doc = readCoverageDocument(selectionLoad.kind === "value" ? selectionLoad.value : undefined);
    // A stored value that decodes only to the defaults was not understood:
    // checking against the defaults would be checking against a guess.
    if (doc.status === "ok" && selectionLoad.kind === "value" && doc.decoded.usedDefaults) selectionUnknown = CANNOT_READ;
    else if (doc.status === "ok") subSelections = doc.decoded.selection.subSelections;
    else selectionUnknown = doc.status === "foreign" ? "it holds a document this app did not write" : "a newer release wrote it";
  }

  // 2. Azure, through the tenant session.
  const plan = planValidation(
    GAP_SOURCES.map((s) => ({ id: s.id, subSelection: subSelections[s.id] ?? [] })),
    progress.planValues,
  );
  let result: ValidationResult | null = null;
  let status: GapIndicator;
  if (plan.firstPageReads === 0) {
    // Nothing to send (every check lacks a plan value): no credential swap.
    result = await validateAzureOnboarding(NEVER_SENT, plan, options.signal !== undefined ? { signal: options.signal } : {});
    status = {
      state: "unknown",
      reason: "Nothing was read from Azure: every check lacks a plan value. Set this tenant's plan values on Azure Native Source Onboarding.",
    };
  } else {
    const signal = options.signal;
    const run = await ports.session.runForTenant(
      profile,
      (tenantPorts) =>
        validateAzureOnboarding(pacedThrough(tenantPorts.azure, ports.pacer, signal), plan, {
          ...(signal !== undefined ? { signal } : {}),
          ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
        }),
      { pacer: ports.pacer, ...(signal !== undefined ? { signal } : {}) },
    );
    if (run.restore.kind === "failed") {
      warnings.push(
        `The active connection's credential could not be put back after this read (${run.restore.reason}). Save and connect on Setup before using other screens.`,
      );
    }
    if (run.kind === "unknown") {
      const reason = `Azure was not read for this tenant: ${run.reason}`;
      ports.logger?.warn("tenant-gap: tenant run unknown", { stage: run.stage });
      if (run.stage === "proof") return row(rowUnknown(reason), { state: "unknown", reason }, plan.firstPageReads);
      status = { state: "unknown", reason };
    } else {
      result = run.value;
      status = { state: "green", reason: "Read through this tenant's own connection, and proven to be this tenant's before and after." };
      if (result.cancelled) warnings.push("The read was cancelled; checks it had not finished are unknown.");
    }
  }

  // 3. Cribl.
  const mappingRead = readTenantCriblMapping(mappingLoad);
  const group: TenantGroupResolution = resolveTenantGroup(mappingRead, tenantId);
  const cache = options.criblInputs ?? new Map<string, Promise<ExistingRead>>();
  const listings = new Map<string, ExistingRead | null>();
  for (const record of Object.values(progress.criblSources)) {
    if (record === undefined || listings.has(record.groupId)) continue;
    if (options.signal?.aborted === true) {
      listings.set(record.groupId, null);
      continue;
    }
    listings.set(record.groupId, await inputsFor(ports, cache, record.groupId));
  }

  // The tenant's own document exists only when the load found a value:
  // loadReadOnly never returns the legacy document itself.
  const legacy =
    progressLoad.kind === "value"
      ? await legacyEvidence(ports.documents, tenantId, progress)
      : { bySource: new Map<OnboardingSourceId, LegacyCriblEvidence>(), warning: null };
  if (legacy.warning !== null) warnings.push(legacy.warning);

  const cells: GapCell[] = GAP_SOURCES.map((source) => {
    const id: OnboardingSourceId = source.id;
    let azure: GapIndicator;
    if (result === null) {
      azure = { state: "unknown", reason: status.reason };
    } else if (selectionUnknown !== null && coverageItem(id)?.subSelection != null) {
      azure = {
        state: "unknown",
        reason: `Which part of this source is chosen for this tenant could not be read (${selectionUnknown}), so there is nothing to check it against.`,
      };
    } else {
      azure = azureGapIndicator(result.checks.filter((c) => c.sourceId === id));
    }
    const record = progress.criblSources[id] ?? null;
    const cribl = criblGapIndicator({
      title: source.title,
      tenantId,
      record,
      group,
      inputs: record === null ? null : (listings.get(record.groupId) ?? null),
      legacy: legacy.bySource.get(id) ?? null,
    });
    return { sourceId: id, azure, cribl };
  });

  // A cancel - during Validate, or after it during the Cribl reads - makes the
  // answer incomplete: never a green status.
  if (options.signal?.aborted === true && status.state === "green") status = { state: "unknown", reason: CANCELLED_STATUS };
  return row(cells, status, plan.firstPageReads);
}
