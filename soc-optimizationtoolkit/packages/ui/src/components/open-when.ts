/**
 * openWhen - the `open` prop of a disclosure that opens ITSELF when something
 * inside needs the operator, and otherwise leaves open/closed to them
 * (DBT-224..232: warnings and gate reasons are never hidden behind a closed
 * disclosure).
 *
 * Returns `true` or `undefined`, never `false`. `open={false}` keeps the
 * attribute under React's control, so a disclosure the operator opened would
 * be shut again on the next render; `undefined` hands the toggle back to the
 * browser. Nine call sites wrote `cond || undefined` by hand before this
 * existed (architecture audit 2026-10-30) - one dropping the `|| undefined`
 * would diverge silently.
 */
export function openWhen(needsAttention: boolean): true | undefined {
  return needsAttention ? true : undefined;
}
