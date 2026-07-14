/**
 * Deployment preview and existing-resource check - porting-plan Unit 7
 * (ENG-36, GUI-12; ux-flow-plan 5.2 amendment: this preview renders as the
 * Integrate arc's REVIEW stage). Pure orchestration over the AzureManagement
 * port: predict exactly what a deploy run would create for a set of tables
 * and answer "does it already exist" from LIVE ARM calls issued in THIS run.
 *
 * Mined from the legacy Integration Solution's IS/azure-deploy.ts 540-628
 * (azure:check-existing) and 684-763 (azure:preview-resources) for CAPABILITY
 * SEMANTICS ONLY - both handlers are partially uncharacterized (the legacy
 * check-existing catch referenced an out-of-scope variable, so its error path
 * could never have run); the tests here are written from the mining, never
 * from the code.
 *
 * DO-NOT-PORT defects, fixed here and pinned by test:
 *
 *   - NAME DIVERGENCE. The legacy preview predicted DCR names with a
 *     simplified approximation (`prefix + table.toLowerCase().replace(/_cl$/i,
 *     '').slice(0, 20) + '-' + suffix.slice(0, 10)`) that DIVERGED from the
 *     names deployment actually created. dcr-naming is THE single name
 *     source: the preview name IS the deployed name, pinned across the
 *     abbreviation-triggering legacy characterization vectors
 *     (deployment-preview.characterization.test.ts).
 *
 *   - STALE CACHE TRUTH. The legacy preview answered "exists" from cached
 *     destination FILES (findDestinationForTable) while check-existing
 *     queried live ARM - two truths that drifted per deployment. Every
 *     existence answer here comes from live ARM GETs in this run. The result
 *     carries {@link DeploymentPreview.generatedAtToken} - an OPAQUE string
 *     the CALLER supplies (e.g. an ISO timestamp minted by the shell) - so
 *     the REVIEW stage can render its staleness marker without core ever
 *     reading a clock.
 *
 *   - FUZZY MATCHING. All four legacy fuzzy substring matchers
 *     (`name.includes(stripped) || stripped.includes(name.replace(/^dcr-/,
 *     ''))` and friends) are replaced by EXACT full-name matching against the
 *     dcr-naming prediction. Names are compared case-insensitively (ARM
 *     resource names are case-insensitive) but always as the WHOLE name -
 *     shared-prefix tables (Cloudflare vs CloudflareAudit, the ASimAudit
 *     family) can no longer cross-match.
 *
 *   - READ-ONLY, ALWAYS. templateOnly does not participate here: a preview
 *     is read-only by definition, independent of any option. Only GET
 *     requests are ever issued (pinned by a call-method audit test).
 *
 * Reuse contract (porting-plan section 3 item 1 and the Unit 7 notes): names
 * come from dcr-naming; request bodies from the dcr-request / dce-request /
 * custom-table builders; pagination from azure-discovery's listAllPages. NO
 * new request-shape logic exists in this module.
 *
 * Ingestion endpoints are returned VERBATIM - the legacy
 * handler.control.monitor -> ingest.monitor rewrite is a Cribl-destination
 * composition concern (deferred to sentinel-destination per the Unit 6
 * follow-up note), never a preview concern.
 *
 * Zero IO of its own, no wall-clock reads, no timers, no Date/crypto.
 */

import type { AzureManagement } from "../../ports/azure-management";
import { generateDcrName } from "../../domain/dcr-naming";
import {
  buildTablePutRequest,
  isCustomTableName,
  LOG_ANALYTICS_TABLES_API_VERSION,
  validateCustomTableSchema,
} from "../../domain/custom-table";
import {
  buildDceDcrRequest,
  buildDirectDcrRequest,
  parseDcrDeployment,
  DIRECT_DCR_API_VERSION,
} from "../../domain/dcr-request";
import {
  buildDceRequest,
  parseDceDeployment,
  DCE_API_VERSION,
} from "../../domain/dce-request";
import { selectSchemaColumns } from "../../domain/schema-mapping";
import type {
  CustomSchemaFileColumn,
  LogAnalyticsColumn,
} from "../../domain/schema-mapping";
import type { OperationOptions } from "../../domain/option-forms";
import { listAllPages } from "../azure-discovery";
import { DEFAULT_DCE_NAME_PREFIX } from "../onboard-batch";

// ---------------------------------------------------------------------------
// Shared helpers (same pattern as the sibling usecases)
// ---------------------------------------------------------------------------

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

/** Coerce an unknown field to a string, '' for anything not a string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Legacy default DCR name prefix (same default as the onboard usecases). */
const DEFAULT_DCR_NAME_PREFIX = "dcr-";

// ---------------------------------------------------------------------------
// checkExistingDcrs
// ---------------------------------------------------------------------------

/** Which DCR flavor the deploy run would create (drives dcr-naming's limit). */
export type DcrPreviewMode = "direct" | "dce";

/** The ARM scope a check/preview runs against. */
export interface DcrResourceScope {
  subscriptionId: string;
  resourceGroup: string;
}

/** Options for {@link checkExistingDcrs} - the dcr-naming prediction inputs. */
export interface CheckExistingDcrsOptions {
  /** "direct" (30-char limit) or "dce" (64-char limit) - from createDCE. */
  mode: DcrPreviewMode;
  /** Azure region used in name prediction (dcr-naming input). */
  location: string;
  /** DCR name prefix, concatenated verbatim (legacy default "dcr-"). */
  dcrNamePrefix?: string;
  /** Optional DCR name suffix (legacy default: none). */
  dcrNameSuffix?: string;
}

/** Per-table answer of {@link checkExistingDcrs}. */
export interface ExistingDcrCheck {
  /** The requested table, verbatim. */
  table: string;
  /**
   * The PREDICTED DCR name (dcr-naming - the single source; byte-identical
   * to what onboardTable/onboardBatch would deploy for the same inputs).
   */
  dcrName: string;
  /** True when a DCR with exactly that name exists in the resource group. */
  exists: boolean;
  /** properties.immutableId from the per-match GET (matches only). */
  immutableId?: string;
  /**
   * The logs-ingestion endpoint URL, VERBATIM (matches only). Direct DCRs
   * expose it themselves; for DCE-based DCRs it is resolved with ONE extra
   * GET of the DCR's dataCollectionEndpointId (the legacy check-existing
   * followed the same chain).
   */
  ingestionEndpoint?: string;
  /**
   * Raw greppable error text when the per-match detail GET - or the DCE
   * follow-up GET resolving a DCE-based DCR's ingestion endpoint - failed
   * (the DCR still EXISTS - the list said so; only the enrichment is
   * missing). The legacy handler swallowed both failures into silent empty
   * strings; both are surfaced honestly here.
   */
  detailError?: string;
}

/**
 * Check which of `tables` already have their DCR deployed - LIVE ARM truth,
 * never cached files (the legacy check-existing/preview split trusted two
 * different truths; this is the ONE existence oracle for Unit 7).
 *
 * ONE list request per call (paginated via listAllPages when the adapter
 * implements requestUrl), scoped to the resource group, at api-version
 * 2023-03-11 ({@link DIRECT_DCR_API_VERSION}); then ONE GET per MATCHED table
 * (never for misses - pinned by call-count test) resolving immutableId and
 * the logs-ingestion endpoint via the existing parsers (parseDcrDeployment,
 * with the dataCollectionEndpointId -> parseDceDeployment fallback for
 * DCE-based DCRs).
 *
 * Matching is EXACT: the table's dcr-naming prediction against the full
 * deployed resource name, compared case-insensitively. Never a substring,
 * never fuzzy.
 *
 * Results are returned in input order. Throws (raw greppable text) when the
 * list itself fails - the legacy swallowed that failure into all-null results
 * through a catch block that itself crashed on an out-of-scope variable.
 */
export async function checkExistingDcrs(
  azure: AzureManagement,
  scope: DcrResourceScope,
  tables: readonly string[],
  options: CheckExistingDcrsOptions,
): Promise<ExistingDcrCheck[]> {
  if (tables.length === 0) {
    return [];
  }

  const listPath =
    `/subscriptions/${scope.subscriptionId}` +
    `/resourceGroups/${scope.resourceGroup}` +
    `/providers/Microsoft.Insights/dataCollectionRules`;
  const items = await listAllPages(
    azure,
    { method: "GET", path: listPath, apiVersion: DIRECT_DCR_API_VERSION },
    `list DCRs in resource group '${scope.resourceGroup}'`,
  );

  // Deployed name (lowercased - ARM names are case-insensitive) -> ARM path.
  const deployed = new Map<string, string>();
  for (const item of items) {
    const name = asString(prop(item, "name"));
    if (name === "") {
      continue;
    }
    const id = asString(prop(item, "id"));
    deployed.set(name.toLowerCase(), id !== "" ? id : `${listPath}/${name}`);
  }

  const results: ExistingDcrCheck[] = [];
  for (const table of tables) {
    // THE single name source. Same inputs as the deploy path (onboardTable
    // mode "direct"/"dce", isCustomTable derived from the _CL suffix), so
    // preview name === deployed name by construction - and pinned by the
    // characterization vectors anyway.
    const { name: dcrName } = generateDcrName({
      table,
      mode: options.mode,
      prefix: options.dcrNamePrefix ?? DEFAULT_DCR_NAME_PREFIX,
      suffix: options.dcrNameSuffix,
      location: options.location,
      isCustomTable: isCustomTableName(table),
    });

    const resourcePath = deployed.get(dcrName.toLowerCase());
    if (resourcePath === undefined) {
      results.push({ table, dcrName, exists: false });
      continue;
    }

    // Per-MATCH GET: immutableId + logsIngestion endpoint (api-version
    // 2023-03-11 is required to read endpoints.logsIngestion on Direct DCRs).
    const detail = await azure.request({
      method: "GET",
      path: resourcePath,
      apiVersion: DIRECT_DCR_API_VERSION,
    });
    if (!is2xx(detail.status)) {
      // The DCR exists (the list said so); only the enrichment failed. The
      // failure is surfaced honestly instead of the legacy silent empty
      // strings.
      results.push({
        table,
        dcrName,
        exists: true,
        detailError: httpErrorText(
          `fetch DCR '${dcrName}'`,
          detail.status,
          detail.body,
        ),
      });
      continue;
    }

    const deployment = parseDcrDeployment(detail.body);
    let ingestionEndpoint = deployment.logsIngestionEndpoint;
    let detailError: string | undefined;
    if (ingestionEndpoint === null) {
      // DCE-based DCRs expose no endpoint of their own; the legacy
      // check-existing followed properties.dataCollectionEndpointId to the
      // DCE and read its logsIngestion endpoint - same chain here, through
      // the existing parser. ONE version is pinned repo-wide: 2023-03-11
      // (the legacy IS handler's 2022-06-01 was a drifted second copy).
      const dceId = asString(
        prop(prop(detail.body, "properties"), "dataCollectionEndpointId"),
      );
      if (dceId !== "") {
        const dceResponse = await azure.request({
          method: "GET",
          path: dceId,
          apiVersion: DCE_API_VERSION,
        });
        if (is2xx(dceResponse.status)) {
          ingestionEndpoint = parseDceDeployment(
            dceResponse.body,
          ).logsIngestionEndpoint;
        } else {
          // Same honesty rule as the per-match GET: the DCR exists; only
          // the endpoint enrichment failed. Never the legacy silent empty
          // string.
          detailError = httpErrorText(
            `fetch DCE for DCR '${dcrName}'`,
            dceResponse.status,
            dceResponse.body,
          );
        }
      }
    }

    results.push({
      table,
      dcrName,
      exists: true,
      ...(deployment.immutableId !== null
        ? { immutableId: deployment.immutableId }
        : {}),
      ...(ingestionEndpoint !== null ? { ingestionEndpoint } : {}),
      ...(detailError !== undefined ? { detailError } : {}),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// buildDeploymentPreview
// ---------------------------------------------------------------------------

/** One table of a preview (same spec shape as onboard-batch). */
export interface DeploymentPreviewTableSpec {
  /** Table name - native ("SecurityEvent") or custom ("CloudFlare_CL"). */
  table: string;
  /**
   * Parsed schema-file columns for a custom (_CL) table that does not exist
   * yet. Ignored for native tables and for custom tables that already exist
   * (the EXISTING Azure schema always wins - the Unit 5 contract).
   */
  customSchema?: readonly CustomSchemaFileColumn[];
}

/** The Azure scope a preview targets. */
export interface DeploymentPreviewScope {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** Azure region; defaults to the workspace's live location. */
  location?: string;
}

/**
 * The deployment options a preview honors. Note what is ABSENT: templateOnly
 * does not exist here - a preview is always read-only, independent of it.
 */
export type DeploymentPreviewOperationOptions = Pick<
  OperationOptions,
  "createDCE" | "customTableRetentionDays" | "dcePublicNetworkAccess"
>;

/** Input for {@link buildDeploymentPreview}. */
export interface DeploymentPreviewInput {
  scope: DeploymentPreviewScope;
  /** Tables to preview, in order. */
  tables: readonly DeploymentPreviewTableSpec[];
  options: DeploymentPreviewOperationOptions;
  /** DCR name prefix, concatenated verbatim (legacy default "dcr-"). */
  dcrNamePrefix?: string;
  /** Optional DCR name suffix (legacy default: none). */
  dcrNameSuffix?: string;
  /** DCE name prefix (legacy default "dce-"). */
  dceNamePrefix?: string;
  /** Optional DCE name suffix (legacy default: none). */
  dceNameSuffix?: string;
  /**
   * OPAQUE token echoed onto the result. The CALLER supplies it (e.g. an ISO
   * timestamp minted by the shell) so the REVIEW stage can render a staleness
   * marker; core never reads clocks, so it never mints one.
   */
  generatedAtToken: string;
}

/**
 * An ARM request a deploy run WOULD send, attached for display ("expandable
 * request JSON" in the review UI). Always a PUT by construction - and never
 * sent by this module.
 */
export interface PreviewArmRequest {
  method: "PUT";
  path: string;
  apiVersion: string;
  body: unknown;
}

/** The shared DCE entry of a DCE-mode preview. */
export interface DcePreview {
  /** Predicted DCE name (dcr-naming mode "dce-endpoint" over the workspace
   * name - the Unit 6 shared-DCE decision, one per batch scope). */
  name: string;
  /** True when the DCE already exists (live GET). */
  exists: boolean;
  /**
   * The ARM resource id the DCE-based DCR bodies reference: the EXISTING
   * DCE's id when it exists, else the PUT path the create would claim (real
   * subscription - never the legacy zeroed placeholder).
   */
  resourceId: string;
  /**
   * The PUT a deploy run would send, or null when the DCE exists (ensure-dce
   * reuses it - nothing would be sent).
   */
  request: PreviewArmRequest | null;
}

/** The workspace-table entry of a custom (_CL) table's preview. */
export interface TableResourcePreview {
  /** True when the Log Analytics table already exists (live GET). */
  exists: boolean;
  /**
   * The tables PUT a deploy run would send (buildTablePutRequest), or null
   * when the table exists (creation is skipped - the Unit 5 idempotency
   * contract; the existing schema wins).
   */
  request: PreviewArmRequest | null;
}

/** The DCR entry of one table's preview. */
export interface DcrResourcePreview {
  /** True when the predicted-name DCR exists ({@link checkExistingDcrs}). */
  exists: boolean;
  /** The DCR PUT a deploy run would send (Direct or DCE-based per options). */
  request: PreviewArmRequest;
  /** Existing DCR's immutableId (exists only; from the per-match GET). */
  immutableId?: string;
  /** Existing DCR's ingestion endpoint, VERBATIM (exists only). */
  ingestionEndpoint?: string;
  /** Raw error text when the per-match detail GET failed (see check). */
  detailError?: string;
}

/** One table's preview row. */
export interface DeploymentPreviewTable {
  table: string;
  kind: "native" | "custom";
  /** The predicted DCR name - dcr-naming, THE single source. */
  dcrName: string;
  /** Present for custom (_CL) tables only; null for native. */
  tableResource: TableResourcePreview | null;
  dcrResource: DcrResourcePreview;
}

/** Result of {@link buildDeploymentPreview} - JSON-serializable throughout. */
export interface DeploymentPreview {
  /** The caller-supplied staleness token, echoed verbatim. */
  generatedAtToken: string;
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** The region every prediction used (input or the workspace's live one). */
  location: string;
  /** "dce" when options.createDCE, else "direct". */
  mode: DcrPreviewMode;
  /** The shared DCE entry (mode "dce"), else null. */
  dce: DcePreview | null;
  /** Per-table rows, in input order. */
  tables: DeploymentPreviewTable[];
}

/** Freeze a builder request into the display shape. */
function toPreviewRequest(request: {
  method: "PUT";
  path: string;
  apiVersion: string;
  body: unknown;
}): PreviewArmRequest {
  return {
    method: request.method,
    path: request.path,
    apiVersion: request.apiVersion,
    body: request.body,
  };
}

/**
 * Compose the full REVIEW-stage preview for a set of tables: per table the
 * predicted DCR name (dcr-naming), the DCR PUT body a deploy run would send
 * (buildDirectDcrRequest / buildDceDcrRequest per options.createDCE), the
 * workspace-table entry for _CL tables (exists flag + the buildTablePutRequest
 * body that WOULD be sent), existence flags from {@link checkExistingDcrs},
 * and the shared DCE entry when createDCE.
 *
 * LIVE ARM calls only, all GETs, in this fixed order (tests script FIFO
 * responses against it):
 *   1. GET the workspace (resource id + location)
 *   2. mode "dce": GET the predicted DCE
 *   3. ONE DCR list (+ nextLink pages) then one GET per MATCHED table
 *   4. one GET per table (workspaces/{ws}/tables/{table} - the schema the
 *      DCR body is built from; for _CL tables also the exists answer)
 *
 * Throws (raw greppable text) when the workspace fetch, the DCE check, the
 * DCR list, or a table's schema resolution fails, when a missing custom table
 * has no customSchema, or when a supplied customSchema is invalid - the same
 * conditions a deploy run would fail on (preview honesty: a green preview
 * must not hide a red deploy).
 */
export async function buildDeploymentPreview(
  azure: AzureManagement,
  input: DeploymentPreviewInput,
): Promise<DeploymentPreview> {
  const { scope, options } = input;
  const mode: DcrPreviewMode = options.createDCE ? "dce" : "direct";

  // ---- 1. Workspace: resource id + location ---------------------------
  const workspacePath =
    `/subscriptions/${scope.subscriptionId}` +
    `/resourceGroups/${scope.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${scope.workspaceName}`;
  const workspaceResponse = await azure.request({
    method: "GET",
    path: workspacePath,
    apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
  });
  if (!is2xx(workspaceResponse.status)) {
    throw new Error(
      httpErrorText(
        `fetch workspace '${scope.workspaceName}'`,
        workspaceResponse.status,
        workspaceResponse.body,
      ),
    );
  }
  const workspaceResourceId =
    asString(prop(workspaceResponse.body, "id")) !== ""
      ? asString(prop(workspaceResponse.body, "id"))
      : workspacePath;
  const bodyLocation = asString(prop(workspaceResponse.body, "location"));
  const location =
    scope.location ?? (bodyLocation !== "" ? bodyLocation : undefined);
  if (location === undefined) {
    throw new Error(
      `workspace '${scope.workspaceName}' reported no location and none was provided`,
    );
  }

  // ---- 2. Shared DCE (mode "dce" only) --------------------------------
  let dce: DcePreview | null = null;
  if (options.createDCE) {
    // Same naming decision as onboard-batch's ensure-dce: ONE shared DCE per
    // scope, named over the WORKSPACE name (mode "dce-endpoint", no limit).
    const { name: dceName } = generateDcrName({
      table: scope.workspaceName,
      mode: "dce-endpoint",
      prefix: input.dceNamePrefix ?? DEFAULT_DCE_NAME_PREFIX,
      suffix: input.dceNameSuffix,
      location,
    });
    const dceRequest = buildDceRequest({
      subscriptionId: scope.subscriptionId,
      resourceGroup: scope.resourceGroup,
      dceName,
      location,
      publicNetworkAccess: options.dcePublicNetworkAccess,
    });
    const existing = await azure.request({
      method: "GET",
      path: dceRequest.path,
      apiVersion: DCE_API_VERSION,
    });
    if (is2xx(existing.status)) {
      const info = parseDceDeployment(existing.body);
      dce = {
        name: dceName,
        exists: true,
        resourceId: info.id ?? dceRequest.path,
        // ensure-dce REUSES an existing DCE - no PUT would be sent.
        request: null,
      };
    } else if (existing.status === 404) {
      dce = {
        name: dceName,
        exists: false,
        // The PUT path IS the predicted resource id (real subscription -
        // the onboard-batch templateOnly rule, never a zeroed placeholder).
        resourceId: dceRequest.path,
        request: toPreviewRequest(dceRequest),
      };
    } else {
      throw new Error(
        httpErrorText(`check DCE '${dceName}'`, existing.status, existing.body),
      );
    }
  }

  // ---- 3. Existing DCRs: ONE live check for all tables ----------------
  const checks = await checkExistingDcrs(
    azure,
    { subscriptionId: scope.subscriptionId, resourceGroup: scope.resourceGroup },
    input.tables.map((spec) => spec.table),
    {
      mode,
      location,
      ...(input.dcrNamePrefix !== undefined
        ? { dcrNamePrefix: input.dcrNamePrefix }
        : {}),
      ...(input.dcrNameSuffix !== undefined
        ? { dcrNameSuffix: input.dcrNameSuffix }
        : {}),
    },
  );

  // ---- 4. Per-table composition ----------------------------------------
  const tables: DeploymentPreviewTable[] = [];
  for (const [index, spec] of input.tables.entries()) {
    const check = checks[index];
    if (check === undefined || check.table !== spec.table) {
      // Unreachable in practice: checkExistingDcrs returns input order.
      throw new Error(
        `internal: existing-DCR check misaligned for table '${spec.table}'`,
      );
    }
    const isCustom = isCustomTableName(spec.table);
    const tablePath = `${workspacePath}/tables/${spec.table}`;

    // Column source: the LIVE table when it exists (existing schema always
    // wins - the Unit 5 contract), else the supplied customSchema whose
    // creation PUT is then part of the preview.
    let columns: readonly LogAnalyticsColumn[];
    let tableResource: TableResourcePreview | null = null;
    const tableResponse = await azure.request({
      method: "GET",
      path: tablePath,
      apiVersion: LOG_ANALYTICS_TABLES_API_VERSION,
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
        throw new Error(
          `table '${spec.table}' has no usable column source in its schema response`,
        );
      }
      columns = selected;
      if (isCustom) {
        // Creation would be SKIPPED (idempotency): nothing would be sent.
        tableResource = { exists: true, request: null };
      }
    } else if (tableResponse.status === 404 && isCustom) {
      if (spec.customSchema === undefined || spec.customSchema.length === 0) {
        throw new Error(
          `custom table '${spec.table}' does not exist and no customSchema ` +
            "was provided; supply a parsed schema or create the table first",
        );
      }
      const validation = validateCustomTableSchema(
        spec.table,
        spec.customSchema,
      );
      if (!validation.valid) {
        throw new Error(
          `custom table schema for '${spec.table}' is invalid: ` +
            validation.errors.join("; "),
        );
      }
      const tableRequest = buildTablePutRequest({
        subscriptionId: scope.subscriptionId,
        resourceGroup: scope.resourceGroup,
        workspaceName: scope.workspaceName,
        table: spec.table,
        columns: spec.customSchema,
        retentionDays: options.customTableRetentionDays,
      });
      tableResource = { exists: false, request: toPreviewRequest(tableRequest) };
      // The creation payload's columns double as the DCR column source (the
      // deploy path reads the created table back; the preview uses what the
      // PUT would create - same rule as onboard-batch templateOnly).
      columns = tableRequest.body.properties.schema.columns;
    } else {
      throw new Error(
        httpErrorText(
          `fetch schema for table '${spec.table}'`,
          tableResponse.status,
          tableResponse.body,
        ),
      );
    }

    // DCR body: the SAME builders the deploy path uses, never re-derived.
    const dcrRequestInput = {
      table: spec.table,
      columns,
      location,
      workspaceResourceId,
      dcrName: check.dcrName,
      tableMode: isCustom ? ("custom" as const) : ("native" as const),
    };
    const dcrRequest =
      dce !== null
        ? buildDceDcrRequest({
            ...dcrRequestInput,
            dataCollectionEndpointId: dce.resourceId,
          })
        : buildDirectDcrRequest(dcrRequestInput);

    tables.push({
      table: spec.table,
      kind: isCustom ? "custom" : "native",
      dcrName: check.dcrName,
      tableResource,
      dcrResource: {
        exists: check.exists,
        request: toPreviewRequest(dcrRequest),
        ...(check.immutableId !== undefined
          ? { immutableId: check.immutableId }
          : {}),
        ...(check.ingestionEndpoint !== undefined
          ? { ingestionEndpoint: check.ingestionEndpoint }
          : {}),
        ...(check.detailError !== undefined
          ? { detailError: check.detailError }
          : {}),
      },
    });
  }

  return {
    generatedAtToken: input.generatedAtToken,
    subscriptionId: scope.subscriptionId,
    resourceGroup: scope.resourceGroup,
    workspaceName: scope.workspaceName,
    location,
    mode,
    dce,
    tables,
  };
}
