/**
 * Fuzzy Sentinel-solution NAME matching - the ONE matcher (legacy had three
 * copies, consolidated in Unit 16).
 *
 * REHOMED 2026-08-18 (ADR 0003, sample-browser removal). {@link matchSolutionName}
 * lived in the sample-acquisition domain's solution-map.ts, alongside the curated
 * SOLUTION_SAMPLE_MAP the browser scored against. The map went with the browser;
 * the matcher did not, because it has a live consumer that never had anything to
 * do with browsing - analyze-samples reconciles a user-typed solution name
 * against the repo's solution list with it.
 *
 * Matching a solution NAME is a sentinel-content concern (that is where solution
 * discovery lives), which is why it landed here rather than in a new module.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** lowercase, non-alphanumerics removed (the legacy normalization). */
export function normalizeSolutionKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** lowercase words split on whitespace/-/_ , keeping only tokens >= 3 chars. */
function solutionWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((w) => w.length >= 3);
}

/**
 * The ONE fuzzy solution-name matcher. Returns true when `a` and `b` should be
 * treated as the same solution under the legacy fuzzy rules: a case-insensitive
 * alnum-equal, a substring either direction, or a shared >= 3-char word (via
 * bidirectional `includes`). Symmetric.
 *
 * A side that normalizes to nothing NAMES NO SOLUTION and matches nothing -
 * the same stance {@link packAppliesToSolution} takes on a blank name, and for
 * the same reason. It has to be said out loud because the rules below are all
 * `includes`, and every string contains the empty string: without this line
 * `matchSolutionName(anySolution, "")` was TRUE, so an unselected gap analysis
 * matched the first solution the repo listed and inherited its DCR - its
 * renames, coercions and route condition (DBT-42).
 */
export function matchSolutionName(a: string, b: string): boolean {
  const na = normalizeSolutionKey(a);
  const nb = normalizeSolutionKey(b);
  if (na === "" || nb === "") return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = solutionWords(a);
  const wb = solutionWords(b);
  return wa.some((x) => wb.some((y) => y.includes(x) || x.includes(y)));
}

/**
 * A per-vendor pack that claims solutions by keyword. Both the field-matcher's
 * VendorMappingPack and the log-type catalog's DocumentedLogTypePack satisfy
 * it structurally, which is the point - see {@link packAppliesToSolution}.
 */
export interface SolutionKeywordedPack {
  /** Lowercased substrings matched against the solution name. */
  solutionKeywords: readonly string[];
  /**
   * Lowercased substrings that DISQUALIFY this pack even when a keyword hits.
   *
   * Needed because vendors ship several products under one brand and substring
   * containment cannot express "most specific wins": "Zscaler Private Access"
   * contains "zscaler", so a ZIA pack would otherwise claim a ZPA solution.
   * Claiming the WRONG product is worse than claiming nothing - it cites one
   * product's documentation for another product's data.
   */
  excludeKeywords?: readonly string[];
}

/**
 * Whether a vendor pack applies to a solution name. THE one implementation
 * (2026-08-20 audit found two, and they had already diverged).
 *
 * WHY IT LIVES HERE and not in either pack module: this asks a question about a
 * SOLUTION NAME, which is a sentinel-content concern for exactly the reason
 * {@link matchSolutionName} gives above - solution discovery lives here.
 * field-matcher already reaches into this module for normalizeSolutionKey, so
 * the dependency direction is established rather than invented.
 *
 * WHY IT IS SHARED AT ALL: the field matcher's mapping packs and the log-type
 * catalog's documented packs were the same four lines, until one of them
 * learned about {@link SolutionKeywordedPack.excludeKeywords} and the other did
 * not. Both answers land on one screen, so a ZPA operator was offered ZPA feeds
 * by the recommendation and Zscaler ZIA field mappings by the review table. The
 * exclusion is now DATA every pack kind can carry, not a rule one copy knows.
 */
export function packAppliesToSolution(
  solutionName: string,
  pack: SolutionKeywordedPack,
): boolean {
  const haystack = solutionName.trim().toLowerCase();
  if (haystack === "") return false;
  return (
    pack.solutionKeywords.some((k) => haystack.includes(k)) &&
    !(pack.excludeKeywords ?? []).some((k) => haystack.includes(k))
  );
}

/**
 * Sibling-product exclusions for GENERATED packs, by pack id. THE ONE TABLE.
 *
 * Generated packs derive their keywords from a package title, so they routinely
 * claim a parent brand - "zscaler", "palo alto" - and catch every sibling that
 * shares it. Which products share a brand is hand knowledge, and the generated
 * assets are rewritten wholesale by their miners, so the exclusion cannot live
 * in the asset: it is re-applied at read time from here.
 *
 * IT IS ONE TABLE BECAUSE TWO DISAGREED (2026-08-21 audit). The log-type catalog
 * and the field-matcher each grew their own copy, and within a day they had
 * drifted: the mapping side excluded Prisma Cloud from Cortex XDR while the
 * log-type side still offered a Cortex XDR operator BOTH Prisma Cloud feeds and
 * PAN-OS FIREWALL feeds. Those two answers render on one screen. The
 * cross-module pin that exists to catch exactly this covered only Zscaler, so
 * the Palo Alto family walked straight past it.
 *
 * Ids are shared across both pack kinds (`generated-prisma_cloud` is both a
 * log-type pack and a mapping pack), which is what makes one table by id the
 * right shape rather than a coincidence.
 */
export const GENERATED_PACK_EXCLUSIONS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  // Zscaler: "Zscaler Private Access" contains "zscaler", so ZIA's bare keyword
  // caught ZPA - and the generated ZPA pack claims bare "zscaler" too, so it
  // caught ZIA right back. Both directions are load-bearing.
  "generated-zscaler_zia": ["private access", "zpa"],
  "generated-zscaler_zpa": ["internet access", "zia"],
  "sentinel-dcr-zscaler": ["private access", "zpa"],

  // Palo Alto. The firewall is not the EDR is not the cloud-security product,
  // and all three answer to "palo alto".
  //
  // NOT excluding "ngfw" from the firewall packs on purpose: Cloud NGFW IS a
  // Palo Alto firewall, so PAN-OS log types and mappings are genuinely relevant
  // there. Only the EDR / ASM / cloud-posture siblings are wrong.
  "generated-panw": ["cortex", "xpanse", "prisma"],
  "generated-panw_cortex_xdr": ["xpanse", "prisma"],
  // "ngfw" IS excluded here, unlike on the firewall packs above: Cloud NGFW is
  // a Palo Alto FIREWALL, so PAN-OS content belongs there and Prisma Cloud
  // (cloud posture) does not.
  "generated-prisma_cloud": ["cortex", "xpanse", "pan-os", "panos", "ngfw"],
});

/** Apply the hand-declared sibling exclusion to a generated pack, if it has one. */
export function withGeneratedExclusions<T extends SolutionKeywordedPack & { id: string }>(
  pack: T,
): T {
  const exclude = GENERATED_PACK_EXCLUSIONS[pack.id];
  return exclude === undefined ? pack : { ...pack, excludeKeywords: exclude };
}
