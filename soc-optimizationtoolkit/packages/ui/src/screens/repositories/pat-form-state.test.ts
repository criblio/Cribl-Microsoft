/**
 * Tests for the Repositories / PAT pure decisions (porting-plan Unit 14 UI):
 * the PAT form state machine (including the legacy save-then-unstick stale-error
 * sequence) and the honest reachability status derivation (reachable + PAT-valid
 * + indexed, NEVER "downloaded N files").
 */
import { describe, expect, it } from "vitest";
import type { PatManagerStatus } from "@soc/core";
import {
  derivePatFormView,
  deriveReachabilityStatus,
  initialPatFormState,
  patFormReducer,
} from "./pat-form-state";
import type { PatFormState } from "./pat-form-state";

function reduce(
  state: PatFormState,
  ...actions: Parameters<typeof patFormReducer>[1][]
): PatFormState {
  return actions.reduce((s, a) => patFormReducer(s, a), state);
}

describe("patFormReducer", () => {
  it("edit updates the value", () => {
    const s = patFormReducer(initialPatFormState(), { type: "edit", value: "ghp_abc" });
    expect(s.value).toBe("ghp_abc");
  });

  it("submit-start enters the validating phase and clears any prior error", () => {
    const s = reduce(
      initialPatFormState(),
      { type: "edit", value: "ghp_abcdefghij" },
      { type: "submit-error", message: "boom" },
      { type: "submit-start" },
    );
    expect(s.phase).toBe("validating");
    expect(s.error).toBe("");
  });

  it("submit-result success stores the status and clears the input (token is write-only)", () => {
    const status: PatManagerStatus = { hasPat: true, login: "octocat" };
    const s = reduce(
      initialPatFormState(),
      { type: "edit", value: "ghp_abcdefghij" },
      { type: "submit-start" },
      { type: "submit-result", status },
    );
    expect(s.phase).toBe("idle");
    expect(s.status).toEqual(status);
    expect(s.value).toBe("");
    expect(s.error).toBe("");
  });

  it("submit-result failure surfaces the error and KEEPS the value for correction", () => {
    const status: PatManagerStatus = { hasPat: false, error: "GitHub rejected the token (HTTP 401)." };
    const s = reduce(
      initialPatFormState(),
      { type: "edit", value: "ghp_bad_token" },
      { type: "submit-start" },
      { type: "submit-result", status },
    );
    expect(s.phase).toBe("idle");
    expect(s.error).toMatch(/rejected/);
    expect(s.value).toBe("ghp_bad_token");
  });

  it("save-then-unstick: a stale error clears on the NEXT edit (the legacy sequence)", () => {
    const status: PatManagerStatus = { hasPat: false, error: "GitHub rejected the token." };
    const afterFailure = reduce(
      initialPatFormState(),
      { type: "edit", value: "ghp_bad_token" },
      { type: "submit-start" },
      { type: "submit-result", status },
    );
    expect(afterFailure.error).not.toBe("");
    // The user edits the token again -> the stale error unsticks.
    const afterEdit = patFormReducer(afterFailure, { type: "edit", value: "ghp_bad_token2" });
    expect(afterEdit.error).toBe("");
  });

  it("clear-result resets to the no-PAT state", () => {
    const s = reduce(
      initialPatFormState(),
      { type: "hydrate", status: { hasPat: true, login: "octocat" } },
      { type: "clear-start" },
      { type: "clear-result" },
    );
    expect(s.status).toEqual({ hasPat: false });
    expect(s.phase).toBe("idle");
    expect(s.value).toBe("");
  });
});

describe("derivePatFormView", () => {
  it("disables submit for a too-short token and shows the format hint once typed", () => {
    const s = patFormReducer(initialPatFormState(), { type: "edit", value: "short" });
    const view = derivePatFormView(s);
    expect(view.canSubmit).toBe(false);
    expect(view.formatHint).not.toBe("");
  });

  it("does not nag an empty field", () => {
    const view = derivePatFormView(initialPatFormState());
    expect(view.formatHint).toBe("");
    expect(view.canSubmit).toBe(false);
  });

  it("enables submit for a plausible token", () => {
    const s = patFormReducer(initialPatFormState(), { type: "edit", value: "ghp_abcdefghij" });
    const view = derivePatFormView(s);
    expect(view.canSubmit).toBe(true);
    expect(view.formatHint).toBe("");
    expect(view.submitLabel).toMatch(/save/i);
  });

  it("reflects a stored PAT: Replace label, clear enabled, login shown", () => {
    const s = patFormReducer(initialPatFormState(), {
      type: "hydrate",
      status: { hasPat: true, login: "octocat" },
    });
    const view = derivePatFormView(s);
    expect(view.hasPat).toBe(true);
    expect(view.login).toBe("octocat");
    expect(view.canClear).toBe(true);
    expect(view.submitLabel).toMatch(/replace/i);
  });

  it("disables everything while a round-trip is in flight", () => {
    const s = reduce(
      initialPatFormState(),
      { type: "hydrate", status: { hasPat: true } },
      { type: "edit", value: "ghp_abcdefghij" },
      { type: "submit-start" },
    );
    const view = derivePatFormView(s);
    expect(view.busy).toBe(true);
    expect(view.canSubmit).toBe(false);
    expect(view.canClear).toBe(false);
  });
});

describe("deriveReachabilityStatus - reachable + PAT-valid + indexed, never 'downloaded'", () => {
  it("cloud with no PAT is an error (a PAT is required)", () => {
    const s = deriveReachabilityStatus({
      platform: "cloud",
      hasPat: false,
      solutionCount: null,
      error: "",
    });
    expect(s.tone).toBe("error");
    expect(s.label).toMatch(/not connected/i);
  });

  it("local with no PAT is a soft warning (anonymous works, rate-limited)", () => {
    const s = deriveReachabilityStatus({
      platform: "local",
      hasPat: false,
      solutionCount: null,
      error: "",
    });
    expect(s.tone).toBe("warn");
    expect(s.detail).toMatch(/rate-limited/i);
  });

  it("a load error is surfaced regardless of platform", () => {
    const s = deriveReachabilityStatus({
      platform: "local",
      hasPat: true,
      solutionCount: null,
      error: "network down",
    });
    expect(s.tone).toBe("error");
    expect(s.detail).toMatch(/network down/);
  });

  it("PAT valid but index not loaded: ok, and the copy is about reachability not downloads", () => {
    const s = deriveReachabilityStatus({
      platform: "cloud",
      hasPat: true,
      solutionCount: null,
      error: "",
    });
    expect(s.tone).toBe("ok");
    expect(s.label).toMatch(/valid/i);
    expect(s.detail.toLowerCase()).not.toContain("download");
    expect(s.detail.toLowerCase()).toContain("lazily");
  });

  it("connected with a count reports 'N solutions available', never 'downloaded'", () => {
    const s = deriveReachabilityStatus({
      platform: "cloud",
      hasPat: true,
      solutionCount: 549,
      error: "",
    });
    expect(s.tone).toBe("ok");
    expect(s.label).toMatch(/connected/i);
    expect(s.detail).toContain("549 solutions available");
    expect(s.detail.toLowerCase()).not.toContain("download");
  });
});
