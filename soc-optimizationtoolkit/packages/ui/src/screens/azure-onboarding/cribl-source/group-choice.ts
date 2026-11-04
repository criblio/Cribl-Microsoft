/**
 * Which worker group the onboarding screen creates the Cribl source in and
 * reads the live flow from (AZR-64, ADR 0009 decision 5).
 *
 *   mapped    the tenant's group from the tenant to Cribl mapping on Setup.
 *             The screen's own picker is hidden: two answers to one question
 *             would let the screen create where the mapping says not to.
 *   unset     the mapping was read and names no group for this tenant: the
 *             group chosen on the screen is used, and the screen says so as
 *             information - unset is the default, not a fault.
 *   unknown   the mapping could not be read (or the tenant id is blank): no
 *             group at all. Falling back here would treat a failed read as
 *             "nothing chosen", which is the guess decision 5 forbids.
 *   loading   the same as unknown until the read lands.
 *
 * Pure: the screen hands in the resolution and the picker's value.
 */

import { UNSET_TENANT_CRIBL_MAPPING, resolveTenantGroup } from "@soc/core";
import type { TenantCriblMappingRead, TenantGroupResolution, TenantGroupUnsetWhy } from "@soc/core";
import type { PickerMessage } from "../azure-onboarding-state";

export interface OnboardingGroupChoice {
  /** The group to create in and read from; "" when there is none. */
  readonly groupId: string;
  readonly source: "mapping" | "screen" | "blocked";
  /** Whether the screen's own worker-group picker is offered. */
  readonly pickerShown: boolean;
  /** What to say beside the picker, or null. */
  readonly message: PickerMessage | null;
  /** Why Create and Watch are unavailable while blocked; null otherwise. */
  readonly blockedReason: string | null;
}

const UNSET_LEAD: Readonly<Record<TenantGroupUnsetWhy, string>> = {
  "no-mode": "No tenant to Cribl mapping is set up yet.",
  "no-shared-group":
    "The tenant to Cribl mapping says one worker group for every tenant, but no group is chosen yet.",
  "no-tenant-group":
    "The tenant to Cribl mapping gives each tenant its own worker group, but none is chosen for this tenant yet.",
};

/**
 * The resolution the screen hands to {@link onboardingGroupChoice}. With no
 * tenant id the mapping is never read, so this is the blank-tenant `unknown`
 * at once: "loading" there would claim a read that is not happening, forever.
 * The read state is ignored too, so a mapping read for an earlier tenant does
 * not resolve a blank one.
 */
export function onboardingGroupResolution(
  read: TenantCriblMappingRead | "loading",
  tenantId: string,
): TenantGroupResolution | "loading" {
  if (tenantId.trim() === "") {
    return resolveTenantGroup({ kind: "read", mapping: UNSET_TENANT_CRIBL_MAPPING, stored: false }, tenantId);
  }
  return read === "loading" ? "loading" : resolveTenantGroup(read, tenantId);
}

const LOADING_REASON = "Reading the tenant to Cribl mapping...";

export function onboardingGroupChoice(
  resolution: TenantGroupResolution | "loading",
  screenGroup: string,
): OnboardingGroupChoice {
  if (resolution === "loading") {
    return { groupId: "", source: "blocked", pickerShown: false, message: null, blockedReason: LOADING_REASON };
  }
  switch (resolution.kind) {
    case "mapped": {
      const which =
        resolution.mode === "shared" ? "the one group for every tenant" : "this tenant's own group";
      return {
        groupId: resolution.groupId,
        source: "mapping",
        pickerShown: false,
        message: {
          tone: "info",
          text: `Worker group ${resolution.groupId}: ${which}, from the tenant to Cribl mapping on Setup.`,
        },
        blockedReason: null,
      };
    }
    case "unset":
      return {
        groupId: screenGroup,
        source: "screen",
        pickerShown: true,
        message: {
          // Info, not a warning: unset is the documented default (ADR 0009
          // decision 5), and a single-tenant customer never needs the mapping.
          tone: "info",
          text: `${UNSET_LEAD[resolution.why]} The worker group chosen here is used; the mapping on Setup can set one per tenant.`,
        },
        blockedReason: null,
      };
    case "unknown":
      return {
        groupId: "",
        source: "blocked",
        pickerShown: false,
        message: {
          tone: "error",
          text: `Which worker group this tenant uses is unknown: ${resolution.reason}. Nothing is created or watched in Cribl until the tenant to Cribl mapping can be read.`,
        },
        blockedReason: `The worker group for this tenant is unknown: ${resolution.reason}.`,
      };
  }
}
