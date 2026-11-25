/**
 * useStoreRefusal: the last KV store call that was REFUSED, kept for a screen
 * to say - and the one rule for which answers still describe what is on
 * screen (DBT-181).
 *
 * Since DBT-145 a refused KV call throws. Several screens fire their writes
 * without waiting and used to swallow that; each now says it. Two questions
 * every such screen has to answer the same way, so they are answered here:
 *
 *  - WHICH ANSWER COUNTS. A store answers late. In "latest" mode every tracked
 *    call writes the same slot (one selected solution, one saved plan), so only
 *    the newest call's answer counts. In "scope" mode calls are told apart by
 *    the scope they were asked under (a solution, a vendor + log type): every
 *    answer counts until reset() says the scope moved.
 *  - WHEN A NOTE GOES AWAY. A note describes the store as it is now, so a
 *    later success takes it down: in "latest" mode any success of the newest
 *    call (it rewrote the whole slot); in "scope" mode a success clears the
 *    refusals it is declared to cover - by default its own kind.
 */

import { useCallback, useRef, useState } from "react";

/** Which call the store refused, and why. */
export interface StoreRefusal<A extends string> {
  action: A;
  /** The thrown error, stringified. */
  reason: string;
}

export interface StoreRefusalState<A extends string> {
  /** The refusal to say, or null while none stands. */
  refusal: StoreRefusal<A> | null;
  /**
   * Follow one store call. Never rejects: resolves true when the call
   * succeeded and its answer still counts, false otherwise (refused, or
   * outranked by a newer call / a scope change). A refusal that counts is
   * kept; a success that counts clears per the mode (see the module doc).
   * `clears` names the refusals a success covers in "scope" mode; it defaults
   * to the call's own action.
   */
  track: (work: Promise<unknown>, action: A, clears?: readonly A[]) => Promise<boolean>;
  /** Record a refusal the caller already knows is current (a guarded read). */
  refuse: (action: A, err: unknown) => void;
  /** Replace the note outright - or drop it with null - for the current scope. */
  setRefusal: (refusal: StoreRefusal<A> | null) => void;
  /** The scope moved: drop the note and ignore every answer asked before. */
  reset: () => void;
  /** A check that the scope current NOW still is, for multi-step work. */
  pin: () => () => boolean;
}

export function useStoreRefusal<A extends string>(
  mode: "latest" | "scope",
): StoreRefusalState<A> {
  const [refusal, setRefusal] = useState<StoreRefusal<A> | null>(null);
  // The token an answer must still match. "latest" replaces it on every call;
  // "scope" only on reset().
  const tokenRef = useRef<object>({});

  const track = useCallback(
    (work: Promise<unknown>, action: A, clears?: readonly A[]): Promise<boolean> => {
      if (mode === "latest") tokenRef.current = {};
      const token = tokenRef.current;
      const covered = clears ?? [action];
      return work.then(
        () => {
          if (tokenRef.current !== token) return false;
          setRefusal((current) =>
            current === null || mode === "latest" || covered.includes(current.action)
              ? null
              : current,
          );
          return true;
        },
        (err: unknown) => {
          if (tokenRef.current !== token) return false;
          setRefusal({ action, reason: String(err) });
          return false;
        },
      );
    },
    [mode],
  );

  const refuse = useCallback((action: A, err: unknown) => {
    setRefusal({ action, reason: String(err) });
  }, []);

  const reset = useCallback(() => {
    tokenRef.current = {};
    setRefusal(null);
  }, []);

  const pin = useCallback(() => {
    const token = tokenRef.current;
    return () => tokenRef.current === token;
  }, []);

  return { refusal, track, refuse, setRefusal, reset, pin };
}
