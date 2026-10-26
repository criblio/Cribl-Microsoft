/**
 * Coverage selection - WHAT IS TICKED, and how it survives a reload.
 *
 * The state half of the `resource-coverage.json` port (AZR-0, backlog.md#6).
 * LOG-02's portability note is explicit about where it goes: "Coverage config
 * ports as an in-app settings page persisted in the app KV store (replacing the
 * JSON file and the launch-VS-Code/Notepad editor step)."
 *
 * Three modules, three jobs, and they are deliberately separate:
 *
 *   coverage-catalog      WHAT can be ticked (fixed, ported, shipped in code)
 *   coverage-selection    WHAT IS ticked (this file; persisted to the KV store)
 *   onboarding-selection  what ticking MEANS (AZR-1's additive-only contract)
 *
 * DECODING IS DEFENSIVE, AND THAT IS THE POINT. A KV value outlives the code
 * that wrote it: an operator's saved selection is read back by whatever version
 * of the app they upgrade to, and the catalog will move underneath it. So
 * {@link decodeSelection} never throws and never trusts - it takes `unknown`,
 * keeps what still resolves against the catalog, and REPORTS what it dropped in
 * {@link DecodedSelection.dropped} rather than discarding it silently.
 *
 * That report is load-bearing rather than decorative. Silently dropping an id
 * means an operator who ticked a source, upgraded, and lost it gets no signal
 * at all - the box is simply unticked next time they look, which under AZR-1's
 * contract also means the thing is still deployed in Azure while the UI shows
 * it as off. Dropping quietly here would manufacture exactly the
 * `deployed-unselected`-rendered-as-`unselected` confusion that contract
 * exists to prevent.
 *
 * A corrupt or absent value decodes to the DEFAULTS, not to an empty selection.
 * Empty would be a valid selection meaning "onboard nothing", and a parse
 * failure must not silently become a meaningful choice the operator did not
 * make.
 *
 * IDENTITY AND READABILITY ARE TWO CHECKS (AZR-18). {@link decodeSelection} is
 * tolerant by design, which makes it the wrong gate for a WRITE: it would read a
 * document a later release wrote as "defaults", and the next Save would replace
 * real data. {@link readCoverageDocument} answers the two questions the shared
 * KV standard (claude-kit standards/cribl-kv-store.md) keeps apart - is this
 * ours (`kind`), and can this release read it (`version` exactly) - before the
 * tolerant decode runs. A screen saves only on `ok`.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. The KV read
 * and write belong to the shell; this module only turns values into text and
 * back.
 */

import {
  COVERAGE_CATALOG,
  DEFAULT_ENABLED,
  DEPLOYMENT_MODES,
  coverageItem,
} from "./coverage-catalog";
import type { DeploymentMode } from "./coverage-catalog";

/** The KV key this selection persists under. One key, one JSON document. */
export const COVERAGE_SELECTION_KEY = "azure-coverage-selection";

/**
 * The schema version of the stored document. Bump it when a change cannot be
 * absorbed by the tolerant decode below; the decoder keeps reading older
 * versions rather than discarding them.
 */
export const COVERAGE_SELECTION_VERSION = 1;

/**
 * The document's IDENTITY, written by {@link encodeSelection}. Distinct from the
 * key on purpose: the key says where the value lives, `kind` says what the value
 * is, and only the value travels (an envelope, a copy, a restore). It happens to
 * spell the same as the key; changing either does not change the other.
 */
export const COVERAGE_SELECTION_KIND = "azure-coverage-selection";

export interface CoverageSelection {
  readonly mode: DeploymentMode;
  /** Ticked item ids. Order is not meaningful; kept catalog-ordered. */
  readonly enabled: readonly string[];
  /** Per-item sub-selection, keyed by item id. Absent means "use the default". */
  readonly subSelections: Readonly<Record<string, readonly string[]>>;
}

/** What a decode produced, and what it had to throw away to produce it. */
export interface DecodedSelection {
  readonly selection: CoverageSelection;
  /**
   * Ids and options that were in the stored value but are not in the catalog
   * any more. Reported so a screen can say so - see the module docblock for why
   * silence here is actively harmful.
   */
  readonly dropped: readonly string[];
  /**
   * True when the stored value was absent, unparseable, or not an object, and
   * the defaults were used instead. Distinct from "decoded an empty selection",
   * which is a real choice.
   */
  readonly usedDefaults: boolean;
}

/** The selection a first run starts from: the legacy file's own `enabled` flags. */
export function defaultSelection(): CoverageSelection {
  const subSelections: Record<string, readonly string[]> = {};
  for (const item of COVERAGE_CATALOG) {
    if (item.subSelection !== null) {
      subSelections[item.id] = [...item.subSelection.defaultSelected];
    }
  }
  return { mode: "Centralized", enabled: [...DEFAULT_ENABLED], subSelections };
}

/** Catalog order, so a re-encoded document is stable and diffable. */
function inCatalogOrder(ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return COVERAGE_CATALOG.filter((i) => wanted.has(i.id)).map((i) => i.id);
}

/** Serialize for the KV store. Deterministic: same selection, same text. */
export function encodeSelection(selection: CoverageSelection): string {
  const subSelections: Record<string, readonly string[]> = {};
  for (const id of Object.keys(selection.subSelections).sort()) {
    subSelections[id] = selection.subSelections[id];
  }
  return JSON.stringify({
    kind: COVERAGE_SELECTION_KIND,
    version: COVERAGE_SELECTION_VERSION,
    mode: selection.mode,
    enabled: inCatalogOrder(selection.enabled),
    subSelections,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Read a stored selection back. Never throws.
 *
 * @param raw the KV value: a JSON string, or `null`/`undefined` when unset.
 */
export function decodeSelection(raw: unknown): DecodedSelection {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { selection: defaultSelection(), dropped: [], usedDefaults: true };
    }
  }
  if (!isRecord(parsed)) {
    return { selection: defaultSelection(), dropped: [], usedDefaults: true };
  }

  const dropped: string[] = [];

  const rawMode = parsed["mode"];
  const mode: DeploymentMode =
    typeof rawMode === "string" && (DEPLOYMENT_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as DeploymentMode)
      : "Centralized";
  if (typeof rawMode === "string" && mode !== rawMode) dropped.push(`mode:${rawMode}`);

  const enabled: string[] = [];
  for (const id of stringArray(parsed["enabled"])) {
    if (coverageItem(id) === undefined) dropped.push(id);
    else if (!enabled.includes(id)) enabled.push(id);
  }

  const subSelections: Record<string, readonly string[]> = {};
  const rawSubs = parsed["subSelections"];
  if (isRecord(rawSubs)) {
    for (const [id, value] of Object.entries(rawSubs)) {
      const item = coverageItem(id);
      if (item === undefined || item.subSelection === null) {
        dropped.push(`${id}.subSelection`);
        continue;
      }
      const valid = new Set(item.subSelection.options.map((o) => o.key));
      const kept: string[] = [];
      for (const key of stringArray(value)) {
        if (valid.has(key)) kept.push(key);
        else dropped.push(`${id}.${key}`);
      }
      // An item whose every stored option vanished falls back to its default
      // rather than to nothing: "no tier selected" would deploy an initiative
      // with no policies in it, which looks like success and collects nothing.
      subSelections[id] =
        kept.length > 0 ? kept : [...item.subSelection.defaultSelected];
    }
  }
  // Anything ticked with a sub-selection but no stored value takes its default.
  for (const item of COVERAGE_CATALOG) {
    if (item.subSelection !== null && subSelections[item.id] === undefined) {
      subSelections[item.id] = [...item.subSelection.defaultSelected];
    }
  }

  return {
    selection: { mode, enabled: inCatalogOrder(enabled), subSelections },
    dropped,
    usedDefaults: false,
  };
}

/**
 * What a stored value IS, decided before anything decodes it.
 *
 *   ok          ours and readable; `decoded` is {@link decodeSelection}'s answer.
 *               Also the answer for nothing stored, for unparseable or
 *               non-object text, and for an object with neither `kind` nor
 *               `version` (`{}`, a hand edit): the standard reads a value that
 *               fails the identity check as absent (defaults, `usedDefaults:
 *               true`) and lets the next deliberate write replace it.
 *   foreign     an object whose `kind` is present and is not ours. Not ours to
 *               overwrite, so Save is blocked.
 *   unreadable  ours (our `kind`, or no `kind` but a `version` field) and
 *               `version` is anything
 *               other than {@link COVERAGE_SELECTION_VERSION} exactly - missing,
 *               0, the string "1", or a later release's number. Save is blocked:
 *               overwriting it would destroy a document this release cannot see.
 */
export type CoverageDocument =
  | { readonly status: "ok"; readonly decoded: DecodedSelection }
  | { readonly status: "foreign"; readonly kind: unknown }
  | { readonly status: "unreadable"; readonly version: unknown };

/**
 * Classify a stored value, then decode it only if it is ours and readable.
 * Never throws.
 *
 * A document with NO `kind` counts as ours only when it carries a `version`:
 * {@link encodeSelection} wrote no `kind` before AZR-18 but always wrote
 * `version: 1`, so a version-1 document without one is an earlier release's
 * save, not a stranger's. With neither field it is treated as absent. The
 * version test is strict equality, never "numeric
 * and at least 1": a looser test would let version 0 or "1" be decoded as
 * defaults and then overwritten.
 *
 * @param raw the KV value: a JSON string, or `null`/`undefined` when unset.
 */
export function readCoverageDocument(raw: unknown): CoverageDocument {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "ok", decoded: decodeSelection(raw) };
    }
  }
  if (!isRecord(parsed)) return { status: "ok", decoded: decodeSelection(parsed) };

  if ("kind" in parsed && parsed["kind"] !== COVERAGE_SELECTION_KIND) {
    return { status: "foreign", kind: parsed["kind"] };
  }
  // No `kind` AND no `version` fails the identity check outright: nothing in
  // it says it is ours, so it reads as absent (the defaults), and the next
  // deliberate Save replaces it. Blocking here would strand the operator, since
  // only a write could repair the key and writes would be refused.
  if (!("kind" in parsed) && !("version" in parsed)) {
    return { status: "ok", decoded: decodeSelection(undefined) };
  }
  if (parsed["version"] !== COVERAGE_SELECTION_VERSION) {
    return { status: "unreadable", version: parsed["version"] };
  }
  return { status: "ok", decoded: decodeSelection(parsed) };
}

/**
 * Resolve a sub-selection to the options it actually means, expanding the
 * `All` shorthand the community tiers use. `All` in the stored value expands to
 * every real tier, so nothing downstream has to know the shorthand exists.
 */
export function resolvedSubSelection(
  itemId: string,
  selection: CoverageSelection,
): readonly string[] {
  const item = coverageItem(itemId);
  if (item === undefined || item.subSelection === null) return [];

  const chosen = selection.subSelections[itemId] ?? item.subSelection.defaultSelected;
  if (!chosen.includes("All")) return [...chosen];
  return item.subSelection.options.map((o) => o.key).filter((k) => k !== "All");
}

/**
 * The ticked ids, as {@link OnboardingItemId}s for `onboarding-selection`.
 * The seam between this module and AZR-1's contract: a selection becomes a
 * deploy plan only by going through `deployPlan`, which cannot remove anything.
 */
export function selectedItemIds(selection: CoverageSelection): readonly string[] {
  return inCatalogOrder(selection.enabled);
}
