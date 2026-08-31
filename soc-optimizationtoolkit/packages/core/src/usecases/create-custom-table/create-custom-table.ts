/**
 * Create ONE Log Analytics custom table from a supplied schema, idempotently.
 *
 * EXTRACTED FROM `onboardTable`'s create-custom-table step (TBL-3), not
 * rewritten: the Tables tab needs to create a table with Azure alone, and the
 * only implementation of this lived inside a pipelined job that also needs a
 * Cribl worker group and an ingestion client id. `onboardTable` now calls this
 * and keeps its own step reporting, so there is one implementation of the
 * creation contract rather than two that must agree.
 *
 * THE CONTRACT, preserved verbatim from the legacy Process-CustomTable flow:
 *
 *   - GET FIRST, and AN EXISTING TABLE WINS. Creation is skipped and the live
 *     body is returned. This is why the result carries `body` - the caller
 *     uses the table it already fetched rather than GETting a second time.
 *   - A 404 REQUIRES `columns`. Creating a table with no schema is not a
 *     thing, and the error says how to get one.
 *   - THE READBACK IS ATTEMPT-BOUNDED, replacing the legacy blind
 *     `Start-Sleep 10`. A 404 during polling means "not replicated yet" and is
 *     retried; `failed`/`canceled` ends it; a missing provisioningState counts
 *     as done, because a table that GETs back without one is not pending.
 *
 * ERRORS ARE PLAIN `Error`S WITH THE MESSAGES `onboardTable` ALREADY USED, so
 * that caller can rewrap them in its own StepFailure without changing a single
 * operator-visible string - the characterization pins on those messages are
 * what make this extraction safe.
 *
 * NO CLOCK AND NO SLEEP: the poll loop is attempt-bounded rather than
 * time-bounded, exactly as it was inside the step, so core stays clock-free.
 */

import type { AzureManagement } from "../../ports/azure-management";
import { httpErrorText, is2xx, prop } from "../arm-http";
import {
  buildTablePutRequest,
  LOG_ANALYTICS_TABLES_API_VERSION,
  validateCustomTableSchema,
} from "../../domain/custom-table";
import type { CustomSchemaFileColumn } from "../../domain/schema-mapping";
import type { CustomTableRetentionDays } from "../../domain/option-forms";

/** Default readback attempts, matching onboardTable's own default. */
export const DEFAULT_CREATE_TABLE_POLL_ATTEMPTS = 10;

export interface CreateCustomTableInput {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** The table name, including its `_CL` suffix. */
  table: string;
  /**
   * The schema to create the table FROM. Required only when the table does
   * not exist - an existing table keeps its live schema and this is ignored.
   */
  columns?: readonly CustomSchemaFileColumn[];
  retentionDays?: CustomTableRetentionDays;
  /** Readback attempts before giving up. Defaults to 10. */
  maxPollAttempts?: number;
}

export interface CreateCustomTableResult {
  /** The name as the request built it (the `_CL` suffix rule applied). */
  tableName: string;
  /** False when the table already existed and creation was skipped. */
  created: boolean;
  /** The table resource body, existing or created. */
  body: unknown;
  /**
   * Shape of what was CREATED, for the caller's report. All null when the
   * table already existed - there is nothing this call decided about it.
   */
  columnCount: number | null;
  retentionInDays: number | null;
  totalRetentionInDays: number | null;
}

export async function createCustomTable(
  azure: AzureManagement,
  input: CreateCustomTableInput,
): Promise<CreateCustomTableResult> {
  const workspacePath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}`;
  const tablePath = `${workspacePath}/tables/${input.table}`;

  const existingResponse = await azure.request({
    method: "GET",
    path: tablePath,
    apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
  });

  if (is2xx(existingResponse.status)) {
    return {
      tableName: input.table,
      created: false,
      body: existingResponse.body,
      columnCount: null,
      retentionInDays: null,
      totalRetentionInDays: null,
    };
  }

  if (existingResponse.status !== 404) {
    throw new Error(
      httpErrorText(
        `check custom table '${input.table}'`,
        existingResponse.status,
        existingResponse.body,
      ),
    );
  }

  if (input.columns === undefined || input.columns.length === 0) {
    throw new Error(
      `custom table '${input.table}' does not exist and no ` +
        "customSchema was provided; supply a parsed schema " +
        "(parseTableSchemaFile / VENDOR_SCHEMAS) or create the table first",
    );
  }

  const validation = validateCustomTableSchema(input.table, input.columns);
  if (!validation.valid) {
    throw new Error(
      `custom table schema for '${input.table}' is invalid: ` +
        validation.errors.join("; "),
    );
  }

  const tableRequest = buildTablePutRequest({
    subscriptionId: input.subscriptionId,
    resourceGroup: input.resourceGroup,
    workspaceName: input.workspaceName,
    table: input.table,
    columns: input.columns,
    ...(input.retentionDays !== undefined
      ? { retentionDays: input.retentionDays }
      : {}),
  });

  const putResponse = await azure.request({
    method: tableRequest.method,
    path: tableRequest.path,
    apiVersion: tableRequest.apiVersion,
    body: tableRequest.body,
  });
  if (!is2xx(putResponse.status)) {
    throw new Error(
      httpErrorText(
        `create custom table '${tableRequest.tableName}'`,
        putResponse.status,
        putResponse.body,
      ),
    );
  }

  const maxAttempts =
    input.maxPollAttempts ?? DEFAULT_CREATE_TABLE_POLL_ATTEMPTS;
  let attempts = 0;
  let body: unknown;
  for (;;) {
    if (attempts >= maxAttempts) {
      throw new Error(
        `custom table '${tableRequest.tableName}' was created but did ` +
          `not read back successfully within ${maxAttempts} poll attempts`,
      );
    }
    attempts++;
    const pollResponse = await azure.request({
      method: "GET",
      path: tablePath,
      apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
    });
    if (is2xx(pollResponse.status)) {
      const state = prop(prop(pollResponse.body, "properties"), "provisioningState");
      const stateText = typeof state === "string" ? state : null;
      if (stateText !== null && /^(failed|canceled)$/i.test(stateText)) {
        throw new Error(
          `custom table '${tableRequest.tableName}' provisioning ended ` +
            `in state '${stateText}'`,
        );
      }
      if (stateText === null || /^succeeded$/i.test(stateText)) {
        body = pollResponse.body;
        break;
      }
    } else if (pollResponse.status !== 404) {
      throw new Error(
        httpErrorText(
          `poll custom table '${tableRequest.tableName}'`,
          pollResponse.status,
          pollResponse.body,
        ),
      );
    }
  }

  return {
    tableName: tableRequest.tableName,
    created: true,
    body,
    columnCount: tableRequest.body.properties.schema.columns.length,
    retentionInDays: tableRequest.body.properties.retentionInDays,
    totalRetentionInDays: tableRequest.body.properties.totalRetentionInDays,
  };
}
