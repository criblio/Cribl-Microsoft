/**
 * Lab configuration validators - roadmap Phase 5 (LAB-14).
 *
 * The PURE validators ported from the legacy UnifiedLab Core/Validation-Module.ps1:
 * CIDR notation (Test-CIDRNotation), subnet containment + pairwise overlap via
 * IP-range math (Test-SubnetOverlap), storage account naming rules
 * (Test-StorageAccountName), Event Hub partition bounds
 * (Test-EventHubPartitionCount), the ADX SKU whitelist with the Dev-SKU cost
 * warning (Test-ADXClusterSKU), and the required-field / placeholder checks of
 * Test-AzureParametersConfiguration. The legacy module's LIVE permission check
 * (Test-AzurePermissions over Get-AzRoleAssignment) does NOT port here - the
 * app's RBAC preflight (permission-preflight usecase) already covers
 * effective-action checks; this module stays dependency-free.
 *
 * Validators return error/warning STRINGS mirroring the legacy console
 * messages so operators recognize them; empty arrays mean valid.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { LabSubnet } from "./lab-naming";

// ---------------------------------------------------------------------------
// CIDR (Test-CIDRNotation + the Get-IPRange math)
// ---------------------------------------------------------------------------

const CIDR_PATTERN = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$/;

/** True when `cidr` is well-formed IPv4 CIDR notation (legacy rule set). */
export function isValidLabCidr(cidr: string): boolean {
  if (!CIDR_PATTERN.test(cidr)) {
    return false;
  }
  const [ip, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (prefix < 0 || prefix > 32) {
    return false;
  }
  for (const octet of ip.split(".")) {
    const value = Number(octet);
    if (value < 0 || value > 255) {
      return false;
    }
  }
  return true;
}

/** An inclusive numeric IPv4 range (network..broadcast) for a CIDR block. */
export interface LabIpRange {
  start: number;
  end: number;
}

/**
 * The numeric network..broadcast range of a CIDR block (legacy Get-IPRange).
 * Caller must have validated the CIDR first; malformed input yields NaN math.
 */
export function labCidrRange(cidr: string): LabIpRange {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const octets = ip.split(".").map(Number);
  const ipNum =
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (ipNum & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

/** True when the two inclusive ranges overlap (legacy Test-RangeOverlap). */
export function labRangesOverlap(a: LabIpRange, b: LabIpRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Validate the subnet layout against the VNet (legacy Test-SubnetOverlap):
 * every subnet must be well-formed CIDR, inside the VNet range, and no two
 * subnets may overlap. Returns error strings; [] means valid.
 */
export function validateLabSubnetLayout(
  vnetCidr: string,
  subnets: readonly LabSubnet[],
): string[] {
  const errors: string[] = [];
  if (!isValidLabCidr(vnetCidr)) {
    return [`Invalid vNet address prefix: ${vnetCidr} (must be CIDR notation, e.g. 10.0.0.0/16)`];
  }
  const vnetRange = labCidrRange(vnetCidr);
  const ranges: { key: string; cidr: string; range: LabIpRange }[] = [];
  for (const subnet of subnets) {
    if (!isValidLabCidr(subnet.addressPrefix)) {
      errors.push(
        `Invalid CIDR notation for subnet '${subnet.key}': ${subnet.addressPrefix}`,
      );
      continue;
    }
    const range = labCidrRange(subnet.addressPrefix);
    if (range.start < vnetRange.start || range.end > vnetRange.end) {
      errors.push(
        `Subnet '${subnet.key}' (${subnet.addressPrefix}) is outside VNet range (${vnetCidr})`,
      );
      continue;
    }
    ranges.push({ key: subnet.key, cidr: subnet.addressPrefix, range });
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (labRangesOverlap(ranges[i].range, ranges[j].range)) {
        errors.push(
          `Subnets overlap: '${ranges[i].key}' (${ranges[i].cidr}) and '${ranges[j].key}' (${ranges[j].cidr})`,
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Storage account name (Test-StorageAccountName)
// ---------------------------------------------------------------------------

/** Storage account naming rules: 3-24 chars, lowercase alphanumeric only. */
export function validateLabStorageAccountName(name: string): string[] {
  const errors: string[] = [];
  if (name.length < 3 || name.length > 24) {
    errors.push("Storage account name must be 3-24 characters");
  }
  if (name !== name.toLowerCase()) {
    errors.push("Storage account name must be lowercase");
  }
  if (!/^[a-z0-9]+$/.test(name)) {
    errors.push(
      "Storage account name can only contain lowercase letters and numbers",
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Event Hub partitions (Test-EventHubPartitionCount)
// ---------------------------------------------------------------------------

/** Event Hub partition count must be 1-32 (legacy bound, verbatim). */
export function validateLabEventHubPartitionCount(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 32) {
    return ["Event Hub partition count must be between 1 and 32"];
  }
  return [];
}

// ---------------------------------------------------------------------------
// ADX SKU (Test-ADXClusterSKU)
// ---------------------------------------------------------------------------

/** The legacy ADX cluster SKU whitelist, verbatim. */
export const LAB_ADX_VALID_SKUS: readonly string[] = [
  "Dev(No SLA)_Standard_E2a_v4",
  "Dev(No SLA)_Standard_D11_v2",
  "Standard_D11_v2",
  "Standard_D12_v2",
  "Standard_D13_v2",
  "Standard_D14_v2",
  "Standard_E2a_v4",
  "Standard_E4a_v4",
  "Standard_E8a_v4",
  "Standard_E16a_v4",
] as const;

/** Result shape for validators that can warn without failing. */
export interface LabValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Validate an ADX cluster SKU against the legacy whitelist; a Dev SKU is
 * valid but carries the legacy cost warning (no SLA, ~$240/month minimum).
 */
export function validateLabAdxSku(sku: string): LabValidationResult {
  if (!LAB_ADX_VALID_SKUS.includes(sku)) {
    return {
      errors: [
        `Invalid ADX cluster SKU: ${sku}. Valid SKUs: ${LAB_ADX_VALID_SKUS.join(", ")}`,
      ],
      warnings: [],
    };
  }
  if (sku.startsWith("Dev(No SLA)")) {
    return {
      errors: [],
      warnings: [
        "Dev SKU has no SLA and is for testing only (~$240/month minimum even for Dev)",
      ],
    };
  }
  return { errors: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Settings-level validation (the pure parts of Test-AzureParametersConfiguration)
// ---------------------------------------------------------------------------

/** Placeholder detection: empty, or an angle-bracketed template value. */
function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || (trimmed.startsWith("<") && trimmed.endsWith(">"));
}

/** Inputs for {@link validateLabSettings}. */
export interface LabSettingsInput {
  subscriptionId: string;
  /** Resource-group prefix (create-new mode) OR the full existing RG name. */
  resourceGroupName: string;
  location: string;
  baseObjectName: string;
  /** TTL warning recipient; required because TTL is mandatory in-app. */
  ttlUserEmail: string;
  /** TTL lifetime hours; must be a positive integer. */
  ttlHours: number;
  /** Warning lead time; must be a non-negative integer below ttlHours. */
  ttlWarningHours: number;
}

/**
 * Validate the lab settings (the pure required-field / placeholder half of
 * the legacy Test-AzureParametersConfiguration, plus the app's mandatory-TTL
 * rules). Component-specific checks (subnets, storage name, ADX SKU,
 * partitions) compose separately via the validators above.
 */
export function validateLabSettings(input: LabSettingsInput): string[] {
  const errors: string[] = [];
  if (isPlaceholder(input.subscriptionId)) {
    errors.push("subscriptionId is required (connect an Azure target first)");
  }
  if (isPlaceholder(input.resourceGroupName)) {
    errors.push("Resource group name is required");
  }
  if (isPlaceholder(input.location)) {
    errors.push("location is required (e.g. eastus, westus2)");
  }
  if (isPlaceholder(input.baseObjectName)) {
    errors.push("baseObjectName is required (e.g. cribllab, jpederson)");
  }
  if (isPlaceholder(input.ttlUserEmail)) {
    errors.push(
      "TTL warning email is required - every app-provisioned lab self-destructs and someone must be warned",
    );
  }
  if (!Number.isInteger(input.ttlHours) || input.ttlHours < 1) {
    errors.push("TTL hours must be a positive whole number");
  }
  if (
    !Number.isInteger(input.ttlWarningHours) ||
    input.ttlWarningHours < 0 ||
    (Number.isInteger(input.ttlHours) && input.ttlWarningHours >= input.ttlHours)
  ) {
    errors.push("TTL warning hours must be a whole number smaller than the TTL");
  }
  return errors;
}
