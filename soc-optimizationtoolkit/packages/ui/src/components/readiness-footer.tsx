/**
 * ReadinessFooter - the persistent deploy-readiness footer for the
 * single-page Integrate arc (legacy-flow-analysis.md: the legacy flagship's
 * always-visible readiness pills plus the single Deploy All action). Sticky
 * at the page bottom so readiness is auditable without scrolling back to the
 * Deploy section.
 *
 * The pills come from @soc/core deriveReadinessPills - one per prerequisite
 * in the legacy order (Solution, Samples, Mappings, Workspace, Worker Groups,
 * Pack Name). ZERO decision logic here: pill state and canDeploy are computed
 * by the core and passed in. Pill palette (theme tokens, dark-mode ready):
 *   - ok          -> green (the prerequisite is satisfied);
 *   - missing     -> amber (a built prerequisite is unsatisfied);
 *   - coming-soon -> muted (the prerequisite's section has not shipped - it
 *     is honestly pending, NEVER a false green, and does NOT block Deploy
 *     during the MVP transition; see @soc/core canDeploy).
 *
 * The Deploy button is enabled per canDeploy; when disabled it surfaces the
 * single unlock condition (deployDisabledReason) as its title and an inline
 * hint, never per-screen prose.
 */

import type { ReadinessPill } from "@soc/core";

export interface ReadinessFooterProps {
  /** The readiness pills from @soc/core deriveReadinessPills. */
  pills: readonly ReadinessPill[];
  /** Whether the operable deploy can run (from @soc/core canDeploy). */
  canDeploy: boolean;
  /** Trigger the deploy (the same handler the Deploy section's Run uses). */
  onDeploy: () => void;
  /** True while a deploy run is in flight - disables and relabels the button. */
  deploying?: boolean;
  /**
   * The single unlock condition shown when Deploy is disabled (from the pure
   * deployDisabledReason). Null when Deploy is enabled.
   */
  disabledReason?: string | null;
  /** Button label; defaults to "Deploy". */
  deployLabel?: string;
}

export function ReadinessFooter({
  pills,
  canDeploy,
  onDeploy,
  deploying = false,
  disabledReason = null,
  deployLabel = "Deploy",
}: ReadinessFooterProps) {
  const disabled = !canDeploy || deploying;
  return (
    <div
      className={`readiness-footer${
        canDeploy ? " readiness-footer-ready" : ""
      }`}
    >
      <div className="readiness-footer-pills">
        {pills.map((pill) => (
          <span
            key={pill.id}
            className={`readiness-pill readiness-pill-${pill.state}`}
            title={pill.hint}
          >
            {pill.label}
          </span>
        ))}
      </div>
      <div className="readiness-footer-action">
        {disabled && disabledReason !== null && (
          <span className="readiness-footer-hint">{disabledReason}</span>
        )}
        <button
          className="next-action-button next-action-button-positive"
          onClick={onDeploy}
          disabled={disabled}
          title={
            !canDeploy && disabledReason !== null ? disabledReason : undefined
          }
        >
          {deploying ? "Deploying..." : deployLabel}
        </button>
      </div>
    </div>
  );
}
