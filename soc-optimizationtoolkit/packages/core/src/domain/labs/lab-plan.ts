/**
 * Lab plan composition - roadmap Phase 5.
 *
 * The pure preview the Labs screen renders before anything deploys: resolve
 * the preset to component flags, gate the phases, name every resource through
 * the naming engine, validate the settings, and state the Azure permissions
 * the selected resource-group mode needs (feature-catalog "Lab environments"
 * permission design, 2026-07-02: create-new-RG needs subscription Contributor
 * plus a constrained RBAC Administrator grant; bring-your-own-RG needs only
 * Contributor on the pre-created resource group).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  DEFAULT_LAB_ADX_SKU,
  DEFAULT_LAB_EVENT_HUBS,
  DEFAULT_LAB_NAMING,
  DEFAULT_LAB_SUBNETS,
  DEFAULT_LAB_VNET_CIDR,
  allLabResourceNames,
  applyLabLocationSuffixes,
  labResourceGroupName,
  type LabEventHub,
  type LabNamingConfig,
  type LabResourceNames,
  type LabSubnet,
} from "./lab-naming";
import {
  labDeploymentConfig,
  requiredLabPhases,
  type LabComponentFlags,
  type LabMode,
  type LabPhase,
  type LabType,
} from "./lab-profiles";
import {
  validateLabAdxSku,
  validateLabEventHubPartitionCount,
  validateLabSettings,
  validateLabStorageAccountName,
  validateLabSubnetLayout,
} from "./lab-validation";
import type { LabTtlSettings } from "./lab-foundation";

/**
 * How the lab resource group is obtained (feature-catalog permission design):
 * "create-new" creates `{prefix}-{ProfileSuffix}` and needs subscription-level
 * rights; "bring-your-own" targets an admin-pre-created group and needs only
 * Contributor on it.
 */
export type LabResourceGroupMode = "create-new" | "bring-your-own";

/** Inputs for {@link buildLabPlan}. */
export interface LabPlanInput {
  labType: LabType;
  labMode: LabMode;
  subscriptionId: string;
  rgMode: LabResourceGroupMode;
  /** Resource-group prefix (create-new mode; profile suffix is appended). */
  resourceGroupPrefix: string;
  /** The admin-pre-created group (bring-your-own mode). */
  existingResourceGroupName: string;
  location: string;
  baseObjectName: string;
  ttl: LabTtlSettings;
  /** Naming overrides; defaults to the legacy naming config. */
  naming?: LabNamingConfig;
  /** Subnet layout; defaults to the legacy 4-subnet /24 layout. */
  subnets?: readonly LabSubnet[];
  /** VNet address space; defaults to the legacy 10.198.30.0/24. */
  vnetCidr?: string;
  /** Event Hub definitions; defaults to the legacy logs/metrics/events hubs. */
  eventHubs?: readonly LabEventHub[];
  /** ADX SKU name; defaults to the legacy Dev SKU. */
  adxSkuName?: string;
}

/** One permission requirement row rendered in the plan review. */
export interface LabPermissionRequirement {
  scope: string;
  role: string;
  reason: string;
}

/** The composed, renderable lab plan. */
export interface LabPlan {
  labType: LabType;
  labMode: LabMode;
  resourceGroupName: string;
  rgMode: LabResourceGroupMode;
  location: string;
  flags: LabComponentFlags;
  /** The phases this profile runs, in legacy execution order. */
  phases: LabPhase[];
  /** Every resource the full profile would create, pre-named. */
  names: LabResourceNames;
  errors: string[];
  warnings: string[];
  permissions: LabPermissionRequirement[];
}

/** The permission rows for one resource-group mode (feature-catalog, verbatim intent). */
export function labPermissionRequirements(
  rgMode: LabResourceGroupMode,
  resourceGroupName: string,
): LabPermissionRequirement[] {
  if (rgMode === "create-new") {
    return [
      {
        scope: "Subscription",
        role: "Contributor",
        reason: "Resource-group creation is subscription-scoped.",
      },
      {
        scope: "Subscription",
        role: "Role Based Access Control Administrator (constrained)",
        reason:
          "The TTL self-destruct Logic App identity receives its resource-group-delete " +
          "Contributor role at deploy time (roleAssignments/write). Constrain the grant " +
          "to assigning only Contributor and Monitoring Metrics Publisher, only to " +
          "service principals.",
      },
    ];
  }
  return [
    {
      scope: `Resource group '${resourceGroupName}'`,
      role: "Contributor",
      reason:
        "Least-privilege path: an admin pre-creates the lab resource group. The TTL " +
        "identity's delete rights must be granted by the admin after the foundation " +
        "deploy reports the identity's principal id.",
    },
  ];
}

/**
 * Compose the full lab plan: flags, phases, names, validation, permissions.
 * Validation covers the settings plus only the components the profile
 * actually deploys (a Sentinel lab is not blocked by an ADX SKU typo).
 */
export function buildLabPlan(input: LabPlanInput): LabPlan {
  const flags = labDeploymentConfig(input.labType, input.labMode);
  const resourceGroupName =
    input.rgMode === "create-new"
      ? labResourceGroupName(input.resourceGroupPrefix, flags.resourceGroupSuffix)
      : input.existingResourceGroupName.trim();

  const naming = applyLabLocationSuffixes(
    input.naming ?? DEFAULT_LAB_NAMING,
    input.location,
  );
  const subnets = input.subnets ?? DEFAULT_LAB_SUBNETS;
  const eventHubs = input.eventHubs ?? DEFAULT_LAB_EVENT_HUBS;
  const names = allLabResourceNames({
    naming,
    baseObjectName: input.baseObjectName,
    subscriptionId: input.subscriptionId,
    subnets,
    eventHubs,
  });

  const errors: string[] = [];
  const warnings: string[] = [];
  errors.push(
    ...validateLabSettings({
      subscriptionId: input.subscriptionId,
      resourceGroupName,
      location: input.location,
      baseObjectName: input.baseObjectName,
      ttlUserEmail: input.ttl.userEmail,
      ttlHours: input.ttl.hours,
      ttlWarningHours: input.ttl.warningHours,
    }),
  );
  if (flags.infrastructure.deployVNet) {
    errors.push(
      ...validateLabSubnetLayout(input.vnetCidr ?? DEFAULT_LAB_VNET_CIDR, subnets),
    );
  }
  if (flags.storage.deploy) {
    errors.push(...validateLabStorageAccountName(names.storageAccount));
  }
  if (flags.analytics.deployEventHub) {
    for (const hub of eventHubs) {
      for (const error of validateLabEventHubPartitionCount(hub.partitionCount)) {
        errors.push(`${error} (hub '${hub.key}')`);
      }
    }
  }
  if (flags.analytics.deployADX) {
    const adx = validateLabAdxSku(input.adxSkuName ?? DEFAULT_LAB_ADX_SKU);
    errors.push(...adx.errors);
    warnings.push(...adx.warnings);
  }
  if (flags.infrastructure.deployVPN) {
    warnings.push(
      "VPN gateway deployment takes 30-45 minutes and runs as a long polled job.",
    );
  }

  return {
    labType: input.labType,
    labMode: input.labMode,
    resourceGroupName,
    rgMode: input.rgMode,
    location: input.location,
    flags,
    phases: requiredLabPhases(flags),
    names,
    errors,
    warnings,
    permissions: labPermissionRequirements(input.rgMode, resourceGroupName),
  };
}
