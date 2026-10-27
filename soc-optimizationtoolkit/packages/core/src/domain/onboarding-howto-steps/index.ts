/**
 * onboarding-howto-steps domain barrel (AZR-31): the guided steps a customer
 * follows instead of letting the app write Azure, and the renderer that fills
 * them with the plan values.
 */

export {
  ALL_HOWTO_STEPS,
  PLACEHOLDER,
  SUPERSEDED_STEPS,
  howToStep,
  stepsFor,
  stepsForSelection,
  templatePlaceholders,
  templateTexts,
} from "./steps";
export type { HowToStep, StepProvenance, StepValueRow } from "./steps";

export {
  API_VERSION_COPY_ALLOWANCE,
  API_VERSION_MASK,
  copyCheckTexts,
  fillTemplate,
  filledPlanValues,
  renderStep,
  renderedTexts,
  unsetPlaceholder,
} from "./render-instruction";
export type { RenderedStep } from "./render-instruction";

export { CONNECTION_STRING_STAND_IN, defenderExportBody } from "./defender-steps";
export { ENTRA_WARNING, entraCategoriesFor, entraProfileFrom } from "./entra-activity-steps";
export { LEGACY_POLICY_NAMES } from "./policy-steps";
