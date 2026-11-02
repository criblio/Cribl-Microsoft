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
import { appRegistrationRequest, requestSummary } from "@soc/core";
import type { AzureSetupPath, ChangeRequestContext } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
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

/** The setup-path notes, shown behind an InfoTip (moved verbatim from inline prose). */
const SETUP_PATH_NOTES: Readonly<Record<AzureSetupPath, string>> = {
  existing:
    "Least privilege for an existing environment: Monitoring Contributor and Log Analytics " +
    "Contributor scoped to the workspace resource group, plus Reader on the subscription. " +
    "Nothing is granted subscription-wide beyond read.",
  "lab-new-rg":
    "Requires Contributor at the subscription scope (resource group creation is a " +
    "subscription-level action, and it covers all workspace and DCR operations inside the lab, " +
    "so no workspace resource group is needed) and RBAC Administrator at the subscription scope " +
    "for the lab TTL self-destruct. Assign RBAC Administrator in the portal with the condition " +
    '"Constrain roles and principal types": only Contributor and Monitoring Metrics Publisher, ' +
    "only to service principals.",
  "lab-byo-rg":
    "Least privilege for labs: an admin pre-creates an empty lab resource group and grants " +
    "Contributor on it - the lab deploys its workspace there with no subscription-scope rights. " +
    "The admin also pre-assigns the TTL self-destruct identity its delete rights on that group.",
};

/** The manual app-registration steps, shown behind an InfoTip (moved verbatim). */
const REGISTRATION_STEPS =
  "1. In Entra ID, open App registrations and select New registration. Single tenant; no redirect URI is needed (this is a daemon-style confidential client).\n" +
  "2. Record the Directory (tenant) ID and Application (client) ID from the Overview page.\n" +
  "3. Under Certificates and secrets, create a New client secret and copy its value immediately - it is shown only once.\n" +
  "4. Enter the tenant ID, client ID, and client secret below, choose your setup path, then Save and connect.";

/**
 * The one visible line above the generator. It FOLLOWS the connectivity choice:
 * the ticket asks for the registration and secret plus what requestSummary says
 * the saved choice requests, so it never claims to cover "everything" (DBT-240).
 */
function ticketLine(ctx: ChangeRequestContext): string {
  const summary = requestSummary(ctx.config);
  const asks =
    summary === "nothing selected"
      ? "the app registration and a client secret"
      : `the app registration and a client secret, plus ${summary}`;
  return `A paste-ready ticket for the team that manages Entra ID, asking for ${asks}.`;
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
  // Disconnected asks for no identity at all; read the same config the ticket reads.
  if (ctx.config.connectivity === "disconnected") return null;
  // The setup-path radios and their notes belong to Fully Connected only.
  const full = (ctx.config.connectivity ?? "full") === "full";

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
        description={ticketLine(ctx)}
        detail={
          "The ticket is for a single-tenant daemon confidential client (no redirect URI) and a client " +
          "secret, plus what the connectivity choice above asks for. Each line names the feature that " +
          "needs it, why, and what stops working without it, so any single permission can be approved " +
          "or refused on its own. The current tenant/client ids are included; blank fields appear as " +
          "clear placeholders."
        }
        filename="app-registration-request.txt"
        generate={() => appRegistrationRequest(ctx)}
      />
      <p className="field-hint">
        How to create the app registration
        <InfoTip label="How to create the app registration" text={REGISTRATION_STEPS} />
      </p>
      {full && (
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
      )}
      {full && (
        <p className="field-hint">
          About this setup path
          <InfoTip label="About this setup path" text={SETUP_PATH_NOTES[setupPath]} />
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
      <p className="field-hint">
        Where the secret and token are stored
        <InfoTip label="Where the secret and token are stored" text={storageNote} />
      </p>
    </section>
  );
}
