/**
 * LeaderConnectStep - the cribl-side Connect step for the LOCAL target: derive
 * and validate the leader base URL, and (when saved profiles exist) reconnect a
 * dual-profile leader WITHOUT the legacy half-apply bug.
 *
 * Every rule is @soc/core:
 *   - the base-URL PREVIEW runs through deriveLeaderBaseUrl (this module's pure
 *     dispatcher over the core cloud / self-managed derivations), so a pasted
 *     `.../api/v1` surfaces the verbatim host fix message;
 *   - the RECONNECT runs planReconnect, which validates the override SET and the
 *     stored secret AS ONE UNIT and never half-applies. A divergent cloud
 *     base-URL vs org id, an absent profile, or a missing stored secret each
 *     yields a CLEAN failure message and applies nothing - there is no stuck
 *     state and no cross-profile fallback.
 *
 * This shell does not itself mutate host credentials here (the local host reads
 * identity from its config file); the derivation is a live validator and the
 * reconnect is wired for shells that provide a saved-profile store + apply
 * callback. The guidance line names where credentials actually live.
 */

import { useState } from "react";
import { planReconnect } from "@soc/core";
import type {
  LeaderDeploymentType,
  LeaderProfileStore,
  ReconnectOverrides,
} from "@soc/core";
import { deriveLeaderBaseUrl } from "./setup-wizard-state";
import type { LeaderConnectFormInput } from "./setup-wizard-state";

/** A resolved reconnect the shell applies wholesale (the ok branch of ReconnectPlan). */
export interface AppliedReconnect {
  deploymentType: LeaderDeploymentType;
  clientId: string;
  baseUrl: string;
  organizationId?: string;
}

export interface LeaderConnectStepProps {
  /**
   * The saved dual-profile store, when the shell persists one. Absent (the
   * local host today) means the reconnect action is unavailable and the step is
   * a live validator plus guidance.
   */
  leaderProfiles?: LeaderProfileStore;
  /** Apply a validated reconnect plan (called only on a clean, consistent plan). */
  onReconnect?: (plan: AppliedReconnect) => void | Promise<void>;
  /** Where this shell reads leader credentials from (e.g. the config-file path). */
  connectGuidance?: string;
}

export function LeaderConnectStep({
  leaderProfiles,
  onReconnect,
  connectGuidance,
}: LeaderConnectStepProps) {
  const [form, setForm] = useState<LeaderConnectFormInput>({
    deploymentType: "cloud",
    organizationId: "",
    protocol: "https",
    address: "",
    port: "",
  });
  const [clientId, setClientId] = useState("");
  const [reconnectError, setReconnectError] = useState("");
  const [reconnectOk, setReconnectOk] = useState("");
  const [reconnecting, setReconnecting] = useState(false);

  const patch = (next: Partial<LeaderConnectFormInput>) =>
    setForm((prev) => ({ ...prev, ...next }));

  const derived = deriveLeaderBaseUrl(form);
  const hasProfiles = leaderProfiles !== undefined && onReconnect !== undefined;

  const reconnect = async () => {
    if (leaderProfiles === undefined || onReconnect === undefined) {
      return;
    }
    setReconnecting(true);
    setReconnectError("");
    setReconnectOk("");
    // Build the override set from the form; the secret is NOT here - reconnect
    // reuses the stored secret for the SAME profile (planReconnect's contract).
    const overrides: ReconnectOverrides = {
      deploymentType: form.deploymentType,
      ...(clientId.trim() !== "" ? { clientId: clientId.trim() } : {}),
      ...(form.deploymentType === "cloud"
        ? form.organizationId.trim() !== ""
          ? { organizationId: form.organizationId.trim() }
          : {}
        : derived.ok
          ? { baseUrl: derived.baseUrl }
          : {}),
    };
    const plan = planReconnect(leaderProfiles, overrides);
    try {
      if (!plan.ok) {
        // Clean failure: nothing applied, no stuck state.
        setReconnectError(plan.error);
        return;
      }
      await onReconnect({
        deploymentType: plan.deploymentType,
        clientId: plan.clientId,
        baseUrl: plan.baseUrl,
        ...(plan.organizationId !== undefined
          ? { organizationId: plan.organizationId }
          : {}),
      });
      setReconnectOk(`Reconnected ${plan.deploymentType} leader at ${plan.baseUrl}.`);
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div className="wizard-step">
      <h2 className="wizard-step-title">Connect your Cribl leader</h2>
      <p className="panel-desc">
        Point the toolkit at your leader. Choose the deployment type and confirm
        the base URL - the toolkit appends <code className="code-chip">/api/v1</code>{" "}
        to every leader call itself, so enter the bare leader base URL.
      </p>

      <div className="form-grid">
        <label className="field">
          <span className="field-label">Deployment type</span>
          <select
            value={form.deploymentType}
            onChange={(e) =>
              patch({ deploymentType: e.target.value as LeaderDeploymentType })
            }
          >
            <option value="cloud">Cribl.Cloud workspace</option>
            <option value="self-managed">On-prem / self-managed</option>
          </select>
        </label>

        {form.deploymentType === "cloud" ? (
          <label className="field">
            <span className="field-label">Cribl.Cloud organization id</span>
            <input
              type="text"
              value={form.organizationId}
              spellCheck={false}
              placeholder="your-org"
              onChange={(e) => patch({ organizationId: e.target.value })}
            />
            <span className="field-hint">
              The base URL is derived as https://main-&lt;org&gt;.cribl.cloud.
            </span>
          </label>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Protocol</span>
              <select
                value={form.protocol}
                onChange={(e) =>
                  patch({ protocol: e.target.value as "https" | "http" })
                }
              >
                <option value="https">https</option>
                <option value="http">http</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Leader address (IP or FQDN)</span>
              <input
                type="text"
                value={form.address}
                spellCheck={false}
                placeholder="leader.example.com"
                onChange={(e) => patch({ address: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Port (optional)</span>
              <input
                type="text"
                value={form.port}
                spellCheck={false}
                placeholder="9000"
                onChange={(e) => patch({ port: e.target.value })}
              />
            </label>
          </>
        )}
      </div>

      <div className={`reachability reachability-${derived.ok ? "ok" : "error"}`}>
        <span className="reachability-dot" aria-hidden="true" />
        <div>
          <span className="reachability-label">
            {derived.ok ? "Base URL looks valid" : "Base URL needs attention"}
          </span>
          <p className="panel-desc">
            {derived.ok ? derived.baseUrl : derived.error}
          </p>
        </div>
      </div>

      {hasProfiles && (
        <section className="panel">
          <span className="field-label">Reconnect a saved profile</span>
          <p className="panel-desc">
            Reconnect using the stored secret for the selected deployment type.
            Overrides and the stored secret are validated together - a divergent
            edit fails cleanly and changes nothing.
          </p>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Client id (leave blank to keep saved)</span>
              <input
                type="text"
                value={clientId}
                spellCheck={false}
                onChange={(e) => setClientId(e.target.value)}
              />
            </label>
          </div>
          <div className="panel-controls">
            <button
              type="button"
              className="next-action-button"
              disabled={reconnecting}
              onClick={() => void reconnect()}
            >
              {reconnecting ? "Reconnecting..." : "Reconnect"}
            </button>
          </div>
          {reconnectError !== "" && <pre className="result">{reconnectError}</pre>}
          {reconnectOk !== "" && (
            <div className="status-bar status-bar-ready">
              <span className="status-bar-dot" aria-hidden="true" />
              <span className="status-bar-text">{reconnectOk}</span>
            </div>
          )}
        </section>
      )}

      {connectGuidance !== undefined && connectGuidance !== "" && (
        <p className="field-hint">{connectGuidance}</p>
      )}
    </div>
  );
}
