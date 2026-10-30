/**
 * onboarding-sections domain barrel (AZR-18): the Azure onboarding screen's
 * section layout and per-item availability, as data. The catalog says what CAN
 * be ticked (coverage-model), onboarding-selection says what ticking MEANS, and
 * this says where each row sits and whether its deploy path is built yet.
 */

export {
  ITEM_AVAILABILITY,
  ITEM_PREREQUISITES,
  ONBOARDING_SECTIONS,
  XDR_TABLES_ROW_ID,
  itemAvailability,
  sectionAvailability,
} from "./onboarding-sections";
export type {
  ItemAvailability,
  OnboardingPrerequisite,
  OnboardingRow,
  OnboardingSection,
  SectionAvailability,
} from "./onboarding-sections";
