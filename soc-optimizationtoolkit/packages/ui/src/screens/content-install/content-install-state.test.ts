/**
 * Pins for the content-install section's pure state (2026-07-14): the
 * installed/installable split, the selection toggles, and the outcome
 * partition.
 */

import { describe, expect, it } from "vitest";
import type {
  AvailableWorkbook,
  ContentInstallOutcome,
  InstalledContentState,
  ParsedAnalyticRule,
} from "@soc/core";
import {
  partitionOutcomes,
  selectAll,
  splitRules,
  splitWorkbooks,
  toggleName,
} from "./content-install-state";

function rule(name: string): ParsedAnalyticRule {
  return {
    id: name,
    name,
    severity: "Medium",
    tactics: [],
    dataTypes: [],
    query: "T | take 1",
    entityFields: [],
    fileName: `${name}.yaml`,
  };
}

function state(over: Partial<InstalledContentState>): InstalledContentState {
  return {
    solutionInstalled: false,
    installedSolutionVersion: null,
    installedRuleNames: new Set(),
    installedWorkbookNames: new Set(),
    notes: [],
    notOnboarded: false,
    ...over,
  };
}

describe("splitRules / splitWorkbooks", () => {
  it("splits available content on case-insensitive installed names", () => {
    const rules = [rule("Bad IP"), rule("New Rule")];
    const split = splitRules(rules, state({ installedRuleNames: new Set(["bad ip"]) }));
    expect(split.installed.map((r) => r.name)).toEqual(["Bad IP"]);
    expect(split.installable.map((r) => r.name)).toEqual(["New Rule"]);
  });

  it("splits workbooks the same way", () => {
    const wbs: AvailableWorkbook[] = [
      { displayName: "Overview", serializedData: "{}" },
      { displayName: "Fresh", serializedData: "{}" },
    ];
    const split = splitWorkbooks(wbs, state({ installedWorkbookNames: new Set(["overview"]) }));
    expect(split.installed.map((w) => w.displayName)).toEqual(["Overview"]);
    expect(split.installable.map((w) => w.displayName)).toEqual(["Fresh"]);
  });
});

describe("selection helpers", () => {
  it("toggles a name in and out immutably", () => {
    const a = toggleName(new Set<string>(), "X");
    expect([...a]).toEqual(["X"]);
    const b = toggleName(a, "X");
    expect([...b]).toEqual([]);
    expect([...a]).toEqual(["X"]); // original untouched
  });

  it("selects all provided names", () => {
    expect([...selectAll(["A", "B"])].sort()).toEqual(["A", "B"]);
  });
});

describe("partitionOutcomes", () => {
  it("groups by success", () => {
    const outcomes: ContentInstallOutcome[] = [
      { name: "a", ok: true, detail: "installed" },
      { name: "b", ok: false, detail: "HTTP 400" },
    ];
    const { ok, failed } = partitionOutcomes(outcomes);
    expect(ok.map((o) => o.name)).toEqual(["a"]);
    expect(failed.map((o) => o.name)).toEqual(["b"]);
  });
});
