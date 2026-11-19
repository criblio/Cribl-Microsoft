/**
 * FocusSummary - "Focus here" on Azure Native Source Onboarding (AZR-147, ADR
 * 0009 decision 6 amendment 2026-11-19): the ACTIVE tenant's measured gaps,
 * from its latest gap read (saved or made this session).
 *
 *   - Lists every source with a RED indicator, each red indicator with its own
 *     reason sentence and a jump link to the source on this page.
 *   - Counts unknown sources apart ("N not read or unknown"), never folding
 *     them into the gaps or into OK (domain/tenant-gap focusSummary).
 *   - Says when the read was taken, and how long ago.
 *   - With no read for the active tenant, says so and offers to open All
 *     tenants to read it - it never shows an empty list as "no gaps".
 *
 * The words beside each colour are the grid's own (AZURE_WORD, CRIBL_WORD),
 * so the two cannot drift. Presentational over props; no IO.
 */

import { focusSummary } from "@soc/core";
import type { FocusIndicator, OnboardingSourceId } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import { AZURE_WORD, CRIBL_WORD, readAgeText, type TenantGapEntry } from "../../tenant-gap/tenant-gap-state";
import { useAgeTick } from "../../tenant-gap/use-age-tick";

export interface FocusSummaryProps {
  /** The active connection's name, or null when there is none. */
  readonly tenantName: string | null;
  /** Its latest gap read, or null when none is saved or cached. */
  readonly entry: TenantGapEntry | null;
  /** The clock, for the age; read at each render, and the summary ticks itself (review round 2). */
  readonly now: () => number;
  /** Show the source on this page. */
  readonly onJump: (sourceId: OnboardingSourceId) => void;
  /** Open the All tenants section (to read this tenant). */
  readonly onOpenAllTenants: () => void;
}

const FOCUS_TIP =
  "The active tenant's latest gap read: each source where Azure is measured not configured as its plan says, or " +
  "where this app has no Cribl source for it that Cribl still has. Sources that could not be told (a read was " +
  "refused, not run, or not proven to be this tenant's) are counted apart, never as a gap and never as fine. " +
  "Read this tenant again in All tenants to bring it up to date.";

function noReadText(tenantName: string): string {
  return `No gap read is saved for ${tenantName} yet, so its gaps are not known.`;
}

/**
 * Said above a CANCELLED read (review round 1): the cache keeps a partial row
 * when no earlier answer exists, and only complete reads are saved, so the
 * operator must not take it for a finished read that survives a reload.
 */
export const FOCUS_CANCELLED_TEXT =
  "This read was cancelled before it finished: checks it had not finished are unknown, and it is not saved. " +
  "Read this tenant again in All tenants for a complete answer.";

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function sideLabel(i: FocusIndicator): string {
  const word = i.side === "azure" ? AZURE_WORD[i.indicator.state] : CRIBL_WORD[i.indicator.state];
  return `${i.side === "azure" ? "Azure" : "Cribl"}: ${word}`;
}

export function FocusSummary({ tenantName, entry, now, onJump, onOpenAllTenants }: FocusSummaryProps) {
  useAgeTick(tenantName !== null && entry !== null);
  return (
    <section className="panel azo-focus" aria-labelledby="azo-focus-title">
      <h3 className="panel-title" id="azo-focus-title">
        Focus here{tenantName === null ? "" : `: ${tenantName}`} <InfoTip text={FOCUS_TIP} label="Focus here: what it shows" />
      </h3>
      {tenantName === null ? (
        <p className="field-hint">No Azure connection is active. Choose one on Setup.</p>
      ) : entry === null ? (
        <div className="panel-controls">
          <p className="field-hint">{noReadText(tenantName)}</p>
          <button type="button" className="run-button" onClick={onOpenAllTenants}>
            Open All tenants to read it
          </button>
        </div>
      ) : (
        <FocusBody entry={entry} now={now()} onJump={onJump} />
      )}
    </section>
  );
}

function FocusBody({ entry, now, onJump }: { entry: TenantGapEntry; now: number; onJump: (id: OnboardingSourceId) => void }) {
  const summary = focusSummary(entry.row);
  const gapCount = summary.gaps.length;
  const unknownCount = summary.unknownSources.length;
  const okCount = summary.okSources.length;
  return (
    <>
      <p className="field-hint" data-testid="azo-focus-read-at">
        {`Read at ${stamp(entry.readAt)}, ${readAgeText(entry.readAt, now)}.`}{" "}
        <InfoTip text={entry.row.status.reason} label="How this tenant was read" />
      </p>
      {entry.row.cancelled && (
        <p className="field-hint" data-testid="azo-focus-cancelled">
          {FOCUS_CANCELLED_TEXT}
        </p>
      )}
      <p className="azo-focus-counts" data-testid="azo-focus-counts">
        {`${gapCount} ${gapCount === 1 ? "source" : "sources"} with a gap, ${unknownCount} not read or unknown, ` +
          `${okCount} configured and onboarded.`}
      </p>
      {gapCount === 0 ? (
        <p className="field-hint">No source has a measured gap in this read.</p>
      ) : (
        <ul className="azo-focus-list">
          {summary.gaps.map((gap) => (
            <li key={gap.sourceId} className="azo-focus-gap" data-source={gap.sourceId}>
              <button
                type="button"
                className="link-button"
                aria-label={`Go to ${gap.title} on this page`}
                onClick={() => onJump(gap.sourceId)}
              >
                {gap.title}
              </button>
              {gap.red.map((r) => (
                <span key={r.side} className="azo-focus-red" data-side={r.side}>
                  <span className="tgap-ind tgap-red">
                    <span className="tgap-dot" aria-hidden="true" />
                    <span className="tgap-word">{sideLabel(r)}</span>
                  </span>
                  <span className="azo-focus-reason">{r.indicator.reason}</span>
                </span>
              ))}
              {gap.unknownSide !== null && (
                <span className="tgap-ind tgap-unknown" data-side={gap.unknownSide.side}>
                  <span className="tgap-dot" aria-hidden="true" />
                  <span className="tgap-word">{sideLabel(gap.unknownSide)}</span>
                  <InfoTip text={gap.unknownSide.indicator.reason} label={`${gap.title}, ${sideLabel(gap.unknownSide)}, why`} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
