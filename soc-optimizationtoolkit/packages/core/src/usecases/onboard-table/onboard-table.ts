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
 *                              custom tables get "_CL" stripped)
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
import { generateDcrName } from "../../domain/dcr-naming";
import { selectSchemaColumns } from "../../domain/schema-mapping";
import type { LogAnalyticsColumn } from "../../domain/schema-mapping";
import {
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
    const { name: dcrName } = generateDcrName({
      table: input.table,
      mode: "direct",
      prefix: input.dcrNamePrefix ?? "dcr-",
      suffix: input.dcrNameSuffix,
      location,
      isCustomTable: isCustom,
    });
    await setStep(currentStep, "succeeded", dcrName);

    // ---- Step 5: deploy-dcr (PUT, poll, parse) -----------------------
    currentStep = "deploy-dcr";
    await setStep(currentStep, "running");

    const dcrRequest = buildDirectDcrRequest({
      table: input.table,
      columns,
      location,
      workspaceResourceId,
      dcrName,
      tableMode: isCustom ? "custom" : "native",
    });

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

    let deployment = parseDcrDeployment(putResponse.body);
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
    if (deployment.logsIngestionEndpoint === null) {
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

    const destinationId =
      input.destinationId ?? defaultSentinelDestinationId(input.table);
    const destination = buildSentinelDestination({
      id: destinationId,
      dcrImmutableId: deployment.immutableId,
      ingestionEndpoint: deployment.logsIngestionEndpoint,
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
    await setStep(currentStep, "succeeded", destinationId);

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
      logsIngestionEndpoint: deployment.logsIngestionEndpoint,
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
