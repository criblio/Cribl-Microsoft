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
 *   - blocked             -> muted number plus an AMBER gating-reason line
 *     naming the single unlock condition (the commit inside the body is
 *     gated; the body still renders - read-ahead);
 *   - coming-soon         -> muted, dashed circle, an "Arrives in Unit N"
 *     note and a short description of what will land, and NO body (a
 *     not-yet-built section is never a working teaser).
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
   * The roadmap unit a coming-soon section ships in - rendered as the
   * "Arrives in Unit N" note. Present only on not-yet-built sections.
   */
  shippedInUnit?: number;
  /**
   * The section body (built sections only). A coming-soon section renders no
   * body regardless of what is passed here.
   */
  children?: ReactNode;
}

export function NumberedSection({
  number,
  title,
  status,
  infoTip,
  reason,
  shippedInUnit,
  children,
}: NumberedSectionProps) {
  const comingSoon = status === "coming-soon";
  const blocked = status === "blocked";
  // COLLAPSIBLE (user request 2026-07-12: shorten the page as sections are
  // completed). Manual toggle - never auto-collapses, so a section cannot
  // vanish mid-edit when a gate flips. Header click or the chevron toggles;
  // coming-soon sections have no body to collapse.
  const [collapsed, setCollapsed] = useState(false);
  const collapsible = !comingSoon;
  const bodyHidden = collapsible && collapsed;
  return (
    <section
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
            status === "complete" ? ", complete" : ""
          }`}
        >
          {status === "complete" ? (
            <span className="numbered-section-check" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">{number}</span>
          )}
        </span>
        <h2 className="numbered-section-title">{title}</h2>
        <span onClick={(e) => e.stopPropagation()}>
          <InfoTip text={infoTip} />
        </span>
        {collapsible && (
          <button
            className="numbered-section-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }}
          >
            {collapsed ? "Expand" : "Collapse"}
          </button>
        )}
      </div>

      {comingSoon ? (
        <div className="numbered-section-comingsoon">
          <span className="numbered-section-comingsoon-badge">
            {shippedInUnit !== undefined
              ? `Arrives in Unit ${shippedInUnit}`
              : "Arrives in a later unit"}
          </span>
          {reason !== undefined && reason !== "" && (
            <p className="numbered-section-comingsoon-note">{reason}</p>
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
          <div className="numbered-section-body">{children}</div>
        </div>
      )}
    </section>
  );
}
