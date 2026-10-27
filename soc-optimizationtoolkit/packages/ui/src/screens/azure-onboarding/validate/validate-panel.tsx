/**
 * ValidatePanel - the "Check the Azure configuration" panel (AZR-32, ADR 0007
 * D16). Props-driven and presentational: the screen owns the run (it wraps the
 * Azure port with paceAzureManagement and calls core's READ-ONLY
 * validateAzureOnboarding), and this panel only says, before the run, how many
 * reads it will make and at what pace, and afterwards what each check found.
 *
 * HONESTY. Every word comes from validate-state.ts, which never lets a read
 * that could not be reached say "not found": an unknown verdict reads "could
 * not be read" (or "not checked" for a missing plan value), and a measured
 * zero arrival ("no messages in the window") is kept apart from an arrival
 * that could not be read. The tone is a data attribute beside the word, never
 * instead of it.
 *
 * Mounting it makes no call: the only thing that starts a run is the button.
 */

import { howToStep } from "@soc/core";
import type { ValidationPlan, ValidationResult } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import {
  arrivalView,
  runStatusText,
  validateDisabledReason,
  validateIntro,
  verdictGroups,
} from "./validate-state";
import type { ValidateRunState } from "./validate-state";

export interface ValidatePanelProps {
  /** The planned run (core planValidation), or null when no source is chosen. */
  readonly plan: ValidationPlan | null;
  /** The screen was given a pacing; without one Validate never runs. */
  readonly hasPacing: boolean;
  readonly run: ValidateRunState;
  readonly onValidate: () => void;
  readonly onCancel: () => void;
}

const PANEL_TIP =
  "Validate only reads. It sends GET requests to Azure Resource Manager and " +
  "Azure Monitor for the objects your plan names, and compares what it finds " +
  "with the plan. It never changes anything, and it never reads a key.\n\n" +
  "\"Could not be read\" means Azure did not answer the read (no permission, " +
  "an error, or a list that was not read to the end) - the object may still exist.";

const ARRIVAL_TIP =
  "Messages Azure Monitor counted arriving at the hub (IncomingMessages) in " +
  "the window. \"No messages in the window\" is a real answer from Azure; " +
  "\"could not be read\" means there is no answer.";

function stepTitle(stepId: string): string {
  return howToStep(stepId)?.title ?? stepId;
}

export function ValidatePanel({ plan, hasPacing, run, onValidate, onCancel }: ValidatePanelProps) {
  const running = run.kind === "running";
  const disabled = validateDisabledReason({ hasPacing, running, plan });
  const result: ValidationResult | null = run.kind === "done" ? run.result : null;
  const groups = result === null ? [] : verdictGroups(result);
  const arrival = result === null ? [] : Object.entries(result.arrival);

  return (
    <div className="azo-validate">
      <p className="panel-desc">
        {plan === null ? "Choose a source to check its Azure side." : validateIntro(plan)}{" "}
        <InfoTip text={PANEL_TIP} />
      </p>
      <div className="panel-controls">
        <button
          type="button"
          className="run-button"
          disabled={disabled !== null}
          onClick={onValidate}
        >
          Validate (read only)
        </button>
        {running && (
          <button type="button" className="run-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {disabled !== null && !running && <p className="field-hint">{disabled}</p>}
      <p className="field-hint" role="status">
        {runStatusText(run)}
      </p>

      {groups.map((group) => (
        <section key={group.sourceId} aria-label={`Checks for ${group.title}`}>
          <h4>{group.title}</h4>
          <ul>
            {group.rows.map((row) => (
              <li key={row.key} className="azo-verdict" data-tone={row.view.tone}>
                <span>{`${stepTitle(row.stepId)}: `}</span>
                <strong>{row.view.word}</strong>
                {row.view.detail !== "" && <span>{` - ${row.view.detail}`}</span>}{" "}
                <InfoTip text={`What was checked: ${row.kind}, for the step "${stepTitle(row.stepId)}". Result: ${row.view.word}.`} />
                {row.view.diffs.length > 0 && (
                  <table className="azo-verdict-diffs">
                    <thead>
                      <tr>
                        <th scope="col">Setting</th>
                        <th scope="col">Plan</th>
                        <th scope="col">Azure</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.view.diffs.map((d) => (
                        <tr key={d.field}>
                          <td>{d.field}</td>
                          <td>{d.expected}</td>
                          <td>{d.actual}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {arrival.length > 0 && (
        <section aria-label="Hub arrival">
          <h4>
            Arrival at the hub <InfoTip text={ARRIVAL_TIP} />
          </h4>
          <ul>
            {arrival.map(([hub, reading]) => {
              const view = arrivalView(hub, reading);
              return (
                <li key={hub} className="azo-verdict" data-tone={view.tone}>
                  {view.text}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
