/**
 * Entra ID tenant diagnostic categories - THE CHECKBOX GRAIN IS THE CATEGORY.
 *
 * backlog.md#6b / LOG-07, ported from
 * `deprecated/Azure/Azure-LogCollection/core/Deploy-EntraIDDiagnostics.ps1`
 * (production, v5.1.0). The legacy script offered three whole-profile switches
 * and nothing finer. Here the profiles are PRESETS over a per-category
 * selection, because two of the facts an operator most needs - the volume cliff
 * and the UEBA consequence - attach to individual categories and disappear the
 * moment the unit of choice is the profile.
 *
 * THE TWO WARNINGS RIDE THEIR CATEGORIES, NOT A FOOTNOTE. backlog.md#6b is
 * explicit that the non-interactive sign-in warning "belongs at the checkbox,
 * not in a footnote", and {@link EntraCategory.volumeWarning} is where it
 * lives. A footnote is read once and then scrolled past; the warning has to be
 * adjacent to the act it is about.
 *
 * THE UEBA CONSEQUENCE IS THE SECOND, AND IT IS A HARD LIMIT. Sentinel's UEBA
 * engine consumes a FIXED SET OF NAMED native tables - `SigninLogs`,
 * `AuditLogs`, `AADServicePrincipalSignInLogs`, `AADManagedIdentitySignInLogs`.
 * Rerouting a source through Cribl lands it in a custom `_CL` table, the
 * physical name diverges from what UEBA reads, and identity baselines,
 * `BehaviorAnalytics` and entity enrichment are simply not produced.
 * features/content-preserving-native-reroute.md is unambiguous: **UEBA cannot
 * be redirected at all** - it is a limit to surface, not to hide.
 *
 * So {@link EntraCategory.uebaBoundTable} names the table per category rather
 * than warning vaguely about "sign-in categories". Four of the fifteen carry
 * it. Warning on all fifteen would be false and would train people to ignore
 * it; warning on none is the silent breakage the reroute plan exists to
 * prevent.
 *
 * LOG-07 DRIFT, RESOLVED HERE. The census documents THREE profiles -
 * SecurityOnly (6), Standard (9), HighVolume (15) - while
 * `resource-coverage.json`'s `_profileOptions` lists only Standard and
 * HighVolume. AZR-2 called for resolving that while porting. Resolved in favour
 * of the SCRIPT, which is the thing that actually ran: all three are here,
 * their members taken from `$SecurityLogCategories`, `$StandardLogCategories`
 * and `$HighVolumeLogCategories` verbatim. The coverage catalog keeps offering
 * the two it always did, because changing what a stored selection means is a
 * separate act from making a third preset available.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

/** A category name as the ARM API spells it. */
export type EntraCategoryName = string;

/** The legacy profile presets. Names verbatim from the script's switches. */
export type EntraProfile = "SecurityOnly" | "Standard" | "HighVolume";

export const ENTRA_PROFILES: readonly EntraProfile[] = [
  "SecurityOnly",
  "Standard",
  "HighVolume",
];

export interface EntraCategory {
  readonly name: EntraCategoryName;
  /** What it carries, for the checkbox label. */
  readonly description: string;
  /**
   * Set when this category is a KNOWN volume cliff. The string is shown at the
   * checkbox itself. Only categories the legacy tool called out by name carry
   * one - inventing more would dilute the two that are real.
   */
  readonly volumeWarning: string | null;
  /**
   * The NATIVE Sentinel table Microsoft's UEBA engine reads for this category,
   * or `null` when UEBA never consumed it. Non-null means: route this through
   * Cribl and UEBA stops seeing it, permanently, with no workaround.
   */
  readonly uebaBoundTable: string | null;
}

/**
 * Every category the legacy script could enable, in its own order. The union of
 * the three profiles is exactly this list.
 */
export const ENTRA_CATEGORIES: readonly EntraCategory[] = [
  {
    name: "AuditLogs",
    description: "Directory changes, app registrations, role assignments",
    volumeWarning: null,
    uebaBoundTable: "AuditLogs",
  },
  {
    name: "SignInLogs",
    description: "Interactive user sign-ins",
    volumeWarning: null,
    uebaBoundTable: "SigninLogs",
  },
  {
    name: "NonInteractiveUserSignInLogs",
    description: "Token refresh and background authentication",
    volumeWarning:
      "5-10x the volume of interactive sign-ins. This is the single largest category here.",
    uebaBoundTable: null,
  },
  {
    name: "ServicePrincipalSignInLogs",
    description: "Service principal sign-ins",
    volumeWarning: null,
    uebaBoundTable: "AADServicePrincipalSignInLogs",
  },
  {
    name: "ManagedIdentitySignInLogs",
    description: "Managed identity sign-ins",
    volumeWarning: null,
    uebaBoundTable: "AADManagedIdentitySignInLogs",
  },
  {
    name: "ProvisioningLogs",
    description: "User and group provisioning activity",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "ADFSSignInLogs",
    description: "AD FS sign-ins",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "RiskyUsers",
    description: "Identity Protection risky user state",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "UserRiskEvents",
    description: "Identity Protection user risk detections",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "RiskyServicePrincipals",
    description: "Identity Protection risky service principal state",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "ServicePrincipalRiskEvents",
    description: "Identity Protection service principal risk detections",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "NetworkAccessTrafficLogs",
    description: "Global Secure Access traffic",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "EnrichedOffice365AuditLogs",
    description: "Enriched Microsoft 365 audit logs",
    volumeWarning: null,
    uebaBoundTable: null,
  },
  {
    name: "MicrosoftGraphActivityLogs",
    description: "Microsoft Graph API activity",
    volumeWarning:
      "High volume in tenants with heavy Graph automation - every API call is an event.",
    uebaBoundTable: null,
  },
  {
    name: "RemoteNetworkHealthLogs",
    description: "Global Secure Access remote network health",
    volumeWarning: null,
    uebaBoundTable: null,
  },
];

/**
 * The three presets, VERBATIM from the legacy script's category arrays. Order
 * matters only for display; membership is what the pins check.
 */
export const ENTRA_PROFILE_CATEGORIES: Readonly<
  Record<EntraProfile, readonly EntraCategoryName[]>
> = {
  SecurityOnly: [
    "AuditLogs",
    "SignInLogs",
    "RiskyUsers",
    "UserRiskEvents",
    "RiskyServicePrincipals",
    "ServicePrincipalRiskEvents",
  ],
  Standard: [
    "AuditLogs",
    "SignInLogs",
    "ServicePrincipalSignInLogs",
    "ManagedIdentitySignInLogs",
    "ProvisioningLogs",
    "RiskyUsers",
    "UserRiskEvents",
    "RiskyServicePrincipals",
    "ServicePrincipalRiskEvents",
  ],
  HighVolume: [
    "AuditLogs",
    "SignInLogs",
    "NonInteractiveUserSignInLogs",
    "ServicePrincipalSignInLogs",
    "ManagedIdentitySignInLogs",
    "ProvisioningLogs",
    "ADFSSignInLogs",
    "RiskyUsers",
    "UserRiskEvents",
    "RiskyServicePrincipals",
    "ServicePrincipalRiskEvents",
    "NetworkAccessTrafficLogs",
    "EnrichedOffice365AuditLogs",
    "MicrosoftGraphActivityLogs",
    "RemoteNetworkHealthLogs",
  ],
};

/** Category lookup. `undefined` for an unknown name, never throws. */
export function entraCategory(name: string): EntraCategory | undefined {
  return ENTRA_CATEGORIES.find((c) => c.name === name);
}

/**
 * What a preset selects. Unknown profile yields an empty list rather than
 * throwing - a stored profile name can outlive the code that offered it.
 */
export function categoriesForProfile(
  profile: EntraProfile,
): readonly EntraCategoryName[] {
  return ENTRA_PROFILE_CATEGORIES[profile] ?? [];
}

/**
 * Which preset a selection corresponds to, or `null` when it is a custom set.
 * The screen needs this to say "Standard" instead of "9 of 15 selected", and to
 * stop claiming a preset the moment one box is changed.
 */
export function profileForSelection(
  selected: readonly EntraCategoryName[],
): EntraProfile | null {
  const want = new Set(selected);
  for (const profile of ENTRA_PROFILES) {
    const have = ENTRA_PROFILE_CATEGORIES[profile];
    if (have.length === want.size && have.every((c) => want.has(c))) return profile;
  }
  return null;
}

/**
 * The UEBA consequence of a selection: the native tables Sentinel's UEBA engine
 * would stop seeing once these categories are rerouted through Cribl.
 *
 * AZR-2 calls stating this NON-NEGOTIABLE at the moment a sign-in category is
 * ticked. Empty means no UEBA-bound category is selected and the screen has
 * nothing to warn about - which is a real and reachable answer, not an
 * oversight.
 */
export function uebaBoundTables(
  selected: readonly EntraCategoryName[],
): readonly string[] {
  const out: string[] = [];
  for (const name of selected) {
    const table = entraCategory(name)?.uebaBoundTable;
    if (table !== undefined && table !== null && !out.includes(table)) out.push(table);
  }
  return out;
}

/** Every volume warning a selection has earned, paired with its category. */
export function volumeWarnings(
  selected: readonly EntraCategoryName[],
): readonly { readonly category: EntraCategoryName; readonly warning: string }[] {
  const out: { category: EntraCategoryName; warning: string }[] = [];
  for (const name of selected) {
    const warning = entraCategory(name)?.volumeWarning;
    if (warning !== undefined && warning !== null) out.push({ category: name, warning });
  }
  return out;
}
