/**
 * Azure setup state - the PURE decisions behind the Setup page's Azure
 * sections (AzureConnectSection / AzureResourcesSection), promoted from the
 * cloud shell's Diagnostics panels 3 (App registration and connect) and 4
 * (Select resources and grant permissions). Kept out of the components so
 * the ARM response parsing, the actionable error messages, and the
 * setup-path -> permission-scope mapping are unit-testable without a DOM.
 *
 * The components run every request through ports.azure / ports.secrets;
 * adapters own token acquisition and refresh end to end, so nothing here
 * (and nothing in the components) touches tokens or storage directly.
 *
 * Pure: no IO, no fetch, no React.
 */

import { evaluatePermissions, allGranted, REQUIRED_ACTIONS } from "@soc/core";
import type {
  AzureSetupPath,
  PermissionsResponse,
  RequiredAction,
} from "@soc/core";
import type { SelectOption } from "../../components/searchable-select-filter";

// ARM api-versions - the exact versions the live-tested Diagnostics panels
// used. The RBAC permissions api-version comes from @soc/core
// (RBAC_PERMISSIONS_API_VERSION) so preflight and Setup cannot drift.
export const SUBSCRIPTIONS_API_VERSION = "2022-12-01";
export const WORKSPACES_API_VERSION = "2023-09-01";
export const RESOURCE_GROUPS_API_VERSION = "2021-04-01";

/** The role-assignment script's download name (both shells). */
export const ROLE_SCRIPT_FILENAME = "assign-roles.sh";

/** Discovery option shapes populated from ARM list responses. Minimal - only
 * the fields the dropdowns render or use to derive shared config. */
export interface SubscriptionOption {
  subscriptionId: string;
  displayName: string;
}
export interface WorkspaceOption {
  name: string;
  id: string;
}
export interface ResourceGroupOption {
  name: string;
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Render a port body for error messages without ever throwing. */
function bodyText(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body === null || body === undefined) {
    return "";
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/** The `value` array of an ARM list body, or [] for any surprising shape. */
function listValue(body: unknown): unknown[] {
  const value = prop(body, "value");
  return Array.isArray(value) ? value : [];
}

/** Tolerantly map an ARM subscriptions list body into dropdown options. */
export function parseSubscriptionOptions(body: unknown): SubscriptionOption[] {
  const out: SubscriptionOption[] = [];
  for (const entry of listValue(body)) {
    const subscriptionId = prop(entry, "subscriptionId");
    if (typeof subscriptionId !== "string" || subscriptionId === "") {
      continue;
    }
    const displayName = prop(entry, "displayName");
    out.push({
      subscriptionId,
      displayName:
        typeof displayName === "string" && displayName !== ""
          ? displayName
          : "(no displayName)",
    });
  }
  return out;
}

/** Tolerantly map an ARM workspaces list body into dropdown options. */
export function parseWorkspaceOptions(body: unknown): WorkspaceOption[] {
  const out: WorkspaceOption[] = [];
  for (const entry of listValue(body)) {
    const name = prop(entry, "name");
    const id = prop(entry, "id");
    if (
      typeof name === "string" &&
      name !== "" &&
      typeof id === "string" &&
      id !== ""
    ) {
      out.push({ name, id });
    }
  }
  return out;
}

/** Tolerantly map an ARM resource-groups list body into dropdown options. */
export function parseResourceGroupOptions(body: unknown): ResourceGroupOption[] {
  const out: ResourceGroupOption[] = [];
  for (const entry of listValue(body)) {
    const name = prop(entry, "name");
    if (typeof name === "string" && name !== "") {
      out.push({ name });
    }
  }
  return out;
}

/** SearchableSelect options for discovered subscriptions (id is the value). */
export function subscriptionSelectOptions(
  subs: readonly SubscriptionOption[],
): SelectOption[] {
  return subs.map((s) => ({
    value: s.subscriptionId,
    label: `${s.displayName} (${s.subscriptionId})`,
  }));
}

/** SearchableSelect options for discovered workspaces (name is the value). */
export function workspaceSelectOptions(
  workspaces: readonly WorkspaceOption[],
): SelectOption[] {
  return workspaces.map((w) => ({ value: w.name, label: w.name }));
}

/** SearchableSelect options for discovered resource groups. */
export function resourceGroupSelectOptions(
  groups: readonly ResourceGroupOption[],
): SelectOption[] {
  return groups.map((g) => ({ value: g.name, label: g.name }));
}

/**
 * An actionable message for a failed ARM read (non-2xx port response). The
 * port adapter already injects and refreshes tokens, so a surviving 401 means
 * the stored secret cannot mint a working token - reconnecting is the fix.
 */
export function armFailureMessage(
  label: string,
  status: number,
  body: unknown,
): string {
  if (status === 401) {
    return (
      `${label}: HTTP 401 - the ARM token was rejected and could not be refreshed. ` +
      "Save and connect again in the App registration and connect section, then retry."
    );
  }
  if (status === 403) {
    return (
      `${label}: HTTP 403 - the service principal is not authorized at this scope. ` +
      "Grant it at least Reader (run the role assignment script below), wait for " +
      "propagation, then retry."
    );
  }
  return `${label}: HTTP ${status}\n${bodyText(body)}`;
}

/** Everything the connect action needs from the form. */
export interface AzureConnectInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * The connect form's validation message, or null when the input is complete.
 * Same rules the live-tested panel enforced.
 */
export function connectInputIssue(input: AzureConnectInput): string | null {
  if (input.clientId.trim() === "" || input.clientSecret === "") {
    return "Client ID and client secret are both required to connect.";
  }
  if (input.tenantId.trim() === "") {
    return "Tenant ID is required to acquire an ARM token - enter it above, then Save and connect.";
  }
  return null;
}

/**
 * One permission-scope check the selected setup path requires: either a
 * runnable RBAC permissions read (label + GET path + required actions) or an
 * honest "select the resource first" message when the scope inputs are blank.
 */
export type ScopeCheck =
  | {
      kind: "check";
      label: string;
      /** GET path for ports.azure (RBAC_PERMISSIONS_API_VERSION applies). */
      permissionsPath: string;
      required: RequiredAction[];
    }
  | { kind: "needs-input"; message: string };

function subscriptionPermissionsPath(sub: string): string {
  return (
    `/subscriptions/${encodeURIComponent(sub)}` +
    "/providers/Microsoft.Authorization/permissions"
  );
}

function resourceGroupPermissionsPath(sub: string, rg: string): string {
  return (
    `/subscriptions/${encodeURIComponent(sub)}` +
    `/resourceGroups/${encodeURIComponent(rg)}` +
    "/providers/Microsoft.Authorization/permissions"
  );
}

/**
 * The scope check(s) the selected setup path requires, mapping the coarse
 * shell {@link AzureSetupPath} to the @soc/core required-action set keys.
 * Blank scope inputs yield needs-input entries rather than failures - the
 * validation report stays total.
 */
export function permissionScopeChecks(
  path: AzureSetupPath,
  subscriptionId: string,
  resourceGroup: string,
): ScopeCheck[] {
  const sub = subscriptionId.trim();
  const rg = resourceGroup.trim();
  if (path === "existing") {
    const checks: ScopeCheck[] = [];
    if (sub === "") {
      checks.push({
        kind: "needs-input",
        message:
          "Subscription scope: select a subscription above to validate subscription-level reads (existing-subscription).",
      });
    } else {
      checks.push({
        kind: "check",
        label: "Subscription scope (existing-subscription)",
        permissionsPath: subscriptionPermissionsPath(sub),
        required: REQUIRED_ACTIONS["existing-subscription"],
      });
    }
    if (sub === "" || rg === "") {
      checks.push({
        kind: "needs-input",
        message:
          "Resource group scope: select a subscription and workspace above to validate RG-level writes (existing-rg).",
      });
    } else {
      checks.push({
        kind: "check",
        label: "Resource group scope (existing-rg)",
        permissionsPath: resourceGroupPermissionsPath(sub, rg),
        required: REQUIRED_ACTIONS["existing-rg"],
      });
    }
    return checks;
  }
  if (path === "lab-new-rg") {
    if (sub === "") {
      return [
        {
          kind: "needs-input",
          message:
            "Subscription scope: select a subscription above to validate subscription-level lab creation (lab-new-rg-subscription).",
        },
      ];
    }
    return [
      {
        kind: "check",
        label: "Subscription scope (lab-new-rg-subscription)",
        permissionsPath: subscriptionPermissionsPath(sub),
        required: REQUIRED_ACTIONS["lab-new-rg-subscription"],
      },
    ];
  }
  // lab-byo-rg: the pre-created lab resource group scope only.
  if (sub === "" || rg === "") {
    return [
      {
        kind: "needs-input",
        message:
          "Resource group scope: select a subscription and lab resource group above to validate RG-level lab deployment (lab-byo-rg).",
      },
    ];
  }
  return [
    {
      kind: "check",
      label: "Resource group scope (lab-byo-rg)",
      permissionsPath: resourceGroupPermissionsPath(sub, rg),
      required: REQUIRED_ACTIONS["lab-byo-rg"],
    },
  ];
}

/**
 * Render one scope's RBAC permissions response as report lines: a summary
 * line plus one [ok|missing] line per required action. 401/403 and surprising
 * shapes get actionable messages rather than raw bodies.
 */
export function evaluateScopeLines(
  label: string,
  status: number,
  body: unknown,
  required: RequiredAction[],
): string[] {
  if (status === 401) {
    return [
      `${label}: HTTP 401 - the ARM token was rejected and could not be refreshed.`,
      "  Save and connect again in the App registration and connect section, then retry.",
    ];
  }
  if (status === 403) {
    return [
      `${label}: HTTP 403 - the service principal cannot even read permissions at this scope.`,
      "  Grant it at least Reader on this scope so the preflight can evaluate effective actions.",
    ];
  }
  if (status < 200 || status >= 300) {
    return [`${label}: HTTP ${status}\n${bodyText(body)}`];
  }
  const value = prop(body, "value");
  if (!Array.isArray(value)) {
    return [`${label}: unexpected permissions response shape\n${bodyText(body)}`];
  }
  const parsed: PermissionsResponse = { value: value as PermissionsResponse["value"] };
  const results = evaluatePermissions(parsed, required);
  const lines = [
    `${label}: ${allGranted(results) ? "all required actions granted" : "MISSING required actions"}`,
  ];
  for (const result of results) {
    lines.push(`  [${result.granted ? "ok" : "missing"}] ${result.label} (${result.action})`);
  }
  return lines;
}

/** The stored-credentials report derived from a secrets-store key listing. */
export interface StoredCredentialReport {
  lines: string[];
  azureBasicPresent: boolean;
  tenant: string;
}

/**
 * The stored-credentials report: what already exists in this app context's
 * secret store (from ports.secrets.list("azure") key names) plus the active
 * connection's tenant id. The heading line is shell-supplied so the cloud
 * shell can name its app-scoped KV store.
 */
export function storedCredentialReport(
  keys: readonly string[],
  tenantId: string,
  contextLabel: string,
): StoredCredentialReport {
  const tenant = tenantId.trim();
  const azureBasicPresent = keys.includes("azureBasic");
  const lines = [
    contextLabel,
    azureBasicPresent
      ? "  client secret: stored (encrypted, not shown) - NOTE this is a single shared slot, not per connection"
      : "  client secret: not saved - Save and connect in the App registration and connect section to store it",
    tenant !== ""
      ? `  tenant ID: ${tenant} (remembered in this connection)`
      : "  tenant ID: not saved - enter it in the App registration and connect section (remembered per connection)",
    keys.includes("azureArmToken")
      ? "  azureArmToken: present (encrypted) - a token has been acquired in this context"
      : "  azureArmToken: not yet acquired - connecting or validating acquires one",
  ];
  return { lines, azureBasicPresent, tenant };
}

/** The skip message when validation cannot run without a connected secret. */
export const VALIDATION_SKIPPED_LINES: readonly string[] = [
  "",
  "Permission validation skipped: connect first in the App registration and connect",
  "section (Save and connect stores the client secret and tenant ID). Validation",
  "needs the stored secret plus a tenant ID on the active connection.",
];

/** Copy feedback for the role script, placeholder-aware. */
export function scriptCopyFeedback(script: string): string {
  return script.includes("<")
    ? "Copied - NOTE: some fields are blank, so the script still contains <placeholders>."
    : "Copied to clipboard. Run it in a shell with az logged into the test tenant.";
}

/** Download feedback for the role script, placeholder-aware. */
export function scriptDownloadFeedback(script: string): string {
  return script.includes("<")
    ? `Download dispatched (${ROLE_SCRIPT_FILENAME}) - NOTE: some fields are blank, so it still contains <placeholders>.`
    : `Download dispatched (${ROLE_SCRIPT_FILENAME}). Run: bash ${ROLE_SCRIPT_FILENAME} (or run the az lines in PowerShell).`;
}

/** The downloadable role script body (shebang + strict mode + script). */
export function wrapRoleScript(script: string): string {
  return `#!/usr/bin/env bash\nset -euo pipefail\n\n${script}\n`;
}
