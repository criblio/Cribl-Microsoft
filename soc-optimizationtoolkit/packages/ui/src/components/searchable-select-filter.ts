/**
 * Pure filtering + highlight math for the searchable-select components. Kept out
 * of the component so the matching rule and the keyboard-highlight clamping are
 * unit-testable without a DOM. No IO, no React.
 */

/** One selectable option. `hint` renders as dimmed secondary text (e.g. an id). */
export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Collapse text to letters and digits, so a search ignores separators.
 *
 * Names in this app are separator-heavy and typed from memory: vendors
 * ("Check Point" vs "checkpoint", "Palo Alto" vs "paloalto") and Azure
 * resources ("rg-jpederson-QuickstartLab" searched as "rg jpederson").
 * Shared with the solution browser so both searches obey one rule.
 */
export function collapseForSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Case-insensitive substring filter over an option's label AND value (so an id
 * paste matches even when the label is a display name). A blank query returns
 * every option, order preserved. Whitespace-only queries are treated as blank.
 *
 * Falls back to a separator-insensitive comparison so "checkpoint" matches
 * "Check Point" (user report 2026-08-04). A query that collapses to empty
 * (all punctuation) skips that pass rather than matching every option.
 */
export function filterOptions(
  options: readonly SelectOption[],
  query: string,
): SelectOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...options];
  const collapsedQuery = collapseForSearch(q);
  const matches = (field: string): boolean => {
    if (field.toLowerCase().includes(q)) return true;
    if (collapsedQuery === "") return false;
    return collapseForSearch(field).includes(collapsedQuery);
  };
  return options.filter(
    (o) =>
      matches(o.label) ||
      matches(o.value) ||
      (o.hint !== undefined && matches(o.hint)),
  );
}

/**
 * Clamp a keyboard-highlight index into `[0, length - 1]`, or -1 when the list
 * is empty. Used when the filtered list shrinks under the current highlight.
 */
export function clampHighlight(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

/** Move a highlight by `delta`, wrapping around the ends. Empty list -> -1. */
export function moveHighlight(
  index: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return -1;
  // From "no highlight" (-1), a downward move lands on the first item and an
  // upward move on the last - not one step past them.
  if (index < 0) return delta > 0 ? 0 : length - 1;
  return (((index + delta) % length) + length) % length;
}

/** The single-select control label: the selected option's label, or the placeholder. */
export function selectedLabel(
  options: readonly SelectOption[],
  value: string,
  placeholder: string,
): string {
  if (value === "") return placeholder;
  return options.find((o) => o.value === value)?.label ?? value;
}

/** The multi-select summary label: "N selected" / the single label / placeholder. */
export function multiSummary(
  options: readonly SelectOption[],
  values: readonly string[],
  placeholder: string,
): string {
  if (values.length === 0) return placeholder;
  if (values.length === 1) {
    return options.find((o) => o.value === values[0])?.label ?? values[0];
  }
  return `${values.length} selected`;
}
