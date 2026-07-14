/**
 * JourneyStepper - the numbered progress rail (ux-flow-plan 4.2, Unit 6.5):
 * the legacy numbered-circle grammar over @soc/core deriveJourney output.
 * ZERO logic of its own: statuses come from the core module, route/hint
 * binding from the pure stepper-state helpers; this component only renders.
 *
 * Read-ahead: every stage renders; stages with a route target navigate via
 * the shell-provided callback (including 'blocked' ones - commits stay
 * gated inside the screens); 'not-yet-available' stages are never
 * clickable. Hints (blockedReason or shell guidance) render as inline
 * microcopy AND as the title, never hidden.
 *
 * Vertical by default (Home's rail); orientation="horizontal" is the
 * compact strip step screens can mount later.
 */

import type { JourneyStage } from "@soc/core";
import { buildStepperItems } from "./stepper-state";
import type { JourneyLinks, StepperItem } from "./stepper-state";

export interface JourneyStepperProps {
  /** The stages of ONE arc, from @soc/core deriveJourney. */
  stages: readonly JourneyStage[];
  /** Shell route/hint bindings (see mergeJourneyLinks). */
  links?: JourneyLinks;
  /** Navigate to a route id (AppFrameNav.navigate). */
  onNavigate: (routeId: string) => void;
  /** Rail direction; vertical is Home's, horizontal the compact strip. */
  orientation?: "vertical" | "horizontal";
}

function StepBody({ item }: { item: StepperItem }) {
  return (
    <>
      <span className="journey-step-circle">{item.index}</span>
      <span className="journey-step-label">{item.label}</span>
    </>
  );
}

export function JourneyStepper({
  stages,
  links,
  onNavigate,
  orientation = "vertical",
}: JourneyStepperProps) {
  const items = buildStepperItems(stages, links);
  return (
    <ol
      className={`journey-stepper${
        orientation === "horizontal" ? " journey-stepper-horizontal" : ""
      }`}
    >
      {items.map((item) => {
        const routeId = item.routeId;
        return (
          <li
            key={item.id}
            className={`journey-step journey-step-${item.status}`}
            aria-current={item.status === "current" ? "step" : undefined}
          >
            {routeId !== null ? (
              <button
                className="journey-step-main"
                title={item.hint ?? undefined}
                onClick={() => onNavigate(routeId)}
              >
                <StepBody item={item} />
              </button>
            ) : (
              <div
                className="journey-step-main"
                title={item.hint ?? undefined}
              >
                <StepBody item={item} />
              </div>
            )}
            {item.hint !== null && (
              <span className="journey-step-hint">{item.hint}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
