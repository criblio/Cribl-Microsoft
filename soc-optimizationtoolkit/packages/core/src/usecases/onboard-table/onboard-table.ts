/**
 * onboardTable - the walking-skeleton use-case: onboard one NATIVE Log
 * Analytics table end to end. Pure orchestration against the three ports
 * (AzureManagement, CriblClient, JobStore); zero IO of its own, no wall-clock
 * reads, no timers - polling is bounded by ATTEMPT COUNT only (the adapters
 * enforce per-request timeouts).
 *
 * Steps (each updates the JobStore record AND fires onProgress):
 *   1 fetch-workspace          GET the workspace resource (resource id +
 *                              location when the caller did not provide one)
 *   2 fetch-table-schema       GET workspace tables/{table}; native mode
 *                              REFUSES "_CL" tables; columns are selected via
 *                              schema-mapping selectSchemaColumns
 *   3 generate-dcr-name        dcr-naming, mode "direct" (legacy contract)
 *   4 deploy-dcr               PUT the Kind:Direct DCR (buildDirectDcrRequest)
 *                              then GET-poll until provisioningState Succeeded
 *                              or maxDcrPollAttempts is exhausted; parse
 *                              immutableId + logsIngestion endpoint
 *   5 create-cribl-destination POST /system/outputs in groupId context with
 *                              buildSentinelDestination
 *   6 commit-and-deploy        POST /version/commit (group) then PATCH
 *                              /master/groups/{groupId}/deploy (leader).
 *                              HTTP errors here are REPORTED BUT NONFATAL:
 *                              deployment semantics differ per Cribl mode
 *                              (single-instance leaders reject group commit
 *                              routes), so the step is recorded honestly as
 *                              failed and the job continues.
 *   7 verify                   GET the DCR and GET the created output
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

/** JobStore `kind` for records created by {@link onboardTable}. */
export const ONBOARD_TABLE_JOB_KIND = "onboard-table";

/**
 * ARM api-version for Microsoft.OperationalInsights workspaces and tables
 * (the legacy engine pins 2022-10-01 for both the tables GET and PUT).
 */
export const LOG_ANALYTICS_API_VERSION = "2022-10-01";

/** Default bound on DCR provisioning-poll GETs (attempts, not wall-clock). */
export const DEFAULT_DCR_POLL_ATTEMPTS = 10;

/** Ordered step names of an onboard-table job. */
export const ONBOARD_TABLE_STEPS = Object.freeze([
  "fetch-workspace",
  "fetch-table-schema",
  "generate-dcr-name",
  "deploy-dcr",
  "create-cribl-destination",
  "commit-and-deploy",
  "verify",
] as const);

/** One of the {@link ONBOARD_TABLE_STEPS} names. */
export type OnboardTableStepName = (typeof ONBOARD_TABLE_STEPS)[number];

/** The ports {@link onboardTable} orchestrates. */
export interface OnboardTablePorts {
  azure: AzureManagement;
  cribl: CriblClient;
  jobs: JobStore;
}

/** Input for {@link onboardTable}. */
export interface OnboardTableInput {
  /** Native table name, e.g. "SecurityEvent". "_CL" tables are refused. */
  table: string;
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
 * Onboard a native table: deploy a Kind:Direct DCR for it and create the
 * matching Cribl Sentinel destination. Never rejects for step failures - the
 * job record carries the outcome; the final record is returned either way.
 * (It can still reject if the JobStore itself fails.)
 */
export async function onboardTable(
  ports: OnboardTablePorts,
  input: OnboardTableInput,
): Promise<JobRecord> {
  const { azure, cribl, jobs } = ports;
  const secretProvided =
    input.ingestionClientSecret != null && input.ingestionClientSecret !== "";

  // Persisted job input: everything serializable, NEVER the secret value.
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
  });

  const steps: JobStep[] = ONBOARD_TABLE_STEPS.map((name) => ({
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

    // ---- Step 2: fetch-table-schema ----------------------------------
    currentStep = "fetch-table-schema";
    await setStep(currentStep, "running");

    // Native mode refuses custom (_CL) tables outright - the legacy variant
    // rules never look up _CL names for native tables (collision guard).
    if (/_CL$/i.test(input.table)) {
      throw new StepFailure(
        `table '${input.table}' ends with _CL; onboardTable handles NATIVE tables only`,
      );
    }

    const tableResponse = await azure.request({
      method: "GET",
      path: `${workspacePath}/tables/${input.table}`,
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

    const schema = prop(prop(tableResponse.body, "properties"), "schema");
    const columns = selectSchemaColumns(
      {
        columns: prop(schema, "columns") as LogAnalyticsColumn[] | undefined,
        standardColumns: prop(schema, "standardColumns") as
          | LogAnalyticsColumn[]
          | undefined,
      },
      "native",
    );
    if (columns === null) {
      throw new StepFailure(
        `table '${input.table}' has no usable column source in its schema response`,
      );
    }
    await setStep(currentStep, "succeeded", `${columns.length} columns`);

    // ---- Step 3: generate-dcr-name -----------------------------------
    currentStep = "generate-dcr-name";
    await setStep(currentStep, "running");
    const { name: dcrName } = generateDcrName({
      table: input.table,
      mode: "direct",
      prefix: input.dcrNamePrefix ?? "dcr-",
      suffix: input.dcrNameSuffix,
      location,
      isCustomTable: false,
    });
    await setStep(currentStep, "succeeded", dcrName);

    // ---- Step 4: deploy-dcr (PUT, poll, parse) -----------------------
    currentStep = "deploy-dcr";
    await setStep(currentStep, "running");

    const dcrRequest = buildDirectDcrRequest({
      table: input.table,
      columns,
      location,
      workspaceResourceId,
      dcrName,
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

    // ---- Step 5: create-cribl-destination ----------------------------
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

    // ---- Step 6: commit-and-deploy (REPORTED BUT NONFATAL) -----------
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

    // ---- Step 7: verify ----------------------------------------------
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
      groupId: input.groupId,
      commitVersion,
    };
    await jobs.update(job.id, { status: "succeeded", result: outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setStep(currentStep, "failed", message);
    await jobs.update(job.id, { status: "failed", error: message });
  }

  const finalRecord = await jobs.get(job.id);
  // Unreachable in practice: the record was created at the top of this run.
  if (finalRecord === null) {
    throw new Error(`job '${job.id}' vanished from the JobStore`);
  }
  return finalRecord;
}
