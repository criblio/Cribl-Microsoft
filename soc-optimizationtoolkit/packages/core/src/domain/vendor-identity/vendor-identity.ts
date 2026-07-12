/**
 * Vendor identity - determining the DeviceVendor/DeviceProduct (and ASim
 * EventVendor/EventProduct) constants a destination table REQUIRES, and where
 * their values come from (user request 2026-07-08: "Can we determine
 * DeviceVendor and DeviceProduct for each vendor and if not force the user to
 * input them?").
 *
 * Sentinel content (analytics rules, workbooks, parsers) filters
 * CommonSecurityLog on DeviceVendor/DeviceProduct, but raw vendor logs often
 * never carry them - a CEF header does (parseCef lifts them out), a syslog or
 * CSV export does not. The resolution ladder, most-authoritative first:
 *
 *   1. SAMPLE   - the gap analysis mapped a source field onto the identity
 *                 column (CEF headers land here). Nothing to add; an
 *                 enrichment constant would OVERWRITE the real value.
 *   2. ENRICHMENT - the user (or the auto-seeded solution suggestion) added
 *                 the constant in the enrichment editor.
 *   3. MISSING  - neither. The UI blocks the pack build until the user
 *                 supplies a value: shipping a pipeline without them produces
 *                 rows Sentinel content silently never matches.
 *
 * The curated {@link KNOWN_VENDOR_IDENTITIES} list turns a selected solution
 * name into a SUGGESTION the UI seeds as an editable enrichment. Values come
 * from the vendors' documented CEF headers / the Sentinel connector queries;
 * product is omitted where it varies by log type (the suggestion then covers
 * the vendor field only and the product stays a forced input).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** A curated vendor/product identity suggestion. */
export interface VendorIdentity {
  /** The DeviceVendor/EventVendor constant (e.g. "Palo Alto Networks"). */
  vendor: string;
  /**
   * The DeviceProduct/EventProduct constant (e.g. "PAN-OS"), when the vendor
   * uses one stable value. Omitted when it varies by log type - the product
   * field then stays a required manual input.
   */
  product?: string;
  /**
   * The KNOWN candidate products when the vendor emits several (e.g. the
   * Zscaler NSS feeds send NSSWeblog for web logs and NSSFWlog for firewall
   * logs). NEVER auto-seeded - the operator must pick, because the wrong
   * constant silently breaks Sentinel content filters - but the UI offers
   * them as one-click choices on the forced-input row.
   */
  productOptions?: readonly string[];
}

/** One curated entry: solution-name keywords -> identity. */
interface VendorIdentityHint {
  /** Lowercased substrings matched against the lowercased solution name. */
  keywords: readonly string[];
  identity: VendorIdentity;
}

/**
 * Curated solution-name -> identity knowledge, most-specific first (the FIRST
 * entry with a matching keyword wins - e.g. "clearpass" must outrank a bare
 * "aruba"). Values follow the vendors' documented CEF headers and the
 * Sentinel connector queries that filter on them.
 */
const KNOWN_VENDOR_IDENTITIES: readonly VendorIdentityHint[] = [
  {
    keywords: ["palo alto", "paloalto", "pan-os"],
    identity: { vendor: "Palo Alto Networks", product: "PAN-OS" },
  },
  {
    keywords: ["fortinet", "fortigate"],
    identity: { vendor: "Fortinet", product: "Fortigate" },
  },
  {
    keywords: ["check point", "checkpoint"],
    identity: {
      vendor: "Check Point",
      productOptions: ["VPN-1 & FireWall-1"],
    },
  },
  {
    keywords: ["zscaler"],
    identity: {
      vendor: "Zscaler",
      productOptions: ["NSSWeblog", "NSSFWlog"],
    },
  },
  { keywords: ["cisco asa"], identity: { vendor: "Cisco", product: "ASA" } },
  {
    keywords: ["crowdstrike"],
    identity: { vendor: "CrowdStrike", product: "FalconHost" },
  },
  {
    keywords: ["deep security", "trend micro"],
    identity: { vendor: "Trend Micro", product: "Deep Security Agent" },
  },
  {
    keywords: ["clearpass"],
    identity: { vendor: "Aruba Networks", product: "ClearPass" },
  },
  { keywords: ["aruba"], identity: { vendor: "Aruba Networks" } },
  { keywords: ["infoblox"], identity: { vendor: "Infoblox", product: "NIOS" } },
  {
    keywords: ["cyberark", "cyber-ark"],
    identity: { vendor: "Cyber-Ark", product: "Vault" },
  },
  { keywords: ["sonicwall"], identity: { vendor: "SonicWall" } },
  { keywords: ["watchguard"], identity: { vendor: "WatchGuard" } },
  { keywords: ["barracuda"], identity: { vendor: "Barracuda" } },
  { keywords: ["juniper"], identity: { vendor: "Juniper Networks" } },
  { keywords: ["imperva"], identity: { vendor: "Imperva" } },
  { keywords: ["citrix", "netscaler"], identity: { vendor: "Citrix" } },
  { keywords: ["f5"], identity: { vendor: "F5" } },
];

/**
 * The identity columns a destination table REQUIRES before its content works:
 * CommonSecurityLog's rules/workbooks filter on DeviceVendor/DeviceProduct;
 * the ASim normalized tables require EventVendor/EventProduct. Every other
 * table needs none.
 */
export function requiredIdentityFields(tableName: string): readonly string[] {
  const name = tableName.trim();
  if (name === "CommonSecurityLog") {
    return ["DeviceVendor", "DeviceProduct"];
  }
  if (name.startsWith("ASim")) {
    return ["EventVendor", "EventProduct"];
  }
  return [];
}

/**
 * Detect the vendor identity from the selected Sentinel solution's name via
 * the curated list (first matching entry wins). Null when the solution is not
 * curated - the identity fields then stay forced manual inputs.
 */
export function detectVendorIdentity(
  solutionName: string,
): VendorIdentity | null {
  const haystack = solutionName.trim().toLowerCase();
  if (haystack === "") {
    return null;
  }
  for (const hint of KNOWN_VENDOR_IDENTITIES) {
    if (hint.keywords.some((k) => haystack.includes(k))) {
      return { ...hint.identity };
    }
  }
  return null;
}

/**
 * The suggested constant for one identity FIELD from a detected identity:
 * *Vendor fields take the vendor, *Product fields take the product (null when
 * the curated entry has no stable product - the field stays a manual input;
 * productOptions are deliberately NOT auto-suggested, only offered).
 */
export function suggestedIdentityValue(
  field: string,
  identity: VendorIdentity,
): string | null {
  if (field.endsWith("Vendor")) {
    return identity.vendor;
  }
  if (field.endsWith("Product")) {
    return identity.product ?? null;
  }
  return null;
}

/**
 * The KNOWN candidate values for one identity field, for the forced-input
 * row's one-click choices: the vendor for *Vendor fields; for *Product
 * fields the stable product when there is one, else the curated
 * productOptions (e.g. Zscaler's NSSWeblog / NSSFWlog). Empty when nothing
 * is known - the operator types the value.
 */
export function identityValueOptions(
  field: string,
  identity: VendorIdentity | null,
): string[] {
  if (identity === null) {
    return [];
  }
  if (field.endsWith("Vendor")) {
    return [identity.vendor];
  }
  if (field.endsWith("Product")) {
    if (identity.product !== undefined) {
      return [identity.product];
    }
    return [...(identity.productOptions ?? [])];
  }
  return [];
}

/** The mapping-row shape the resolver needs (a GapFieldMapping subset). */
export interface IdentityMappingRow {
  dest: string;
  action: string;
  sampleValue?: string;
}

/** The enrichment-entry shape the resolver needs. */
export interface IdentityEnrichmentRow {
  field: string;
  value: string;
}

/** Where one required identity field's value comes from. */
export interface IdentityFieldStatus {
  field: string;
  /**
   * "sample" - a source field maps onto the column (CEF headers);
   * "enrichment" - a user/seeded constant covers it; "missing" - neither,
   * and the pack build must stay blocked until the user supplies it.
   */
  status: "sample" | "enrichment" | "missing";
  /** The known value (the sample's example or the enrichment constant). */
  value?: string;
}

/**
 * Resolve each required identity field for a table through the ladder:
 * sample mapping first (an enrichment would overwrite the real per-event
 * value), then enrichment constant, else missing. Tables with no required
 * fields resolve to an empty list.
 */
export function resolveIdentityFields(
  tableName: string,
  mappings: readonly IdentityMappingRow[],
  enrichments: readonly IdentityEnrichmentRow[],
): IdentityFieldStatus[] {
  return requiredIdentityFields(tableName).map((field) => {
    const fromSample = mappings.find(
      (m) =>
        m.dest === field && m.action !== "overflow" && m.action !== "drop",
    );
    if (fromSample !== undefined) {
      const status: IdentityFieldStatus = { field, status: "sample" };
      if (fromSample.sampleValue !== undefined) {
        status.value = fromSample.sampleValue;
      }
      return status;
    }
    const fromEnrichment = enrichments.find((e) => e.field === field);
    if (fromEnrichment !== undefined) {
      return { field, status: "enrichment", value: fromEnrichment.value };
    }
    return { field, status: "missing" };
  });
}

/** Convenience: just the missing required identity fields for a table. */
export function missingIdentityFields(
  tableName: string,
  mappings: readonly IdentityMappingRow[],
  enrichments: readonly IdentityEnrichmentRow[],
): string[] {
  return resolveIdentityFields(tableName, mappings, enrichments)
    .filter((s) => s.status === "missing")
    .map((s) => s.field);
}

/**
 * The pack-build gate message for missing identity fields across tables, or
 * null when nothing is missing. Entries for the same table (two samples
 * aligned to CommonSecurityLog) merge, preserving field order.
 */
export function identityGateMessage(
  perTable: ReadonlyArray<{ tableName: string; missing: readonly string[] }>,
): string | null {
  const byTable = new Map<string, string[]>();
  for (const entry of perTable) {
    if (entry.missing.length === 0) {
      continue;
    }
    const fields = byTable.get(entry.tableName) ?? [];
    for (const field of entry.missing) {
      if (!fields.includes(field)) {
        fields.push(field);
      }
    }
    byTable.set(entry.tableName, fields);
  }
  if (byTable.size === 0) {
    return null;
  }
  const parts = [...byTable.entries()].map(
    ([table, fields]) => `${table} needs ${fields.join(", ")}`,
  );
  return `Add the required vendor identity fields in the Gap Analysis section: ${parts.join("; ")}.`;
}

/**
 * Derive a vendor identity from a solution's OWN connector definitions
 * (Wave C of docs/sentinel-repo-mapping-sources.md): for shared-table (CEF/
 * Syslog) vendors the connector-UI KQL is the only machine-readable identity
 * signal (Fortinet: `DeviceVendor == "Fortinet" | where DeviceProduct
 * startswith "Fortigate"`). Scans RAW connector JSON text - the filters live
 * inside baseQuery/connectivityCriterias strings across all four connector
 * formats, so structural decoding is unnecessary.
 *
 * A single distinct product value becomes `product`; several become
 * `productOptions` (never auto-seeded - operator picks). A `startswith`
 * value is accepted as the product stem: it is the constant the connector
 * itself filters on, so a pipeline emitting it satisfies the content.
 * Returns null when no DeviceVendor/EventVendor filter is found - curated
 * knowledge (detectVendorIdentity) stays the first tier.
 */
export function identityFromConnectorKql(
  connectorTexts: readonly string[],
): VendorIdentity | null {
  const vendors = new Set<string>();
  const products = new Set<string>();
  // JSON-embedded KQL carries escaped quotes: DeviceVendor == \"Fortinet\".
  const value = String.raw`\\?['"]([^'"\\]+)\\?['"]`;
  const vendorRe = new RegExp(
    String.raw`(?:DeviceVendor|EventVendor)\s*(?:==|=~)\s*` + value,
    "g",
  );
  const productRe = new RegExp(
    String.raw`(?:DeviceProduct|EventProduct)\s*(?:==|=~|startswith)\s*` + value,
    "g",
  );
  for (const text of connectorTexts) {
    for (const m of text.matchAll(vendorRe)) vendors.add(m[1].trim());
    for (const m of text.matchAll(productRe)) products.add(m[1].trim());
  }
  if (vendors.size !== 1) {
    // Zero: nothing to derive. Several: conflicting definitions - do not
    // guess an identity constant that silently breaks content filters.
    return null;
  }
  const identity: VendorIdentity = { vendor: [...vendors][0] };
  if (products.size === 1) {
    identity.product = [...products][0];
  } else if (products.size > 1) {
    identity.productOptions = [...products].sort();
  }
  return identity;
}
