/**
 * VENDOR FIELD DEFINITIONS - a remembered positional COLUMN ORDER for one
 * vendor + log type, so the operator who named `field_17` once is never asked
 * again (docs/vendor-field-definition-plan.md, Gap 3 / step 4).
 *
 * This is the same shape `field-matcher/learned-mappings.ts` already solved for
 * field mappings and it deliberately MIRRORS it: diff against a baseline,
 * persist through the plain-KV `ports.contentCache`, replay on load, decode
 * DEFENSIVELY so a corrupt value reads as absent rather than poisoning a parse.
 * The UI owns the load/save calls; this module owns every decision.
 *
 * THE THREE DECISIONS IT IMPLEMENTS (plan, "Decisions taken 2026-08-25"):
 *
 * 1. KEYED TO VENDOR + LOG TYPE, NOT TO THE SOLUTION. A PAN-OS TRAFFIC column
 *    order is true whichever Sentinel solution is selected, so it does NOT
 *    reuse `learnedMappingsCacheKey` even though that is the closest existing
 *    machinery: reusing it would re-ask for the same vendor under a different
 *    solution and record a vendor fact in a solution-shaped slot. Not scoped per
 *    connection - single tenant (see the plan's paragraph to revisit if that
 *    changes; the key gains a component, nothing else moves).
 *
 * 2. A KNOWN VENDOR PRE-FILLS AND THE OPERATOR CONFIRMS. {@link
 *    resolveColumnOrder} answers with the bundled order when nothing is stored,
 *    so the dialog opens already filled in and the operator is confirming rather
 *    than supplying. That is only safe because the live preview shows real
 *    values beside each name - a bundled order wrong for their firmware stops
 *    making sense on screen before anything is stored.
 *
 * 3. AN OPERATOR-SUPPLIED ORDER BEATS THE BUNDLED ONE, AND THEY ARE TOLD. Same
 *    precedence as learned mappings over bundled packs. The override is RECORDED
 *    ({@link BundledOverride}) and rendered ({@link describeColumnOrder}), so a
 *    mistaken paste replacing a correct shipped order is visible, not silent.
 *
 * THE TRAP THIS MODULE INHERITS FROM LEARNED MAPPINGS. `learnedActionOf` refuses
 * to learn an `overflow` because overflow is the MATCHER'S OWN default
 * disposition, not a reviewer decision - learning machine-applied dispositions
 * poisoned every later analysis. The equivalent here is decision 2's pre-fill:
 * should an operator who merely CONFIRMED a bundled order have that order stored
 * as if they had supplied it? No, and {@link buildVendorFieldDefinition} returns
 * null for exactly that case. Three reasons, in order of weight:
 *
 *   a. It is a machine-applied decision wearing an operator's clipboard. The app
 *      put those names in the box; clicking Apply is assent, not knowledge.
 *   b. Storing it FREEZES today's bundled order as an operator fact. A later
 *      corrected bundled order (vendor column orders change between firmware
 *      versions - the plan says so, and it is why operators outrank the shipped
 *      table at all) would then be silently overridden by a decision nobody
 *      made, and the override notice would say the operator overrode the vendor
 *      when they did not. The notice would LIE, which is precisely the failure
 *      decision 3 exists to prevent.
 *   c. It costs nothing. With nothing stored, resolveColumnOrder falls straight
 *      through to the bundled order and pre-fills identically. Next week's
 *      dialog looks the same either way; only the provenance stays honest.
 *
 * The counter-argument, recorded because it is not silly: an operator who
 * confirmed the old order might have wanted THAT one, and a bundled update takes
 * it away. They get the new one with the live preview beside it - the same
 * safety net that made decision 2 acceptable the first time - and if it is wrong
 * for their firmware they override it, which IS stored.
 *
 * KV KEY SHAPE. The leader's KV store only reliably round-trips a key that is a
 * SINGLE path segment of [A-Za-z0-9-]; a percent-escape returns a 404 that reads
 * like a missing entry, and this codebase has been bitten by that twice (a `~`
 * separator in content-cache, and "Palo Alto_Cortex XDR_AlertEvent" in the
 * tagged-sample keys). Vendor names and log types are exactly the kind of text a
 * human or a vendor chose, so {@link vendorFieldDefinitionKey} folds both to
 * [a-z0-9] and joins with "-": one segment, no escapes, still readable.
 *
 * THE CALLER SUPPLIES A CANONICAL VENDOR NAME. The fold absorbs SPELLING - case,
 * spaces, punctuation - so "Palo Alto Networks", "palo alto networks" and
 * "PALO-ALTO-NETWORKS" are one scope. It does NOT absorb ALIASES: "PAN-OS" and
 * "Palo Alto Networks" are different strings and key separately, even though
 * {@link bundledColumnOrder} recognises both. That asymmetry is deliberate -
 * containment is not an equivalence relation and cannot produce a key, and an
 * alias table here would be a second, drifting copy of the curated vendor list.
 * It is safe because the app derives the vendor from ONE place,
 * `detectVendorIdentity`, which always answers with the curated canonical name.
 * Pinned in both test files so a second source of vendor names cannot appear
 * without a failure first.
 *
 * COLLISIONS MUST NOT SILENTLY MERGE TWO VENDORS. Two gates, because the folding
 * that makes the key safe is also what could make two scopes share a slot:
 *   - An UNNAMEABLE scope has NO key. A vendor or log type that folds to "" -
 *     empty, whitespace, or all punctuation - returns null rather than a key
 *     with an empty segment. Without this every un-named vendor would share one
 *     slot and the first one's TRAFFIC order would be handed to the next.
 *   - A stored entry CARRIES its own vendor + log type, and {@link
 *     parseVendorFieldDefinition} refuses one whose scope does not match what
 *     was asked for. A collision therefore reads as ABSENT, never as somebody
 *     else's column order.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { panosHeadersFor } from "./panos-dictionary";

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/** Namespace prefix so definition keys never collide with other KV entries. */
export const VENDOR_FIELD_DEFINITION_NAMESPACE = "vendor-field-definitions";

/** Bumped when the stored SHAPE changes; old entries then simply miss. */
export const VENDOR_FIELD_DEFINITION_VERSION = "v1";

/**
 * Fold a vendor name or log type to its identity form: lowercase, every
 * non-alphanumeric removed. "Palo Alto Networks", "paloalto networks" and
 * "PALO-ALTO-NETWORKS" are the same vendor and MUST resolve to the same
 * definition; "TRAFFIC" and "Traffic" are the same log type.
 *
 * DELIBERATELY NOT `normalizeSolutionKey`, even though the two are currently
 * character-for-character identical. That one normalizes SOLUTION names for
 * fuzzy matching and is free to evolve for matching reasons (strip a "Solution"
 * suffix, fold a plural); this one is PERSISTED - a change to it silently
 * re-keys every stored definition, which reads to the operator as "the app
 * forgot the columns I named". Different subject, different lifetime, so the
 * sharing argument that applies inside learned-mappings does not apply here.
 * The literal output is pinned in vendor-field-definitions.test.ts.
 */
export function normalizeDefinitionScope(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The ContentCache key holding one vendor + log type's column order, or null
 * when the scope cannot be named.
 *
 * Shape: `vendor-field-definitions-v1-<vendor>-<logType>`, a SINGLE KV path
 * segment of [a-z0-9-]. Both folded parts are [a-z0-9] with no hyphen of their
 * own, so the two segments after the fixed prefix are unambiguous however the
 * originals were spelled.
 *
 * NULL IS NOT AN EMPTY KEY. An absent definition is absent, not empty: a vendor
 * or log type that folds to nothing gets no key at all rather than a shared
 * `...-v1--traffic` slot that would merge every un-named vendor into one.
 */
export function vendorFieldDefinitionKey(
  vendor: string,
  logType: string,
): string | null {
  const vendorPart = normalizeDefinitionScope(vendor);
  const logTypePart = normalizeDefinitionScope(logType);
  if (vendorPart === "" || logTypePart === "") {
    return null;
  }
  return [
    VENDOR_FIELD_DEFINITION_NAMESPACE,
    VENDOR_FIELD_DEFINITION_VERSION,
    vendorPart,
    logTypePart,
  ].join("-");
}

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

/**
 * The RECORD of an operator order replacing a bundled one - decision 3's "and
 * they are told" made concrete enough for the UI to say what changed rather
 * than that something changed.
 */
export interface BundledOverride {
  /** How many columns the bundled order carries. */
  bundledColumnCount: number;
  /** 0-based position where the two orders first differ. */
  firstDivergentIndex: number;
  /** The bundled name at that position ("" when the bundled order is shorter). */
  bundledName: string;
  /** The operator's name there ("" when the operator's order is shorter). */
  operatorName: string;
}

/** One remembered positional column order, as stored under its key. */
export interface VendorFieldDefinition {
  /** The vendor as the operator/solution spells it (the fold is only the key). */
  vendor: string;
  /** The log type as the sample is tagged. */
  logType: string;
  /** The column names, IN ORDER. Position is the whole meaning. */
  columns: string[];
  /**
   * Present when this order replaced a bundled one AT THE TIME IT WAS STORED.
   * Kept so a raw KV entry is self-describing, but never the notice's source of
   * truth - {@link resolveColumnOrder} re-derives it against the CURRENT bundled
   * order, so a bundled update cannot leave a stale record silently disagreeing.
   */
  overrides?: BundledOverride;
}

/** Where a resolved column order came from. Operator beats bundled. */
export type ColumnOrderSource = "operator" | "bundled";

/** The answer the dialog pre-fills from and the field mapper reuses. */
export interface ResolvedColumnOrder {
  /** The vendor this order is about. */
  vendor: string;
  /** The log type this order is about. */
  logType: string;
  /** The column names, in order. */
  columns: readonly string[];
  /** "operator" when a stored definition won; "bundled" when it is shipped. */
  source: ColumnOrderSource;
  /** Present only when an operator order is replacing a live bundled one. */
  override?: BundledOverride;
}

// ---------------------------------------------------------------------------
// The bundled orders operator input can override
// ---------------------------------------------------------------------------

/** One vendor's bundled column orders, addressed by folded vendor substring. */
interface BundledVendorOrders {
  /**
   * Folded vendor fragments this entry answers to, matched as a SUBSTRING of the
   * folded vendor - the same containment test `detectVendorIdentity` uses, so
   * "Palo Alto Networks", "PAN-OS" and "Palo Alto Networks PAN-OS" all land here.
   */
  readonly scopes: readonly string[];
  /** Look one log type up in this vendor's bundled dictionary. */
  readonly lookup: (logType: string) => readonly string[] | undefined;
}

/**
 * The bundled column orders this app ships. One entry today; the shape is a
 * registry rather than a PAN-OS special case because the whole point of the
 * plan's step 1 was to let the operator fix ANY vendor, including the next one.
 *
 * `panosHeadersFor` covers twelve PAN-OS log types since 2026-08-25 (the
 * original eight plus AUDIT, CORRELATION, IPTAG and USERID, each transcribed
 * from Palo Alto's published Format line) and deliberately answers `undefined`
 * for the rest - AUTH, GTP, SCTP, WILDFIRE and friends. Those have no recorded
 * order, which is exactly the case where an operator-supplied one is new
 * knowledge rather than an override. AUTH in particular is a DECISION: the
 * vendor publishes no such log type, so there is nothing to transcribe and
 * inventing one would mislabel every column after the first mistake.
 */
const BUNDLED_COLUMN_ORDERS: readonly BundledVendorOrders[] = [
  { scopes: ["paloalto", "panos"], lookup: panosHeadersFor },
];

/**
 * The bundled column order for a vendor + log type, or undefined when none is
 * shipped. Undefined is an honest answer, not a failure: it is what makes an
 * operator-supplied order NEW knowledge instead of an override.
 */
export function bundledColumnOrder(
  vendor: string,
  logType: string,
): readonly string[] | undefined {
  const folded = normalizeDefinitionScope(vendor);
  if (folded === "" || logType.trim() === "") {
    return undefined;
  }
  for (const entry of BUNDLED_COLUMN_ORDERS) {
    if (entry.scopes.some((scope) => folded.includes(scope))) {
      return entry.lookup(logType);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Diff, build, resolve
// ---------------------------------------------------------------------------

/** Element-wise equality over two column orders. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * The override record for `columns` against `bundled`, or null when there is
 * nothing to record - either no bundled order exists, or the operator's order is
 * byte-for-byte the bundled one (the pre-fill they merely confirmed).
 *
 * This is {@link diffLearnedMappings}' rule in another costume: only genuine
 * hand edits count, and an edit back to the baseline un-records itself by simply
 * not differing.
 */
export function diffBundledOrder(
  bundled: readonly string[] | undefined,
  columns: readonly string[],
): BundledOverride | null {
  if (bundled === undefined || sameOrder(bundled, columns)) {
    return null;
  }
  let at = 0;
  while (
    at < bundled.length &&
    at < columns.length &&
    bundled[at] === columns[at]
  ) {
    at += 1;
  }
  return {
    bundledColumnCount: bundled.length,
    firstDivergentIndex: at,
    bundledName: bundled[at] ?? "",
    operatorName: columns[at] ?? "",
  };
}

/**
 * The definition to STORE for an operator-supplied order, or null when there is
 * nothing worth storing:
 *   - the scope cannot be keyed (see {@link vendorFieldDefinitionKey});
 *   - no columns were supplied (absent is absent, never an empty definition);
 *   - the columns ARE the bundled order - a confirmed pre-fill, which is the
 *     machine's own disposition and not an operator decision (module header).
 *
 * Column names are taken VERBATIM. Dropping a blank one would shift every name
 * after it, which is the exact off-by-one the dialog's mismatch warning exists
 * to catch; the callers (parseHeaderFileText, parseFeedConfig) already clean.
 */
export function buildVendorFieldDefinition(
  vendor: string,
  logType: string,
  columns: readonly string[],
): VendorFieldDefinition | null {
  if (vendorFieldDefinitionKey(vendor, logType) === null) {
    return null;
  }
  if (columns.length === 0) {
    return null;
  }
  const bundled = bundledColumnOrder(vendor, logType);
  if (bundled !== undefined && sameOrder(bundled, columns)) {
    return null;
  }
  const definition: VendorFieldDefinition = {
    vendor: vendor.trim(),
    logType: logType.trim(),
    columns: [...columns],
  };
  const override = diffBundledOrder(bundled, columns);
  if (override !== null) {
    definition.overrides = override;
  }
  return definition;
}

/**
 * Defensively decode a stored value FOR A KNOWN SCOPE. Anything that is not a
 * complete definition about this exact vendor + log type reads as null.
 *
 * WHOLE-ENTRY REJECTION, unlike {@link parseLearnedMappings}, which drops bad
 * entries individually and keeps the rest. That difference is deliberate and is
 * the whole hazard of positional data: learned mappings are INDEPENDENT facts,
 * so losing one costs one field, while a column order is ONE fact whose meaning
 * is the position - silently dropping element 17 renames every column after it.
 * A partially decoded column order is worse than none.
 *
 * The scope check is the collision gate: a key that somehow resolved to another
 * vendor's entry yields null, so two vendors can never silently merge.
 */
export function parseVendorFieldDefinition(
  raw: unknown,
  vendor: string,
  logType: string,
): VendorFieldDefinition | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entry = raw as Partial<VendorFieldDefinition>;
  if (typeof entry.vendor !== "string" || typeof entry.logType !== "string") {
    return null;
  }
  if (!Array.isArray(entry.columns) || entry.columns.length === 0) {
    return null;
  }
  const columns = entry.columns.filter(
    (name): name is string => typeof name === "string" && name !== "",
  );
  if (columns.length !== entry.columns.length) {
    return null;
  }
  if (
    normalizeDefinitionScope(entry.vendor) !== normalizeDefinitionScope(vendor) ||
    normalizeDefinitionScope(entry.logType) !== normalizeDefinitionScope(logType)
  ) {
    return null;
  }
  const decoded: VendorFieldDefinition = {
    vendor: entry.vendor,
    logType: entry.logType,
    columns,
  };
  const override = diffBundledOrder(
    bundledColumnOrder(entry.vendor, entry.logType),
    columns,
  );
  if (override !== null) {
    decoded.overrides = override;
  }
  return decoded;
}

/**
 * THE PRECEDENCE FUNCTION, and the one both callers use: the dialog pre-fills
 * from it (decision 2) and a re-acquired sample reuses it (Gap 3).
 *
 *   stored operator order  -> wins, with the override re-derived LIVE
 *   else bundled order     -> pre-fill for the operator to confirm
 *   else null              -> nothing is known; the columns stay positional and
 *                             the app never invents a name for them
 */
export function resolveColumnOrder(
  vendor: string,
  logType: string,
  stored: VendorFieldDefinition | null,
): ResolvedColumnOrder | null {
  const bundled = bundledColumnOrder(vendor, logType);
  if (stored !== null) {
    const resolved: ResolvedColumnOrder = {
      vendor: stored.vendor,
      logType: stored.logType,
      columns: stored.columns,
      source: "operator",
    };
    const override = diffBundledOrder(bundled, stored.columns);
    if (override !== null) {
      resolved.override = override;
    }
    return resolved;
  }
  if (bundled !== undefined) {
    return {
      vendor: vendor.trim(),
      logType: logType.trim(),
      columns: bundled,
      source: "bundled",
    };
  }
  return null;
}

/**
 * How far a bundled column order OVERSHOOTS the event it is naming (VND-3).
 *
 * Positional naming maps field[i] to name[i], so a feed that omits any middle
 * column mis-names every column after it - silently. The size of the gap is the
 * best cheap proxy for how likely that is, and the app already holds both
 * numbers: measured live on 2026-08-28, PAN THREAT arrived with 35 fields
 * against a bundled 120-column order, and TRAFFIC 41 against 115.
 *
 * Returns null when there is nothing to say - no field count supplied, or the
 * event has at least as many fields as the order has names.
 */
export interface ColumnOrderShortfall {
  readonly columnCount: number;
  readonly fieldCount: number;
  /** Names with no field to sit on. */
  readonly missing: number;
  /** `missing / columnCount`, in [0, 1). */
  readonly ratio: number;
  /** True once the gap is large enough to warn about. */
  readonly warn: boolean;
}

/**
 * WARN above a quarter (user decision 2026-08-28, backlog.md#13c).
 *
 * A stated product judgement, not a derived one, and deliberately so: there is
 * no measurement that says where "probably fine" becomes "probably mis-named".
 * Both live cases sit far past it - 35-of-120 and 41-of-115 are each over 60%
 * short - while an order matching its feed closely does not trip.
 */
export const COLUMN_ORDER_SHORTFALL_THRESHOLD = 0.25;

export function columnOrderShortfall(
  columnCount: number,
  fieldCount: number | undefined,
): ColumnOrderShortfall | null {
  if (fieldCount === undefined || !Number.isFinite(fieldCount)) return null;
  if (columnCount <= 0 || fieldCount < 0) return null;
  const missing = columnCount - fieldCount;
  if (missing <= 0) return null;
  const ratio = missing / columnCount;
  return {
    columnCount,
    fieldCount,
    missing,
    ratio,
    warn: ratio > COLUMN_ORDER_SHORTFALL_THRESHOLD,
  };
}

/**
 * The operator-facing sentence for a resolved order - the surface decision 3's
 * "AND THEY ARE TOLD" is actually told through. Plain text, no markup, so any
 * caller (dialog status line, sample chip) can render it.
 */
export function describeColumnOrder(
  resolved: ResolvedColumnOrder,
  fieldCount?: number,
): string {
  const scope = `${resolved.vendor} ${resolved.logType}`.trim();
  const count = `${resolved.columns.length} column${
    resolved.columns.length === 1 ? "" : "s"
  }`;
  if (resolved.source === "bundled") {
    // VND-3. The hedge "check the values beside each name" was the app asking
    // the operator to eyeball a number it already held: measured live on
    // 2026-08-28, a PAN THREAT event arrived with 35 fields against this
    // bundled 120-column order, and both numbers were printed one line apart.
    // A hedge is not a measurement.
    const shortfall = columnOrderShortfall(resolved.columns.length, fieldCount);
    if (shortfall === null) {
      // No field count to compare against - checking the values really is the
      // best available advice, so the original sentence stands.
      return `Bundled ${scope} column order (${count}) - check the values beside each name before applying.`;
    }
    const measured =
      `Bundled ${scope} column order (${count}), naming ${shortfall.fieldCount} field` +
      `${shortfall.fieldCount === 1 ? "" : "s"}.`;
    if (!shortfall.warn) return measured;
    return (
      `${measured} ${shortfall.missing} of the ${resolved.columns.length} names have no ` +
      "field to sit on, so any column this feed omits mis-names every column after it. " +
      "Check the values beside each name, or edit the order, before applying."
    );
  }
  if (resolved.override === undefined) {
    return `Your saved ${scope} column order (${count}).`;
  }
  const at = resolved.override.firstDivergentIndex + 1;
  const mine = quoteName(resolved.override.operatorName);
  const theirs = quoteName(resolved.override.bundledName);
  return (
    `Your saved ${scope} column order (${count}) REPLACES the bundled order ` +
    `(${resolved.override.bundledColumnCount} columns) - they first differ at ` +
    `column ${at}: bundled ${theirs}, yours ${mine}.`
  );
}

/** A column name for the override notice; "(none)" when the order ran out. */
function quoteName(name: string): string {
  return name === "" ? "(none)" : `"${name}"`;
}
