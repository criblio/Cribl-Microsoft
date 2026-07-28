/**
 * Phase 8 - Data collection (LAB-10 redesign): Direct DCRs for the four
 * legacy native tables through the SAME dcr-naming/dcr-request/
 * schema-mapping pieces the onboarding thread uses (the legacy shelled out
 * to the DCR toolkit; here it is direct composition). Sentinel-provisioned
 * tables are polled attempt-bounded (the legacy blind 60s wait). The
 * sequencer gates this phase on ctx.workspaceReady.
 */

import {
  selectSchemaColumns,
  type LogAnalyticsColumn,
} from "../../domain/schema-mapping";
import { generateDcrName } from "../../domain/dcr-naming";
import {
  DIRECT_DCR_API_VERSION,
  buildDirectDcrRequest,
  parseDcrDeployment,
} from "../../domain/dcr-request";
import { LOG_ANALYTICS_TABLES_API_VERSION } from "../../domain/custom-table";
import { httpErrorText, is2xx, prop } from "../arm-http";
import { pollProvisioningState } from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import { LAB_DCR_TABLES, type LabDcrOutcome } from "./provision-lab-types";

/** Run the data-collection phase (the sequencer guards on hasStep + workspace). */
export async function runDcrPhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg } = ctx;
  await ctx.setStep("data-collection-rules", "running");
  const dcrs: LabDcrOutcome[] = [];
  result.dcrs = dcrs;
  const workspaceId =
    `/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.names.logAnalytics}`;

  for (const table of input.dcrTables ?? LAB_DCR_TABLES) {
    const record: LabDcrOutcome = {
      table,
      dcrName: "",
      immutableId: "",
      logsIngestionEndpoint: "",
      stream: `Custom-${table}`,
      reused: false,
    };
    dcrs.push(record);

    // Sentinel-provisioned native tables appear asynchronously (the legacy
    // waited a blind 60s); poll the table attempt-bounded.
    let tableBody: unknown = null;
    for (let attempt = 0; attempt < ctx.maxAttempts; attempt++) {
      const tableResponse = await azure.request({
        method: "GET",
        path: `${workspaceId}/tables/${table}`,
        apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
      });
      if (is2xx(tableResponse.status)) {
        tableBody = tableResponse.body;
        break;
      }
      if (tableResponse.status !== 404) {
        record.error = httpErrorText(
          `read table '${table}'`,
          tableResponse.status,
          tableResponse.body,
        );
        break;
      }
      await ctx.sleep(ctx.delayMs);
    }
    if (record.error !== undefined) {
      continue;
    }
    if (tableBody === null) {
      record.error =
        `table '${table}' is not provisioned yet (Sentinel tables appear ` +
        `asynchronously) - re-run the deploy later`;
      continue;
    }

    const schema = prop(prop(tableBody, "properties"), "schema");
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
      record.error = `table '${table}' has no usable column source in its schema`;
      continue;
    }

    const { name: dcrName } = generateDcrName({
      table,
      mode: "direct",
      prefix: "dcr-",
      location: input.location,
      isCustomTable: false,
    });
    record.dcrName = dcrName;
    const dcrPath =
      `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Insights/dataCollectionRules/${dcrName}`;

    const getDcr = await azure.request({
      method: "GET",
      path: dcrPath,
      apiVersion: DIRECT_DCR_API_VERSION,
    });
    if (is2xx(getDcr.status)) {
      const existing = parseDcrDeployment(getDcr.body);
      record.reused = true;
      record.immutableId = existing.immutableId ?? "";
      record.logsIngestionEndpoint = existing.logsIngestionEndpoint ?? "";
      continue;
    }
    if (getDcr.status !== 404) {
      record.error = httpErrorText(
        `read DCR '${dcrName}'`,
        getDcr.status,
        getDcr.body,
      );
      continue;
    }

    let request;
    try {
      request = buildDirectDcrRequest({
        table,
        columns,
        location: input.location,
        workspaceResourceId: workspaceId,
        dcrName,
        tableMode: "native",
      });
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      continue;
    }
    record.stream = request.streamName;
    const putDcr = await azure.request({
      method: request.method,
      path: request.path,
      apiVersion: request.apiVersion,
      body: request.body,
    });
    if (!is2xx(putDcr.status)) {
      record.error = httpErrorText(
        `deploy DCR '${dcrName}'`,
        putDcr.status,
        putDcr.body,
      );
      continue;
    }
    // The DCR poll compares lowercased states (ARM returns mixed casing).
    let deployment = parseDcrDeployment(putDcr.body);
    const state = await pollProvisioningState({
      read: () =>
        azure.request({
          method: "GET",
          path: dcrPath,
          apiVersion: DIRECT_DCR_API_VERSION,
        }),
      parse: (body) => {
        deployment = parseDcrDeployment(body);
        return deployment.provisioningState?.toLowerCase() ?? "";
      },
      target: "succeeded",
      seed: deployment.provisioningState?.toLowerCase() ?? "",
      attempts: ctx.maxAttempts,
      sleep: ctx.sleep,
      delayMs: ctx.delayMs,
      keepStateOnFailedRead: true,
    });
    if (state !== "succeeded") {
      record.error =
        `DCR '${dcrName}' did not reach Succeeded within ${ctx.maxAttempts} poll attempt(s)`;
      continue;
    }
    record.immutableId = deployment.immutableId ?? "";
    record.logsIngestionEndpoint = deployment.logsIngestionEndpoint ?? "";
  }

  const failures = dcrs.filter((d) => d.error !== undefined);
  if (failures.length > 0) {
    const error = failures.map((f) => `${f.table}: ${f.error}`).join("; ");
    errors.push(error);
    await ctx.setStep("data-collection-rules", "failed", error);
  } else {
    await ctx.setStep(
      "data-collection-rules",
      "succeeded",
      dcrs
        .map((d) => `${d.table} -> ${d.dcrName}${d.reused ? " (reused)" : ""}`)
        .join(", "),
    );
  }
}
