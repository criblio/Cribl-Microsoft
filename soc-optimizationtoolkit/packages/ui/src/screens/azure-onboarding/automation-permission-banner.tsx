/**
 * AutomationPermissionBanner - what the cached permission check says about an
 * automatable source's Azure needs, at the top of the section that automates
 * it (AZR-60). The model is core's automationPermissionView; this only draws
 * it.
 *
 *   denied        error tone, names the missing action(s), the role, how old
 *                 the check is and how to reach the How-to steps (switch the
 *                 row to How-to); the section's Deploy stays clickable with a
 *                 caution as its accessible description. NOT a live alert:
 *                 the verdict is cached and present at mount, so announcing it
 *                 would interrupt the screen reader on every visit.
 *   not-measured  a soft info note - never worded as a denial
 *                 (claude-kit standards/inventory-honesty.md)
 *   partial       a warning about a capability deploy does not need
 *
 * Every banner offers the How-to row for the source (the operator's fallback),
 * and, unless there is no identity to check, the existing Re-check permissions
 * action. The re-check is the SHELL's (the connection bar's useCapabilityAudit
 * refresh): when the shell wires none, the banner says where it is instead of
 * drawing a button that does nothing.
 *
 * Presentational: no IO, no Azure call. Rendering it costs nothing.
 */

import type { AutomationPermissionView } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import { refreshLabel } from "../../capabilities/capability-audit-state";
import { PickerLine } from "./eventhub-prerequisite-section";

/** The banner's (i): what it reads, and why unmeasured is not denied. */
export const PERMISSION_BANNER_TIP =
  "What the app's last permission check found for the Azure actions this section needs to set the source up. " +
  "It reads the stored result and makes no Azure call; Re-check permissions measures again. " +
  "Not measured means the check has no answer, which is not a denial: Azure's own answer at each step is what decides. " +
  "The How-to steps for a source appear once its row in the How-to section is switched to How-to.";

/** Shown when the shell wires no re-check into the screen. */
export const RECHECK_IN_BAR_HINT = "Use Re-check permissions in the connection bar to measure again.";

/** The How-to button's visible name. */
function howtoLinkLabel(sourceTitle: string): string {
  return `Go to the How-to steps for ${sourceTitle}`;
}

export interface AutomationPermissionBannerProps {
  readonly view: AutomationPermissionView;
  readonly sourceTitle: string;
  /** Scroll to and focus the source's How-to switch in the How-to section. */
  readonly onShowHowto: () => void;
  /** The shell's Re-check permissions; absent when the shell wires none. */
  readonly onRecheck?: () => void;
  readonly rechecking?: boolean;
}

export function AutomationPermissionBanner({
  view,
  sourceTitle,
  onShowHowto,
  onRecheck,
  rechecking = false,
}: AutomationPermissionBannerProps) {
  const banner = view.banner;
  if (banner === null) return null;
  return (
    <div className="azure-onboarding-subblock" data-testid="azo-permission-banner" data-kind={banner.kind}>
      <span className="field-label">
        Permissions to set this up <InfoTip text={PERMISSION_BANNER_TIP} />
      </span>
      <PickerLine message={{ tone: banner.tone, text: banner.text }} announce={false} />
      <div className="panel-controls">
        <button type="button" className="run-button" onClick={onShowHowto}>
          {howtoLinkLabel(sourceTitle)}
        </button>
        {banner.offerRecheck &&
          (onRecheck !== undefined ? (
            <button type="button" className="run-button" disabled={rechecking} onClick={onRecheck}>
              {refreshLabel(rechecking)}
            </button>
          ) : (
            <span className="field-hint">{RECHECK_IN_BAR_HINT}</span>
          ))}
      </div>
    </div>
  );
}
