/**
 * InfoTip - a small "i" affordance that reveals an explanatory tip on hover,
 * keyboard focus, or click/tap. Mined from the legacy InfoTip with two
 * deliberate changes: focus/blur support (the legacy tip was mouse-only) and
 * class-based styling instead of inline styles.
 *
 * The KEPT contract: embedded newlines in `text` render as line breaks
 * (white-space: pre-wrap in .info-tip-pop), so multi-line domain
 * explanations lay out as authored.
 */

import { useState } from "react";

export interface InfoTipProps {
  /** Tip content. Embedded "\n" characters render as line breaks. */
  text: string;
}

export function InfoTip({ text }: InfoTipProps) {
  const [open, setOpen] = useState(false);

  return (
    <span className="info-tip">
      <span
        className="info-tip-icon"
        role="button"
        tabIndex={0}
        aria-label="More information"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        i
      </span>
      {open && (
        <span className="info-tip-pop" role="tooltip">
          {text}
        </span>
      )}
    </span>
  );
}
