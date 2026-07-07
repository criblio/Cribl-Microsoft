/**
 * TargetChooser - the Setup Wizard's first step: choose where the toolkit
 * itself runs (Cribl-hosted vs local host). The tradeoff table is @soc/core
 * DATA (targetTradeoffs) - what each target CAN and CANNOT do - rendered as
 * radio cards, never prose baked into the component.
 */

import { targetTradeoffs } from "@soc/core";
import type { WizardTarget } from "@soc/core";

export interface TargetChooserProps {
  /** The currently selected target. */
  value: WizardTarget;
  /** Select a target. */
  onChange: (target: WizardTarget) => void;
  /**
   * When true the target is fixed by the hosting shell (e.g. the Cribl.Cloud
   * app is always cribl-hosted): the cards render read-only for context.
   */
  locked?: boolean;
}

export function TargetChooser({ value, onChange, locked = false }: TargetChooserProps) {
  const tradeoffs = targetTradeoffs();
  return (
    <div className="wizard-step">
      <h2 className="wizard-step-title">Where should the toolkit run?</h2>
      <p className="panel-desc">
        This decides how the app reaches your Cribl leader and where generated
        artifacts land. You can reconfigure later from Settings.
      </p>
      <div className="wizard-cards" role="radiogroup" aria-label="Hosting target">
        {tradeoffs.map((tradeoff) => {
          const selected = tradeoff.target === value;
          return (
            <button
              key={tradeoff.target}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={locked && !selected}
              className={`wizard-card${selected ? " wizard-card-selected" : ""}`}
              onClick={() => onChange(tradeoff.target)}
            >
              <span className="wizard-card-head">
                <span className="wizard-card-label">{tradeoff.label}</span>
              </span>
              <span className="wizard-card-desc">{tradeoff.summary}</span>
              <span className="wizard-tradeoff">
                <span className="wizard-tradeoff-col">
                  <span className="wizard-tradeoff-heading">Can</span>
                  <ul className="wizard-tradeoff-list">
                    {tradeoff.can.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </span>
                <span className="wizard-tradeoff-col">
                  <span className="wizard-tradeoff-heading">Cannot</span>
                  <ul className="wizard-tradeoff-list wizard-tradeoff-list-cannot">
                    {tradeoff.cannot.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {locked && (
        <p className="field-hint">
          This shell runs Cribl-hosted; the local host option is shown for
          comparison only.
        </p>
      )}
    </div>
  );
}
