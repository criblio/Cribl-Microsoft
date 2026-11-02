/**
 * AzureConnectivitySection - "How will this app work with Azure?" (setup-pages
 * plan, the Azure step, Option A). A three-way choice - Fully, Partially or
 * Disconnected - and, under Partial, a checklist built from the SAME
 * permission plan the change-request ticket renders (checklistEntries), so the
 * checklist and the ticket cannot disagree.
 *
 * Pure view over the saved {@link AzureConfig}: every edit is reported through
 * onChange with a whole next config. Choosing Full or Disconnected leaves
 * allowedPermissions alone so Partial -> Full -> Partial round-trips.
 */

import { useState } from "react";
import {
  READ_ONLY_PERMISSION,
  checklistEntries,
  requestSummary,
} from "@soc/core";
import type { AzureConfig, AzureConnectivity } from "@soc/core";
import { InfoTip } from "../../components/info-tip";

export interface AzureConnectivitySectionProps {
  config: AzureConfig;
  onChange: (next: AzureConfig) => void;
  /** Whether an app-registration identity is already stored for this connection. */
  storedIdentity: boolean;
  onClearIdentity: () => void;
}

const CHOICES: ReadonlyArray<{ value: AzureConnectivity; label: string }> = [
  { value: "full", label: "Fully Connected" },
  { value: "partial", label: "Partially Connected" },
  { value: "disconnected", label: "Disconnected" },
];

export function AzureConnectivitySection({
  config,
  onChange,
  storedIdentity,
  onClearIdentity,
}: AzureConnectivitySectionProps) {
  const [notice, setNotice] = useState("");
  const { readOnly, others } = checklistEntries();
  const connectivity = config.connectivity ?? "full";

  const choose = (value: AzureConnectivity) => {
    if (value === "partial") {
      // Partial is always the existing-resources path; say so when it moves.
      const moved = config.setupPath !== "existing";
      setNotice(
        moved
          ? "Lab setups need Fully Connected; switched to existing resources."
          : "",
      );
      onChange({ ...config, connectivity: value, setupPath: "existing" });
      return;
    }
    setNotice("");
    onChange({ ...config, connectivity: value });
  };

  // Written in checklist order (Reader, then the others in plan order), no duplicates.
  const toggle = (name: string, on: boolean) => {
    const next = new Set(config.allowedPermissions);
    if (on) next.add(name);
    else next.delete(name);
    const order = [readOnly.name, ...others.map((o) => o.name)];
    const known = order.filter((n) => next.has(n));
    const extra = config.allowedPermissions.filter(
      (n) => next.has(n) && !order.includes(n),
    );
    onChange({ ...config, allowedPermissions: [...known, ...extra] });
  };

  const has = (name: string) => config.allowedPermissions.includes(name);

  return (
    <div className="connectivity-section">
      <div
        className="connectivity-choice"
        role="radiogroup"
        aria-label="How will this app work with Azure?"
      >
        {CHOICES.map((c) => (
          <label key={c.value}>
            <input
              type="radio"
              name="azure-connectivity"
              checked={connectivity === c.value}
              onChange={() => choose(c.value)}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
      {notice !== "" && <p className="field-hint">{notice}</p>}

      {connectivity === "partial" && (
        <div className="connectivity-partial">
          <div className="connectivity-featured">
            <label className="connectivity-check">
              <input
                type="checkbox"
                checked={has(READ_ONLY_PERMISSION)}
                onChange={(e) => toggle(READ_ONLY_PERMISSION, e.target.checked)}
              />
              <span>Read-only access</span>
            </label>
            <InfoTip
              text={`${readOnly.justification}\n${readOnly.withoutIt}`}
            />
            <span className="connectivity-badge">Recommended</span>
            <p className="field-hint">
              Fills the workspace, table and DCR pickers and the inventory
              views.
            </p>
          </div>
          <div className="connectivity-others">
            <span className="field-label">Also allow the app to</span>
            {others.map((entry) => (
              <div key={entry.name} className="connectivity-row">
                <label className="connectivity-check">
                  <input
                    type="checkbox"
                    checked={has(entry.name)}
                    onChange={(e) => toggle(entry.name, e.target.checked)}
                  />
                  <span>{entry.feature}</span>
                </label>
                <InfoTip text={`${entry.justification}\n${entry.withoutIt}`} />
              </div>
            ))}
          </div>
          <p className="field-hint">{`Requesting: ${requestSummary(config)}`}</p>
        </div>
      )}

      {connectivity === "disconnected" &&
        (storedIdentity ? (
          <div className="connectivity-disconnected">
            <span>An app identity is still stored.</span>
            <button type="button" onClick={onClearIdentity}>
              Clear stored identity
            </button>
            <button type="button" onClick={() => choose("partial")}>
              Use Partially Connected
            </button>
          </div>
        ) : (
          <p className="field-hint">
            This app will produce ARM templates and deployment guides to hand to
            someone who can run them.
          </p>
        ))}
    </div>
  );
}
