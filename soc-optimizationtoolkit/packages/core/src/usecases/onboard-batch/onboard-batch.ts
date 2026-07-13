/**
 * onboardBatch - onboard MANY tables as ONE parent job (porting-plan Unit 6:
 * batch deployment queue and DCE/Private Link modes; ENG-33 delta, ENG-39
 * inner multi-table loop). Wraps the onboardTable usecase per table - there
 * is exactly ONE deploy implementation in this codebase (the legacy repo had
 * two drifted ones; Unit 6 pins a single path).
 *
 * PARENT RECORD: one JobStore record of kind "onboard-batch" carries shared
 * prologue steps plus one step per table ("table:{name}"); per-table child
 * results are EMBEDDED in the parent result (partial results, never
 * all-or-nothing) and the result is re-persisted after EVERY table so an
 * interrupted run leaves usable progress behind.
 *
 * Steps (seed UI step lines from {@link onboardBatchStepsFor}):
 *   fetch-workspace   GET the workspace once for the batch (location +
 *                     resource id; children still resolve their own)
 *   ensure-dce        PRESENT ONLY when options.createDCE. ONCE per batch:
 *                     the DCE name comes from dcr-naming mode "dce-endpoint"
 *                     over the WORKSPACE name (decision: the legacy engine
 *                     created a DCE PER TABLE - "${DCEPrefix}${table}-${loc}",
 *                     Create-TableDCRs.ps1 line 2667 - burning DCE quota for
 *                     no routing benefit; the batch creates or REUSES one
 *                     shared DCE, GET-first then PUT via dce-request).
 *                     Enforces the Unit 6 cross-field rule here too: public
 *                     network access disabled REQUIRES amplsResourceId (the
 *                     legacy warned and shipped an unreachable private-only
 *                     DCE anyway - Create-TableDCRs.ps1 lines 2752-2755).
 *   associate-ampls   PRESENT ONLY when options.createDCE and public network
 *                     access is DISABLED (the legacy association rule). PUT
 *                     the AMPLS scopedResources association
 *                     (buildAmplsAssociationRequest). Deviation from legacy:
 *                     the association is ALWAYS applied (idempotent PUT),
 *                     including for a REUSED DCE - the legacy only associated
 *                     newly created DCEs, leaving reused ones unassociated.
 *   table:{name}      one step per input table, in input order.
 *
 * 'skipped' IS FIRST-CLASS (user decision, porting-plan "DECISIONS RESOLVED
 * 2026-07-03" item 1). A table step is 'skipped' when:
 *   - options.skipExistingDCRs found a same-named DCR (GET-first; ZERO deploy
 *     calls for that table - reason "already-exists"),
 *   - a shared prologue step failed (reason "prerequisite-failed" - the
 *     legacy engine cascaded confusing downstream errors instead; DO-NOT-PORT
 *     defect fixed + pinned),
 *   - a previous run with the same batch key already completed the table
 *     (reason "already-completed" - resumability; a re-run of a fully
 *     completed batch issues ZERO ARM and ZERO Cribl calls and the parent
 *     record finishes 'skipped', pinned).
 * One table FAILING never stops the others (isolation, pinned); the parent
 * finishes 'failed' with a count summary when any table failed.
 *
 * templateOnly (DO-NOT-PORT defect FIXED: the legacy IPC accepted the flag
 * and silently never forwarded it): when set, NO ARM WRITES happen at all -
 * only schema/workspace GETs. Every ARM request body that a deploy run would
 * PUT (custom-table PUT, DCE, AMPLS association, DCR) is collected into the
 * parent result's `templates` array for the SHELL to export via ArtifactSink
 * (the UI wires the download); no Cribl calls, no child jobs. Pinned by a
 * zero-write call-count test. The predicted DCE resource id (its ARM path -
 * REAL subscription, not the legacy zeroed placeholder) is wired into the
 * collected DCE-based DCR bodies. templateOnly runs neither consume nor
 * produce resume state - artifacts regenerate deterministically.
 *
 * BUDGET PACING: every ARM call (the batch's own and the wrapped children's)
 * flows through {@link paceAzureManagement}, which enforces at most
 * maxRequestsPerMinute requests per ROLLING minute using the poll-scheduler
 * budget math. The shell INJECTS now()/sleep() - core stays clock-free; tests
 * drive fake ticks. Default budget: {@link
 * DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE} (headroom under the cloud shell's
 * ~100 req/min proxy budget, leaving room for the status pollers). Cribl
 * calls are NOT paced: on the cloud shell the app runs inside the leader, so
 * only ARM traffic crosses the proxied budget.
 *
 * Pure orchestration over the ports; no IO of its own, no Date/crypto -
 * polling is bounded by ATTEMPT COUNT ({@link pollAttemptsForTimeout} maps
 * the legacy deploymentTimeoutSeconds option onto attempts) and pacing time
 * comes from the injected hooks.
 */

import type {
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
} from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import type { JobRecord, JobStatus, JobStep } from "../../ports/job-store";
import { generateDcrName } from "../../domain/dcr-naming";
import type { OperationOptions } from "../../domain/option-forms";
import { selectSchemaColumns } from "../../domain/schema-mapping";
import type {
  CustomSchemaFileColumn,
  LogAnalyticsColumn,
} from "../../domain/schema-mapping";
import {
  buildDceDcrRequest,
  buildDirectDcrRequest,
  DIRECT_DCR_API_VERSION,
} from "../../domain/dcr-request";
import {
  buildAmplsAssociationRequest,
  buildDceRequest,
  parseDceDeployment,
  DCE_API_VERSION,
} from "../../domain/dce-request";
import {
  buildTablePutRequest,
  isCustomTableName,
  validateCustomTableSchema,
} from "../../domain/custom-table";
import {
  BUDGET_WINDOW_MS,
  recordRun,
  remainingBudget,
} from "../../domain/poll-scheduler";
import type { PollBudget } from "../../domain/poll-scheduler";
import { onboardTable, LOG_ANALYTICS_API_VERSION } from "../onboard-table";
import type {
  OnboardTableInput,
  OnboardTableOutcome,
  OnboardTablePorts,
} from "../onboard-table";

/** JobStore `kind` for records created by {@link onboardBatch}. */
export const ONBOARD_BATCH_JOB_KIND = "onboard-batch";

/**
 * Default ARM budget per rolling minute: the cloud shell's proxy allows
 * ~100 requests/minute for the WHOLE app, so the batch defaults to 80 and
 * leaves headroom for the status pollers and the operator's other screens.
 */
export const DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE = 80;

/**
 * Seconds one provisioning-poll attempt stands for when mapping the legacy
 * deploymentTimeoutSeconds option onto attempt bounds. 10s is the legacy
 * engine's inter-poll pause (the Start-Sleep 10 the attempt-bounded readback
 * replaced), so timeout/10 attempts preserves the option's meaning without
 * core ever reading a clock.
 */
export const POLL_ATTEMPT_SECONDS = 10;

/** Legacy default DCE name prefix (dcr-naming mode "dce-endpoint"). */
export const DEFAULT_DCE_NAME_PREFIX = "dce-";

/** Prefix of per-table step names on the parent record. */
export const ONBOARD_BATCH_TABLE_STEP_PREFIX = "table:";

/**
 * Map the Unit 4 deploymentTimeoutSeconds option onto a poll-attempt bound
 * (core never waits on a wall clock; adapters own per-request timeouts).
 * The legacy default 600s maps to 60 attempts; anything under one attempt's
 * worth still polls once.
 */
export function pollAttemptsForTimeout(timeoutSeconds: number): number {
  return Math.max(1, Math.floor(timeoutSeconds / POLL_ATTEMPT_SECONDS));
}

/** The parent-record step name for a table. */
export function batchTableStepName(table: string): string {
  return `${ONBOARD_BATCH_TABLE_STEP_PREFIX}${table}`;
}

/** One table of a batch. */
export interface OnboardBatchTableSpec {
  /** Table name - native ("SecurityEvent") or custom ("CloudFlare_CL"). */
  table: string;
  /**
   * Parsed schema-file columns for a custom (_CL) table that does not exist
   * yet; forwarded to onboardTable (and to the template builder in
   * templateOnly mode). Ignored for native tables and existing tables.
   */
  customSchema?: readonly CustomSchemaFileColumn[];
}

/**
 * The pacing hooks the SHELL injects. Core never calls Date or setTimeout;
 * `now` supplies epoch milliseconds and `sleep` resolves after (at least)
 * the given delay - tests drive both with fake ticks.
 */
export interface BatchPacing {
  /**
   * Max ARM requests per rolling minute; defaults to
   * {@link DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE}. Must be a positive
   * integer.
   */
  maxRequestsPerMinute?: number;
  /** Epoch-ms clock (shell-owned). */
  now: () => number;
  /** Delay hook (shell-owned; fake ticks in tests). */
  sleep: (ms: number) => Promise<void>;
}

/** Input for {@link onboardBatch}. */
export interface OnboardBatchInput {
  /** Tables to onboard, processed in order. */
  tables: readonly OnboardBatchTableSpec[];
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** Azure region; defaults to the workspace's location. */
  location?: string;
  /** Cribl Worker Group destinations are created in. */
  groupId: string;
  /** Entra ID tenant id (Cribl OAuth loginUrl). */
  tenantId: string;
  /** App-registration client id the destinations authenticate with. */
  ingestionClientId: string;
  /** TRANSIENT client secret - never persisted (see onboardTable). */
  ingestionClientSecret?: string;
  /** DCR name prefix, concatenated verbatim (legacy default "dcr-"). */
  dcrNamePrefix?: string;
  /** Optional DCR name suffix (legacy default: none). */
  dcrNameSuffix?: string;
  /** DCE name prefix (legacy default "dce-"). */
  dceNamePrefix?: string;
  /** Optional DCE name suffix (legacy default: none). */
  dceNameSuffix?: string;
  /** The Unit 4 deployment options driving mode selection and skips. */
  options: OperationOptions;
  /** Shell-injected budget pacing (see {@link BatchPacing}). */
  pacing: BatchPacing;
  /** Fired with a copy of the PARENT step after every step-state change. */
  onProgress?: (step: JobStep) => void;
}

/** Why a table step was skipped (machine-readable; detail is the prose). */
export type OnboardBatchSkipReason =
  | "already-exists"
  | "prerequisite-failed"
  | "already-completed";

/** Per-table entry embedded in the parent result. */
export interface OnboardBatchTableResult {
  table: string;
  status: "succeeded" | "failed" | "skipped";
  /** Human-readable summary (skip reason prose, success summary). */
  detail?: string;
  /** Set when status is 'skipped'. */
  reason?: OnboardBatchSkipReason;
  /** Child onboard-table job id (deploy runs that reached the child). */
  jobId?: string;
  /** The child job's outcome when it succeeded. */
  outcome?: OnboardTableOutcome;
  /** Failure text when status is 'failed'. */
  error?: string;
}

/** The shared DCE of a DCE-mode deploy run. */
export interface OnboardBatchDceOutcome {
  name: string;
  resourceId: string;
  logsIngestionEndpoint: string;
  /** True when the DCE already existed and was reused (GET-first). */
  reused: boolean;
  /** True when the AMPLS association step succeeded this run. */
  amplsAssociated: boolean;
}

/** What kind of ARM resource a collected templateOnly body deploys. */
export type CollectedArmRequestKind =
  | "custom-table"
  | "dce"
  | "ampls-association"
  | "dcr";

/**
 * One ARM request body collected in templateOnly mode. The SHELL exports
 * these via ArtifactSink (`artifactName` is the suggested file name); the
 * usecase itself never writes artifacts.
 */
export interface CollectedArmRequest {
  kind: CollectedArmRequestKind;
  /** Owning table, or null for batch-shared resources (DCE, AMPLS). */
  table: string | null;
  /** Suggested artifact file name, e.g. "dcr-SecurityEvent-eastus.json". */
  artifactName: string;
  method: "PUT";
  path: string;
  apiVersion: string;
  body: unknown;
}

/** `result` recorded on the parent job (also persisted after every table). */
export interface OnboardBatchOutcome {
  /** Per-table results, in input order (partial while the run progresses). */
  tables: OnboardBatchTableResult[];
  /** The shared DCE (DCE-mode deploy runs), else null. */
  dce: OnboardBatchDceOutcome | null;
  /** Collected ARM bodies (templateOnly runs), else empty. */
  templates: CollectedArmRequest[];
  succeeded: number;
  failed: number;
  skipped: number;
}

/** The ports {@link onboardBatch} orchestrates (same set as onboardTable). */
export type OnboardBatchPorts = OnboardTablePorts;

/**
 * The ordered PARENT step names a batch for these tables/options will carry
 * (UIs seed step lines from this, mirroring onboardTableStepsFor).
 */
export function onboardBatchStepsFor(
  tables: readonly OnboardBatchTableSpec[],
  options: Pick<OperationOptions, "createDCE" | "dcePublicNetworkAccess">,
): string[] {
  const steps: string[] = ["fetch-workspace"];
  if (options.createDCE) {
    steps.push("ensure-dce");
    if (!options.dcePublicNetworkAccess) {
      steps.push("associate-ampls");
    }
  }
  for (const spec of tables) {
    steps.push(batchTableStepName(spec.table));
  }
  return steps;
}

/**
 * Wrap an {@link AzureManagement} port so every request first acquires a slot
 * in a rolling-minute budget (poll-scheduler math over the INJECTED clock).
 * When the window is full, the wrapper sleeps until the oldest in-window
 * request expires, then re-checks. Exposed for shells that want to pace other
 * ARM flows with the same discipline.
 *
 * @throws RangeError when maxRequestsPerMinute is not a positive integer.
 */
export function paceAzureManagement(
  azure: AzureManagement,
  pacing: BatchPacing,
): AzureManagement {
  const maxPerMinute =
    pacing.maxRequestsPerMinute ?? DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE;
  if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1) {
    throw new RangeError(
      `maxRequestsPerMinute must be a positive integer (got ${maxPerMinute})`,
    );
  }
  let budget: PollBudget = { maxPerMinute, recentRunTimestamps: [] };

  const acquire = async (): Promise<void> => {
    for (;;) {
      const now = pacing.now();
      if (remainingBudget(budget, now) > 0) {
        budget = recordRun(budget, now);
        return;
      }
      // Window full: wait until the OLDEST in-window issue timestamp leaves
      // the sliding minute, then re-check. maxPerMinute >= 1 guarantees the
      // in-window list is non-empty here.
      const inWindow = budget.recentRunTimestamps.filter(
        (t) => now - t < BUDGET_WINDOW_MS,
      );
      const oldest = Math.min(...inWindow);
      await pacing.sleep(Math.max(1, BUDGET_WINDOW_MS - (now - oldest)));
    }
  };

  const paced: AzureManagement = {
    request: async (opts: AzureManagementRequest): Promise<PortHttpResponse> => {
      await acquire();
      return azure.request(opts);
    },
  };
  const requestUrl = azure.requestUrl?.bind(azure);
  if (requestUrl !== undefined) {
    paced.requestUrl = async (
      opts: AzureManagementUrlRequest,
    ): Promise<PortHttpResponse> => {
      await acquire();
      return requestUrl(opts);
    };
  }
  return paced;
}

/** Render an HTTP failure as raw, greppable error text. */
function httpErrorText(context: string, status: number, body: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(body);
  } catch {
    raw = String(body);
  }
  return `${context}: HTTP ${status} ${raw ?? ""}`.trim();
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Internal signal: a step failed; message already carries the raw text. */
class StepFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFailure";
  }
}

/** Suggested artifact file name for a collected ARM request: last segment. */
function artifactNameFor(path: string): string {
  const segments = path.split("/");
  return `${segments[segments.length - 1]}.json`;
}

/**
 * The RESUME identity of a batch: same tables (in order) against the same
 * scope, worker group, and DCR flavor = the same batch. Retry knobs
 * (timeouts, skipExistingDCRs, pacing) deliberately do NOT participate, so
 * tightening them never orphans previous progress. Stored verbatim on the
 * parent record's input as `batchKey`.
 */
function batchKeyFor(input: OnboardBatchInput): string {
  return JSON.stringify({
    subscriptionId: input.subscriptionId,
    resourceGroup: input.resourceGroup,
    workspaceName: input.workspaceName,
    groupId: input.groupId,
    createDCE: input.options.createDCE,
    tables: input.tables.map((spec) => spec.table),
  });
}

/** A prior-run table entry that counts as COMPLETED for resume purposes. */
function isCompletedEntry(entry: unknown): boolean {
  const status = prop(entry, "status");
  if (status === "succeeded") {
    return true;
  }
  if (status !== "skipped") {
    return false;
  }
  const reason = prop(entry, "reason");
  return reason === "already-exists" || reason === "already-completed";
}

/** Compose the ARM path of the target workspace. */
function workspacePathFor(input: OnboardBatchInput): string {
  return (
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}`
  );
}

/** Compose the ARM path of a DCR by name (same RG as the workspace). */
function dcrPathFor(input: OnboardBatchInput, dcrName: string): string {
  return (
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionRules/${dcrName}`
  );
}

/**
 * templateOnly per-table work: resolve columns via GETs only (existing table
 * wins - the Unit 5 contract - else the supplied customSchema), and return
 * the ARM bodies a deploy run would PUT. Throws StepFailure on anything a
 * deploy run would fail on.
 */
async function collectTableTemplates(args: {
  azure: AzureManagement;
  input: OnboardBatchInput;
  spec: OnboardBatchTableSpec;
  location: string;
  workspaceResourceId: string;
  /** Predicted DCE resource id (its ARM path) when createDCE, else null. */
  dceResourceId: string | null;
}): Promise<{ requests: CollectedArmRequest[]; detail: string }> {
  const { azure, input, spec, location, workspaceResourceId } = args;
  const options = input.options;
  const isCustom = isCustomTableName(spec.table);
  const requests: CollectedArmRequest[] = [];
  const tablePath = `${workspacePathFor(input)}/tables/${spec.table}`;

  // Column source: the LIVE table when it exists (existing schema always
  // wins), else the supplied customSchema (custom tables only) - whose
  // creation PUT is then collected too.
  let columns: readonly LogAnalyticsColumn[];
  let createsTable = false;
  const tableResponse = await azure.request({
    method: "GET",
    path: tablePath,
    apiVersion: LOG_ANALYTICS_API_VERSION,
  });
  if (is2xx(tableResponse.status)) {
    const schema = prop(prop(tableResponse.body, "properties"), "schema");
    const selected = selectSchemaColumns(
      {
        columns: prop(schema, "columns") as LogAnalyticsColumn[] | undefined,
        standardColumns: prop(schema, "standardColumns") as
          | LogAnalyticsColumn[]
          | undefined,
      },
      isCustom ? "custom" : "native",
    );
    if (selected === null) {
      throw new StepFailure(
        `table '${spec.table}' has no usable column source in its schema response`,
      );
    }
    columns = selected;
  } else if (tableResponse.status === 404 && isCustom) {
    if (spec.customSchema === undefined || spec.customSchema.length === 0) {
      throw new StepFailure(
        `custom table '${spec.table}' does not exist and no customSchema ` +
          "was provided; supply a parsed schema or create the table first",
      );
    }
    const validation = validateCustomTableSchema(spec.table, spec.customSchema);
    if (!validation.valid) {
      throw new StepFailure(
        `custom table schema for '${spec.table}' is invalid: ` +
          validation.errors.join("; "),
      );
    }
    const tableRequest = buildTablePutRequest({
      subscriptionId: input.subscriptionId,
      resourceGroup: input.resourceGroup,
      workspaceName: input.workspaceName,
      table: spec.table,
      columns: spec.customSchema,
      retentionDays: options.customTableRetentionDays,
    });
    requests.push({
      kind: "custom-table",
      table: spec.table,
      artifactName: artifactNameFor(tableRequest.path),
      method: tableRequest.method,
      path: tableRequest.path,
      apiVersion: tableRequest.apiVersion,
      body: tableRequest.body,
    });
    createsTable = true;
    // The creation payload's columns double as the DCR column source (the
    // deploy path reads the created table back; offline we use what the PUT
    // would create).
    columns = tableRequest.body.properties.schema.columns;
  } else {
    throw new StepFailure(
      httpErrorText(
        `fetch schema for table '${spec.table}'`,
        tableResponse.status,
        tableResponse.body,
      ),
    );
  }

  const { name: dcrName } = generateDcrName({
    table: spec.table,
    mode: options.createDCE ? "dce" : "direct",
    prefix: input.dcrNamePrefix ?? "dcr-",
    suffix: input.dcrNameSuffix,
    location,
    isCustomTable: isCustom,
  });
  const dcrRequestInput = {
    table: spec.table,
    columns,
    location,
    workspaceResourceId,
    dcrName,
    tableMode: isCustom ? ("custom" as const) : ("native" as const),
  };
  let dcrRequest;
  if (options.createDCE) {
    if (args.dceResourceId === null) {
      // Unreachable: ensure-dce runs (and predicts the id) before any table.
      throw new StepFailure(
        "internal: createDCE is set but no DCE resource id was predicted",
      );
    }
    dcrRequest = buildDceDcrRequest({
      ...dcrRequestInput,
      dataCollectionEndpointId: args.dceResourceId,
    });
  } else {
    dcrRequest = buildDirectDcrRequest(dcrRequestInput);
  }
  requests.push({
    kind: "dcr",
    table: spec.table,
    artifactName: artifactNameFor(dcrRequest.path),
    method: dcrRequest.method,
    path: dcrRequest.path,
    apiVersion: dcrRequest.apiVersion,
    body: dcrRequest.body,
  });

  const detail = createsTable
    ? `templates collected for table '${spec.table}' and DCR '${dcrName}' ` +
      "(templateOnly - not deployed)"
    : `template collected for DCR '${dcrName}' (templateOnly - not deployed)`;
  return { requests, detail };
}

/**
 * Onboard a batch of tables under ONE parent job record. Never rejects for
 * step or table failures - the parent record carries the outcome and is
 * returned either way. (It can still reject when the JobStore itself fails,
 * or synchronously-shaped when the pacing budget input is invalid.)
 */
export async function onboardBatch(
  ports: OnboardBatchPorts,
  input: OnboardBatchInput,
): Promise<JobRecord> {
  const { cribl, jobs, logger } = ports;
  const options = input.options;
  // Validates maxRequestsPerMinute (throws RangeError on junk) and paces
  // EVERY ARM call from here on, the children's included.
  const azure = paceAzureManagement(ports.azure, input.pacing);
  const pollAttempts = pollAttemptsForTimeout(options.deploymentTimeoutSeconds);
  const secretProvided =
    input.ingestionClientSecret != null && input.ingestionClientSecret !== "";
  const batchKey = batchKeyFor(input);

  // ---- Resume scan: which tables did a previous run of THIS batch finish?
  // templateOnly runs neither consume nor produce completion (artifacts
  // regenerate deterministically); newest matching record wins per table.
  const completedBy = new Map<string, string>();
  if (!options.templateOnly) {
    const prior = await jobs.list(ONBOARD_BATCH_JOB_KIND);
    for (const record of prior) {
      if (prop(record.input, "batchKey") !== batchKey) {
        continue;
      }
      // A templateOnly run deployed NOTHING - its "succeeded" table entries
      // are collected artifacts, never completion.
      if (prop(prop(record.input, "options"), "templateOnly") === true) {
        continue;
      }
      const priorTables = prop(record.result, "tables");
      if (!Array.isArray(priorTables)) {
        continue;
      }
      for (const entry of priorTables) {
        const table = prop(entry, "table");
        if (typeof table !== "string" || completedBy.has(table)) {
          continue;
        }
        if (isCompletedEntry(entry)) {
          completedBy.set(table, record.id);
        }
      }
    }
  }

  // Persisted parent input: everything serializable, NEVER the secret value.
  const job = await jobs.create(ONBOARD_BATCH_JOB_KIND, {
    batchKey,
    tables: input.tables.map((spec) => ({
      table: spec.table,
      customSchemaProvided:
        spec.customSchema !== undefined && spec.customSchema.length > 0,
    })),
    subscriptionId: input.subscriptionId,
    resourceGroup: input.resourceGroup,
    workspaceName: input.workspaceName,
    location: input.location ?? null,
    groupId: input.groupId,
    tenantId: input.tenantId,
    ingestionClientId: input.ingestionClientId,
    ingestionClientSecretProvided: secretProvided,
    options: { ...options },
    maxRequestsPerMinute:
      input.pacing.maxRequestsPerMinute ??
      DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE,
  });

  logger?.info(
    "onboard-batch: job started",
    {
      tables: input.tables.length,
      createDCE: options.createDCE,
      templateOnly: options.templateOnly,
      skipExistingDCRs: options.skipExistingDCRs,
      alreadyCompleted: completedBy.size,
    },
    job.id,
  );

  const steps: JobStep[] = onboardBatchStepsFor(input.tables, options).map(
    (name) => ({ name, status: "pending" }),
  );

  const pushSteps = async (): Promise<void> => {
    await jobs.update(job.id, { steps: steps.map((step) => ({ ...step })) });
  };

  const setStep = async (
    name: string,
    status: JobStep["status"],
    detail?: string,
  ): Promise<void> => {
    const step = steps.find((candidate) => candidate.name === name);
    // Unreachable in practice: names come from onboardBatchStepsFor.
    if (step === undefined) {
      throw new Error(`unknown step '${name}'`);
    }
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    await pushSteps();
    input.onProgress?.({ ...step });

    const stepContext = detail !== undefined ? { detail } : undefined;
    if (status === "running") {
      logger?.debug(`onboard-batch: step ${name} running`, undefined, job.id);
    } else if (status === "succeeded") {
      logger?.info(`onboard-batch: step ${name} succeeded`, stepContext, job.id);
    } else if (status === "skipped") {
      logger?.info(`onboard-batch: step ${name} skipped`, stepContext, job.id);
    } else if (status === "failed") {
      logger?.error(`onboard-batch: step ${name} failed`, stepContext, job.id);
    }
  };

  await jobs.update(job.id, { status: "running" });
  await pushSteps();

  const tableResults: OnboardBatchTableResult[] = [];
  const templates: CollectedArmRequest[] = [];
  let dce: OnboardBatchDceOutcome | null = null;

  const outcomeSoFar = (): OnboardBatchOutcome => ({
    tables: tableResults.map((result) => ({ ...result })),
    dce: dce === null ? null : { ...dce },
    templates: templates.map((request) => ({ ...request })),
    succeeded: tableResults.filter((r) => r.status === "succeeded").length,
    failed: tableResults.filter((r) => r.status === "failed").length,
    skipped: tableResults.filter((r) => r.status === "skipped").length,
  });

  // Persist per-table progress the moment it exists (resumability contract).
  const recordTable = async (result: OnboardBatchTableResult): Promise<void> => {
    tableResults.push(result);
    await jobs.update(job.id, { result: outcomeSoFar() });
  };

  // RE-RUN NO-OP: when EVERY table is already completed by a prior run, the
  // prologue is skipped too - the whole run issues ZERO ARM calls (pinned).
  const allResumed =
    input.tables.length > 0 &&
    input.tables.every((spec) => completedBy.has(spec.table));

  const amplsStepPresent = options.createDCE && !options.dcePublicNetworkAccess;

  // The first failed SHARED step; while set, every remaining table SKIPS
  // with a detail referencing it (fix for the legacy cascade defect).
  let prerequisiteFailed: string | null = null;
  let location = input.location;
  let workspaceResourceId: string | null = null;
  /** templateOnly: the predicted DCE resource id (its ARM path). */
  let predictedDceResourceId: string | null = null;
  /** Deploy mode: the preresolved DCE handed to every child job. */
  let dceForTables: { resourceId: string; logsIngestionEndpoint: string } | undefined;

  const failPrologue = async (name: string, detail: string): Promise<void> => {
    await setStep(name, "failed", detail);
    prerequisiteFailed = name;
  };

  // ---- Shared prologue ------------------------------------------------
  if (allResumed) {
    const detail = "all tables already completed by a previous run - nothing to do";
    await setStep("fetch-workspace", "skipped", detail);
    if (options.createDCE) {
      await setStep("ensure-dce", "skipped", detail);
    }
    if (amplsStepPresent) {
      await setStep("associate-ampls", "skipped", detail);
    }
  } else {
    // fetch-workspace: location (DCR/DCE naming) + workspace resource id
    // (templateOnly DCR bodies). Children re-resolve their own.
    await setStep("fetch-workspace", "running");
    const workspacePath = workspacePathFor(input);
    const workspaceResponse = await azure.request({
      method: "GET",
      path: workspacePath,
      apiVersion: LOG_ANALYTICS_API_VERSION,
    });
    if (!is2xx(workspaceResponse.status)) {
      await failPrologue(
        "fetch-workspace",
        httpErrorText(
          `fetch workspace '${input.workspaceName}'`,
          workspaceResponse.status,
          workspaceResponse.body,
        ),
      );
    } else {
      workspaceResourceId =
        typeof prop(workspaceResponse.body, "id") === "string"
          ? (prop(workspaceResponse.body, "id") as string)
          : workspacePath;
      const bodyLocation = prop(workspaceResponse.body, "location");
      location =
        input.location ??
        (typeof bodyLocation === "string" && bodyLocation !== ""
          ? bodyLocation
          : undefined);
      if (location === undefined) {
        await failPrologue(
          "fetch-workspace",
          `workspace '${input.workspaceName}' reported no location and none was provided`,
        );
      } else {
        await setStep("fetch-workspace", "succeeded", `location ${location}`);
      }
    }

    // ensure-dce: ONCE for the batch.
    if (options.createDCE) {
      if (prerequisiteFailed !== null) {
        await setStep(
          "ensure-dce",
          "skipped",
          `skipped: prerequisite step '${prerequisiteFailed}' failed`,
        );
      } else if (
        !options.dcePublicNetworkAccess &&
        options.amplsResourceId.trim() === ""
      ) {
        // Unit 6 cross-field rule, enforced at the usecase too (option-forms
        // blocks the save; programmatic input must not sneak past it): the
        // legacy created the unreachable private-only DCE anyway.
        await setStep("ensure-dce", "running");
        await failPrologue(
          "ensure-dce",
          "DCE public network access is disabled but no amplsResourceId is " +
            "configured - a private-only DCE would be unreachable; set the " +
            "AMPLS resource ID in the deployment options",
        );
      } else {
        await setStep("ensure-dce", "running");
        try {
          const resolvedLocation = location;
          if (resolvedLocation === undefined) {
            throw new StepFailure("internal: location unresolved after fetch-workspace");
          }
          const { name: dceName } = generateDcrName({
            table: input.workspaceName,
            mode: "dce-endpoint",
            prefix: input.dceNamePrefix ?? DEFAULT_DCE_NAME_PREFIX,
            suffix: input.dceNameSuffix,
            location: resolvedLocation,
          });
          const dceRequest = buildDceRequest({
            subscriptionId: input.subscriptionId,
            resourceGroup: input.resourceGroup,
            dceName,
            location: resolvedLocation,
            publicNetworkAccess: options.dcePublicNetworkAccess,
          });

          if (options.templateOnly) {
            // NO ARM writes, no existence GET (nothing will be deployed) -
            // collect the body; the PUT path IS the predicted resource id
            // (REAL subscription - the legacy used a zeroed placeholder).
            predictedDceResourceId = dceRequest.path;
            templates.push({
              kind: "dce",
              table: null,
              artifactName: artifactNameFor(dceRequest.path),
              method: dceRequest.method,
              path: dceRequest.path,
              apiVersion: dceRequest.apiVersion,
              body: dceRequest.body,
            });
            await setStep(
              "ensure-dce",
              "succeeded",
              `template collected for DCE '${dceName}' (templateOnly - not deployed)`,
            );
          } else {
            // Create or REUSE by name: GET first.
            const existing = await azure.request({
              method: "GET",
              path: dceRequest.path,
              apiVersion: DCE_API_VERSION,
            });
            let info;
            let reused: boolean;
            if (is2xx(existing.status)) {
              info = parseDceDeployment(existing.body);
              reused = true;
            } else if (existing.status === 404) {
              const putResponse = await azure.request({
                method: dceRequest.method,
                path: dceRequest.path,
                apiVersion: dceRequest.apiVersion,
                body: dceRequest.body,
              });
              if (!is2xx(putResponse.status)) {
                throw new StepFailure(
                  httpErrorText(
                    `create DCE '${dceName}'`,
                    putResponse.status,
                    putResponse.body,
                  ),
                );
              }
              info = parseDceDeployment(putResponse.body);
              // Attempt-bounded provisioning readback (the endpoint may only
              // appear once provisioning settles).
              let attempts = 0;
              for (;;) {
                const state = info.provisioningState?.toLowerCase() ?? "";
                if (/^(failed|canceled)$/.test(state)) {
                  throw new StepFailure(
                    `DCE '${dceName}' provisioning ended in state '${info.provisioningState}'`,
                  );
                }
                if (state === "succeeded" && info.logsIngestionEndpoint !== null) {
                  break;
                }
                if (attempts >= pollAttempts) {
                  throw new StepFailure(
                    `DCE '${dceName}' did not reach provisioningState ` +
                      `Succeeded with a logsIngestion endpoint within ` +
                      `${pollAttempts} poll attempts`,
                  );
                }
                attempts++;
                const pollResponse = await azure.request({
                  method: "GET",
                  path: dceRequest.path,
                  apiVersion: DCE_API_VERSION,
                });
                if (!is2xx(pollResponse.status)) {
                  throw new StepFailure(
                    httpErrorText(
                      `poll DCE '${dceName}'`,
                      pollResponse.status,
                      pollResponse.body,
                    ),
                  );
                }
                info = parseDceDeployment(pollResponse.body);
              }
              reused = false;
            } else {
              throw new StepFailure(
                httpErrorText(
                  `check DCE '${dceName}'`,
                  existing.status,
                  existing.body,
                ),
              );
            }

            if (info.logsIngestionEndpoint === null) {
              throw new StepFailure(
                `DCE '${dceName}' exposes no logsIngestion endpoint`,
              );
            }
            const resourceId = info.id ?? dceRequest.path;
            dce = {
              name: dceName,
              resourceId,
              logsIngestionEndpoint: info.logsIngestionEndpoint,
              reused,
              amplsAssociated: false,
            };
            dceForTables = {
              resourceId,
              logsIngestionEndpoint: info.logsIngestionEndpoint,
            };
            await setStep(
              "ensure-dce",
              "succeeded",
              reused
                ? `reusing existing DCE '${dceName}'`
                : `created DCE '${dceName}'`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await failPrologue("ensure-dce", message);
        }
      }
    }

    // associate-ampls: only when public network access is DISABLED (the
    // legacy association rule).
    if (amplsStepPresent) {
      if (prerequisiteFailed !== null) {
        await setStep(
          "associate-ampls",
          "skipped",
          `skipped: prerequisite step '${prerequisiteFailed}' failed`,
        );
      } else {
        await setStep("associate-ampls", "running");
        try {
          const dceResourceId = options.templateOnly
            ? predictedDceResourceId
            : (dce?.resourceId ?? null);
          if (dceResourceId === null) {
            throw new StepFailure(
              "internal: no DCE resource id available for the AMPLS association",
            );
          }
          const association = buildAmplsAssociationRequest({
            dceResourceId,
            amplsResourceId: options.amplsResourceId,
          });
          if (options.templateOnly) {
            templates.push({
              kind: "ampls-association",
              table: null,
              artifactName: artifactNameFor(association.path),
              method: association.method,
              path: association.path,
              apiVersion: association.apiVersion,
              body: association.body,
            });
            await setStep(
              "associate-ampls",
              "succeeded",
              "template collected for the AMPLS association (templateOnly - not deployed)",
            );
          } else {
            const response = await azure.request({
              method: association.method,
              path: association.path,
              apiVersion: association.apiVersion,
              body: association.body,
            });
            if (!is2xx(response.status)) {
              throw new StepFailure(
                httpErrorText(
                  "associate DCE with AMPLS",
                  response.status,
                  response.body,
                ),
              );
            }
            if (dce !== null) {
              dce = { ...dce, amplsAssociated: true };
            }
            await setStep(
              "associate-ampls",
              "succeeded",
              `associated with '${options.amplsResourceId}'`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await failPrologue("associate-ampls", message);
        }
      }
    }

    // Prologue results persist before the first table runs.
    await jobs.update(job.id, { result: outcomeSoFar() });
  }

  // ---- Per-table loop ---------------------------------------------------
  for (const spec of input.tables) {
    const stepName = batchTableStepName(spec.table);

    const completedIn = completedBy.get(spec.table);
    if (completedIn !== undefined) {
      const detail = `already completed by batch job '${completedIn}' - skipped`;
      await setStep(stepName, "skipped", detail);
      await recordTable({
        table: spec.table,
        status: "skipped",
        reason: "already-completed",
        detail,
      });
      continue;
    }

    if (prerequisiteFailed !== null) {
      const detail = `skipped: prerequisite step '${prerequisiteFailed}' failed`;
      await setStep(stepName, "skipped", detail);
      await recordTable({
        table: spec.table,
        status: "skipped",
        reason: "prerequisite-failed",
        detail,
      });
      continue;
    }

    await setStep(stepName, "running");
    try {
      const resolvedLocation = location;
      const resolvedWorkspaceId = workspaceResourceId;
      if (resolvedLocation === undefined || resolvedWorkspaceId === null) {
        throw new StepFailure("internal: workspace unresolved after fetch-workspace");
      }

      if (options.templateOnly) {
        const collected = await collectTableTemplates({
          azure,
          input,
          spec,
          location: resolvedLocation,
          workspaceResourceId: resolvedWorkspaceId,
          dceResourceId: predictedDceResourceId,
        });
        templates.push(...collected.requests);
        await setStep(stepName, "succeeded", collected.detail);
        await recordTable({
          table: spec.table,
          status: "succeeded",
          detail: collected.detail,
        });
        continue;
      }

      const isCustom = isCustomTableName(spec.table);
      const { name: dcrName } = generateDcrName({
        table: spec.table,
        mode: options.createDCE ? "dce" : "direct",
        prefix: input.dcrNamePrefix ?? "dcr-",
        suffix: input.dcrNameSuffix,
        location: resolvedLocation,
        isCustomTable: isCustom,
      });

      // skip-existing: GET the DCR first; a hit means ZERO deploy calls for
      // this table (user decision: first-class 'skipped', pinned).
      if (options.skipExistingDCRs) {
        const existing = await azure.request({
          method: "GET",
          path: dcrPathFor(input, dcrName),
          apiVersion: DIRECT_DCR_API_VERSION,
        });
        if (is2xx(existing.status)) {
          const detail = `DCR '${dcrName}' already exists - skipped (skipExistingDCRs)`;
          await setStep(stepName, "skipped", detail);
          await recordTable({
            table: spec.table,
            status: "skipped",
            reason: "already-exists",
            detail,
          });
          continue;
        }
        if (existing.status !== 404) {
          throw new StepFailure(
            httpErrorText(
              `check existing DCR '${dcrName}'`,
              existing.status,
              existing.body,
            ),
          );
        }
      }

      // Exactly ONE deploy implementation: the onboardTable usecase, with
      // the batch's shared scope, the timeout-derived attempt bounds, and
      // (in DCE mode) the preresolved shared DCE.
      const childInput: OnboardTableInput = {
        table: spec.table,
        // The batch runs its OWN skip-existing pass above - do not repeat
        // the per-table collision/reuse listings inside every child.
        skipCollisionScan: true,
        customSchema: spec.customSchema,
        customTableRetentionDays: options.customTableRetentionDays,
        maxTablePollAttempts: pollAttempts,
        maxDcrPollAttempts: pollAttempts,
        subscriptionId: input.subscriptionId,
        resourceGroup: input.resourceGroup,
        workspaceName: input.workspaceName,
        location: resolvedLocation,
        groupId: input.groupId,
        tenantId: input.tenantId,
        ingestionClientId: input.ingestionClientId,
        ingestionClientSecret: input.ingestionClientSecret,
        dcrNamePrefix: input.dcrNamePrefix,
        dcrNameSuffix: input.dcrNameSuffix,
        dce: dceForTables,
      };
      const child = await onboardTable({ azure, cribl, jobs, logger }, childInput);
      if (child.status === "succeeded") {
        const outcome = child.result as OnboardTableOutcome;
        const detail = `DCR '${outcome.dcrName}' deployed (job '${child.id}')`;
        await setStep(stepName, "succeeded", detail);
        await recordTable({
          table: spec.table,
          status: "succeeded",
          detail,
          jobId: child.id,
          outcome,
        });
      } else {
        const error =
          child.error ??
          `onboard-table job '${child.id}' ended with status '${child.status}'`;
        await setStep(stepName, "failed", error);
        await recordTable({
          table: spec.table,
          status: "failed",
          jobId: child.id,
          error,
        });
      }
    } catch (error) {
      // ISOLATION: one table's failure never stops the others (the legacy
      // engine cascaded errors across tables) - record and continue.
      const message = error instanceof Error ? error.message : String(error);
      await setStep(stepName, "failed", message);
      await recordTable({ table: spec.table, status: "failed", error: message });
    }
  }

  // ---- Finalize the parent record ----------------------------------------
  const outcome = outcomeSoFar();
  const allSkipped =
    steps.length > 0 && steps.every((step) => step.status === "skipped");
  let status: JobStatus;
  let error: string | undefined;
  if (prerequisiteFailed !== null) {
    status = "failed";
    error =
      `prerequisite step '${prerequisiteFailed}' failed - ` +
      `${outcome.skipped} table(s) skipped`;
  } else if (outcome.failed > 0) {
    status = "failed";
    error = `${outcome.failed} of ${input.tables.length} table(s) failed`;
  } else if (allSkipped) {
    // Re-run of a fully completed batch: honestly 'skipped', not 'succeeded'
    // - the run did no work ('skipped' is first-class, user decision).
    status = "skipped";
  } else {
    status = "succeeded";
  }
  await jobs.update(job.id, {
    status,
    ...(error !== undefined ? { error } : {}),
    result: outcome,
  });

  if (status === "failed") {
    logger?.error(
      "onboard-batch: job failed",
      { error: error ?? null, failed: outcome.failed, skipped: outcome.skipped },
      job.id,
    );
  } else {
    logger?.info(
      `onboard-batch: job ${status}`,
      {
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        skipped: outcome.skipped,
        templates: outcome.templates.length,
      },
      job.id,
    );
  }

  const finalRecord = await jobs.get(job.id);
  // Unreachable in practice: the record was created at the top of this run.
  if (finalRecord === null) {
    throw new Error(`job '${job.id}' vanished from the JobStore`);
  }
  return finalRecord;
}
