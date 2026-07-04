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
 *   - The honest mode note (MODE_LABELS/MODE_OPTIONS, one source) plus the
 *     Settings/Reconfigure pointer.
 *   - RecentRuns embedded read-only, so "what happened last time" frames
 *     "what to do next".
 *
 * Cross-links are PROPS, not shell-sniffing prose: the shell passes its
 * JourneyLinks (merged over SHARED_JOURNEY_LINKS) - the cloud shell binds
 * the connect stage to its Diagnostics harness route (panel 3, until Unit
 * 9 promotes it), the local shell passes config-file guidance text with no
 * route. Mount inside a PortsProvider: the embedded RecentRuns reads the
 * JobStore through the ports context.
 */

import { deriveJourney, readinessChips } from "@soc/core";
import type { JourneyFacts } from "@soc/core";
import { JourneyStepper } from "../../frame/journey-stepper";
import type { JourneyLinks } from "../../frame/stepper-state";
import { RecentRuns } from "../../onboarding/recent-runs";
import {
  NO_ACTION_FALLBACK,
  deriveNextActionView,
  modeNoteFor,
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
}

export function HomeScreen({
  facts,
  links = {},
  onNavigate,
  settingsRouteId = "settings",
  runsRefreshToken = 0,
}: HomeScreenProps) {
  const journey = deriveJourney(facts);
  const action = deriveNextActionView(facts, links);
  const chips = readinessChips(facts);
  // Const-captured so the click closure keeps the null-check narrowing.
  const actionRouteId = action === null ? null : action.routeId;

  return (
    <>
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
                {chip.label}: {chip.state}
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
                  onClick={() => onNavigate(actionRouteId)}
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

      <section className="panel">
        <h2 className="panel-title">Journey</h2>
        <p className="panel-desc">
          Every stage is visible and navigable; commits stay gated inside
          their screens. Position is derived from saved state, so resuming is
          automatic.
        </p>
        <div className="home-arc-title">First run</div>
        <JourneyStepper
          stages={journey.firstRun}
          links={links}
          onNavigate={onNavigate}
        />
        <div className="home-arc-title">Integrate</div>
        <JourneyStepper
          stages={journey.integrate}
          links={links}
          onNavigate={onNavigate}
        />
      </section>

      <section className="panel">
        <h2 className="panel-title">Mode</h2>
        <p className="panel-desc">{modeNoteFor(facts.mode)}</p>
        <div className="panel-controls">
          <button
            className="run-button"
            onClick={() => onNavigate(settingsRouteId)}
          >
            Open Settings
          </button>
          <span className="field-hint">
            Change the mode from Settings (Reconfigure).
          </span>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-title">Recent runs</h2>
        <RecentRuns refreshToken={runsRefreshToken} />
      </section>
    </>
  );
}
