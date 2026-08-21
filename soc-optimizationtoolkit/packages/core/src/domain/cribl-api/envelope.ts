/**
 * How the Cribl API shapes a list response, in one place.
 *
 * Every list endpoint answers `{count, items: [...]}` - `CountedConfigGroup`,
 * `CountedDatasetEnriched`, `CountedCriblLakeDataset`, and so on - but not all
 * of them, and not always: some routes hand back a bare array, and `data` shows
 * up instead of `items` on a few. So every caller has ended up writing the same
 * three-line unwrap.
 *
 * THIS MODULE EXISTS BECAUSE THERE WERE ALREADY FIVE OF THEM (found by the
 * 2026-08-19 architecture audit): live-architecture's `envelopeItems`,
 * onboard-table twice, deploy-flowlog-pack, and the cloud adapter's `listGroups`
 * and `SecretsStore.list`. They agree today. Nothing makes them agree tomorrow,
 * and a list silently read as empty is the worst failure shape this codebase has
 * - it reads as "you have no datasets" rather than as an error.
 *
 * New code uses this. The existing five are deliberately NOT rewritten here -
 * that is a change to onboard-table's and the adapters' behaviour surface, which
 * wants its own change with its own pins, not a drive-by inside a feature.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** Read a property off an unknown value, or undefined when it is not an object. */
export function readProp(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * The items of a Cribl list response, or `null` when the body is not a list
 * shape at all.
 *
 * `null` and `[]` mean different things and callers must keep them apart: `[]`
 * is "the leader answered, and there are none"; `null` is "this is not a
 * response I understand", which is a bug or a version skew and must never be
 * reported to an operator as an empty inventory.
 */
export function criblEnvelopeItems(body: unknown): unknown[] | null {
  if (Array.isArray(body)) {
    return body;
  }
  const items = readProp(body, "items") ?? readProp(body, "data");
  return Array.isArray(items) ? items : null;
}

/** A non-empty string property, or undefined. Trims; "" is treated as absent. */
export function readString(value: unknown, key: string): string | undefined {
  const raw = readProp(value, key);
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A finite number property, or undefined. */
export function readNumber(value: unknown, key: string): number | undefined {
  const raw = readProp(value, key);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
