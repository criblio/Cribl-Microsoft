/**
 * A bounded number input the operator can CLEAR without it meaning zero
 * (2026-08-20 bug-hunt).
 *
 * THE DEFECT THIS EXISTS TO END, which was written three times independently:
 * a `useState(DEFAULT)` holding a number, fed by
 * `onChange={(e) => setX(Number(e.target.value))}`. `Number("")` is 0, and every
 * consumer of these bounds clamps up to its floor of 1. So clearing the box to
 * retype did not mean "the default" - it meant ONE. One event per log type from
 * a Lake query, one event from a capture, or a capture lasting one second, which
 * on a quiet source returns nothing and is then reported to the operator as an
 * idle source. None of the three looks wrong on screen.
 *
 * COERCED AT READ TIME, NOT ON EVERY KEYSTROKE. Coercing in the change handler
 * is the obvious alternative and is the same bug better dressed: the field snaps
 * back to the default mid-edit, so the operator who cleared "10" to type "25"
 * gets "1025". Holding the text and interpreting it once is what lets the box be
 * empty while it is being typed into.
 *
 * The fallback is the DEFAULT rather than the previous value: an operator who
 * blanks a bound and runs has expressed no preference, and the default is the
 * only value the panel can defend.
 */

import { useState } from "react";

/** What {@link useNumericField} hands back. */
export interface NumericField {
  /** Exactly what is in the box, including empty and mid-edit states. */
  text: string;
  /** Bind to the input's onChange - takes the raw string, never a Number. */
  setText: (next: string) => void;
  /** What to SEND: the typed number, or the default when it is not usable. */
  value: number;
}

/**
 * Hold a numeric input as text and interpret it once, at read time.
 *
 * `value` falls back to `fallback` for an empty box, a non-numeric one, and
 * anything <= 0 - all three of which mean the operator has not named a bound.
 * Upper bounds stay where they already are, in the usecase that owns the API's
 * real ceiling; this is only about the floor that empty was falling through.
 */
export function useNumericField(fallback: number): NumericField {
  const [text, setText] = useState(String(fallback));
  const typed = Number(text);
  return {
    text,
    setText,
    value: Number.isFinite(typed) && typed > 0 ? typed : fallback,
  };
}
