/**
 * StepDialog - the instructions for one How-to step (AZR-31), rendered from
 * howto-state stepDialogView: the step as core renderStep produced it against
 * the plan values, with unset values as `<key>` placeholders, never gaps.
 *
 * Content, in reading order: why, any missing-values note, the warning, the
 * Azure portal steps, the Azure CLI (with Copy), the computed values table,
 * the RBAC it needs, how to confirm it worked, a stale note when the tick was
 * taken against older values, and a "Mark as done" box.
 *
 * DIALOG BEHAVIOUR. A native <dialog> opened with showModal() where the
 * browser has it (the top layer, and the page behind is inert). On top of
 * that, because not every host implements those parts:
 *   - Escape closes it (keydown, and the dialog's own cancel event);
 *   - Tab and Shift+Tab are kept inside it (a focus trap);
 *   - focus moves into it on open and RETURNS to whatever had it before
 *     (normally the Instructions button) when it closes.
 *
 * COPY is guarded: navigator.clipboard may be missing or refuse (the app runs
 * in a sandboxed iframe), and either case says so as visible text instead of
 * failing silently.
 *
 * The dialog is mounted only while open; its parent unmounts it to close.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { StepDialogView } from "./howto-state";

export interface StepDialogProps {
  readonly view: StepDialogView;
  readonly onClose: () => void;
  readonly onToggleTick: (stepId: string, checked: boolean) => void;
}

/** What the Copy button reports. */
export const COPY_DONE = "Copied.";
export const COPY_UNAVAILABLE = "Copying is not available here. Select the command and copy it by hand.";
export const COPY_FAILED = "The command could not be copied. Select it and copy it by hand.";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export function StepDialog({ view, onClose, onToggleTick }: StepDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const { rendered } = view;

  // Open on mount, restore focus on unmount.
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog !== null) {
      if (!dialog.open) {
        try {
          if (typeof dialog.showModal === "function") dialog.showModal();
          else dialog.setAttribute("open", "");
        } catch {
          dialog.setAttribute("open", "");
        }
      }
      focusables(dialog)[0]?.focus();
    }
    return () => {
      try {
        if (dialog?.open) dialog.close();
      } catch {
        // already closed
      }
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || ref.current === null) return;
    const items = focusables(ref.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setCopyStatus(COPY_UNAVAILABLE);
      return;
    }
    try {
      clipboard.writeText(rendered.cli).then(
        () => setCopyStatus(COPY_DONE),
        () => setCopyStatus(COPY_FAILED),
      );
    } catch {
      setCopyStatus(COPY_FAILED);
    }
  };

  return (
    <dialog
      ref={ref}
      className="azo-step-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h3 id={titleId}>{rendered.title}</h3>
      {view.tag !== null && <span className="azo-step-tag">{view.tag}</span>}
      {view.sourceTitles.length > 0 && (
        <p className="field-hint">{`For: ${view.sourceTitles.join(", ")}`}</p>
      )}
      <p>{rendered.why}</p>
      {view.missingNote !== null && <p className="field-hint">{view.missingNote}</p>}
      {rendered.warning !== null && (
        <p className="azure-onboarding-banner azure-onboarding-banner-warning" role="note">
          {rendered.warning}
        </p>
      )}

      {rendered.portal.length > 0 && (
        <>
          <h4>In the Azure portal</h4>
          <ol>
            {rendered.portal.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </>
      )}

      {rendered.cli !== "" && (
        <>
          <h4>With the Azure CLI</h4>
          <pre className="azo-step-cli">
            <code>{rendered.cli}</code>
          </pre>
          <div className="panel-controls">
            <button type="button" className="run-button" onClick={copy}>
              Copy
            </button>
            {copyStatus !== null && (
              <span className="field-hint" role="status">
                {copyStatus}
              </span>
            )}
          </div>
        </>
      )}

      {rendered.values.length > 0 && (
        <>
          <h4>Values</h4>
          <table className="azo-step-values">
            <tbody>
              {rendered.values.map((v) => (
                <tr key={v.label}>
                  <th scope="row">{v.label}</th>
                  <td>
                    <code>{v.value}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {rendered.rbac.length > 0 && (
        <>
          <h4>Permissions it needs</h4>
          <ul>
            {rendered.rbac.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      )}

      <h4>How to confirm it worked</h4>
      <p>{rendered.confirmHow}</p>

      {view.staleNote !== null && <p className="azo-step-stale">{view.staleNote}</p>}

      <label className="integrate-check">
        <input
          type="checkbox"
          checked={view.checked}
          disabled={view.tickDisabled}
          onChange={(e) => onToggleTick(rendered.id, e.target.checked)}
        />
        <span className="integrate-check-text">{view.doneLabel}</span>
      </label>
      {view.tickDisabledReason !== null && <p className="field-hint">{view.tickDisabledReason}</p>}

      <div className="panel-controls">
        <button type="button" className="run-button" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
