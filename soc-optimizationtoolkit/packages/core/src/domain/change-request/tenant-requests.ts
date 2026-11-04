/**
 * Per-tenant change requests - one app-registration ticket per tenant, plus
 * one combined file, as Markdown downloads (AZR-62, ADR 0009 decision 1).
 *
 * Each tenant gets its own app registration, so each gets its own ticket:
 * exactly {@link appRegistrationRequest} for that tenant's config, whose
 * permissions come from the least-privilege registry through
 * appPermissionPlan. Nothing here restates a role or a scope.
 *
 * ONE TICKET PER CONNECTION. The RBAC plan and its scopes are per connection
 * (setup path, subscription, resource group), so a tenant two connections
 * carry gets two tickets, each opening with which connection it covers.
 *
 * THE COMBINED FILE IS THE REQUESTER'S COPY. It carries every tenant's ids,
 * subscriptions, resource groups and client ids, so its first line says not
 * to send it, and its index names no connection (customer-chosen labels).
 *
 * WHY MARKDOWN NEEDS A PASS. The ticket is plain text that reads as
 * Markdown, with two traps a renderer springs:
 *
 *   - a placeholder such as `<client id>` is an HTML open tag to a Markdown
 *     renderer, so the one value the reader must notice is missing renders
 *     as nothing. Outside the Mermaid fence each placeholder is wrapped in
 *     code, which renders literally;
 *   - the permission blocks are aligned lines a renderer reflows into one
 *     paragraph. Each prose line ends in a hard break, so it stays a line.
 *
 * The Mermaid source is left alone: its placeholders are entity-encoded
 * already (dataflow-diagram), and trailing spaces mean nothing there.
 *
 * Pure: no IO, no Date, no randomness.
 */

import { appRegistrationRequest } from "./change-request";
import type { ChangeRequestOptions } from "./change-request";
import type { TenantTicketTarget } from "../tenant-intake";

/** One downloadable ticket file. */
export interface TenantChangeRequestFile {
  /** The tenant this ticket is for (empty only for the combined file's own use). */
  readonly tenantId: string;
  /** The one connection this ticket covers; null for a tenant with none yet. */
  readonly connectionName: string | null;
  /** How many connections carry the tenant; above 1, each has its own ticket. */
  readonly connectionsForTenant: number;
  /** 1-based position among this tenant's tickets (1 when it has one). */
  readonly ordinal: number;
  /** Connections whose tenant could not be compared, for a tenant with none known. */
  readonly undeterminedConnections: readonly string[];
  /** A bare file name, safe for the ArtifactSink. */
  readonly filename: string;
  /** The Markdown body. */
  readonly body: string;
}

/** Every ticket (one per connection, or one per tenant with none), plus the combined file (null for none). */
export interface TenantChangeRequestSet {
  readonly perTenant: TenantChangeRequestFile[];
  readonly combined: { readonly filename: string; readonly body: string } | null;
}

/** A placeholder as resolveNames writes one: `<` lower-case words `>`. */
const PLACEHOLDER = /<([a-z][a-z ]*)>/g;

/**
 * Make a plain-text ticket safe to render as Markdown: outside ``` fences,
 * wrap each placeholder in code and end each non-blank line with a hard
 * break. Fenced lines pass through untouched.
 */
export function ticketMarkdown(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimEnd().startsWith("```")) {
        fenced = !fenced;
        return line;
      }
      if (fenced || line.trim() === "") return line;
      return line.replace(PLACEHOLDER, "`<$1>`") + "  ";
    })
    .join("\n");
}

/**
 * The per-ticket file name: the tenant id is a GUID, so the name is path-safe;
 * a tenant with several connections numbers its tickets.
 */
function ticketFilename(tenantId: string, ordinal: number, count: number): string {
  return count > 1 ? `app-registration-request-${tenantId}-${ordinal}.md` : `app-registration-request-${tenantId}.md`;
}

/** The opening of a ticket for one of several connections on a tenant: which one it covers. */
function connectionNote(connectionName: string, count: number): string {
  return [
    `This tenant has ${count} connections in the requesting app, and each has its own`,
    `request. This one covers connection "${connectionName}" only: the roles and scopes`,
    "below are for its subscription, resource group and setup path. If the",
    "connections share one app registration, create it once and grant it every request's roles.",
    "",
    "",
  ].join("\n");
}

/** The index line's note for one ticket. No connection name: another tenant may read the index. */
function indexNote(f: TenantChangeRequestFile): string {
  if (f.connectionsForTenant > 1) return ` (request ${f.ordinal} of ${f.connectionsForTenant})`;
  if (f.connectionName !== null) return "";
  if (f.undeterminedConnections.length > 0) return " (unknown whether a connection already carries it)";
  return " (no connection yet)";
}

/** The combined file's opening: what it is, and which tenants it holds. */
function combinedIndex(appName: string, files: readonly TenantChangeRequestFile[]): string {
  const tenants = new Set(files.map((f) => f.tenantId)).size;
  const tenantWord = `${tenants} tenant${tenants === 1 ? "" : "s"}`;
  return [
    `REQUESTER'S COPY - DO NOT SEND THIS FILE. It holds the requests for ${tenantWord}, so it names every tenant's ids; send each tenant's administrators only that tenant's own file.`,
    "",
    `# App registration change requests for ${appName}: ${tenantWord}`,
    "",
    "One request per connection follows (one for a tenant with no connection",
    "yet), each complete on its own. Each belongs to the administrators of the",
    "tenant it names: a registration, its consent and its roles in one tenant",
    "grant nothing in another.",
    "",
    ...files.map((f) => `- ${f.tenantId}${indexNote(f)}`),
  ].join("\n");
}

/**
 * One app-registration ticket per target, and the combined file. `appName`
 * is the requesting application's display name; a blank one renders as a
 * placeholder, like every other unknown value.
 */
export function tenantChangeRequests(
  appName: string,
  targets: readonly TenantTicketTarget[],
  options?: ChangeRequestOptions,
): TenantChangeRequestSet {
  const seen = new Map<string, number>();
  const perTenant: TenantChangeRequestFile[] = targets.map((target) => {
    const ordinal = (seen.get(target.tenantId) ?? 0) + 1;
    seen.set(target.tenantId, ordinal);
    const count = target.connectionsForTenant;
    const ticket = appRegistrationRequest({ appName, config: target.config }, options);
    const note = count > 1 && target.connectionName !== null ? connectionNote(target.connectionName, count) : "";
    return {
      tenantId: target.tenantId,
      connectionName: target.connectionName,
      connectionsForTenant: count,
      ordinal,
      undeterminedConnections: [...target.undeterminedConnections],
      filename: ticketFilename(target.tenantId, ordinal, count),
      body: ticketMarkdown(note + ticket),
    };
  });
  if (perTenant.length === 0) return { perTenant, combined: null };
  const combined = [combinedIndex(appName, perTenant), ...perTenant.map((f) => f.body)].join("\n\n---\n\n");
  return {
    perTenant,
    combined: { filename: `app-registration-requests-${perTenant.length}-tenants.md`, body: combined + "\n" },
  };
}
