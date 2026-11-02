/**
 * HomeScreen - the state-aware landing surface (ux-flow-plan 4.3, Unit
 * 6.5), initialRouteId in BOTH shells and route section 'journey'. Never a
 * wall: it always renders something actionable.
 *
 *   - The journey rails for the active mode (first-run arc + integrate
 *     arc), straight from @soc/core deriveJourney via JourneyStepper -
 *     where-you-are and what-is-next at a glance. Position is DERIVED from
 *     persisted facts on every render; there is no stored wizard-progress
 *     blob to drift.
 *   - ONE primary next-action card driven by the core nextAction (the
 *     legacy single-next-action pattern applied at app level), with the
 *     honest fallback when nothing is actionable in this mode.
 *   - Readiness chips (identity / secret / scope) with the honest
 *     'unknown' hedge - the legacy point-of-commitment chip checklist
 *     promoted to the overview.
 *     Settings/Reconfigure pointer.
 *   - RecentRuns embedded read-only, so "what happened last time" frames
 *     "what to do next".
 *
 * Cross-links are PROPS, not shell-sniffing prose: the shell passes its
 * JourneyLinks (merged over SHARED_JOURNEY_LINKS) - the cloud shell binds
 * the connect stage to the setup sections it renders HERE, the local shell
 * passes config-file guidance text with no route. The SETUP SECTIONS are
 * likewise composition props ({@link HomeScreenProps.setupSections}): the
 * cloud shell passes the Azure connect + resource sections and the GitHub
 * token surface; the local shell passes its config-file guidance and the
 * GitHub token surface. Mount inside a PortsProvider: the embedded
 * RecentRuns - and every ports-driven setup section - reads through the
 * ports context.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { deriveJourney, readinessChips } from "@soc/core";
import type { JourneyFacts } from "@soc/core";
import { JourneyStepper } from "../../frame/journey-stepper";
import type { JourneyLinks } from "../../frame/stepper-state";
import { RecentRuns } from "../../onboarding/recent-runs";
import { NumberedSection } from "../../components/numbered-section";
import { sectionFoldProps } from "../../components/section-folding/section-fold-context";
import { SectionFoldScope } from "../../components/section-folding/section-fold-scope";
import { useSectionFolding } from "../../components/section-folding/use-section-folding";
import {
  NO_ACTION_FALLBACK,
  SETUP_PIN_PREFIX,
  SETUP_SECTION_IDS,
  currentSetupSection,
  deriveNextActionView,
  journeySummary,
  runsSummary,
  sectionForStage,
  setupAnchorFor,
  visibleSetupSections,
} from "./home-state";

export interface HomeScreenProps {
  /** The split readiness facts, composed by the shell from its signals. */
  facts: JourneyFacts;
  /**
   * The shell's stage route/hint bindings (mergeJourneyLinks over
   * SHARED_JOURNEY_LINKS). The connect entry is the per-shell cross-link.
   */
  links?: JourneyLinks;
  /** Navigate to a route id (AppFrameNav.navigate). */
  onNavigate: (routeId: string) => void;
  /** Route id of the Settings screen (the Reconfigure pointer). */
  settingsRouteId?: string;
  /** Bump to reload the embedded RecentRuns list. */
  runsRefreshToken?: number;
  /**
   * Shell-composed setup sections (Azure connect, resource selection, the
   * GitHub token surface, config-file guidance...) rendered between the
   * journey rails and the mode note. Composition stays with the shell so
   * this screen never names shell-specific surfaces.
   */
  setupSections?: ReactNode;
}

export function HomeScreen({
  facts,
  links = {},
  onNavigate,
  runsRefreshToken = 0,
  setupSections,
}: HomeScreenProps) {
  const journey = deriveJourney(facts);
  const action = deriveNextActionView(facts, links);
  const chips = readinessChips(facts);
  // Const-captured so the click closure keeps the null-check narrowing.
  const actionRouteId = action === null ? null : action.routeId;

  // DBT-248: the Setup page opens collapsed like Sentinel Integration. ONE
  // folding instance owns every section on the page - the panels below and the
  // shell-composed setupSections, which reach it through the scope. Next action
  // is not in the list: it is the page's focus and never folds.
  const folding = useSectionFolding({
    ids: SETUP_SECTION_IDS,
    currentId: currentSetupSection(action),
    pinPrefix: SETUP_PIN_PREFIX,
    anchorFor: setupAnchorFor,
  });
  const visible = visibleSetupSections(facts);
  const numberFor = (id: string): number | undefined => {
    const at = visible.indexOf(id);
    return at < 0 ? undefined : at + 1;
  };
  const [runCount, setRunCount] = useState<number | null>(null);
  const foldOf = (id: string, fallback: number) => {
    const { number, ...rest } = sectionFoldProps(folding, id, numberFor);
    return { ...rest, number: number ?? fallback };
  };
  const journeyFold = foldOf("journey", 1);
  const runsFold = foldOf("recent-runs", visible.length);
  // A journey link opens the section its stage lives in.
  const onStage = (stageId: string) => {
    const section = sectionForStage(stageId);
    if (section !== undefined) folding.goTo(section);
  };

  return (
    <SectionFoldScope folding={folding} numberFor={numberFor}>
      <section className="panel">
        <h2 className="panel-title">Next action</h2>
        {chips.length > 0 && (
          <div className="readiness-chips">
            {chips.map((chip) => (
              <span
                key={chip.id}
                className={`readiness-chip readiness-chip-${chip.state}`}
                title={chip.hint}
              >
                {chip.label}: {chip.state === "not-used" ? "not used" : chip.state}
              </span>
            ))}
          </div>
        )}
        {action !== null ? (
          <>
            <p className="panel-desc">{action.description}</p>
            {actionRouteId !== null ? (
              <div className="panel-controls">
                <button
                  className="next-action-button"
                  onClick={() => {
                    onNavigate(actionRouteId);
                    // Same-route actions (connect lives ON Setup) would
                    // otherwise appear to do nothing: scroll to the target
                    // section after navigation settles.
                    const section = sectionForStage(action.stageId);
                    const anchorId = action.anchorId;
                    if (section !== undefined) {
                      // Open the target (and fold the rest) rather than scroll
                      // to a folded section.
                      folding.goTo(section);
                    } else if (anchorId !== null) {
                      window.setTimeout(() => {
                        document
                          .getElementById(anchorId)
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }, 60);
                    }
                  }}
                >
                  {action.label}
                </button>
              </div>
            ) : (
              <p className="panel-desc">
                <strong>{action.label}.</strong>
              </p>
            )}
            {action.hint !== null && (
              <p className="field-hint">{action.hint}</p>
            )}
          </>
        ) : (
          <p className="panel-desc">{NO_ACTION_FALLBACK}</p>
        )}
      </section>

      <NumberedSection
        {...journeyFold}
        title="Journey"
        status="available"
        infoTip="Every stage is visible and navigable; commits stay gated inside their screens. Position is derived from saved state, so resuming is automatic."
        summary={journeySummary(facts)}
      >
        <div className="home-arc-title">First run</div>
        <JourneyStepper
          stages={journey.firstRun}
          links={links}
          onNavigate={onNavigate}
          onStage={onStage}
        />
        <div className="home-arc-title">Integrate</div>
        <JourneyStepper
          stages={journey.integrate}
          links={links}
          onNavigate={onNavigate}
          onStage={onStage}
        />
      </NumberedSection>

      {setupSections}

      <NumberedSection
        {...runsFold}
        title="Recent runs"
        status="available"
        infoTip="The app's own run log - every recorded run, newest first, kept in this app's storage."
        summary={runsSummary(runCount)}
      >
        <RecentRuns refreshToken={runsRefreshToken} onLoaded={setRunCount} />
      </NumberedSection>
    </SectionFoldScope>
  );
}
