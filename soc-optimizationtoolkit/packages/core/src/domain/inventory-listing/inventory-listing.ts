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
 * Rows, a VERIFIED zero, or an unverified nothing.
 *
 * The three-way split was forced by `listLabs` (DBT-62/DBT-64) and it is the
 * right model, not a concession. That usecase FILTERS: it reads the
 * subscription's resource groups and keeps the ones tagged as labs. So an
 * empty answer has two genuinely different causes - we read forty groups and
 * none was a lab (a real zero, and the operator should be told so plainly), or
 * the group read itself came back empty (nothing can be concluded). A two-way
 * type collapses those, and collapsing them trades a confident wrong answer
 * for a permanent hedge, which is its own wrong answer.
 *
 * The codebase had already discovered this shape and named it well: the DCR
 * column's `DcrPresence` is `has | none-in-scope | unchecked`. Same three
 * states, arrived at independently, which is the strongest argument that they
 * are real.
 *
 * `rows` stays NON-EMPTY BY TYPE - that is what makes a count taken from it
 * safe. `none` carries no rows because there are none to carry.
 */
export type Listing<T> =
  | { readonly kind: "rows"; readonly rows: readonly [T, ...T[]] }
  | { readonly kind: "none" }
  | { readonly kind: "empty" };

/**
 * Wrap a RAW listing result - the whole response, unfiltered.
 *
 * Empty means unverified here and never `none`, because for a raw ARM or Cribl
 * listing those two cases are byte-identical on the wire. Only a caller holding
 * a capability verdict can promote it, which is what `empty-inventory.ts` does.
 */
export function toListing<T>(rows: readonly T[]): Listing<T> {
  return rows.length === 0
    ? { kind: "empty" }
    : { kind: "rows", rows: rows as readonly [T, ...T[]] };
}

/**
 * Wrap rows DERIVED by filtering an already-read listing.
 *
 * This is the only way to mint a verified `none`, and it demands the source
 * listing to do it - so the provenance is structural rather than promised in a
 * comment. If the underlying read told us nothing (`empty`), no filter over it
 * can tell us anything either, and that propagates automatically. If the read
 * did produce rows, then zero matches is a measured zero and is SAFE to state
 * plainly.
 */
export function filterListing<S, T>(
  source: Listing<S>,
  rows: readonly T[],
): Listing<T> {
  if (source.kind === "empty") return { kind: "empty" };
  return rows.length === 0
    ? { kind: "none" }
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
 * True when the read behind this listing actually happened - rows, or a
 * measured zero. False only for the unverified `empty`.
 *
 * For callers that need the question "may I say none?" rather than the rows,
 * so they do not have to know that `none` and `rows` are the two verified
 * kinds. That is the fact most likely to be got wrong by writing
 * `kind !== "empty"` from memory.
 */
export function listingWasRead<T>(listing: Listing<T>): boolean {
  return listing.kind !== "empty";
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
  if (listing.kind === "rows") return listing.rows.length;
  // A verified `none` IS zero and ignores whenEmpty - the argument exists to
  // make the caller state an assumption, and here there is no assumption left
  // to state. Only the unverified `empty` still needs one.
  if (listing.kind === "none") return 0;
  return whenEmpty;
}
