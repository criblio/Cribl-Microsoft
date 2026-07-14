/**
 * Options state - the PURE decisions behind the OptionsScreen (porting-plan
 * Unit 4), kept out of the component so they are unit-testable without a DOM:
 *
 *   - {@link stateFromOptions} / {@link defaultOptionsState}: project typed
 *     @soc/core options onto the raw values the two rendered forms hold.
 *   - {@link isOptionsStateDirty}: the dirty-indicator decision (current vs
 *     last-saved values, per descriptor key).
 *   - {@link validateOptionsState}: validate BOTH forms through the @soc/core
 *     validateOptions (the explicit-rejection contract that replaced the
 *     legacy silent `Number()||0` coercion), returning a per-field error map
 *     keyed 'operation.<key>' / 'cribl.<key>' so the two forms coexist.
 *   - {@link patchFromState}: the typed AppOptionsPatch a valid state saves,
 *     fed to @soc/core applyOptionsPatch for the merge-preserving write.
 *
 * Pure: no IO, no fetch, no React.
 */

import {
  CRIBL_OPTION_FIELDS,
  DEFAULT_APP_OPTIONS,
  OPERATION_OPTION_FIELDS,
  formValuesToOptions,
  optionsToFormValues,
  parseCriblOptions,
  parseOperationOptions,
  validateOptions,
} from "@soc/core";
import type { AppOptions, AppOptionsPatch, OptionFormValues } from "@soc/core";

/** The raw values of both rendered forms. */
export interface OptionsFormState {
  operation: OptionFormValues;
  cribl: OptionFormValues;
}

/** Project typed options onto the raw form values the controls edit. */
export function stateFromOptions(options: AppOptions): OptionsFormState {
  return {
    operation: optionsToFormValues(OPERATION_OPTION_FIELDS, options.operation),
    cribl: optionsToFormValues(CRIBL_OPTION_FIELDS, options.cribl),
  };
}

/** The all-defaults form state (the Reset to defaults target). */
export function defaultOptionsState(): OptionsFormState {
  return stateFromOptions(DEFAULT_APP_OPTIONS);
}

/**
 * Whether the current state differs from the last-saved state. Compared per
 * descriptor key so an extraneous key in either record can never make an
 * untouched form read as modified.
 */
export function isOptionsStateDirty(
  current: OptionsFormState,
  saved: OptionsFormState,
): boolean {
  for (const field of OPERATION_OPTION_FIELDS) {
    if (current.operation[field.key] !== saved.operation[field.key]) {
      return true;
    }
  }
  for (const field of CRIBL_OPTION_FIELDS) {
    if (current.cribl[field.key] !== saved.cribl[field.key]) {
      return true;
    }
  }
  return false;
}

/**
 * Validate both forms. Returns a map of 'formId.fieldKey' -> message; an
 * empty map means the state is saveable. The underlying contract is the
 * @soc/core one: non-numeric number input is REJECTED with a named error,
 * never silently coerced (the legacy `Number(val) || 0` behavior).
 */
export function validateOptionsState(
  state: OptionsFormState,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const error of validateOptions(OPERATION_OPTION_FIELDS, state.operation)) {
    errors[`operation.${error.key}`] = error.message;
  }
  for (const error of validateOptions(CRIBL_OPTION_FIELDS, state.cribl)) {
    errors[`cribl.${error.key}`] = error.message;
  }
  return errors;
}

/**
 * The typed patch a VALID state persists (precondition:
 * {@link validateOptionsState} returned no errors). Coerces the raw form
 * values back to their typed shapes and normalizes them through the tolerant
 * per-section parsers, so what is saved is exactly what will parse back.
 */
export function patchFromState(state: OptionsFormState): AppOptionsPatch {
  return {
    operation: parseOperationOptions(
      formValuesToOptions(OPERATION_OPTION_FIELDS, state.operation),
    ),
    cribl: parseCriblOptions(
      formValuesToOptions(CRIBL_OPTION_FIELDS, state.cribl),
    ),
  };
}
