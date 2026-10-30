/**
 * AuditAgeChip - the capability audit's AGE, in the connection bar, with a
 * manual re-check beside it (HON-6).
 *
 * WHERE: the connection bar, beside the secret / target / platform-link chips
 * (D-1, backlog section 18a). What this reports is the age of a measurement,
 * and age is only meaningful next to the thing measured.
 *
 * WHY IT TAKES THE SET AND THE CLOCK RATHER THAN THE HOOK'S `view`. The hook
 * computes `view` at the SHELL's render, and nothing re-renders the shell as
 * time passes - so a chip fed `view` would sit on "checked just now" until some
 * unrelated state change happened to re-render the app. The age is the
 * operator's freshness signal (the domain reports it and leaves the judgement
 * to them), so a frozen one is a confidently wrong one. The chip therefore
 * derives its own view from the same domain function and re-renders ITSELF on a
 * tick; ticking the shell instead would re-render every screen once a minute
 * to move one chip.
 *
 * The tick runs only while the status is `current`: the other two labels do
 * not depend on the clock, so ticking them would be work with no visible
 * result. One minute matches the age's own resolution (describeAuditAge counts
 * whole minutes below an hour).
 *
 * The re-check is disabled while ANY audit is in flight, including the
 * launch audit: each one spends Azure and Cribl requests against the shared
 * proxy budget, and a second click would only queue the same answer.
 */

import { useEffect, useState } from "react";
import { describeAuditAge, describeCapabilityAudit } from "@soc/core";
import type { CapabilitySet } from "@soc/core";
import { InfoTip } from "../components/info-tip";
import {
  auditChipText,
  auditChipTip,
  auditStatusTone,
  refreshLabel,
} from "./capability-audit-state";

/** One minute: the finest unit describeAuditAge reports. */
export const AUDIT_AGE_TICK_MS = 60_000;

export interface AuditAgeChipProps {
  /** The hook's measured set (`useCapabilityAudit().capabilities`). */
  capabilities: CapabilitySet;
  /** The connection identity it must match (`useCapabilityAudit().key`). */
  auditKey: string;
  /** The shell's clock - the same one the hook stamps audits with. */
  now: () => string;
  /** True while an audit is in flight (`useCapabilityAudit().running`). */
  running: boolean;
  /** Re-audit now (`useCapabilityAudit().refresh`). */
  onRecheck: () => void;
  /** Re-render interval while the age is showing. Defaults to one minute. */
  tickMs?: number;
}

export function AuditAgeChip({
  capabilities,
  auditKey,
  now,
  running,
  onRecheck,
  tickMs = AUDIT_AGE_TICK_MS,
}: AuditAgeChipProps) {
  const nowIso = now();
  const view = describeCapabilityAudit(capabilities, auditKey, nowIso);
  const ticking = view.status === "current";

  // The value is never read: bumping it is what makes the chip re-read the clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const id = setInterval(() => setTick((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [ticking, tickMs]);

  return (
    <span className="audit-chip-group">
      <span className={`audit-chip audit-chip-${auditStatusTone(view.status)}`}>
        {auditChipText(view.status, describeAuditAge(capabilities, nowIso))}
      </span>
      <InfoTip text={auditChipTip(view.label)} />
      <button
        type="button"
        className="audit-chip-recheck"
        disabled={running}
        onClick={onRecheck}
      >
        {refreshLabel(running)}
      </button>
    </span>
  );
}
