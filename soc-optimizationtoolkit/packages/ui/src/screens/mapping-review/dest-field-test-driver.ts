/**
 * Test driver for a mapping row's Dest Field combobox (DBT-251). The cell was
 * a native <select> driven with fireEvent.change; it is now a SearchableSelect,
 * so a test picks a column the way an operator does - open, click the option.
 * One driver so the DOM tests do not each re-learn the combobox's markup.
 */

import { fireEvent } from "@testing-library/react";

/** The row's Dest Field control button. */
export function destFieldControl(row: Element): HTMLButtonElement {
  const control = row.querySelector<HTMLButtonElement>(
    ".mapping-dest-select .searchable-select-control",
  );
  if (control === null) throw new Error("Dest Field control not rendered in row");
  return control;
}

/** The column the row's Dest Field currently shows. */
export function destFieldValue(row: Element): string {
  return destFieldControl(row).textContent ?? "";
}

/** Open the row's Dest Field and click `column`; throws if it is not offered. */
export function chooseDestField(row: Element, column: string): void {
  const control = destFieldControl(row);
  control.focus();
  fireEvent.click(control);
  const options = [
    ...row.querySelectorAll<HTMLElement>(".mapping-dest-select .searchable-select-option"),
  ];
  const option = options.find(
    (o) => o.querySelector(".searchable-select-option-label")?.textContent === column,
  );
  if (option === undefined) {
    throw new Error(
      `Dest Field does not offer ${column} - saw: ${options
        .map((o) => o.querySelector(".searchable-select-option-label")?.textContent)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}
