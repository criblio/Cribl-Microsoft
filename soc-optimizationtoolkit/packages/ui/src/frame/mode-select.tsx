/**
 * ModeSelect - the first-run mode chooser, shown after the acceptance gate
 * when no mode has been chosen yet (parseAppMode returned null).
 *
 * The four options come from frame-state's MODE_OPTIONS, one per @soc/core
 * AppMode, each with an honest one-line description of what it enables. The
 * SHELL owns persistence: onSelect serializes and stores the choice, then
 * updates its state so the frame mounts.
 */

import { useState } from "react";
import type { AppMode } from "@soc/core";
import { MODE_OPTIONS } from "./frame-state";

export interface ModeSelectProps {
  /** Persist the chosen mode and advance into the frame. */
  onSelect: (mode: AppMode) => void | Promise<void>;
}

export function ModeSelect({ onSelect }: ModeSelectProps) {
  // Set while a selection is persisting: disables all options so a slow
  // write cannot be double-submitted or raced by a second choice.
  const [choosing, setChoosing] = useState<AppMode | null>(null);

  const choose = async (mode: AppMode) => {
    setChoosing(mode);
    try {
      await onSelect(mode);
    } finally {
      setChoosing(null);
    }
  };

  return (
    <div className="gate-screen">
      <div className="gate-card">
        <h1 className="gate-title">Choose an operating mode</h1>
        <p className="gate-sub">
          The mode is the one source of truth for what this app may touch: it
          decides which screens appear and whether changes deploy live or are
          generated as downloadable artifacts. You can change it later from
          Settings (Reconfigure).
        </p>
        <div className="mode-options">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.mode}
              className="mode-option"
              disabled={choosing !== null}
              onClick={() => void choose(option.mode)}
            >
              <span className="mode-option-label">
                {option.label}
                {choosing === option.mode ? " (saving...)" : ""}
              </span>
              <span className="mode-option-desc">{option.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
