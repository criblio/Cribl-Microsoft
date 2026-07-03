/**
 * Pure formatting for the onboarding step list: one monospace line per
 * JobStep. Kept out of the screen component so it is unit-testable without a
 * DOM.
 */

import type { JobStep } from "@soc/core";

/**
 * Width the status tag is padded to. The longest tag is "[succeeded]"
 * (11 characters); 12 leaves one space before the step name.
 */
export const STEP_STATUS_TAG_WIDTH = 12;

/**
 * Render one step as "[status]    name - detail" (detail omitted when
 * absent or empty), aligned for a monospace block.
 */
export function formatStepLine(step: JobStep): string {
  const tag = `[${step.status}]`.padEnd(STEP_STATUS_TAG_WIDTH);
  const detail =
    step.detail !== undefined && step.detail !== "" ? ` - ${step.detail}` : "";
  return `${tag}${step.name}${detail}`;
}
