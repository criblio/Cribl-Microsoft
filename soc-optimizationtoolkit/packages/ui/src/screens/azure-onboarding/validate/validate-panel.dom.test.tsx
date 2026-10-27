// @vitest-environment happy-dom
/**
 * Pins for the Validate panel (AZR-32, unit V2).
 *
 * The failures these exist to catch: a denied read rendered as "not found",
 * an unreadable arrival rendered as a zero (or a measured zero as unreadable),
 * a button that hides that it only reads, an intro that does not say how many
 * reads it will make, and a run started by mounting the panel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ValidationPlan, ValidationResult } from "@soc/core";
import { ValidatePanel } from "./validate-panel";
import { VALIDATE_IDLE } from "./validate-state";
import type { ValidateRunState } from "./validate-state";

afterEach(cleanup);

const PLAN = {
  firstPageReads: 7,
  listReads: 0,
  maxReads: 7,
  missing: [],
} as unknown as ValidationPlan;

const RESULT: ValidationResult = {
  verdicts: {},
  checks: [
    {
      key: "k1",
      sourceId: "defenderExport",
      stepId: "eh-namespace",
      kind: "eh-namespace",
      verdict: { kind: "unknown", reason: "denied", detail: "" },
    },
    {
      key: "k2",
      sourceId: "defenderExport",
      stepId: "defender-export",
      kind: "defender-export",
      verdict: { kind: "present-differs", diffs: [{ field: "sku", expected: "Standard", actual: "Basic" }] },
    },
  ],
  measuredHubs: [],
  arrival: {
    quiet: { kind: "measured", messages: 0, window: "PT1H" },
    denied: { kind: "unknown", reason: "denied", detail: "" },
  },
  cancelled: false,
};

function renderPanel(run: ValidateRunState, over: { hasPacing?: boolean; plan?: ValidationPlan | null } = {}) {
  const onValidate = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ValidatePanel
      plan={over.plan === undefined ? PLAN : over.plan}
      hasPacing={over.hasPacing ?? true}
      run={run}
      onValidate={onValidate}
      onCancel={onCancel}
    />,
  );
  return { ...utils, onValidate, onCancel };
}

describe("ValidatePanel", () => {
  it("says it only reads, states the read count, and runs only on click", () => {
    const { onValidate, container } = renderPanel(VALIDATE_IDLE);
    expect(onValidate).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Validate (read only)" });
    expect(container.textContent).toContain("Validate reads 7 Azure resources at most 40 a minute. Nothing is changed.");
    fireEvent.click(button);
    expect(onValidate).toHaveBeenCalledTimes(1);
  });

  it("is disabled without pacing, and says why", () => {
    renderPanel(VALIDATE_IDLE, { hasPacing: false });
    expect((screen.getByRole("button", { name: "Validate (read only)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/pacing unavailable/)).toBeTruthy();
  });

  it("offers Cancel while running", () => {
    const { onCancel } = renderPanel({ kind: "running", runId: 1, done: 2, total: 7 });
    expect((screen.getByRole("button", { name: "Validate (read only)" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a denied read as 'could not be read', never 'not found'", () => {
    const { container } = renderPanel({ kind: "done", result: RESULT, asOf: "10:00" });
    const rows = Array.from(container.querySelectorAll(".azo-verdict"));
    const denied = rows.find((r) => r.textContent?.includes("could not be read") && r.getAttribute("data-tone") === "unknown");
    expect(denied).toBeDefined();
    expect(container.textContent?.toLowerCase()).not.toContain("not found");
    expect(container.textContent?.toLowerCase()).not.toContain("absent");
    expect(container.textContent).toContain("as of 10:00");
  });

  it("tabulates the differences of a present-but-different object", () => {
    const { container } = renderPanel({ kind: "done", result: RESULT, asOf: "10:00" });
    const table = container.querySelector(".azo-verdict-diffs");
    expect(table).not.toBeNull();
    const cells = Array.from(table!.querySelectorAll("tbody td")).map((td) => td.textContent);
    expect(cells).toEqual(["sku", "Standard", "Basic"]);
  });

  it("keeps a measured zero arrival apart from an unreadable one", () => {
    renderPanel({ kind: "done", result: RESULT, asOf: "10:00" });
    const quiet = screen.getByText("quiet: no messages in the window");
    const denied = screen.getByText(/^denied: arrival could not be read/);
    expect(quiet.getAttribute("data-tone")).not.toBe(denied.getAttribute("data-tone"));
  });

  it("puts an (i) on every verdict row", () => {
    const { container } = renderPanel({ kind: "done", result: RESULT, asOf: "10:00" });
    const rows = Array.from(container.querySelectorAll("li.azo-verdict"));
    const checkRows = rows.filter((r) => r.querySelector("strong") !== null);
    expect(checkRows.length).toBe(2);
    for (const r of checkRows) expect(r.querySelector(".info-tip-icon")).not.toBeNull();
  });
});
