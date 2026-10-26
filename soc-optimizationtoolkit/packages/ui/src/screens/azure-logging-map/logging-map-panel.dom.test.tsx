// @vitest-environment happy-dom
/**
 * Panel pins for the Azure Logging Map (AZR-19). The honesty rules the panel
 * renders - a verified zero says "none", a refused read says "could not be
 * read" and never "none" - run on the REAL map core builds from a path-routed
 * ARM stub (logging-map-test-fixture.ts), not on a hand-made value.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { normaliseScopeId, type ReadLoggingMapResult } from "@soc/core";

import { LoggingMapPanel } from "./logging-map-panel";
import { initialState, type LoggingMapUiState } from "./logging-map-state";
import { EXEMPTIONS_REFUSED, NO_EXEMPTIONS, ROLES_REFUSED } from "./logging-map-copy";
import {
  LEGACY_ASSIGNMENT_ID,
  MG_ALPHA,
  PLATFORM_ASSIGNMENT_ID,
  SUB_A,
  SUB_B,
  SUB_DIAG_ASSIGNMENT_ID,
  fixtureResult,
} from "./logging-map-test-fixture";

afterEach(cleanup);

function renderPanel(result: ReadLoggingMapResult, selected: string, patch: Partial<LoggingMapUiState> = {}) {
  const state: LoggingMapUiState = { ...initialState(result.map), selectedScope: normaliseScopeId(selected), ...patch };
  return render(
    <LoggingMapPanel map={result.map} state={state} now="2030-01-01T00:00:00Z" onTrace={() => {}} onSelect={() => {}} />,
  );
}

function card(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-lm-assignment="${normaliseScopeId(key)}"]`);
  if (el === null) throw new Error(`no assignment card for ${key}`);
  return el;
}

describe("LoggingMapPanel - exemptions", () => {
  it("a read exemptions list with zero rows says 'No exemptions at this scope'", async () => {
    const result = await fixtureResult();
    renderPanel(result, SUB_A);
    const section = document.querySelector<HTMLElement>("[data-lm-exemptions]");
    expect(section?.getAttribute("data-lm-exemptions")).toBe("none");
    expect(within(section as HTMLElement).getByText(NO_EXEMPTIONS)).toBeTruthy();
    expect(screen.queryByText(new RegExp(EXEMPTIONS_REFUSED))).toBeNull();
  });

  it("a refused exemptions read says 'could not be read' and NOT 'No exemptions'", async () => {
    const result = await fixtureResult({ exemptionsRefused: [SUB_A] });
    renderPanel(result, SUB_A);
    const section = document.querySelector<HTMLElement>("[data-lm-exemptions]");
    expect(section?.getAttribute("data-lm-exemptions")).toBe("empty");
    expect(section?.textContent).toContain("Exemptions could not be read.");
    expect(section?.textContent).toContain("Reader on this subscription");
    expect(document.body.textContent).not.toContain("No exemptions");
  });
});

describe("LoggingMapPanel - assignments", () => {
  it("a refused assignments read says 'Assignments could not be read' and never 'Nothing is assigned'", async () => {
    const result = await fixtureResult({ assignmentsRefused: [SUB_A] });
    renderPanel(result, SUB_A);
    expect(document.body.textContent).toContain("Assignments could not be read.");
    expect(document.body.textContent).toContain("Set here (unknown)");
    expect(document.body.textContent).not.toContain("Nothing is assigned");
  });

  it("ranks the legacy assignment's ownership evidence and lists the roles the earlier toolkit granted", async () => {
    const result = await fixtureResult();
    renderPanel(result, MG_ALPHA);
    const el = card(LEGACY_ASSIGNMENT_ID);
    const kinds = [...el.querySelectorAll("[data-lm-evidence]")].map((e) => e.getAttribute("data-lm-evidence"));
    // Exactly the recogniser's ranked order; createdBy (present on the fixture) is never evidence.
    const entry = result.map.assignmentsByKey.get(normaliseScopeId(LEGACY_ASSIGNMENT_ID));
    expect(kinds).toEqual(entry?.ownership?.evidence.map((e) => e.kind));
    expect(kinds[0]).toBe("legacy-strong");
    expect(kinds).toContain("legacy-identity");
    expect(el.querySelector("[data-lm-legacy-roles]")?.textContent).toBe(
      "The earlier toolkit granted this identity: Monitoring Contributor (management group), Azure Event Hubs Data Owner (Event Hub namespace).",
    );
    expect(el.textContent).toContain("cribl-diag-policy-identity");
  });
});

describe("LoggingMapPanel - roles", () => {
  it("a read with 2 grants renders exactly 2 role rows, with their names and scopes", async () => {
    const result = await fixtureResult();
    renderPanel(result, MG_ALPHA);
    const el = card(PLATFORM_ASSIGNMENT_ID);
    const rows = el.querySelectorAll(".lm-role-row");
    expect(rows.length).toBe(2);
    expect([...rows].map((r) => r.querySelector(".lm-role-name")?.textContent)).toEqual(["Monitoring Contributor", "Reader"]);
    expect(rows[1]?.querySelector(".lm-role-scope")?.textContent).toBe(SUB_B);
  });

  it("a refused role read renders 'Roles could not be read' and never 'No roles'", async () => {
    const result = await fixtureResult({ rolesRefused: true });
    renderPanel(result, MG_ALPHA);
    const el = card(PLATFORM_ASSIGNMENT_ID);
    expect(el.querySelector("[data-lm-roles]")?.getAttribute("data-lm-roles")).toBe("refused");
    expect(el.textContent).toContain(ROLES_REFUSED);
    expect(el.textContent).not.toMatch(/no roles|No role assignments/i);
    expect(el.querySelectorAll(".lm-role-row").length).toBe(0);
  });
});

describe("LoggingMapPanel - trace summary", () => {
  it("states covered, excluded, exempt and unknown subscriptions for the traced assignment", async () => {
    const result = await fixtureResult();
    renderPanel(result, MG_ALPHA, { tracedAssignment: normaliseScopeId(PLATFORM_ASSIGNMENT_ID) });
    const summary = document.querySelector("[data-lm-trace-summary]");
    // Sub A and Sub B covered, Sub C excluded by notScopes.
    expect(summary?.textContent).toContain("covers 2 subscriptions, 1 excluded, 0 exempt, 0 unknown.");
  });
});

describe("LoggingMapPanel - the gap state at the scope an assignment is set on", () => {
  it("resourceSelectors on a set-here assignment show the 'regions:' pill and the sentence", async () => {
    const result = await fixtureResult({ subAssignment: "selectors" });
    renderPanel(result, SUB_A);
    const el = card(SUB_DIAG_ASSIGNMENT_ID);
    expect(el.querySelector("[data-lm-coverage-pill]")?.textContent).toBe("regions: eastus");
    expect(el.querySelector("[data-lm-coverage]")?.textContent).toBe("Applies here only to resources in: eastus.");
  });

  it("a resource-group notScope on a set-here assignment shows '1 below excluded'", async () => {
    const result = await fixtureResult({ subAssignment: "rg-notscope" });
    renderPanel(result, SUB_A);
    const el = card(SUB_DIAG_ASSIGNMENT_ID);
    expect(el.querySelector("[data-lm-coverage-pill]")?.textContent).toBe("1 below excluded");
    expect(el.querySelector("[data-lm-coverage]")?.getAttribute("data-lm-coverage")).toBe("partial");
  });

  it("a plainly covered set-here assignment carries no gap pill or sentence", async () => {
    const result = await fixtureResult();
    renderPanel(result, MG_ALPHA);
    const el = card(PLATFORM_ASSIGNMENT_ID);
    expect(el.querySelector("[data-lm-coverage-pill]")).toBeNull();
    expect(el.querySelector("[data-lm-coverage]")).toBeNull();
  });
});
