/**
 * AzureConnectSection - the Setup page's "App registration and connect"
 * section, promoted from the cloud shell's Diagnostics panel 3 (the journey's
 * Connect surface). The identity inputs (tenant ID, client ID, client secret)
 * plus a single primary action, Save and connect.
 *
 * The CONNECT MECHANICS are shell-owned and injected via {@link
 * AzureConnectSectionProps.onConnect}: the cloud shell writes the encrypted
 * write-only azureBasic entry, acquires an ARM token, and stores it for the
 * platform proxy to inject server-side. This component owns only the form,
 * validation (connectInputIssue), the change-request escape hatch, and the
 * setup-path choice; the trailing storage explainer is likewise shell prose
 * ({@link AzureConnectSectionProps.storageNote}) because shared copy never
 * describes shell-specific storage.
 */

import { useState } from "react";
import { appRegistrationRequest } from "@soc/core";
import type { AzureSetupPath, ChangeRequestContext } from "@soc/core";
import { ChangeRequestBlock } from "./change-request-block";
import { connectInputIssue } from "./azure-setup-state";
import type { AzureConnectInput } from "./azure-setup-state";
import { useRunner } from "./use-runner";

/** What the shell's connect action reports back to the section. */
export interface AzureConnectResult {
  /** True when the whole connect (secret stored + token verified) landed. */
  ok: boolean;
  /**
   * True when the secret write landed, even if verification failed after it -
   * the section clears the secret input exactly when this is true.
   */
  secretStored: boolean;
  /** Rendered verbatim in the output area (success summary or failure detail). */
  message: string;
}

export interface AzureConnectSectionProps {
  tenantId: string;
  onTenantIdChange: (value: string) => void;
  clientId: string;
  onClientIdChange: (value: string) => void;
  setupPath: AzureSetupPath;
  onSetupPathChange: (value: AzureSetupPath) => void;
  /** Whether this connection's secret is live this session (placeholder copy). */
  secretLive: boolean;
  /**
   * The active connection's change-request context (app name + non-secret
   * config), used to generate the app-registration ticket for the IAM team.
   */
  ctx: ChangeRequestContext;
  /**
   * Perform the shell-specific connect: store the secret, then verify it by
   * acquiring a token. Must RESOLVE with an {@link AzureConnectResult} (never
   * throw) so the section can honor secretStored on partial failures.
   */
  onConnect: (input: AzureConnectInput) => Promise<AzureConnectResult>;
  /**
   * Shell prose explaining where the secret and token live and how they are
   * used (e.g. the cloud shell's encrypted-KV + proxy-injection explainer).
   */
  storageNote: string;
}

export function AzureConnectSection({
  tenantId,
  onTenantIdChange,
  clientId,
  onClientIdChange,
  setupPath,
  onSetupPathChange,
  secretLive,
  ctx,
  onConnect,
  storageNote,
}: AzureConnectSectionProps) {
  const [clientSecret, setClientSecret] = useState("");
  const [status, output, run] = useRunner();

  const saveAndConnect = () =>
    run(async () => {
      const input: AzureConnectInput = { tenantId, clientId, clientSecret };
      const issue = connectInputIssue(input);
      if (issue !== null) {
        throw new Error(issue);
      }
      const result = await onConnect(input);
      if (result.secretStored) {
        setClientSecret("");
      }
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.message;
    });

  return (
    <section className="panel">
      <h2 className="panel-title">App registration and connect</h2>
      <p className="panel-desc">
        Create the Entra app registration, then connect this app to it with the tenant ID, client ID,
        and a client secret. Azure roles are granted in the Select resources and grant permissions
        section below, after you discover your subscription.
      </p>
      <ChangeRequestBlock
        title="Cannot create the app registration yourself? Generate a change request"
        description={
          'Produce a paste-ready ticket for the team that manages Entra ID. It asks them to create a ' +
          'single-tenant daemon confidential client (no redirect URI), create a client secret, and ' +
          'securely share the tenant id, client id, and secret. The current tenant/client ids are ' +
          'included; blank fields appear as clear placeholders.'
        }
        filename="app-registration-request.txt"
        generate={() => appRegistrationRequest(ctx)}
      />
      <ol className="setup-steps">
        <li>
          In Entra ID, open App registrations and select New registration. Single tenant;
          no redirect URI is needed (this is a daemon-style confidential client).
        </li>
        <li>
          Record the Directory (tenant) ID and Application (client) ID from the Overview page.
        </li>
        <li>
          Under Certificates and secrets, create a New client secret and copy its value
          immediately - it is shown only once.
        </li>
        <li>
          Enter the tenant ID, client ID, and client secret below, choose your setup path,
          then Save and connect.
        </li>
      </ol>
      <div className="path-options">
        <label className="path-option">
          <input
            type="radio"
            name="setup-path"
            checked={setupPath === "existing"}
            onChange={() => onSetupPathChange("existing")}
          />
          <span>I have an existing Log Analytics workspace to target</span>
        </label>
        <label className="path-option">
          <input
            type="radio"
            name="setup-path"
            checked={setupPath === "lab-new-rg"}
            onChange={() => onSetupPathChange("lab-new-rg")}
          />
          <span>No workspace yet - a lab will create its own resource group and workspace</span>
        </label>
        <label className="path-option">
          <input
            type="radio"
            name="setup-path"
            checked={setupPath === "lab-byo-rg"}
            onChange={() => onSetupPathChange("lab-byo-rg")}
          />
          <span>No workspace yet - deploy a lab into a pre-created resource group</span>
        </label>
      </div>
      {setupPath === "existing" && (
        <p className="panel-desc">
          Least privilege for an existing environment: Monitoring Contributor and Log Analytics
          Contributor scoped to the workspace resource group, plus Reader on the subscription.
          Nothing is granted subscription-wide beyond read.
        </p>
      )}
      {setupPath === "lab-new-rg" && (
        <p className="panel-desc">
          Requires <strong>Contributor at the subscription scope</strong> (resource group creation is
          a subscription-level action, and it covers all workspace and DCR operations inside the lab,
          so no workspace resource group is needed) and{" "}
          <strong>RBAC Administrator at the subscription scope</strong> for the lab TTL self-destruct.
          Assign RBAC Administrator in the portal with the condition &quot;Constrain roles and
          principal types&quot;: only Contributor and Monitoring Metrics Publisher, only to service
          principals.
        </p>
      )}
      {setupPath === "lab-byo-rg" && (
        <p className="panel-desc">
          Least privilege for labs: an admin pre-creates an empty lab resource group and grants
          Contributor on it - the lab deploys its workspace there with no subscription-scope rights.
          The admin also pre-assigns the TTL self-destruct identity its delete rights on that group.
        </p>
      )}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Directory (tenant) ID</span>
          <input
            type="text"
            value={tenantId}
            onChange={(e) => onTenantIdChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Application (client) ID</span>
          <input
            type="text"
            value={clientId}
            onChange={(e) => onClientIdChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Client secret</span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={secretLive ? "stored for this connection - enter a new value to replace" : ""}
          />
        </label>
      </div>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void saveAndConnect()}
          disabled={status === "running"}
        >
          Save and connect
        </button>
        <span className={`status status-${status}`}>{status}</span>
      </div>
      {output !== "" && <pre className="result">{output}</pre>}
      <p className="panel-desc">{storageNote}</p>
    </section>
  );
}
