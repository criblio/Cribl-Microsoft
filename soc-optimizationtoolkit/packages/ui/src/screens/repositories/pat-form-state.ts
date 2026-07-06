/**
 * Repositories / PAT settings pure decision logic (porting-plan Unit 14 UI;
 * ENG-30, GUI, RepoSetup.tsx). Two pure pieces the DOM-free tests pin:
 *
 *   1. The PAT FORM STATE MACHINE - a reducer over {value, phase, status,
 *      error}. It preserves the legacy "save-then-unstick stale-error" sequence:
 *      a failed validation leaves an error visible, and the NEXT edit unsticks
 *      it (clears the stale error) so the user is never stuck staring at an
 *      error about a token they have already started replacing.
 *
 *   2. The REACHABILITY STATUS derivation - "Repositories ready" means REACHABLE
 *      + PAT-VALID + INDEXED, NOT "downloaded N files" (legacy-flow-analysis.md
 *      LAZY-FETCH NEW WORKFLOW). It reports connected / reachable-no-PAT /
 *      not-connected / error from the hasPat flag, the platform policy, and the
 *      lazily-loaded solution index count.
 *
 * The domain PAT policy (patPolicyFor, evaluatePatGate, patFormatIssue) is the
 * source of truth for required-ness and gating; this module only drives the
 * form and the status line over it.
 *
 * Pure: no IO, no fetch, no React, no Date, no crypto.
 */

import { patFormatIssue } from "@soc/core";
import type { ContentPlatform, PatManagerStatus } from "@soc/core";

/** Where the PAT form is in its validate-then-store lifecycle. */
export type PatFormPhase = "idle" | "validating" | "clearing";

/** The reactive PAT-form state (all reducer-owned; the component holds no other). */
export interface PatFormState {
  /** The current PAT input value (transient - never persisted, never logged). */
  value: string;
  /** The lifecycle phase. */
  phase: PatFormPhase;
  /** The last known stored status (hasPat + login), or null before the first read. */
  status: PatManagerStatus | null;
  /**
   * The visible error from the last failed validate/clear, or "" when none. It
   * STICKS until the next edit (the legacy unstick sequence) or a new attempt.
   */
  error: string;
}

/** The reducer actions. */
export type PatFormAction =
  | { type: "edit"; value: string }
  | { type: "hydrate"; status: PatManagerStatus }
  | { type: "submit-start" }
  | { type: "submit-result"; status: PatManagerStatus }
  | { type: "submit-error"; message: string }
  | { type: "clear-start" }
  | { type: "clear-result" }
  | { type: "clear-error"; message: string };

/** The initial form state (before the stored status is hydrated). */
export function initialPatFormState(): PatFormState {
  return { value: "", phase: "idle", status: null, error: "" };
}

/**
 * The PAT-form reducer. Notable transitions:
 *   - edit: updates the value AND UNSTICKS a stale error (the legacy behavior:
 *     the moment the user changes the token, the old error clears).
 *   - submit-start / clear-start: enter the busy phase and clear any prior error
 *     so the spinner never shows a stale message.
 *   - submit-result: idle; record the status; surface status.error when the
 *     validation failed (hasPat === false with an error), and clear the input on
 *     success so a validated token is not left lingering in the field.
 */
export function patFormReducer(
  state: PatFormState,
  action: PatFormAction,
): PatFormState {
  switch (action.type) {
    case "edit":
      // Unstick: editing the token clears the stale error from the last attempt.
      return { ...state, value: action.value, error: "" };
    case "hydrate":
      return { ...state, status: action.status };
    case "submit-start":
      return { ...state, phase: "validating", error: "" };
    case "submit-result": {
      const failed = !action.status.hasPat;
      return {
        ...state,
        phase: "idle",
        status: action.status,
        // On success, clear the input (the token is stored write-only, never
        // read back); on failure keep the value so the user can correct it.
        value: action.status.hasPat ? "" : state.value,
        error: failed ? (action.status.error ?? "GitHub rejected the token.") : "",
      };
    }
    case "submit-error":
      return { ...state, phase: "idle", error: action.message };
    case "clear-start":
      return { ...state, phase: "clearing", error: "" };
    case "clear-result":
      return {
        ...state,
        phase: "idle",
        value: "",
        status: { hasPat: false },
        error: "",
      };
    case "clear-error":
      return { ...state, phase: "idle", error: action.message };
    default:
      return state;
  }
}

/** The derived, render-ready view of the PAT form. */
export interface PatFormView {
  /** True while a validate/clear round-trip is in flight. */
  busy: boolean;
  /** Whether the Save/Validate action is enabled. */
  canSubmit: boolean;
  /** Whether the Clear action is enabled (only when a PAT is stored). */
  canClear: boolean;
  /** The label for the primary action (Save vs Replace, per stored state). */
  submitLabel: string;
  /** A format precheck hint for the current input (empty when it looks valid). */
  formatHint: string;
  /** The visible error text ("" when none). */
  error: string;
  /** True when a validated PAT is stored. */
  hasPat: boolean;
  /** The resolved GitHub login, or "" when unknown / no PAT. */
  login: string;
}

/**
 * Derive the render-ready form view. The submit action is enabled only when the
 * input passes the format precheck (patFormatIssue) and no round-trip is in
 * flight; the format hint shows the precheck message as the user types (but only
 * once they have typed something, so an empty field is not nagged).
 */
export function derivePatFormView(state: PatFormState): PatFormView {
  const busy = state.phase !== "idle";
  const trimmed = state.value.trim();
  const formatIssue = patFormatIssue(state.value);
  const hasPat = state.status?.hasPat === true;
  return {
    busy,
    canSubmit: !busy && formatIssue === null,
    canClear: !busy && hasPat,
    submitLabel: hasPat ? "Replace token" : "Validate and save token",
    // Only nag once the user has typed something.
    formatHint: trimmed === "" ? "" : (formatIssue ?? ""),
    error: state.error,
    hasPat,
    login: state.status?.login ?? "",
  };
}

/** The tone of the reachability status line (drives the status-dot colour). */
export type ReachabilityTone = "ok" | "warn" | "error" | "idle";

/** Inputs to {@link deriveReachabilityStatus}. */
export interface ReachabilityInput {
  /** Which shell (governs whether a PAT is required). */
  platform: ContentPlatform;
  /** Whether a validated PAT is stored. */
  hasPat: boolean;
  /**
   * The lazily-loaded solution index count, or null when it has not been loaded
   * yet (the wizard verifies REACHABILITY + PAT validity, not "downloaded").
   */
  solutionCount: number | null;
  /** A load error from the index probe, or "" when none. */
  error: string;
}

/** The derived reachability status line for the Repositories page. */
export interface ReachabilityStatus {
  tone: ReachabilityTone;
  /** Short status label (a state, never "downloaded N files"). */
  label: string;
  /** One sentence of detail. */
  detail: string;
}

/**
 * Derive the honest reachability status. "Ready" here means REACHABLE +
 * (PAT-valid where required) + INDEXED - the count comes from the lightweight
 * index call, NEVER a bulk mirror. On cloud a missing PAT is an error (a PAT is
 * required); on local it is a soft warning (anonymous access works, rate-limited).
 */
export function deriveReachabilityStatus(
  input: ReachabilityInput,
): ReachabilityStatus {
  if (input.error !== "") {
    return {
      tone: "error",
      label: "Not reachable",
      detail: `Could not reach GitHub: ${input.error}`,
    };
  }
  if (!input.hasPat) {
    if (input.platform === "cloud") {
      return {
        tone: "error",
        label: "Not connected",
        detail:
          "A GitHub token is required on the hosted app. Add one below to browse " +
          "solutions - the shared egress IP makes anonymous access unreliable.",
      };
    }
    return {
      tone: "warn",
      label: "Reachable, no token",
      detail:
        "Anonymous GitHub access works for light use but is rate-limited. Add a " +
        "token below to raise the limit and avoid throttling while browsing.",
    };
  }
  if (input.solutionCount === null) {
    return {
      tone: "ok",
      label: "Token valid",
      detail:
        "GitHub token validated. Open the Solution browser to load the solution " +
        "index on demand - content is fetched lazily per solution, never mirrored.",
    };
  }
  return {
    tone: "ok",
    label: "Connected",
    detail:
      `GitHub connected - ${input.solutionCount} solution` +
      `${input.solutionCount === 1 ? "" : "s"} available. Content is fetched ` +
      "lazily per selected solution and cached by commit; nothing is mirrored.",
  };
}
