/**
 * onboardTable - onboard one Log Analytics table end to end: NATIVE tables
 * (walking skeleton) and, since porting-plan Unit 5, CUSTOM (_CL) tables in
 * the SAME pipelined job (custom table + DCR as one job - the catalog
 * decision; never the legacy PS double-run). Pure orchestration against the
 * three ports (AzureManagement, CriblClient, JobStore); zero IO of its own,
 * no wall-clock reads, no timers - polling is bounded by ATTEMPT COUNT only
 * (the adapters enforce per-request timeouts).
 *
 * Steps (each updates the JobStore record AND fires onProgress). The
 * create-custom-table step exists ONLY on custom (_CL) jobs - for native
 * tables it is ABSENT, not "skipped", so native job records stay
 * byte-identical to the pre-Unit-5 contract (pinned by test); UIs must seed
 * step lines from {@link onboardTableStepsFor}, not the raw constant:
 *   1 fetch-workspace          GET the workspace resource (resource id +
 *                              location when the caller did not provide one)
 *   2 create-custom-table      CUSTOM ONLY. GET workspace tables/{table}
 *                              first: exists -> creation is skipped
 *                              (idempotency, the legacy Process-CustomTable
 *                              contract) and its schema is reused; 404 ->
 *                              REQUIRES input.customSchema, validates it
 *                              (validateCustomTableSchema), PUTs the table
 *                              (buildTablePutRequest, retention
 *                              30/90-contract via customTableRetentionDays)
 *                              and GET-polls until the created table reads
 *                              back Succeeded, bounded by
 *                              maxTablePollAttempts
 *   3 fetch-table-schema       native: GET workspace tables/{table}; custom:
 *                              reuse the body resolved in step 2 (no second
 *                              GET). Columns are selected via schema-mapping
 *                              selectSchemaColumns in the table's mode
 *   4 generate-dcr-name        dcr-naming, mode "direct" (legacy contract;
 *                              custom tables get "_CL" stripped) - or mode
 *                              "dce" (64-char limit) when a preresolved DCE
 *                              is supplied (input.dce, porting-plan Unit 6;
 *                              the body then comes from buildDceDcrRequest
 *                              and the ingestion endpoint is the DCE's)
 *   5 deploy-dcr               PUT the Kind:Direct DCR (buildDirectDcrRequest
 *                              in the table's mode - custom tables emit
 *                              Custom-{table} output streams) then GET-poll
 *                              until provisioningState Succeeded or
 *                              maxDcrPollAttempts is exhausted; parse
 *                              immutableId + logsIngestion endpoint
 *   6 create-cribl-destination POST /system/outputs in groupId context with
 *                              buildSentinelDestination
 *   7 commit-and-deploy        POST /version/commit (group) then PATCH
 *                              /master/groups/{groupId}/deploy (leader).
 *                              HTTP errors here are REPORTED BUT NONFATAL:
 *                              deployment semantics differ per Cribl mode
 *                              (single-instance leaders reject group commit
 *                              routes), so the step is recorded honestly as
 *                              failed and the job continues.
 *   8 verify                   GET the DCR and GET the created output
 *
 * Any other failure marks the current step AND the job failed with the raw
 * error text and stops.
 *
 * SECRET HANDLING: ingestionClientSecret is TRANSIENT input (the platform's
 * encrypted KV is write-only, so a stored secret can never be read back).
 * It is passed through to buildSentinelDestination or defaulted to the
 * "<replace me>" placeholder; the persisted job input only records WHETHER a
 * secret was provided, never its value.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { CriblClient } from "../../ports/cribl-client";
import type { JobRecord, JobStep, JobStore } from "../../ports/job-store";
import type { Logger } from "../../ports/logger";
import { redactedLength } from "../../ports/logger";
import { avoidNameCollision, generateDcrName } from "../../domain/dcr-naming";
import { selectSchemaColumns } from "../../domain/schema-mapping";
import type { LogAnalyticsColumn } from "../../domain/schema-mapping";
import {
  buildDceDcrRequest,
  buildDirectDcrRequest,
  parseDcrDeployment,
  DIRECT_DCR_API_VERSION,
} from "../../domain/dcr-request";
import {
  buildSentinelDestination,
  defaultSentinelDestinationId,
} from "../../domain/sentinel-destination";
import {
  buildTablePutRequest,
  DEFAULT_CUSTOM_TABLE_RETENTION_DAYS,
  isCustomTableName,
  LOG_ANALYTICS_TABLES_API_VERSION,
  validateCustomTableSchema,
} from "../../domain/custom-table";
import type { CustomSchemaFileColumn } from "../../domain/schema-mapping";
import type { CustomTableRetentionDays } from "../../domain/option-forms";

/** JobStore `kind` for records created by {@link onboardTable}. */
export const ONBOARD_TABLE_JOB_KIND = "onboard-table";

/**
 * ARM api-version for Microsoft.OperationalInsights workspaces and tables
 * (the legacy engine pins 2022-10-01 for both the tables GET and PUT).
 * Single source of truth: domain/custom-table's
 * LOG_ANALYTICS_TABLES_API_VERSION; re-exported here under the walking
 * skeleton's original name.
 */
export const LOG_ANALYTICS_API_VERSION = LOG_ANALYTICS_TABLES_API_VERSION;

/** Default bound on DCR provisioning-poll GETs (attempts, not wall-clock). */
export const DEFAULT_DCR_POLL_ATTEMPTS = 10;

/**
 * Default bound on created-custom-table readback GETs (attempts, not
 * wall-clock; replaces the legacy engine's blind Start-Sleep 10).
 */
export const DEFAULT_TABLE_POLL_ATTEMPTS = 10;

/**
 * Ordered step names of an onboard-table job - the FULL (custom-table) list.
 * "create-custom-table" exists only on custom (_CL) jobs; seed step lines
 * from {@link onboardTableStepsFor}, which drops it for native tables (the
 * Unit 5 decision: absent, not "skipped", so native job records stay
 * byte-identical to the walking-skeleton contract).
 */
export const ONBOARD_TABLE_STEPS = Object.freeze([
  "fetch-workspace",
  "create-custom-table",
  "fetch-table-schema",
  "generate-dcr-name",
  "deploy-dcr",
  "create-cribl-destination",
  "commit-and-deploy",
  "verify",
] as const);

/** One of the {@link ONBOARD_TABLE_STEPS} names. */
export type OnboardTableStepName = (typeof ONBOARD_TABLE_STEPS)[number];

/**
 * The ordered step names an onboard-table job for `table` will carry:
 * the full list for custom (_CL) tables, the list WITHOUT
 * "create-custom-table" for native tables.
 */
export function onboardTableStepsFor(
  table: string,
): readonly OnboardTableStepName[] {
  return isCustomTableName(table)
    ? ONBOARD_TABLE_STEPS
    : ONBOARD_TABLE_STEPS.filter((name) => name !== "create-custom-table");
}

/**
 * A PRERESOLVED Data Collection Endpoint (porting-plan Unit 6). When supplied
 * on {@link OnboardTableInput.dce}, the job deploys a DCE-BASED DCR instead of
 * a Kind:Direct one: the DCR name comes from dcr-naming mode "dce" (64-char
 * limit), the PUT body from buildDceDcrRequest (dataCollectionEndpointId
 * wired, NO kind), and the Cribl destination points at the DCE's
 * logs-ingestion endpoint (DCE-based DCRs expose no endpoints.logsIngestion
 * of their own - the legacy PS engine read the DCE's
 * properties.logsIngestion.endpoint for exactly this case). The DCE itself is
 * ensured by the CALLER (onboardBatch ensures it ONCE per batch); this
 * usecase never creates DCEs.
 */
export interface OnboardTableDceInput {
  /** Full ARM resource id of the deployed DCE (DceDeploymentInfo.id). */
  resourceId: string;
  /** The DCE's logs-ingestion endpoint URL (properties.logsIngestion.endpoint). */
  logsIngestionEndpoint: string;
}

/** The ports {@link onboardTable} orchestrates. */
export interface OnboardTablePorts {
  azure: AzureManagement;
  cribl: CriblClient;
  jobs: JobStore;
  /**
   * OPTIONAL diagnostics sink: step transitions and failures are logged
   * through it, tagged with the job id. Absent logger = no-op, zero behavior
   * change. Context values are primitives only (Logger hard rule); the
   * ingestion client secret is referenced via redactedLength, never logged.
   */
  logger?: Logger;
}

/** Input for {@link onboardTable}. */
export interface OnboardTableInput {
  /**
   * Table name. Native ("SecurityEvent") and custom ("CloudFlare_CL") tables
   * are both supported; a name ending in "_CL" (case-insensitive, matching
   * the original native-mode guard) routes to the custom path, which
   * REQUIRES either an existing table in the workspace or
   * {@link OnboardTableInput.customSchema}.
   */
  table: string;
  /**
   * Parsed schema-file columns for a custom (_CL) table that does not exist
   * yet (from parseTableSchemaFile or a bundled VENDOR_SCHEMAS entry).
   * Ignored for native tables and for custom tables that already exist -
   * the EXISTING Azure schema always wins (legacy Process-CustomTable
   * contract).
   */
  customSchema?: readonly CustomSchemaFileColumn[];
  /**
   * Interactive retention (days) for a NEWLY CREATED custom table; defaults
   * to 30 (compatibility contract 30/90; Unit 4's
   * OperationOptions.customTableRetentionDays feeds this). Total retention
   * is always 90.
   */
  customTableRetentionDays?: CustomTableRetentionDays;
  /**
   * Max readback GETs after creating a custom table; defaults to
   * {@link DEFAULT_TABLE_POLL_ATTEMPTS}.
   */
  maxTablePollAttempts?: number;
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** Azure region for the DCR; defaults to the workspace's location. */
  location?: string;
  /** Cribl Worker Group the destination is created in. */
  groupId: string;
  /** Entra ID tenant id (Cribl OAuth loginUrl). */
  tenantId: string;
  /** App-registration client id the destination authenticates with. */
  ingestionClientId: string;
  /**
   * TRANSIENT client secret - never persisted (write-only KV; see module
   * doc). Absent means the destination ships the "<replace me>" placeholder.
   */
  ingestionClientSecret?: string;
  /** Cribl output id; defaults to the legacy "MS-Sentinel-{table}-dest". */
  destinationId?: string;
  /**
   * Skip the existing-object collision/reuse scans (the RG DCR listing and
   * the group outputs listing). Set by callers that already performed their
   * own existence checks (onboardBatch's skip-existing pass) - avoids N
   * identical listings across a batch.
   */
  skipCollisionScan?: boolean;
  /**
   * UPDATE an existing same-table DCR in place instead of reusing it as-is
   * (user request 2026-07-13: inventory existing DCRs and update them).
   * When the collision scan finds a DCR already targeting the table, the
   * deploy step PUTs the freshly-built body (current table schema) to that
   * DCR's name - an ARM upsert - rather than skipping the deploy. Without a
   * same-table DCR this flag is a no-op (a fresh DCR deploys either way).
   */
  updateExistingDcr?: boolean;
  /**
   * Preresolved DCE for DCE-BASED deployment (see
   * {@link OnboardTableDceInput}). ABSENT = the existing Direct behavior,
   * byte-identical to the pre-Unit-6 contract (pinned by test).
   */
  dce?: OnboardTableDceInput;
  /** DCR name prefix, concatenated verbatim (legacy default "dcr-"). */
  dcrNamePrefix?: string;
  /** Optional DCR name suffix (legacy default: none). */
  dcrNameSuffix?: string;
  /** Max provisioning-poll GETs; defaults to {@link DEFAULT_DCR_POLL_ATTEMPTS}. */
  maxDcrPollAttempts?: number;
  /** Fired with a copy of the step after every step-state change. */
  onProgress?: (step: JobStep) => void;
}

/** `result` recorded on the job when an onboard-table run succeeds. */
export interface OnboardTableOutcome {
  dcrName: string;
  dcrImmutableId: string;
  logsIngestionEndpoint: string;
  streamName: string;
  destinationId: string;
  /** Azure scope the DCR was deployed into - explicit so summaries and job
   * records answer "where" without relying on the connection state at the
   * time of the run. */
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /**
   * The Cribl worker group the destination was created in (and, when the
   * commit-and-deploy step succeeded, deployed to). Carried in the outcome so
   * on-screen summaries and persisted job records answer "where did this go".
   */
  groupId: string;
  /**
   * The Cribl commit hash that was deployed, or null when the
   * commit-and-deploy step did not complete (recorded honestly; the
   * destination may need a manual commit/deploy in some Cribl modes).
   */
  commitVersion: string | null;
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
/** Parse a Cribl outputs listing into id + url pairs. */
function listExistingOutputs(body: unknown): Array<{ id: string; url: string }> {
  const items =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)["items"]
      : undefined;
  if (!Array.isArray(items)) return [];
  const out: Array<{ id: string; url: string }> = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record["id"];
    if (typeof id === "string" && id !== "") {
      out.push({
        id,
        url: typeof record["url"] === "string" ? (record["url"] as string) : "",
      });
    }
  }
  return out;
}

/** One existing DCR from the resource-group listing. */
interface ExistingDcr {
  name: string;
  body: unknown;
}

/** Parse an ARM DCR list response into name + full resource body pairs. */
function listExistingDcrs(body: unknown): ExistingDcr[] {
  const value =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)["value"]
      : undefined;
  if (!Array.isArray(value)) return [];
  const out: ExistingDcr[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>)["name"];
    if (typeof name === "string" && name !== "") {
      out.push({ name, body: item });
    }
  }
  return out;
}

/**
 * Whether an existing DCR resource TARGETS `table`: any dataFlow whose
 * outputStream is Custom-/Microsoft-<table> (case-insensitive).
 */
function dcrTargetsTable(dcrBody: unknown, table: string): boolean {
  const record =
    typeof dcrBody === "object" && dcrBody !== null
      ? (dcrBody as Record<string, unknown>)
      : null;
  const props =
    record !== null && typeof record["properties"] === "object"
      ? (record["properties"] as Record<string, unknown>)
      : null;
  const flows = props !== null ? props["dataFlows"] : undefined;
  if (!Array.isArray(flows)) return false;
  const wanted = table.toLowerCase();
  for (const flow of flows) {
    if (typeof flow !== "object" || flow === null) continue;
    const outputStream = (flow as Record<string, unknown>)["outputStream"];
    if (typeof outputStream !== "string") continue;
    const stripped = outputStream.replace(/^(Custom|Microsoft)-/, "");
    if (stripped.toLowerCase() === wanted) return true;
  }
  return false;
}

class StepFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFailure";
  }
}

/**
 * Onboard a table: for custom (_CL) tables ensure the Log Analytics table
 * exists (create it from the supplied schema when it does not), then deploy
 * a Kind:Direct DCR and create the matching Cribl Sentinel destination - ONE
 * pipelined job. Never rejects for step failures - the job record carries
 * the outcome; the final record is returned either way. (It can still reject
 * if the JobStore itself fails.)
 */
export async function onboardTable(
  ports: OnboardTablePorts,
  input: OnboardTableInput,
): Promise<JobRecord> {
  const { azure, cribl, jobs, logger } = ports;
  const isCustom = isCustomTableName(input.table);
  const secretProvided =
    input.ingestionClientSecret != null && input.ingestionClientSecret !== "";

  // Persisted job input: everything serializable, NEVER the secret value.
  // The custom-path fields are recorded ONLY on custom jobs so native job
  // records stay byte-identical to the walking-skeleton contract.
  const job = await jobs.create(ONBOARD_TABLE_JOB_KIND, {
    table: input.table,
    subscriptionId: input.subscriptionId,
    resourceGroup: input.resourceGroup,
    workspaceName: input.workspaceName,
    location: input.location ?? null,
    groupId: input.groupId,
    tenantId: input.tenantId,
    ingestionClientId: input.ingestionClientId,
    ingestionClientSecretProvided: secretProvided,
    destinationId: input.destinationId ?? null,
    // DCE-mode field recorded ONLY when a DCE was supplied, so Direct-mode
    // job records stay byte-identical to the pre-Unit-6 contract.
    ...(input.dce !== undefined
      ? { dceResourceId: input.dce.resourceId }
      : {}),
    ...(isCustom
      ? {
          customSchemaProvided:
            input.customSchema !== undefined && input.customSchema.length > 0,
          customTableRetentionDays:
            input.customTableRetentionDays ??
            DEFAULT_CUSTOM_TABLE_RETENTION_DAYS,
        }
      : {}),
  });

  logger?.info(
    "onboard-table: job started",
    {
      table: input.table,
      subscriptionId: input.subscriptionId,
      resourceGroup: input.resourceGroup,
      workspaceName: input.workspaceName,
      groupId: input.groupId,
      // The one sanctioned reference to the secret: its shape, never its value.
      ingestionClientSecret:
        input.ingestionClientSecret != null && input.ingestionClientSecret !== ""
          ? redactedLength(input.ingestionClientSecret)
          : null,
    },
    job.id,
  );

  // Native jobs carry the walking-skeleton step list unchanged; the
  // create-custom-table step exists only on custom (_CL) jobs (Unit 5
  // decision: absent for native, never "skipped").
  const steps: JobStep[] = onboardTableStepsFor(input.table).map((name) => ({
    name,
    status: "pending",
  }));

  const pushSteps = async (): Promise<void> => {
    await jobs.update(job.id, { steps: steps.map((step) => ({ ...step })) });
  };

  const setStep = async (
    name: OnboardTableStepName,
    status: JobStep["status"],
    detail?: string,
  ): Promise<void> => {
    const step = steps.find((candidate) => candidate.name === name);
    // Unreachable in practice: names come from ONBOARD_TABLE_STEPS.
    if (step === undefined) {
      throw new Error(`unknown step '${name}'`);
    }
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    await pushSteps();
    input.onProgress?.({ ...step });

    // Step-boundary diagnostics through the OPTIONAL logger (no-op when
    // absent). detail is safe by construction here: step details carry names,
    // ids, counts, and raw HTTP error text - never secret values.
    const stepContext = detail !== undefined ? { detail } : undefined;
    if (status === "running") {
      logger?.debug(`onboard-table: step ${name} running`, undefined, job.id);
    } else if (status === "succeeded") {
      logger?.info(`onboard-table: step ${name} succeeded`, stepContext, job.id);
    } else if (status === "failed") {
      logger?.error(`onboard-table: step ${name} failed`, stepContext, job.id);
    }
  };

  await jobs.update(job.id, { status: "running" });
  await pushSteps();

  let currentStep: OnboardTableStepName = ONBOARD_TABLE_STEPS[0];

  try {
    // ---- Step 1: fetch-workspace -------------------------------------
    currentStep = "fetch-workspace";
    await setStep(currentStep, "running");

    const workspacePath =
      `/subscriptions/${input.subscriptionId}` +
      `/resourceGroups/${input.resourceGroup}` +
      `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}`;

    const workspaceResponse = await azure.request({
      method: "GET",
      path: workspacePath,
      apiVersion: LOG_ANALYTICS_API_VERSION,
    });
    if (!is2xx(workspaceResponse.status)) {
      throw new StepFailure(
        httpErrorText(
          `fetch workspace '${input.workspaceName}'`,
          workspaceResponse.status,
          workspaceResponse.body,
        ),
      );
    }

    const workspaceResourceId =
      typeof prop(workspaceResponse.body, "id") === "string"
        ? (prop(workspaceResponse.body, "id") as string)
        : workspacePath;
    const workspaceLocation = prop(workspaceResponse.body, "location");
    const location =
      input.location ??
      (typeof workspaceLocation === "string" ? workspaceLocation : undefined);
    if (location === undefined || location === "") {
      throw new StepFailure(
        `workspace '${input.workspaceName}' reported no location and none was provided`,
      );
    }
    await setStep(currentStep, "succeeded", `location ${location}`);

    // ---- Step 2 (custom jobs only): create-custom-table ---------------
    // GET first: an existing table wins and creation is skipped (the legacy
    // Process-CustomTable idempotency contract); a 404 requires
    // input.customSchema and creates the table from it.
    const tablePath = `${workspacePath}/tables/${input.table}`;
    let customTableBody: unknown;
    if (isCustom) {
      currentStep = "create-custom-table";
      await setStep(currentStep, "running");

      const existingResponse = await azure.request({
        method: "GET",
        path: tablePath,
        apiVersion: LOG_ANALYTICS_API_VERSION,
      });
      if (is2xx(existingResponse.status)) {
        customTableBody = existingResponse.body;
        await setStep(
          currentStep,
          "succeeded",
          `table '${input.table}' already exists - creation skipped`,
        );
      } else if (existingResponse.status === 404) {
        if (input.customSchema === undefined || input.customSchema.length === 0) {
          throw new StepFailure(
            `custom table '${input.table}' does not exist and no ` +
              "customSchema was provided; supply a parsed schema " +
              "(parseTableSchemaFile / VENDOR_SCHEMAS) or create the table first",
          );
        }
        const validation = validateCustomTableSchema(
          input.table,
          input.customSchema,
        );
        if (!validation.valid) {
          throw new StepFailure(
            `custom table schema for '${input.table}' is invalid: ` +
              validation.errors.join("; "),
          );
        }

        const tableRequest = buildTablePutRequest({
          subscriptionId: input.subscriptionId,
          resourceGroup: input.resourceGroup,
          workspaceName: input.workspaceName,
          table: input.table,
          columns: input.customSchema,
          ...(input.customTableRetentionDays !== undefined
            ? { retentionDays: input.customTableRetentionDays }
            : {}),
        });
        const tablePutResponse = await azure.request({
          method: tableRequest.method,
          path: tableRequest.path,
          apiVersion: tableRequest.apiVersion,
          body: tableRequest.body,
        });
        if (!is2xx(tablePutResponse.status)) {
          throw new StepFailure(
            httpErrorText(
              `create custom table '${tableRequest.tableName}'`,
              tablePutResponse.status,
              tablePutResponse.body,
            ),
          );
        }

        // Attempt-bounded readback (replaces the legacy blind Start-Sleep
        // 10): poll until the created table GETs back with a terminal
        // provisioningState. A 404 counts as "not replicated yet".
        const maxTableAttempts =
          input.maxTablePollAttempts ?? DEFAULT_TABLE_POLL_ATTEMPTS;
        let tableAttempts = 0;
        for (;;) {
          if (tableAttempts >= maxTableAttempts) {
            throw new StepFailure(
              `custom table '${tableRequest.tableName}' was created but did ` +
                `not read back successfully within ${maxTableAttempts} poll attempts`,
            );
          }
          tableAttempts++;
          const pollResponse = await azure.request({
            method: "GET",
            path: tablePath,
            apiVersion: LOG_ANALYTICS_API_VERSION,
          });
          if (is2xx(pollResponse.status)) {
            const state = prop(prop(pollResponse.body, "properties"), "provisioningState");
            const stateText = typeof state === "string" ? state : null;
            if (stateText !== null && /^(failed|canceled)$/i.test(stateText)) {
              throw new StepFailure(
                `custom table '${tableRequest.tableName}' provisioning ended ` +
                  `in state '${stateText}'`,
              );
            }
            if (stateText === null || /^succeeded$/i.test(stateText)) {
              customTableBody = pollResponse.body;
              break;
            }
          } else if (pollResponse.status !== 404) {
            throw new StepFailure(
              httpErrorText(
                `poll custom table '${tableRequest.tableName}'`,
                pollResponse.status,
                pollResponse.body,
              ),
            );
          }
        }
        await setStep(
          currentStep,
          "succeeded",
          `created '${tableRequest.tableName}' with ` +
            `${tableRequest.body.properties.schema.columns.length} columns, ` +
            `retention ${tableRequest.body.properties.retentionInDays}/` +
            `${tableRequest.body.properties.totalRetentionInDays} days`,
        );
      } else {
        throw new StepFailure(
          httpErrorText(
            `check custom table '${input.table}'`,
            existingResponse.status,
            existingResponse.body,
          ),
        );
      }
    }

    // ---- Step 3: fetch-table-schema ----------------------------------
    currentStep = "fetch-table-schema";
    await setStep(currentStep, "running");

    // Custom jobs already hold the table body (existing or created) from
    // the create-custom-table step - no second GET, matching the legacy
    // single-lookup Process-CustomTable flow. Native jobs GET it here.
    let tableBody: unknown;
    if (isCustom) {
      tableBody = customTableBody;
    } else {
      const tableResponse = await azure.request({
        method: "GET",
        path: tablePath,
        apiVersion: LOG_ANALYTICS_API_VERSION,
      });
      if (!is2xx(tableResponse.status)) {
        throw new StepFailure(
          httpErrorText(
            `fetch schema for table '${input.table}'`,
            tableResponse.status,
            tableResponse.body,
          ),
        );
      }
      tableBody = tableResponse.body;
    }

    const schema = prop(prop(tableBody, "properties"), "schema");
    const columns = selectSchemaColumns(
      {
        columns: prop(schema, "columns") as LogAnalyticsColumn[] | undefined,
        standardColumns: prop(schema, "standardColumns") as
          | LogAnalyticsColumn[]
          | undefined,
      },
      isCustom ? "custom" : "native",
    );
    if (columns === null) {
      throw new StepFailure(
        `table '${input.table}' has no usable column source in its schema response`,
      );
    }
    await setStep(currentStep, "succeeded", `${columns.length} columns`);

    // ---- Step 4: generate-dcr-name -----------------------------------
    currentStep = "generate-dcr-name";
    await setStep(currentStep, "running");
    // Direct DCRs cap at 30 characters, DCE-based at 64 (dcr-naming modes
    // "direct" / "dce" - the legacy contract for each deployment flavor).
    const desired = generateDcrName({
      table: input.table,
      mode: input.dce !== undefined ? "dce" : "direct",
      prefix: input.dcrNamePrefix ?? "dcr-",
      suffix: input.dcrNameSuffix,
      location,
      isCustomTable: isCustom,
    });

    // COLLISION + REUSE scan (user direction 2026-07-12): retrieve the
    // resource group's existing DCRs BEFORE committing to a name. A DCR that
    // already TARGETS this table is REUSED (deploy-dcr skips the PUT); a
    // name taken by a DIFFERENT table gets a -N suffix (an ARM PUT is an
    // upsert - an unnoticed collision silently overwrites the other DCR).
    // A failed listing degrades to today's behavior: deploy under the
    // generated name.
    let dcrName = desired.name;
    let reuseDcr: { name: string; body: unknown } | null = null;
    if (input.skipCollisionScan !== true) try {
      const listResponse = await azure.request({
        method: "GET",
        path:
          `/subscriptions/${input.subscriptionId}` +
          `/resourceGroups/${input.resourceGroup}` +
          `/providers/Microsoft.Insights/dataCollectionRules`,
        apiVersion: DIRECT_DCR_API_VERSION,
      });
      if (is2xx(listResponse.status)) {
        const existing = listExistingDcrs(listResponse.body);
        const sameTable = existing.find((dcr) =>
          dcrTargetsTable(dcr.body, input.table),
        );
        if (sameTable !== undefined) {
          reuseDcr = sameTable;
          dcrName = sameTable.name;
        } else {
          const picked = avoidNameCollision(
            desired.name,
            existing.map((dcr) => dcr.name),
            input.dce !== undefined ? 64 : 30,
          );
          dcrName = picked.name;
          if (picked.collided) {
            await setStep(
              currentStep,
              "running",
              `'${desired.name}' is taken by another table - using '${dcrName}'`,
            );
          }
        }
      }
    } catch {
      // Listing is a safety net, never a gate.
    }
    await setStep(
      currentStep,
      "succeeded",
      reuseDcr !== null
        ? `${dcrName} (existing DCR already targets ${input.table} - reusing)`
        : dcrName,
    );

    // ---- Step 5: deploy-dcr (PUT, poll, parse) -----------------------
    currentStep = "deploy-dcr";
    await setStep(currentStep, "running");

    // Exactly ONE deploy path with a mode switch on the request builder
    // (the legacy repo had two drifted deploy implementations; porting-plan
    // Unit 6 pins a single one). DCE-based bodies carry
    // dataCollectionEndpointId and NO kind; Direct bodies are Kind:Direct.
    const dcrRequestInput = {
      table: input.table,
      columns,
      location,
      workspaceResourceId,
      dcrName,
      tableMode: isCustom ? ("custom" as const) : ("native" as const),
    };
    const dcrRequest =
      input.dce !== undefined
        ? buildDceDcrRequest({
            ...dcrRequestInput,
            dataCollectionEndpointId: input.dce.resourceId,
          })
        : buildDirectDcrRequest(dcrRequestInput);

    let deployment;
    if (reuseDcr !== null && input.updateExistingDcr !== true) {
      // Skip the create entirely (user direction 2026-07-12): the existing
      // DCR for this table is the deployment. Its body carries the
      // immutableId and endpoints exactly like a PUT response.
      deployment = parseDcrDeployment(reuseDcr.body);
      await setStep(
        currentStep,
        "running",
        `skipped - reusing existing DCR '${dcrName}'`,
      );
    } else {
      if (reuseDcr !== null) {
        // updateExistingDcr: PUT the freshly-built body (current table
        // schema) over the existing DCR - an ARM upsert to the same name.
        await setStep(
          currentStep,
          "running",
          `updating existing DCR '${dcrName}' in place`,
        );
      }
      const putResponse = await azure.request({
        method: dcrRequest.method,
        path: dcrRequest.path,
        apiVersion: dcrRequest.apiVersion,
        body: dcrRequest.body,
      });
      if (!is2xx(putResponse.status)) {
        throw new StepFailure(
          httpErrorText(
            `deploy DCR '${dcrName}'`,
            putResponse.status,
            putResponse.body,
          ),
        );
      }
      deployment = parseDcrDeployment(putResponse.body);
    }
    const maxAttempts = input.maxDcrPollAttempts ?? DEFAULT_DCR_POLL_ATTEMPTS;
    let attempts = 0;
    while (deployment.provisioningState?.toLowerCase() !== "succeeded") {
      const state = deployment.provisioningState ?? "unknown";
      if (/^(failed|canceled)$/i.test(state)) {
        throw new StepFailure(
          `DCR '${dcrName}' provisioning ended in state '${state}'`,
        );
      }
      if (attempts >= maxAttempts) {
        throw new StepFailure(
          `DCR '${dcrName}' did not reach provisioningState Succeeded ` +
            `within ${maxAttempts} poll attempts (last state '${state}')`,
        );
      }
      attempts++;
      const pollResponse = await azure.request({
        method: "GET",
        path: dcrRequest.path,
        apiVersion: DIRECT_DCR_API_VERSION,
      });
      if (!is2xx(pollResponse.status)) {
        throw new StepFailure(
          httpErrorText(
            `poll DCR '${dcrName}'`,
            pollResponse.status,
            pollResponse.body,
          ),
        );
      }
      deployment = parseDcrDeployment(pollResponse.body);
    }

    if (deployment.immutableId === null) {
      throw new StepFailure(
        `DCR '${dcrName}' provisioned but carries no properties.immutableId`,
      );
    }
    // Ingestion endpoint: Direct DCRs expose their own
    // endpoints.logsIngestion; DCE-based DCRs do not - ingestion goes through
    // the preresolved DCE's endpoint instead.
    let ingestionEndpoint: string;
    if (input.dce !== undefined) {
      ingestionEndpoint = input.dce.logsIngestionEndpoint;
    } else if (deployment.logsIngestionEndpoint !== null) {
      ingestionEndpoint = deployment.logsIngestionEndpoint;
    } else {
      throw new StepFailure(
        `DCR '${dcrName}' provisioned but exposes no logsIngestion endpoint ` +
          `(is it Kind:Direct and api-version >= ${DIRECT_DCR_API_VERSION}?)`,
      );
    }
    await setStep(
      currentStep,
      "succeeded",
      `immutableId ${deployment.immutableId}`,
    );

    // ---- Step 6: create-cribl-destination ----------------------------
    currentStep = "create-cribl-destination";
    await setStep(currentStep, "running");

    let destinationId =
      input.destinationId ?? defaultSentinelDestinationId(input.table);

    // COLLISION + REUSE scan (user direction 2026-07-12): retrieve the
    // group's existing outputs before committing to the id. An output that
    // already points at THIS DCR is reused (skip the create); an id taken
    // by anything else gets a -N suffix. A failed listing degrades to
    // today's behavior.
    let reuseDestination = false;
    if (input.skipCollisionScan !== true) try {
      const listResponse = await cribl.request({
        method: "GET",
        path: "/system/outputs",
        groupId: input.groupId,
      });
      if (is2xx(listResponse.status)) {
        const outputs = listExistingOutputs(listResponse.body);
        const existing = outputs.find(
          (o) => o.id.toLowerCase() === destinationId.toLowerCase(),
        );
        if (
          existing !== undefined &&
          deployment.immutableId !== null &&
          existing.url.includes(deployment.immutableId)
        ) {
          reuseDestination = true;
        } else if (existing !== undefined) {
          const picked = avoidNameCollision(
            destinationId,
            outputs.map((o) => o.id),
            64,
          );
          await setStep(
            currentStep,
            "running",
            `'${destinationId}' exists and points elsewhere - using '${picked.name}'`,
          );
          destinationId = picked.name;
        }
      }
    } catch {
      // Listing is a safety net, never a gate.
    }

    if (!reuseDestination) {
      const destination = buildSentinelDestination({
        id: destinationId,
        dcrImmutableId: deployment.immutableId,
        ingestionEndpoint,
        streamName: dcrRequest.streamName,
        tenantId: input.tenantId,
        ingestionClientId: input.ingestionClientId,
        ingestionClientSecret: input.ingestionClientSecret,
      });

      const createResponse = await cribl.request({
        method: "POST",
        path: "/system/outputs",
        groupId: input.groupId,
        body: destination,
      });
      if (!is2xx(createResponse.status)) {
        throw new StepFailure(
          httpErrorText(
            `create Cribl destination '${destinationId}'`,
            createResponse.status,
            createResponse.body,
          ),
        );
      }
    }
    await setStep(
      currentStep,
      "succeeded",
      reuseDestination
        ? `${destinationId} (already points at this DCR - reusing)`
        : destinationId,
    );

    // ---- Step 7: commit-and-deploy (REPORTED BUT NONFATAL) -----------
    // Deployment semantics differ per Cribl mode (distributed leaders take
    // group commits + /master/groups/{id}/deploy; single-instance rejects
    // them), so an HTTP error here is recorded on the step without failing
    // the job. Transport-level rejections still fail the job.
    currentStep = "commit-and-deploy";
    await setStep(currentStep, "running");

    let commitVersion: string | null = null;
    const commitResponse = await cribl.request({
      method: "POST",
      path: "/version/commit",
      groupId: input.groupId,
      body: {
        message: `Add Sentinel destination ${destinationId}`,
        effective: true,
      },
    });
    if (is2xx(commitResponse.status)) {
      const items = prop(commitResponse.body, "items");
      const commit =
        Array.isArray(items) && items.length > 0
          ? prop(items[0], "commit")
          : undefined;
      commitVersion = typeof commit === "string" && commit !== "" ? commit : null;
      if (commitVersion === null) {
        await setStep(
          currentStep,
          "failed",
          "commit succeeded but no commit hash was returned; deploy skipped " +
            "- commit/deploy manually in Cribl",
        );
      } else {
        const deployResponse = await cribl.request({
          method: "PATCH",
          path: `/master/groups/${input.groupId}/deploy`,
          body: { version: commitVersion },
        });
        if (is2xx(deployResponse.status)) {
          await setStep(currentStep, "succeeded", `deployed ${commitVersion}`);
        } else {
          commitVersion = null;
          await setStep(
            currentStep,
            "failed",
            httpErrorText(
              "deploy committed config (nonfatal; deploy manually in Cribl)",
              deployResponse.status,
              deployResponse.body,
            ),
          );
        }
      }
    } else {
      await setStep(
        currentStep,
        "failed",
        httpErrorText(
          "commit Cribl config (nonfatal; commit/deploy manually in Cribl)",
          commitResponse.status,
          commitResponse.body,
        ),
      );
    }

    // ---- Step 8: verify ----------------------------------------------
    currentStep = "verify";
    await setStep(currentStep, "running");

    const verifyDcr = await azure.request({
      method: "GET",
      path: dcrRequest.path,
      apiVersion: DIRECT_DCR_API_VERSION,
    });
    if (!is2xx(verifyDcr.status)) {
      throw new StepFailure(
        httpErrorText(`verify DCR '${dcrName}'`, verifyDcr.status, verifyDcr.body),
      );
    }
    const verifiedDeployment = parseDcrDeployment(verifyDcr.body);
    if (verifiedDeployment.provisioningState?.toLowerCase() !== "succeeded") {
      throw new StepFailure(
        `verify DCR '${dcrName}': provisioningState is ` +
          `'${verifiedDeployment.provisioningState ?? "unknown"}', expected Succeeded`,
      );
    }

    const verifyOutput = await cribl.request({
      method: "GET",
      path: `/system/outputs/${destinationId}`,
      groupId: input.groupId,
    });
    if (!is2xx(verifyOutput.status)) {
      throw new StepFailure(
        httpErrorText(
          `verify Cribl destination '${destinationId}'`,
          verifyOutput.status,
          verifyOutput.body,
        ),
      );
    }
    await setStep(currentStep, "succeeded");

    const outcome: OnboardTableOutcome = {
      dcrName,
      dcrImmutableId: deployment.immutableId,
      logsIngestionEndpoint: ingestionEndpoint,
      streamName: dcrRequest.streamName,
      destinationId,
      subscriptionId: input.subscriptionId,
      resourceGroup: input.resourceGroup,
      workspaceName: input.workspaceName,
      groupId: input.groupId,
      commitVersion,
    };
    await jobs.update(job.id, { status: "succeeded", result: outcome });
    logger?.info(
      "onboard-table: job succeeded",
      { table: input.table, dcrName, destinationId, groupId: input.groupId },
      job.id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setStep(currentStep, "failed", message);
    await jobs.update(job.id, { status: "failed", error: message });
    logger?.error(
      "onboard-table: job failed",
      { table: input.table, step: currentStep, error: message },
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
