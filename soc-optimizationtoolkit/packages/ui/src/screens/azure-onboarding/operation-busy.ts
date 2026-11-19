/**
 * Which change this page is in the middle of making (AZR-147 review round 1).
 *
 * A connection switch from All tenants remounts the onboarding screen (it is
 * keyed on the active connection), which drops a running flow's state and
 * result mid-way. The shell's credential slot cannot see that: it counts an
 * Azure write only while its request is in flight, so a deploy between two of
 * its requests (reading, polling) looks idle, and a Cribl create or commit and
 * deploy never passes through the Azure slot at all.
 *
 * So each WRITE flow on the screen reports itself here for as long as it runs
 * (useReportBusy), and the page refuses the switch with the flow's own words
 * while any is registered. Reads are not reported: a read cut off by a remount
 * changes nothing anywhere.
 *
 * Absent provider: useReportBusy does nothing (the screen still renders
 * standalone in tests and elsewhere).
 */

import { createContext, useContext, useEffect, useRef } from "react";

export interface OperationBusyRegistry {
  /** Register `label` under `token`, or remove it with null. */
  set(token: object, label: string | null): void;
  /** The first running operation's label, or null when none runs. */
  current(): string | null;
}

export function createOperationBusyRegistry(): OperationBusyRegistry {
  const running = new Map<object, string>();
  return {
    set(token, label) {
      if (label === null) running.delete(token);
      else running.set(token, label);
    },
    current() {
      for (const label of running.values()) return label;
      return null;
    },
  };
}

export const OperationBusyContext = createContext<OperationBusyRegistry | null>(null);

/**
 * Report `label` (a noun phrase, e.g. "an Activity Log deploy") as running
 * while `active` is true. Unmounting removes it.
 */
export function useReportBusy(label: string, active: boolean): void {
  const registry = useContext(OperationBusyContext);
  const token = useRef<object>({});
  useEffect(() => {
    if (registry === null) return;
    const t = token.current;
    registry.set(t, active ? label : null);
    return () => registry.set(t, null);
  }, [registry, label, active]);
}
