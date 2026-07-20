/**
 * Lab resource naming engine - roadmap Phase 5 (LAB-13).
 *
 * Ported from the legacy UnifiedLab Core/Naming-Engine.ps1: location-based
 * suffix application (Update-NamingSuffixes), prefix+base+suffix composition
 * (Get-ResourceName), the storage-account special rules (lowercase,
 * alphanumeric, max 24 - Get-StorageAccountName), the ADX cluster special
 * rules (alphanumeric, 4-22, subscription-derived uniqueness hash -
 * Get-ADXClusterName), the full planned-name map (Get-AllResourceNames), and
 * the lab resource-group name composition (Get-ResourceGroupName).
 *
 * ONE recorded deviation: the legacy ADX uniqueness hash was .NET string
 * GetHashCode - runtime-specific and NOT reproducible outside PowerShell (it
 * can change across .NET versions and is documented as unstable). This port
 * pins a deterministic FNV-1a 32-bit hash instead ({@link labSubscriptionHash});
 * the composition rules around it (lowercase, strip, pad "cluster" if short,
 * cap 22) are verbatim.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** One resource type's naming parts: `{prefix}{baseObjectName}{suffix}`. */
export interface LabNameParts {
  prefix: string;
  suffix: string;
}

/** The per-resource-type naming configuration (legacy azure-parameters.json `naming`). */
export interface LabNamingConfig {
  vnet: LabNameParts;
  subnet: LabNameParts;
  nsg: LabNameParts;
  vpnGateway: LabNameParts;
  publicIp: LabNameParts;
  storageAccount: LabNameParts;
  logAnalyticsWorkspace: LabNameParts;
  networkWatcher: LabNameParts;
  eventHubNamespace: LabNameParts;
  eventHub: LabNameParts;
  adxCluster: LabNameParts;
  adxDatabase: LabNameParts;
  diagnosticSettings: LabNameParts;
}

/** The legacy default naming prefixes (azure-parameters.json, verbatim). */
export const DEFAULT_LAB_NAMING: LabNamingConfig = {
  vnet: { prefix: "vnet-", suffix: "" },
  subnet: { prefix: "snet-", suffix: "" },
  nsg: { prefix: "nsg-", suffix: "" },
  vpnGateway: { prefix: "vpngw-", suffix: "" },
  publicIp: { prefix: "pip-", suffix: "" },
  // Storage suffix is a CUSTOM identifier (never location-based; no hyphens).
  storageAccount: { prefix: "sa", suffix: "cribl" },
  logAnalyticsWorkspace: { prefix: "law-", suffix: "" },
  networkWatcher: { prefix: "nw-", suffix: "" },
  eventHubNamespace: { prefix: "evhns-", suffix: "" },
  eventHub: { prefix: "evh-", suffix: "" },
  adxCluster: { prefix: "adx", suffix: "" },
  adxDatabase: { prefix: "db-", suffix: "" },
  diagnosticSettings: { prefix: "diag-", suffix: "" },
};

/**
 * The known-region alternation the legacy suffix updater recognized, verbatim
 * (Naming-Engine.ps1 line 41). A configured suffix matching one of these (with
 * or without a leading hyphen) is treated as location-derived and REPLACED
 * when the location changes; anything else is a custom suffix and preserved.
 */
export const LAB_KNOWN_REGIONS: readonly string[] = [
  "eastus",
  "westus",
  "centralus",
  "northcentralus",
  "southcentralus",
  "westus2",
  "westus3",
  "eastus2",
  "northeurope",
  "westeurope",
  "uksouth",
  "ukwest",
  "francecentral",
  "germanywestcentral",
  "norwayeast",
  "switzerlandnorth",
  "uaenorth",
  "brazilsouth",
  "southafricanorth",
  "australiaeast",
  "australiasoutheast",
  "centralindia",
  "japaneast",
  "japanwest",
  "koreacentral",
  "southeastasia",
  "eastasia",
] as const;

const LOCATION_SUFFIX_PATTERN = new RegExp(
  `^-?(${LAB_KNOWN_REGIONS.join("|")})$`,
);

/**
 * The resource types whose suffix auto-follows the location WITH a hyphen
 * (legacy `$resourceTypesWithLocationSuffix`, verbatim). ADX is special-cased
 * (no hyphen); the storage account suffix is intentionally NEVER auto-updated.
 */
export const LAB_LOCATION_SUFFIXED_TYPES = [
  "vnet",
  "subnet",
  "nsg",
  "vpnGateway",
  "publicIp",
  "logAnalyticsWorkspace",
  "networkWatcher",
  "eventHubNamespace",
] as const satisfies readonly (keyof LabNamingConfig)[];

/**
 * Apply location-based suffixes (legacy Update-NamingSuffixes): for each
 * location-suffixed type, set `-{location}` when the current suffix is empty
 * or looks location-derived (custom suffixes are preserved); the ADX cluster
 * gets `{location}` without the hyphen under the same rule. Returns a NEW
 * config; the input is not mutated.
 */
export function applyLabLocationSuffixes(
  naming: LabNamingConfig,
  location: string,
): LabNamingConfig {
  const next: LabNamingConfig = {
    ...naming,
    adxCluster: { ...naming.adxCluster },
  };
  for (const type of LAB_LOCATION_SUFFIXED_TYPES) {
    const current = naming[type];
    const replace =
      current.suffix === "" || LOCATION_SUFFIX_PATTERN.test(current.suffix);
    next[type] = {
      ...current,
      suffix: replace ? `-${location}` : current.suffix,
    };
  }
  const adx = naming.adxCluster;
  if (adx.suffix === "" || LOCATION_SUFFIX_PATTERN.test(adx.suffix)) {
    next.adxCluster.suffix = location;
  }
  return next;
}

/**
 * Compose one resource name (legacy Get-ResourceName):
 * `{prefix}{baseObjectName}{suffix}`, or `{prefix}{baseObjectName}-{mid}{suffix}`
 * when a mid suffix is given (e.g. the subnet name in an NSG name, "vpn" in
 * the VPN public IP name).
 */
export function labResourceName(
  naming: LabNamingConfig,
  type: keyof LabNamingConfig,
  baseObjectName: string,
  midSuffix?: string,
): string {
  const parts = naming[type];
  if (midSuffix !== undefined && midSuffix !== "") {
    return `${parts.prefix}${baseObjectName}-${midSuffix}${parts.suffix}`;
  }
  return `${parts.prefix}${baseObjectName}${parts.suffix}`;
}

/**
 * Storage account name (legacy Get-StorageAccountName, verbatim rules):
 * prefix+base+suffix, lowercased, non-alphanumerics stripped, truncated to 24.
 * A result shorter than 3 characters is left as-is for the VALIDATOR to
 * reject (the legacy generator did not pad either).
 */
export function labStorageAccountName(
  naming: LabNamingConfig,
  baseObjectName: string,
): string {
  let name = (
    naming.storageAccount.prefix +
    baseObjectName +
    naming.storageAccount.suffix
  )
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (name.length > 24) {
    name = name.slice(0, 24);
  }
  return name;
}

/**
 * Deterministic 4-hex-char uniqueness hash of the subscription id (FNV-1a
 * 32-bit). RECORDED DEVIATION from the legacy .NET GetHashCode: that hash is
 * runtime-specific and unstable across .NET versions, so it cannot be
 * reproduced faithfully; this replacement is pinned by test instead.
 */
export function labSubscriptionHash(subscriptionId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < subscriptionId.length; i++) {
    hash ^= subscriptionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 4);
}

/**
 * ADX cluster name (legacy Get-ADXClusterName): prefix + base + subscription
 * hash + suffix, lowercased, non-alphanumerics stripped; padded with
 * "cluster" when shorter than 4; truncated to 22 (ADX naming limits).
 */
export function labAdxClusterName(
  naming: LabNamingConfig,
  baseObjectName: string,
  subscriptionId: string,
): string {
  let name = (
    naming.adxCluster.prefix +
    baseObjectName +
    labSubscriptionHash(subscriptionId) +
    naming.adxCluster.suffix
  )
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (name.length < 4) {
    name = name + "cluster";
  }
  if (name.length > 22) {
    name = name.slice(0, 22);
  }
  return name;
}

/** One lab subnet definition (legacy infrastructure.subnets entries). */
export interface LabSubnet {
  /** The config key (e.g. "gateway", "security"). */
  key: string;
  /** The deployed subnet name (e.g. "GatewaySubnet", "SecuritySubnet"). */
  name: string;
  /** CIDR address prefix. */
  addressPrefix: string;
  /** Human description shown in previews. */
  description?: string;
  /**
   * Emit privateEndpointNetworkPolicies Disabled on the subnet - required by
   * private endpoints. Set on the PrivateLinkSubnet default; the legacy
   * flipped it lazily with a second VNet write when deploying AMPLS.
   */
  disablePrivateEndpointNetworkPolicies?: boolean;
}

/** The legacy default subnet layout (azure-parameters.json, verbatim). */
export const DEFAULT_LAB_SUBNETS: readonly LabSubnet[] = [
  {
    key: "gateway",
    name: "GatewaySubnet",
    addressPrefix: "10.198.30.0/27",
    description: "VPN Gateway subnet (required name)",
  },
  {
    key: "security",
    name: "SecuritySubnet",
    addressPrefix: "10.198.30.64/27",
    description: "Security services and workload VMs",
  },
  {
    key: "o11y",
    name: "O11ySubnet",
    addressPrefix: "10.198.30.96/27",
    description: "Observability services (monitoring, logging, analytics)",
  },
  {
    key: "privatelink",
    name: "PrivateLinkSubnet",
    addressPrefix: "10.198.30.128/27",
    description: "Private endpoints for storage, Event Hub, ADX",
    disablePrivateEndpointNetworkPolicies: true,
  },
] as const;

/** The legacy default VNet address space (azure-parameters.json, verbatim). */
export const DEFAULT_LAB_VNET_CIDR = "10.198.30.0/24";

/** One lab Event Hub definition (legacy analytics.eventHub.hubs entries). */
export interface LabEventHub {
  key: string;
  name: string;
  partitionCount: number;
  messageRetentionInDays: number;
}

/** The legacy default Event Hubs (azure-parameters.json, verbatim). */
export const DEFAULT_LAB_EVENT_HUBS: readonly LabEventHub[] = [
  { key: "logs", name: "logs-hub", partitionCount: 4, messageRetentionInDays: 1 },
  { key: "metrics", name: "metrics-hub", partitionCount: 2, messageRetentionInDays: 1 },
  { key: "events", name: "events-hub", partitionCount: 8, messageRetentionInDays: 7 },
] as const;

/** The legacy default ADX cluster SKU (azure-parameters.json, verbatim). */
export const DEFAULT_LAB_ADX_SKU = "Dev(No SLA)_Standard_E2a_v4";

/** Inputs for {@link allLabResourceNames}. */
export interface LabResourceNamesInput {
  /** Naming config, typically after {@link applyLabLocationSuffixes}. */
  naming: LabNamingConfig;
  baseObjectName: string;
  subscriptionId: string;
  /** Subnets to derive NSG names for (GatewaySubnet is skipped, verbatim). */
  subnets: readonly LabSubnet[];
  /** Event Hubs; their names are carried verbatim from the definitions. */
  eventHubs: readonly LabEventHub[];
}

/** The planned-name map (legacy Get-AllResourceNames). */
export interface LabResourceNames {
  vnet: string;
  vpnGateway: string;
  vpnPublicIp: string;
  logAnalytics: string;
  networkWatcher: string;
  eventHubNamespace: string;
  adxCluster: string;
  storageAccount: string;
  /** NSG name per subnet key; GatewaySubnet has no NSG (legacy skip). */
  nsgBySubnet: Record<string, string>;
  /** Event Hub names, in definition order. */
  eventHubs: string[];
}

/**
 * Build the full planned-name map (legacy Get-AllResourceNames): every
 * resource the lab would deploy, named through the same single engine the
 * deployment path uses. NSGs are named after their subnet (mid suffix);
 * GatewaySubnet never gets an NSG (verbatim legacy skip - Azure rejects
 * custom NSGs on it).
 */
export function allLabResourceNames(
  input: LabResourceNamesInput,
): LabResourceNames {
  const { naming, baseObjectName, subscriptionId } = input;
  const nsgBySubnet: Record<string, string> = {};
  for (const subnet of input.subnets) {
    if (subnet.name === "GatewaySubnet") {
      continue;
    }
    nsgBySubnet[subnet.key] = labResourceName(
      naming,
      "nsg",
      baseObjectName,
      subnet.name,
    );
  }
  return {
    vnet: labResourceName(naming, "vnet", baseObjectName),
    vpnGateway: labResourceName(naming, "vpnGateway", baseObjectName),
    vpnPublicIp: labResourceName(naming, "publicIp", baseObjectName, "vpn"),
    logAnalytics: labResourceName(naming, "logAnalyticsWorkspace", baseObjectName),
    networkWatcher: labResourceName(naming, "networkWatcher", baseObjectName),
    eventHubNamespace: labResourceName(naming, "eventHubNamespace", baseObjectName),
    adxCluster: labAdxClusterName(naming, baseObjectName, subscriptionId),
    storageAccount: labStorageAccountName(naming, baseObjectName),
    nsgBySubnet,
    eventHubs: input.eventHubs.map((hub) => hub.name),
  };
}

/**
 * Lab resource-group name (legacy Get-ResourceGroupName): `{prefix}-{suffix}`,
 * or the prefix alone when the suffix is blank. The suffix is the lab
 * profile's ResourceGroupSuffix (e.g. "SentinelLab").
 */
export function labResourceGroupName(prefix: string, suffix: string): string {
  if (suffix.trim() === "") {
    return prefix;
  }
  return `${prefix}-${suffix}`;
}
