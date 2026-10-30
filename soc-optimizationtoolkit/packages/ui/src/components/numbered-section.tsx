/**
 * NumberedSection - the reusable numbered-section vocabulary for the
 * single-page Integrate arc (legacy-flow-analysis.md, structural decision
 * ADOPTED 2026-07-04), and the shared building block later units reuse for
 * their own sections. It renders the legacy flagship's numbered-circle step
 * grammar over a @soc/core integrate-arc SectionStatus - ZERO decision logic
 * of its own; the caller passes the already-derived status, reason, and
 * metadata.
 *
 * Badge grammar (same palette as the JourneyStepper circles, from the CSS
 * tokens - dark-mode ready):
 *   - current / available -> blue-filled circle with the section number (the
 *     section is actionable or fillable now);
 *   - complete            -> green circle with a check (CSS-drawn, so no
 *     emoji or symbol glyph - repo rule);
 *   - informational       -> muted outlined circle keeping the section NUMBER,
 *     plus a small "Informational" tag next to the title. A read-only
 *     diagnostic has nothing to finish, so it must not wear the completion
 *     check: that made the page claim work the operator had not done (live
 *     review 2026-08-03). Muted, not dashed - the section IS available to
 *     use, unlike coming-soon;
 *   - not-needed          -> the informational badge, with the reason (what
 *     replaced the section, "Not needed - using <id>") as the header tag
 *     (GEN-21). Not the check: nothing was finished there;
 *   - blocked             -> muted number plus an AMBER gating-reason line
 *     naming the single unlock condition (the commit inside the body is
 *     gated; the body still renders - read-ahead);
 *   - coming-soon         -> muted, dashed circle, a "Not yet available" note
 *     and a short description of what will land, and NO body (a not-yet-built
 *     section is never a working teaser). The note deliberately does NOT name
 *     a roadmap unit: "Arrives in Unit 16" is internal vocabulary that means
 *     nothing to the operator reading it (user report 2026-08-04).
 *     The optional `notBuiltBody` (AZR-18) is the one exception, and it is
 *     NOT the body: it shows what the section WILL hold - rows with their
 *     controls disabled - so an operator can see every source the screen
 *     knows about without any of it being actionable. Omitted, coming-soon
 *     renders exactly as before.
 *
 * The InfoTip reuses the shared component, fed the section's point-of-
 * decision help text.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import type { SectionStatus } from "@soc/core";
import { InfoTip } from "./info-tip";

export interface NumberedSectionProps {
  /** 1..7 step-badge number, in page order. */
  number: number;
  /** Section title (verbatim vocabulary from the legacy flagship). */
  title: string;
  /** The derived status from @soc/core deriveSectionStatus. */
  status: SectionStatus;
  /** Point-of-decision help fed to the InfoTip. */
  infoTip: string;
  /**
   * The single unlock condition (status 'blocked') or the honest not-shipped
   * note (status 'coming-soon'). Ignored for the other statuses.
   */
  reason?: string;
  /**
   * The section body (built sections only). A coming-soon section renders no
   * body regardless of what is passed here.
   */
  children?: ReactNode;
  /**
   * DBT-127: the page may own the collapsed state, so a "Done - next" button
   * and the readiness-footer pills can fold and open sections. Omitted, the
   * section keeps its own state exactly as before.
   */
  collapsed?: boolean;
  /** Told whenever the header, Expand or Collapse changes the state. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** One line shown in the header while collapsed - what was chosen here. */
  summary?: string;
  /** Renders "Done - next" at the foot of the body; the page decides what it does. */
  onDone?: () => void;
  /** DOM id, so the page can scroll a section into view. */
  anchorId?: string;
  /**
   * AZR-18: what a coming-soon section shows under its note - the rows it
   * will hold, every control already disabled by the caller. Ignored for the
   * other statuses (a built section passes `children`). It is not collapsible
   * and is not the body: the caller owns keeping it inert.
   */
  notBuiltBody?: ReactNode;
}

export function NumberedSection({
  number,
  title,
  status,
  infoTip,
  reason,
  children,
  collapsed: collapsedProp,
  onCollapsedChange,
  summary,
  onDone,
  anchorId,
  notBuiltBody,
}: NumberedSectionProps) {
  const comingSoon = status === "coming-soon";
  const blocked = status === "blocked";
  // COLLAPSIBLE (user request 2026-07-12: shorten the page as sections are
  // completed). Manual toggle - never auto-collapses, so a section cannot
  // vanish mid-edit when a gate flips. Header click or the chevron toggles;
  // coming-soon sections have no body to collapse.
  const [ownCollapsed, setOwnCollapsed] = useState(false);
  const collapsed = collapsedProp ?? ownCollapsed;
  const setCollapsed = (next: boolean | ((c: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(collapsed) : next;
    if (collapsedProp === undefined) {
      setOwnCollapsed(value);
    }
    onCollapsedChange?.(value);
  };
  const collapsible = !comingSoon;
  const bodyHidden = collapsible && collapsed;
  return (
    <section
      {...(anchorId !== undefined ? { id: anchorId } : {})}
      className={`numbered-section numbered-section-${status}${bodyHidden ? " numbered-section-collapsed" : ""}`}
    >
      <div
        className="numbered-section-head"
        {...(collapsible
          ? {
              onClick: () => setCollapsed((c) => !c),
              style: { cursor: "pointer" },
            }
          : {})}
      >
        <span
          className={`numbered-section-badge numbered-section-badge-${status}`}
          aria-label={`Section ${number}${
            status === "complete"
              ? ", complete"
              : status === "informational"
                ? ", informational"
                : status === "not-needed"
                  ? ", not needed"
                  : ""
          }`}
        >
          {status === "complete" ? (
            <span className="numbered-section-check" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">{number}</span>
          )}
        </span>
        <h2 className="numbered-section-title">{title}</h2>
        {status === "informational" && (
          <span className="numbered-section-info-tag">Informational</span>
        )}
        {/* GEN-21: what replaced the section, in the header, so it reads
            "Not needed - using <id>" whether or not the body is open. */}
        {status === "not-needed" && (
          <span className="numbered-section-info-tag">
            {reason !== undefined && reason !== "" ? reason : "Not needed"}
          </span>
        )}
        <span onClick={(e) => e.stopPropagation()}>
          <InfoTip text={infoTip} />
        </span>
        {bodyHidden && summary !== undefined && summary !== "" && (
          <span className="numbered-section-summary">{summary}</span>
        )}
        {collapsible && collapsed && (
          <button
            className="numbered-section-collapse"
            aria-expanded={false}
            aria-label={`Expand ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed(false);
            }}
          >
            Expand
          </button>
        )}
      </div>

      {comingSoon ? (
        <div className="numbered-section-comingsoon">
          <span className="numbered-section-comingsoon-badge">
            Not yet available
          </span>
          {reason !== undefined && reason !== "" && (
            <p className="numbered-section-comingsoon-note">{reason}</p>
          )}
          {notBuiltBody !== undefined && notBuiltBody !== null && (
            <div className="numbered-section-notbuilt" data-testid="numbered-section-notbuilt">
              {notBuiltBody}
            </div>
          )}
        </div>
      ) : (
        // A collapsed body stays MOUNTED and is hidden with CSS (live report
        // 2026-07-13: rendering null here unmounted the section's subtree,
        // so collapsing the DCR Gap Analysis destroyed its analysis state
        // and re-expanding required a fresh Analyze run).
        <div hidden={bodyHidden}>
          {blocked && reason !== undefined && reason !== "" && (
            <p className="numbered-section-blocked-reason">{reason}</p>
          )}
          <div data-testid="numbered-section-body">{children}</div>
          <div className="numbered-section-foot">
            {onDone !== undefined && (
              <button
                className="next-action-button numbered-section-done"
                onClick={onDone}
              >
                Done - next
              </button>
            )}
            {collapsible && (
              // Collapse lives at the BOTTOM of the expanded body (user
              // direction 2026-07-13): a section is finished at its end, so
              // that is where the put-it-away control belongs. Expand stays
              // in the header - a collapsed section has no visible bottom.
              <button
                className="numbered-section-collapse numbered-section-collapse-bottom"
                aria-expanded={true}
                aria-label={`Collapse ${title}`}
                onClick={() => setCollapsed(true)}
              >
                Collapse
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
