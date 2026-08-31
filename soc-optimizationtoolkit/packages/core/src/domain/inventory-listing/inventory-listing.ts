/**
 * A listing whose EMPTY case cannot be mistaken for a measured zero (DBT-61).
 *
 * THE HABIT THIS EXISTS TO END. Half of every defect found on 2026-08-31 was
 * one shape: an unknown reported as a fact. An RBAC-filtered empty ARM list
 * read as a real zero (HON-2, DBT-43, DBT-44), a denied readback reported as
 * "still provisioning" (DBT-41), a 403 rendered as "not enabled" and inviting
 * a write (DBT-52). `docs/inventory-standard.md` already forbade all of it and
 * was violated three more times anyway, because it is prose.
 *
 * WHY A TYPE AND NOT A LINT RULE, established by building the lint rule first
 * and measuring it: a checker was calibrated green on the current tree and then
 * run against the real pre-fix code, where it MISSED ALL THREE defects. The
 * zero-claim is COMPUTED, never literal - DBT-43 shipped
 * `Read ${inventory.length} deployed DCR(s)`, so the wrong sentence exists only
 * at runtime and the source is an innocent template. Text matching can only
 * find a wrong sentence somebody typed, and nobody typed one.
 *
 * SO THE COMPILER DOES IT. The union has no `.length` and no `[]` case that
 * carries a count, so `${listing.length}` does not compile at all, and the
 * `rows` variant is NON-EMPTY BY TYPE - a count taken from it can never be 0.
 * The empty case becomes a branch the author has to write on purpose, which is
 * the moment where the thinking actually happens.
 *
 * ORDINARY LISTS ARE NOT AFFECTED. This is for ARM/Cribl listings whose
 * emptiness is ambiguous under RBAC. A local array does not need it and should
 * not use it.
 */

/**
 * Either rows (at least one, so permission is self-evident) or empty (which
 * means nothing on its own and must be interpreted).
 */
export type Listing<T> =
  | { readonly kind: "rows"; readonly rows: readonly [T, ...T[]] }
  | { readonly kind: "empty" };

/**
 * Wrap a raw listing result. The ONLY way a `Listing` is minted, so a lister
 * cannot half-adopt this by constructing the union inline.
 */
export function toListing<T>(rows: readonly T[]): Listing<T> {
  return rows.length === 0
    ? { kind: "empty" }
    : { kind: "rows", rows: rows as readonly [T, ...T[]] };
}

/**
 * The rows, or an empty array.
 *
 * THE ESCAPE HATCH, AND IT IS DELIBERATE - but read this before reaching for
 * it. Legitimate use is a caller that renders the rows and says nothing about
 * emptiness: a dropdown, a set to union, a list to map over. Emptiness there
 * is either handled elsewhere or genuinely uninteresting.
 *
 * NEVER USE IT TO PRODUCE A COUNT OR A CLAIM. `listingRows(x).length` in a
 * message is exactly the defect this module exists to prevent, spelled the long
 * way. That spelling is the point: unlike the original bug it is a single
 * greppable name, so `npm run check-listings` can find it - the type makes the
 * mistake hard, and the checker makes the remaining way to write it loud.
 */
export function listingRows<T>(listing: Listing<T>): readonly T[] {
  return listing.kind === "rows" ? listing.rows : [];
}

/**
 * How many rows, when the caller has ALREADY established what empty means.
 *
 * Takes the count of the empty case as an argument rather than assuming zero,
 * so the assumption is written down at the call site instead of being implied
 * by the type. A caller that has consulted a capability and earned the right to
 * say "none" passes 0; one that has not should not be counting at all.
 */
export function listingCount<T>(listing: Listing<T>, whenEmpty: number): number {
  return listing.kind === "rows" ? listing.rows.length : whenEmpty;
}
