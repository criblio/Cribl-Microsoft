/**
 * TenantListSection - paste a list of Azure tenant ids, get a connection per
 * new tenant and an app-registration change request per tenant to download
 * (AZR-62, ADR 0009 decision 1: one app registration per tenant).
 *
 *   - MOUNT makes no call. Parsing is live and pure (@soc/core tenant-intake).
 *   - Entries that are not tenant ids are NAMED, and duplicates are said to
 *     have been counted once; nothing pasted disappears without a word.
 *   - Only tenants with no connection are handed to the shell to create. An
 *     existing connection, its secret and the active choice are never
 *     touched: adding profiles writes no secret at all.
 *   - A tenant a domain-named connection might already carry is UNKNOWN, said
 *     so with the connection named, and not created (core decides).
 *   - Each ticket is exactly @soc/core's tenantChangeRequests output,
 *     regenerated from the current connections at render: one per connection
 *     (the RBAC plan and its scopes are per connection), or one for a tenant
 *     with none. Downloads go through the ArtifactSink port as Markdown, one
 *     file per ticket, or one combined file offered as the requester's own
 *     copy - it carries every tenant's identifiers, so it is never to be sent.
 */

import { useMemo, useState } from "react";
import { parseTenantIdList, planTenantProfiles, tenantChangeRequests, tenantTicketTargets } from "@soc/core";
import type { ConnectionProfile, TenantChangeRequestFile } from "@soc/core";
import { usePorts } from "../../ports-context";
import { InfoTip } from "../../components/info-tip";

export interface TenantListSectionProps {
  /** The requesting application's display name, as every change request uses it. */
  readonly appName: string;
  /** The connection profiles; a tenant some profile carries is not created again. */
  readonly profiles: readonly ConnectionProfile[];
  /**
   * Create a connection for each of these tenants. Called only with tenants no
   * profile carries; the shell mints the ids and saves the store.
   */
  readonly onAddTenants: (tenantIds: readonly string[]) => void;
}

const SECTION_TIP =
  "Each Azure tenant needs its own app registration, created by that tenant's administrators. Paste the tenant " +
  "ids (one per line, or separated by commas) to add a connection for every tenant that does not have one yet, " +
  "then download a change request per tenant to send to its administrators. Each request asks for the app " +
  "registration, the least privileges the app needs (the roles it cannot work without, then each optional one " +
  "with what refusing it costs), and the hand-back of the client id and secret. A connection that already exists " +
  "is never changed, and adding connections stores no secret: enter each tenant's secret in its connection once " +
  "the request comes back.";

const MARKDOWN = "text/markdown";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a ticket row says about the connection it was built from. */
function rowLabel(file: TenantChangeRequestFile): string {
  if (file.connectionName !== null) return `${file.tenantId} - connection: ${file.connectionName}`;
  if (file.undeterminedConnections.length > 0) return `${file.tenantId} - unknown whether a connection already carries it`;
  return `${file.tenantId} - no connection`;
}

/** The download button's accessible name; names the connection when the tenant has several. */
function downloadLabel(file: TenantChangeRequestFile): string {
  const base = `Download the change request for ${file.tenantId}`;
  return file.connectionsForTenant > 1 && file.connectionName !== null ? `${base} (connection ${file.connectionName})` : base;
}

const COMBINED_CAUTION =
  "Your own copy: it holds every tenant's request, so never send it to a tenant. Send each tenant only its own file.";

export function TenantListSection({ appName, profiles, onAddTenants }: TenantListSectionProps) {
  const { ports } = usePorts();
  const logger = ports.logger;
  const [text, setText] = useState("");
  // The tenants the change requests are prepared for, fixed at the last Add.
  const [prepared, setPrepared] = useState<string[]>([]);
  const [added, setAdded] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const parsed = useMemo(() => parseTenantIdList(text), [text]);
  const store = useMemo(() => ({ profiles: [...profiles], activeProfileId: null }), [profiles]);
  const plan = useMemo(() => planTenantProfiles(store, parsed.tenants), [store, parsed.tenants]);
  const tickets = useMemo(
    () => tenantChangeRequests(appName, tenantTicketTargets(store, prepared)),
    [appName, store, prepared],
  );

  function add(): void {
    if (parsed.tenants.length === 0) return;
    if (plan.create.length > 0) onAddTenants(plan.create);
    setPrepared(parsed.tenants);
    setMessage(null);
    const kept = plan.existing.length;
    const unknown = plan.undetermined.length;
    setAdded(
      `Added ${plural(plan.create.length, "connection", "connections")}.` +
        (kept === 0
          ? ""
          : ` ${plural(kept, "tenant", "tenants")} already had one and ${kept === 1 ? "was" : "were"} left unchanged.`) +
        (unknown === 0 ? "" : ` ${plural(unknown, "tenant", "tenants")} unknown, not added.`),
    );
    logger?.info("tenant-list: prepared", { tenants: parsed.tenants.length, created: plan.create.length });
  }

  async function download(filename: string, body: string): Promise<void> {
    try {
      await ports.artifacts.save(filename, MARKDOWN, body);
      setMessage({ tone: "info", text: `Download dispatched (${filename}).` });
    } catch (error) {
      const why = errorText(error);
      setMessage({ tone: "error", text: `Download failed (${filename}) - ${why}` });
      logger?.warn("tenant-list: download failed", { filename, error: why });
    }
  }

  return (
    <section className="panel">
      <h2 className="panel-title">
        Tenants and change requests <InfoTip text={SECTION_TIP} />
      </h2>
      <p className="panel-desc">
        Paste the Azure tenant ids to connect. Each new tenant gets a connection, and each tenant gets a change
        request asking its administrators for the app registration and its permissions.
      </p>
      <label className="field">
        <span className="field-label">Tenant ids</span>
        <textarea
          className="sample-paste"
          rows={4}
          value={text}
          placeholder="One tenant id per line, or separated by commas"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {parsed.tenants.length > 0 && (
        <p className="field-hint">
          {`${plural(parsed.tenants.length, "tenant", "tenants")}: ${plan.create.length} new, ` +
            `${plural(plan.existing.length, "already has", "already have")} a connection` +
            (plan.undetermined.length === 0 ? "." : `, ${plan.undetermined.length} unknown.`)}
        </p>
      )}
      {plan.undetermined.map((u) => (
        <p key={u.tenantId} className="field-hint">
          {`Cannot tell whether a connection already carries ${u.tenantId}: ` +
            u.connections.map((c) => `connection ${c.name} holds its tenant as '${c.tenant}'`).join(", ") +
            `, not a tenant id, so no connection is added for it. Set ${u.connections.length === 1 ? "that connection's tenant" : "those connections' tenants"} ` +
            "to its tenant id (a GUID) to decide."}
        </p>
      ))}
      {parsed.invalid.length > 0 && (
        <p className="field-hint">{`Not a tenant id (ignored): ${parsed.invalid.join(", ")}`}</p>
      )}
      {parsed.duplicates.length > 0 && (
        <p className="field-hint">{`Listed more than once (counted once): ${parsed.duplicates.join(", ")}`}</p>
      )}
      <div className="panel-controls">
        <button type="button" className="next-action-button" disabled={parsed.tenants.length === 0} onClick={add}>
          Add connections and prepare change requests
        </button>
      </div>
      {added !== null && <p className="field-hint">{added}</p>}
      {tickets.perTenant.length > 0 && (
        <>
          <ul className="tenant-request-list">
            {tickets.perTenant.map((file) => (
              <li key={file.filename}>
                <span>{rowLabel(file)}</span>{" "}
                <button
                  type="button"
                  className="run-button"
                  aria-label={downloadLabel(file)}
                  onClick={() => void download(file.filename, file.body)}
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
          {tickets.combined !== null && (
            <div className="panel-controls">
              <button
                type="button"
                className="run-button"
                onClick={() => {
                  const combined = tickets.combined;
                  if (combined !== null) void download(combined.filename, combined.body);
                }}
              >
                Download all as one file
              </button>
              <span className="field-hint">{COMBINED_CAUTION}</span>
            </div>
          )}
        </>
      )}
      {message !== null && (
        <p className="field-hint" role={message.tone === "error" ? "alert" : undefined}>
          {message.text}
        </p>
      )}
    </section>
  );
}
