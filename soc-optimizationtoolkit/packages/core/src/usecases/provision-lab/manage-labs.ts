/**
 * manage-labs - the Labs inventory actions (roadmap Phase 5): list the
 * running labs in a subscription, extend a lab's TTL, destroy a lab now.
 *
 * Listing rides ONE paginated resource-groups GET (listAllPages) filtered by
 * the lab tag contract (domain/labs/lab-inventory). Extension re-stamps the
 * foundation TTL tags over the group's existing tags - exactly what a
 * re-deploy's "TTL extended" path does, without touching any resources.
 * Destruction is the ARM resource-group DELETE the TTL watchdog itself would
 * eventually issue: ARM answers 202 and deletes asynchronously; the outcome
 * reports ACCEPTED, not completed.
 *
 * SHELL OWNS TIME: nowIso is injected for all TTL math.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { Logger } from "../../ports/logger";
import {
  buildResourceGroupGetRequest,
  buildResourceGroupPatchTagsRequest,
  labFoundationTags,
  labTtlInstants,
  type LabTtlSettings,
} from "../../domain/labs/lab-foundation";
import {
  buildResourceGroupDeleteRequest,
  buildResourceGroupsListRequest,
  parseLabInventory,
  type LabInventoryEntry,
} from "../../domain/labs/lab-inventory";
import { listAllPages } from "../azure-discovery";
import { filterListing, listingCount, toListing } from "../../domain/inventory-listing";
import type { Listing } from "../../domain/inventory-listing";
import { httpErrorText, is2xx, mergedTags } from "../arm-http";

/**
 * List the lab resource groups in a subscription, soonest expiry first.
 * Throws on a failed list (rendered as "inventory unavailable", not empty).
 *
 * DBT-64: this is a FILTER, and that is why it returns a three-way listing
 * rather than an array. Zero labs out of forty groups read is a real zero and
 * the panel should say so; zero labs because the GROUP READ came back empty is
 * an RBAC-filtered `200 []` and says nothing at all. `filterListing` keeps the
 * two apart by demanding the source read, so the distinction cannot be lost by
 * forgetting it here. Before this, both rendered as "No running labs found in
 * this subscription."
 */
export async function listLabs(
  azure: AzureManagement,
  input: { subscriptionId: string; nowIso: string },
  logger?: Logger,
): Promise<Listing<LabInventoryEntry>> {
  const items = await listAllPages(
    azure,
    buildResourceGroupsListRequest(input.subscriptionId),
    `list resource groups in subscription '${input.subscriptionId}'`,
  );
  const groups = toListing(items);
  const labs = filterListing(groups, parseLabInventory(items, input.nowIso));
  logger?.info("manage-labs: listed", {
    subscriptionId: input.subscriptionId,
    // Both kinds ride along: `groups: empty` is the case where the lab count
    // below means nothing, and a log that showed only the numbers would read
    // as "0 labs" either way.
    groups: listingCount(groups, 0),
    groupListing: groups.kind,
    labs: listingCount(labs, 0),
    labListing: labs.kind,
  });
  return labs;
}

/** Outcome of {@link extendLabTtl}. */
export interface ExtendLabTtlOutcome {
  /** The new TTL_ExpirationTime stamped on the group. */
  expiresAt: string;
}

/**
 * Extend (re-stamp) a lab's TTL: merge the group's existing tags with a
 * fresh foundation TTL tag set computed from nowIso + the given settings.
 * Throws on ARM failure with greppable text.
 */
export async function extendLabTtl(
  azure: AzureManagement,
  input: {
    subscriptionId: string;
    resourceGroupName: string;
    ttl: LabTtlSettings;
    nowIso: string;
  },
  logger?: Logger,
): Promise<ExtendLabTtlOutcome> {
  const got = await azure.request(
    buildResourceGroupGetRequest(input.subscriptionId, input.resourceGroupName),
  );
  if (!is2xx(got.status)) {
    throw new Error(
      httpErrorText(
        `read resource group '${input.resourceGroupName}'`,
        got.status,
        got.body,
      ),
    );
  }
  const merged = mergedTags(got.body, {});
  const ttlSettings: LabTtlSettings = {
    ...input.ttl,
    // Keep the recorded recipient when the caller does not supply one.
    userEmail:
      input.ttl.userEmail !== "" ? input.ttl.userEmail : (merged["TTL_UserEmail"] ?? ""),
  };
  const tags = { ...merged, ...labFoundationTags(ttlSettings, input.nowIso) };
  const patch = await azure.request(
    buildResourceGroupPatchTagsRequest(
      input.subscriptionId,
      input.resourceGroupName,
      tags,
    ),
  );
  if (!is2xx(patch.status)) {
    throw new Error(
      httpErrorText(
        `extend TTL on '${input.resourceGroupName}'`,
        patch.status,
        patch.body,
      ),
    );
  }
  const instants = labTtlInstants(ttlSettings, input.nowIso);
  logger?.info("manage-labs: TTL extended", {
    resourceGroup: input.resourceGroupName,
    expiresAt: instants.expirationTime,
  });
  return { expiresAt: instants.expirationTime };
}

/** Outcome of {@link destroyLab}. */
export interface DestroyLabOutcome {
  /** True: ARM ACCEPTED the delete (202/200); deletion continues async. */
  accepted: boolean;
}

/**
 * Destroy a lab now: the ARM resource-group DELETE. ARM accepts with 202 and
 * deletes asynchronously - the group lingers in listings until done. Throws
 * on rejection with greppable text.
 */
export async function destroyLab(
  azure: AzureManagement,
  input: { subscriptionId: string; resourceGroupName: string },
  logger?: Logger,
): Promise<DestroyLabOutcome> {
  const response = await azure.request(
    buildResourceGroupDeleteRequest(input.subscriptionId, input.resourceGroupName),
  );
  if (!is2xx(response.status)) {
    throw new Error(
      httpErrorText(
        `destroy lab '${input.resourceGroupName}'`,
        response.status,
        response.body,
      ),
    );
  }
  logger?.info("manage-labs: destroy accepted", {
    resourceGroup: input.resourceGroupName,
  });
  return { accepted: true };
}
