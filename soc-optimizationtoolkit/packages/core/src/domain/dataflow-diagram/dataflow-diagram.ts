/**
 * Dataflow diagram renderer - PURE, DETERMINISTIC DIAGRAM CONTRACT.
 *
 * Renders ASCII and Mermaid diagrams of the app's Azure dataflows so they can be
 * embedded in change-request tickets (see ../change-request). The diagrams are
 * parameterized with the caller's real names where present; any blank field
 * renders as a clear placeholder (for example `<tenant id>`) so a partially
 * filled request is visibly incomplete.
 *
 * Pure: no IO, no fetch, no React, and no Date / Math.random / crypto. Given the
 * same context the output is byte-for-byte identical, so every function is
 * snapshot-testable. ASCII diagrams use ONLY 7-bit ASCII drawing characters
 * (- | + > < v ^ [ ] ( ) and text) and are laid out to fit roughly 72 columns.
 */

import type { AzureConfig } from "../azure-config";

/**
 * The context a diagram renders from: the app's display name plus the persisted
 * non-secret Azure config. Structurally identical to the change-request module's
 * ChangeRequestContext, so a caller can pass either interchangeably.
 */
export interface DiagramContext {
  /** Human-readable application name shown on the source node. */
  appName: string;
  /** The persisted non-secret Azure configuration. */
  config: AzureConfig;
}

/**
 * The six context strings after placeholder substitution. Every field is either
 * the trimmed real value or a clear angle-bracket placeholder.
 */
export interface ResolvedNames {
  appName: string;
  clientId: string;
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
}

/** Return the trimmed value, or `placeholder` when it is blank. */
function orPlaceholder(value: string, placeholder: string): string {
  return value.trim() === "" ? placeholder : value.trim();
}

/**
 * Resolve a context to display strings, substituting a clear placeholder for
 * every blank field so a partial request reads as visibly incomplete.
 */
export function resolveNames(ctx: DiagramContext): ResolvedNames {
  return {
    appName: orPlaceholder(ctx.appName, "<app name>"),
    clientId: orPlaceholder(ctx.config.clientId, "<client id>"),
    tenantId: orPlaceholder(ctx.config.tenantId, "<tenant id>"),
    subscriptionId: orPlaceholder(ctx.config.subscriptionId, "<subscription id>"),
    resourceGroup: orPlaceholder(ctx.config.resourceGroup, "<resource group>"),
    workspaceName: orPlaceholder(ctx.config.workspaceName, "<workspace name>"),
  };
}

/**
 * Render a bordered ASCII box sized to its widest line. Returns the box as an
 * array of lines (no trailing newline).
 */
function box(lines: string[]): string[] {
  const width = lines.reduce(
    (max, line) => (line.length > max ? line.length : max),
    0,
  );
  const border = "+" + "-".repeat(width + 2) + "+";
  const body = lines.map(
    (line) => "| " + line + " ".repeat(width - line.length) + " |",
  );
  return [border, ...body, border];
}

/**
 * Render a downward connector between two boxes, with an optional edge label.
 * Uses only ASCII `|` and `v`.
 */
function arrowDown(label: string): string[] {
  if (label === "") {
    return ["     |", "     v"];
  }
  return ["     |", "     | " + label, "     v"];
}

/** Join a sequence of line-arrays into a single newline-delimited string. */
function stack(parts: string[][]): string {
  return parts.flat().join("\n");
}

/**
 * Escape a value for use inside a Mermaid double-quoted node label. Angle
 * brackets (which Mermaid would treat as HTML) and quotes are entity-encoded so
 * placeholders like `<tenant id>` survive rendering. Output stays 7-bit ASCII.
 */
function mermaidLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap Mermaid graph lines in a fenced ```mermaid code block. */
function fence(lines: string[]): string {
  return ["```mermaid", "flowchart LR", ...lines, "```"].join("\n");
}

// ---------------------------------------------------------------------------
// Auth flow: browser -> proxy (secret injected server-side) -> Entra -> ARM.
// ---------------------------------------------------------------------------

/**
 * ASCII auth flow. Emphasizes that the client secret is injected server-side by
 * the Cribl proxy from a write-only KV store and is never handled by the
 * browser.
 */
export function authFlowAscii(ctx: DiagramContext): string {
  const n = resolveNames(ctx);
  const diagram = stack([
    box(["Cribl app (browser)", "app: " + n.appName]),
    arrowDown("HTTPS call, no secret in the browser"),
    box([
      "Cribl proxy (server-side)",
      "injects client secret",
      "from write-only KV store",
    ]),
    arrowDown("POST client_credentials"),
    box([
      "Entra token endpoint",
      "login.microsoftonline.com",
      "tenant: " + n.tenantId,
      "client: " + n.clientId,
    ]),
    arrowDown("access token (bearer)"),
    box(["Azure Resource Manager", "management.azure.com"]),
  ]);
  const note = [
    "Note: the client secret is injected server-side by the Cribl proxy",
    "from a write-only KV store; it is never sent to or handled by the",
    "browser.",
  ].join("\n");
  return diagram + "\n\n" + note;
}

/** Mermaid variant of the auth flow. */
export function authFlowMermaid(ctx: DiagramContext): string {
  const n = resolveNames(ctx);
  return fence([
    'browser["Cribl app (browser) - app: ' + mermaidLabel(n.appName) + '"]',
    'proxy["Cribl proxy (server-side) - injects client secret from write-only KV"]',
    'entra["Entra token endpoint - login.microsoftonline.com - tenant ' +
      mermaidLabel(n.tenantId) +
      " - client " +
      mermaidLabel(n.clientId) +
      '"]',
    'arm["Azure Resource Manager - management.azure.com"]',
    "browser -->|HTTPS call, no secret in the browser| proxy",
    "proxy -->|POST client_credentials, secret injected server-side| entra",
    "entra -->|access token (bearer)| arm",
  ]);
}

// ---------------------------------------------------------------------------
// Data export flow: diagnostic settings -> Event Hub -> Cribl -> Sentinel/DCR.
// ---------------------------------------------------------------------------

/** ASCII ingestion/export flow, naming the target workspace and resource group. */
export function dataExportFlowAscii(ctx: DiagramContext): string {
  const n = resolveNames(ctx);
  return stack([
    box(["Azure diagnostic settings", "subscription: " + n.subscriptionId]),
    arrowDown("stream events"),
    box(["Event Hub"]),
    arrowDown("pull events"),
    box(["Cribl Stream", "reduce / normalize"]),
    arrowDown("Logs Ingestion API (via DCR)"),
    box([
      "Microsoft Sentinel",
      "workspace: " + n.workspaceName,
      "resource group: " + n.resourceGroup,
    ]),
  ]);
}

/** Mermaid variant of the ingestion/export flow. */
export function dataExportFlowMermaid(ctx: DiagramContext): string {
  const n = resolveNames(ctx);
  return fence([
    'diag["Azure diagnostic settings - subscription ' +
      mermaidLabel(n.subscriptionId) +
      '"]',
    'eh["Event Hub"]',
    'cribl["Cribl Stream - reduce / normalize"]',
    'sentinel["Microsoft Sentinel - workspace ' +
      mermaidLabel(n.workspaceName) +
      " - resource group " +
      mermaidLabel(n.resourceGroup) +
      '"]',
    "diag -->|stream events| eh",
    "eh -->|pull events| cribl",
    "cribl -->|Logs Ingestion API via DCR| sentinel",
  ]);
}

// ---------------------------------------------------------------------------
// DCR deploy flow: app -> ARM -> create DCR + table in the workspace.
// ---------------------------------------------------------------------------

/** ASCII DCR deployment flow, naming the subscription, resource group, workspace. */
export function dcrDeployFlowAscii(ctx: DiagramContext): string {
  const n = resolveNames(ctx);
  return stack([
    box([n.appName, "Cribl app"]),
    arrowDown("deploy (ARM template)"),
    box(["Azure Resource Manager", "subscription: " + n.subscriptionId]),
    arrowDown("create resources"),
    box([
      "DCR + custom table",
      "resource group: " + n.resourceGroup,
      "workspace: " + n.workspaceName,
    ]),
  ]);
}

/** Mermaid variant of the DCR deployment flow. */
export function dcrDeployFlowMermaid(ctx: DiagramContext): string {
  const n = resolveNames(ctx);
  return fence([
    'app["' + mermaidLabel(n.appName) + ' (Cribl app)"]',
    'arm["Azure Resource Manager - subscription ' +
      mermaidLabel(n.subscriptionId) +
      '"]',
    'dcr["DCR + custom table - resource group ' +
      mermaidLabel(n.resourceGroup) +
      " - workspace " +
      mermaidLabel(n.workspaceName) +
      '"]',
    "app -->|deploy ARM template| arm",
    "arm -->|create DCR + table| dcr",
  ]);
}
