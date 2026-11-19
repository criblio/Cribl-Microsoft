/**
 * Re-render the caller once a minute while it shows a read's age (AZR-147
 * review round 2).
 *
 * The age of a saved or cached gap read ("just now", "3 minutes ago") is the
 * operator's freshness cue: ADR 0009 decision 4 says a saved answer shows its
 * age. It is computed at render, and the page stays mounted (AppFrame keeps
 * visited screens alive) while nothing else re-renders it, so without a tick a
 * read taken at 10:00 still said "just now" at 13:00. Same reasoning as
 * AuditAgeChip (capabilities/audit-age-chip.tsx): the LEAF that shows the age
 * ticks itself, so the onboarding screen beside it is not re-rendered once a
 * minute; and it ticks only while there is an age on show.
 */

import { useEffect, useState } from "react";

/** The age's own resolution: it never says anything finer than minutes. */
export const READ_AGE_TICK_MS = 60_000;

export function useAgeTick(active: boolean, tickMs: number = READ_AGE_TICK_MS): void {
  // The value is never read: bumping it is what makes the caller re-read the clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [active, tickMs]);
}
