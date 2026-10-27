/**
 * The `__inputId` VALUE an input's events carry, and whether a parsed route
 * filter matches it (DBT-162). ONE answer for every reader: the onboarding
 * diagram's route walk (usecases/read-source-flow/read-onboarding-cribl-side.ts
 * routeConsumption) and the Live Architecture attribution
 * (domain/live-architecture buildLiveDiagram) both ask here. Before this file
 * the two disagreed - one matched only `<type>:<id>`, the other only the bare
 * id - so the same route read "routed" on one screen and "not routed" on the
 * other.
 *
 * THE VALUE IS `<type>:<id>`, optionally followed by further `:` segments
 * (syslog adds the sender). capture-filter.ts inputPredicate records that as
 * verified against the product on 2026-08-21, including that the bare form
 * `__inputId === "<id>"` matched NOTHING.
 *
 * A BARE-ID MATCH IS STILL REPORTED, BUT AS `legacy`. This app's own wiring
 * (guided-deploy/source-wiring.ts, air-gap-export.ts) writes
 * `__inputId=='<id>'`; a reader that ignored it would hide routes the app
 * itself created. Whether that filter routes any event is UNCONFIRMED until
 * __inputId is read live on a wired source, so a reader must surface the
 * `legacy` answer to the operator rather than present it as a plain match.
 * The typed answer always wins: a filter that names both forms is `match`.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** An input as `__inputId` names it: its Cribl type and its configured id. */
export interface InputIdRef {
  /** The type segment: the input's type, or `collection` for a collector job. */
  type: string;
  id: string;
}

/**
 * A route filter's input selection, parsed from the cheap known forms
 * (live-architecture.ts parseRouteFilterInputs produces it).
 */
export type InputIdFilter =
  | { kind: "inputs"; ids: readonly string[] }
  | { kind: "prefix"; value: string }
  | { kind: "all" }
  | { kind: "unparsed" };

/**
 * How a filter selects an input:
 *   match  - by the `<type>:<id>` value the events carry (or a catch-all);
 *   legacy - ONLY by the bare id, a form verified to match nothing in a
 *            capture; drawn so the app's own routes stay visible, flagged so
 *            nobody reads it as confirmed;
 *   none   - not at all.
 */
export type InputIdMatch = "match" | "legacy" | "none";

/** The `__inputId` value an input's events carry: `<type>:<id>`. */
export function inputIdValue(ref: InputIdRef): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Does a parsed filter select the input? `unparsed` is excluded by type: what
 * an unreadable filter means (over-approximate, or cannot-evaluate) is the
 * caller's decision, not this helper's.
 *
 * A prefix is tested against the value WITH a trailing `:` too, so Cribl's own
 * multi-segment form `__inputId.startsWith('syslog:pfsense:')` selects the
 * `syslog:pfsense` input, whose events carry `syslog:pfsense:<sender>`.
 */
export function matchInputIdFilter(
  filter: Exclude<InputIdFilter, { kind: "unparsed" }>,
  ref: InputIdRef,
): InputIdMatch {
  if (filter.kind === "all") {
    return "match";
  }
  const value = inputIdValue(ref);
  if (filter.kind === "inputs") {
    if (filter.ids.includes(value)) {
      return "match";
    }
    return filter.ids.includes(ref.id) ? "legacy" : "none";
  }
  if (`${value}:`.startsWith(filter.value)) {
    return "match";
  }
  return ref.id.startsWith(filter.value) ? "legacy" : "none";
}
