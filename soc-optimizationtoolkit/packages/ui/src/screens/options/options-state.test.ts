import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_OPTIONS,
  DEFAULT_CRIBL_OPTIONS,
  DEFAULT_OPERATION_OPTIONS,
  applyOptionsPatch,
  parseAppOptions,
} from "@soc/core";
import {
  defaultOptionsState,
  isOptionsStateDirty,
  patchFromState,
  stateFromOptions,
  validateOptionsState,
} from "./options-state";

describe("stateFromOptions / defaultOptionsState", () => {
  it("projects typed options onto raw control values for both forms", () => {
    const state = stateFromOptions(DEFAULT_APP_OPTIONS);
    expect(state.operation["createDCE"]).toBe(false);
    expect(state.operation["deploymentTimeoutSeconds"]).toBe("600");
    expect(state.operation["customTableRetentionDays"]).toBe("30");
    expect(state.cribl["destinationPrefix"]).toBe("MS-Sentinel-");
    expect(state.cribl["destinationSuffix"]).toBe("-dest");
    expect(state.cribl["workerGroup"]).toBe("");
  });

  it("defaultOptionsState equals projecting the default options", () => {
    expect(defaultOptionsState()).toEqual(stateFromOptions(DEFAULT_APP_OPTIONS));
  });
});

describe("isOptionsStateDirty", () => {
  it("is clean against itself and dirty after any field edit", () => {
    const saved = defaultOptionsState();
    expect(isOptionsStateDirty(defaultOptionsState(), saved)).toBe(false);
    const operationEdit = {
      ...saved,
      operation: { ...saved.operation, createDCE: true },
    };
    expect(isOptionsStateDirty(operationEdit, saved)).toBe(true);
    const criblEdit = {
      ...saved,
      cribl: { ...saved.cribl, workerGroup: "prod" },
    };
    expect(isOptionsStateDirty(criblEdit, saved)).toBe(true);
  });

  it("Reset to defaults reads as dirty until saved (decision pinned)", () => {
    const saved = stateFromOptions({
      operation: { ...DEFAULT_OPERATION_OPTIONS, createDCE: true },
      cribl: { ...DEFAULT_CRIBL_OPTIONS },
    });
    expect(isOptionsStateDirty(defaultOptionsState(), saved)).toBe(true);
  });
});

describe("validateOptionsState", () => {
  it("returns an empty map for a valid state", () => {
    expect(validateOptionsState(defaultOptionsState())).toEqual({});
  });

  it("prefixes field errors with their form id", () => {
    const state = defaultOptionsState();
    state.operation["deploymentTimeoutSeconds"] = "60O"; // the legacy silent-0 typo
    const errors = validateOptionsState(state);
    expect(Object.keys(errors)).toEqual([
      "operation.deploymentTimeoutSeconds",
    ]);
    expect(errors["operation.deploymentTimeoutSeconds"]).toContain(
      "whole number",
    );
  });

  it("collects errors across both forms independently", () => {
    const state = defaultOptionsState();
    state.operation["keepTemplateVersions"] = "-1";
    // Force a non-string into a text field to prove cribl errors are keyed
    // separately (the renderer never produces this; validation still names it).
    state.cribl["workerGroup"] = true;
    const errors = validateOptionsState(state);
    expect(Object.keys(errors).sort()).toEqual([
      "cribl.workerGroup",
      "operation.keepTemplateVersions",
    ]);
  });
});

describe("patchFromState", () => {
  it("produces the typed patch a valid state persists", () => {
    const state = defaultOptionsState();
    state.operation["createDCE"] = true;
    state.operation["deploymentTimeoutSeconds"] = "120";
    state.operation["customTableRetentionDays"] = "90";
    state.cribl["destinationPrefix"] = "Sec-";
    const patch = patchFromState(state);
    expect(patch.operation).toEqual({
      ...DEFAULT_OPERATION_OPTIONS,
      createDCE: true,
      deploymentTimeoutSeconds: 120,
      customTableRetentionDays: 90,
    });
    expect(patch.cribl).toEqual({
      ...DEFAULT_CRIBL_OPTIONS,
      destinationPrefix: "Sec-",
    });
  });

  it("feeds applyOptionsPatch such that a save round-trips through the tolerant parser", () => {
    const state = defaultOptionsState();
    state.operation["deploymentTimeoutSeconds"] = "45";
    state.cribl["workerGroup"] = "edge";
    const stored = JSON.stringify({ _comments: "operator note" });
    const merged = applyOptionsPatch(stored, patchFromState(state));
    const serialized = JSON.stringify(merged);
    // Unmanaged keys survive the save; managed values read back typed.
    expect((JSON.parse(serialized) as Record<string, unknown>)["_comments"]).toBe(
      "operator note",
    );
    const reread = parseAppOptions(serialized);
    expect(reread.operation.deploymentTimeoutSeconds).toBe(45);
    expect(reread.cribl.workerGroup).toBe("edge");
  });
});
