/**
 * FallbackNotice - "download the thing you'd need someone else to run"
 * (capability-model-plan step 4, rule 2).
 *
 * Rendered beside a blocked action. It NAMES the artifact, says what to do with
 * it, and offers the control that produces it when the caller wires one.
 *
 * IT IS NOT AN ERROR BANNER, and the styling deliberately does not read as one.
 * A blocked action stays attemptable (rule 3): the audit informs and offers,
 * Azure's own 403 is the real gate, and a stale or wrong audit must not talk
 * someone out of an action that would have worked. So this sits alongside the
 * live control rather than replacing it.
 *
 * The caller supplies `onProduce` because the artifacts are produced in
 * different places - the change requests inline from data the app holds, the
 * ARM bodies and the pack by a run. Absent, the notice still names the artifact,
 * which is better than silence about a blocked action.
 */

import type { CapabilityFallback } from "@soc/core";
import {
  fallbackActionLabel,
  fallbackHint,
} from "./fallback-notice-state";

export interface FallbackNoticeProps {
  /** What to offer. From routeCapability / artifactsToOffer in @soc/core. */
  fallback: CapabilityFallback;
  /**
   * Why the action is blocked, from the nav annotation or the audit. Rendered
   * above the offer so the operator sees the cause and the remedy together.
   */
  reason?: string;
  /**
   * Produce the artifact. Absent = the notice names it with no control, which
   * is the honest state when this surface cannot produce it itself.
   */
  onProduce?: () => void | Promise<void>;
  /** Disable the control (e.g. a run already in flight), with a reason. */
  disabledReason?: string;
}

export function FallbackNotice({
  fallback,
  reason,
  onProduce,
  disabledReason,
}: FallbackNoticeProps) {
  const hint = fallbackHint(fallback.kind);
  return (
    <div className="fallback-notice">
      {reason !== undefined && reason !== "" && (
        <p className="fallback-notice-reason">{reason}</p>
      )}
      <div className="fallback-notice-offer">
        <span className="fallback-notice-label">{fallback.label}</span>
        <span className="fallback-notice-action">{fallback.action}</span>
      </div>
      {onProduce !== undefined && (
        <div className="fallback-notice-controls">
          <button
            className="run-button"
            onClick={() => void onProduce()}
            disabled={disabledReason !== undefined}
            title={disabledReason}
          >
            {fallbackActionLabel(fallback.kind)}
          </button>
          {hint !== null && <span className="field-hint">{hint}</span>}
        </div>
      )}
    </div>
  );
}
