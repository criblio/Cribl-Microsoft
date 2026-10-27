/**
 * useDocumentVisible - true while the document is visible.
 *
 * A screen poll passes null to useRegisterPoll while this is false, so a
 * hidden tab spends none of the shared request budget. Without a document
 * (non-DOM render) it reports visible, which is the conservative reading for
 * a caller that also gates on an explicit opt-in.
 */

import { useEffect, useState } from "react";

function readVisible(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState !== "hidden";
}

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(readVisible);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const onChange = () => setVisible(readVisible());
    document.addEventListener("visibilitychange", onChange);
    // Re-read once: visibility may have changed between render and effect.
    onChange();
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
