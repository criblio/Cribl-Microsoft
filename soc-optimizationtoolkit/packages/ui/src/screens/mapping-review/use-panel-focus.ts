/**
 * usePanelFocus - the keyboard contract of the mapping review's inline panels
 * (the unmapped-column suggestions, DBT-202, and the Dest Field claim,
 * DBT-208): the panel takes focus when it opens, and closing it returns focus
 * to the control that opened it.
 */

import { useEffect, useRef } from "react";

/** Focus the panel on open; `close` runs onClose and returns focus. */
export function usePanelFocus(onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    // Record the opener ONCE. StrictMode runs this effect twice on mount, and
    // by the second run the first has already focused the panel - recording
    // again would make Dismiss "return" focus to the panel it removes.
    if (openerRef.current === null) openerRef.current = document.activeElement;
    panelRef.current?.focus();
  }, []);

  const close = () => {
    const opener = openerRef.current;
    onClose();
    if (opener instanceof HTMLElement && opener.isConnected) {
      opener.focus();
    }
  };
  return { panelRef, close };
}
