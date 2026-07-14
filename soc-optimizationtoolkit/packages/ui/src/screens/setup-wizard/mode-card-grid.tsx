/**
 * ModeCardGrid - the Setup Wizard's final step: the operating-mode chooser as
 * availability-gated radio CARDS with a Recommended badge (legacy-flow-analysis.md
 * wizard bar). The cards come from @soc/core modeCards(capabilities) - the SAME
 * MODE_REQUIREMENTS matrix that drives recommendMode, so an unavailable card can
 * never disagree with the recommendation. Unavailable cards stay VISIBLE but
 * disabled with an explicit reason (always-visible-disabled), never hidden.
 *
 * This is the availability-gated sibling of the frame's plain ModeSelect (Unit
 * 1); ModeSelect stays the simple first-run chooser, this is the wizard's
 * connection-aware one. Neither is rebuilt in terms of the other.
 */

import { modeCards } from "@soc/core";
import type { AppMode, WizardCapabilities } from "@soc/core";

export interface ModeCardGridProps {
  /** The established connections; gates availability and picks the recommendation. */
  capabilities: WizardCapabilities;
  /** The chosen mode, null until one is picked. */
  value: AppMode | null;
  /** Pick a mode (only available cards fire this). */
  onChange: (mode: AppMode) => void;
}

/** The reason an unavailable card shows when disabled. */
function unavailableReason(mode: AppMode): string {
  switch (mode) {
    case "full":
      return "Needs both a live Cribl and a live Azure connection.";
    case "azure-only":
      return "Needs a live Azure connection.";
    case "cribl-only":
      return "Needs a live Cribl connection.";
    case "air-gapped":
      return "";
  }
}

export function ModeCardGrid({ capabilities, value, onChange }: ModeCardGridProps) {
  const cards = modeCards(capabilities);
  return (
    <div className="wizard-step">
      <h2 className="wizard-step-title">Choose an operating mode</h2>
      <p className="panel-desc">
        The mode is the one source of truth for what this app may touch. Modes
        whose connection is not yet established stay disabled with the reason -
        go back and connect, or pick an available mode. You can change it later
        from Settings (Reconfigure).
      </p>
      <div className="wizard-cards" role="radiogroup" aria-label="Operating mode">
        {cards.map((card) => {
          const selected = card.mode === value;
          const reason = card.available ? "" : unavailableReason(card.mode);
          return (
            <button
              key={card.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!card.available}
              title={reason !== "" ? reason : undefined}
              className={`wizard-card wizard-mode-card${
                selected ? " wizard-card-selected" : ""
              }${card.available ? "" : " wizard-card-unavailable"}`}
              onClick={() => card.available && onChange(card.mode)}
            >
              <span className="wizard-card-head">
                <span className="wizard-card-radio" aria-hidden="true" />
                <span className="wizard-card-label">{card.label}</span>
                {card.recommended && (
                  <span className="wizard-recommended-badge">Recommended</span>
                )}
              </span>
              <span className="wizard-card-desc">{card.description}</span>
              {!card.available && reason !== "" && (
                <span className="wizard-card-reason">{reason}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
