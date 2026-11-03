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
import type { AppPermission, AzureConfig, AzureConnectivity } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { NumberedSection } from "../../components/numbered-section";
import { useSectionFold } from "../../components/section-folding/section-fold-context";

/** The id the Setup page and the wizard give the Partially Connected checklist. */
export const CONNECTIVITY_SECTION_ID = "azure-connectivity";

/**
 * An entry's (i) text: the role or Graph permission it grants first - what an
 * approver is actually asked for - then the existing justification and
 * withoutIt strings, reused verbatim.
 */
function tipText(entry: AppPermission): string {
  const kind = entry.kind === "graph-api" ? "Graph permission" : "Role";
  return `${kind}: ${entry.name}\n${entry.justification}\n${entry.withoutIt}`;
}

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

/** The fold props NumberedSection takes (everything but the number). */
function foldRest(fold: NonNullable<ReturnType<typeof useSectionFold>>) {
  const { number: _number, ...rest } = fold;
  return rest;
}

export function AzureConnectivitySection({
  config,
  onChange,
  storedIdentity,
  onClearIdentity,
}: AzureConnectivitySectionProps) {
  const [notice, setNotice] = useState("");
  const { readOnly, others } = checklistEntries();
  const connectivity = config.connectivity ?? "full";
  const fold = useSectionFold(CONNECTIVITY_SECTION_ID);

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
      // The operator just asked for this checklist: open it rather than leave
      // it folded behind the radio they pressed (DBT-248).
      // Choosing it is also a move to this section: it ends the load fold, so a
      // current section that follows the choice cannot refold it.
      fold?.onActivate();
      fold?.onCollapsedChange(false);
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

  const partialBody = (
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
              label={`About ${readOnly.feature}`}
              text={tipText(readOnly)}
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
                <InfoTip
                  label={`About ${entry.feature}`}
                  text={tipText(entry)}
                />
              </div>
            ))}
          </div>
          <p className="field-hint">{`Requesting: ${requestSummary(config)}`}</p>
    </div>
  );

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
      {notice !== "" && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}

      {connectivity === "partial" &&
        (fold !== undefined ? (
          // The radios above stay on screen; the checklist is the foldable
          // body, its one-line summary the request it adds up to (DBT-248).
          <NumberedSection
            {...foldRest(fold)}
            number={fold.number ?? 1}
            title="What this app may do in Azure"
            status="available"
            infoTip="The permissions this app will ask for. The same plan renders the change-request ticket, so the checklist and the ticket cannot disagree."
            summary={`Requesting: ${requestSummary(config)}`}
          >
            {partialBody}
          </NumberedSection>
        ) : (
          partialBody
        ))}

      {connectivity === "disconnected" &&
        (storedIdentity ? (
          <div className="connectivity-disconnected">
            <span>An app identity is still stored.</span>
            <button type="button" className="run-button" onClick={onClearIdentity}>
              Clear stored identity
            </button>
            <button
              type="button"
              className="run-button"
              onClick={() => choose("partial")}
            >
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
