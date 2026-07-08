/**
 * Service-principal picker acquisition + ordering (B3). The role-assignment
 * step lets the operator PICK the ingestion service principal instead of typing
 * its object id. This module is the pure ordering the picker renders, plus the
 * thin acquire-then-sort over the GraphDirectory port.
 *
 * Ordering (the user's rule): the app's OWN service principal first (default
 * selection - "the App registration the app uses"), then service principals
 * whose display name contains "cribl" (case-insensitive), then the rest; the
 * two trailing groups sorted alphabetically by display name. Deduplicated by
 * object id (first occurrence wins).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. acquire() is the
 * only async function and it only awaits the injected port.
 */

import type { GraphDirectory, ServicePrincipalRef } from "../../ports/graph-directory";

/** True when a display name mentions "cribl" (case-insensitive). */
function isCriblNamed(sp: ServicePrincipalRef): boolean {
  return sp.displayName.toLowerCase().includes("cribl");
}

/** Case-insensitive display-name comparison (stable tiebreak on object id). */
function byDisplayName(a: ServicePrincipalRef, b: ServicePrincipalRef): number {
  const an = a.displayName.toLowerCase();
  const bn = b.displayName.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Order the service principals for the picker: own app first, then cribl-named
 * (alpha), then the rest (alpha). `ownAppId` is the active connection's app
 * (client) id; the matching SP - the app registration the app authenticates
 * with - is surfaced first as the default. Deduplicated by object id.
 */
export function sortServicePrincipalsForPicker(
  list: readonly ServicePrincipalRef[],
  ownAppId?: string,
): ServicePrincipalRef[] {
  const seen = new Set<string>();
  const deduped: ServicePrincipalRef[] = [];
  for (const sp of list) {
    if (sp.id === "" || seen.has(sp.id)) continue;
    seen.add(sp.id);
    deduped.push(sp);
  }

  const own = ownAppId !== undefined && ownAppId.trim() !== "" ? ownAppId.trim() : "";
  const ownSps: ServicePrincipalRef[] = [];
  const cribl: ServicePrincipalRef[] = [];
  const rest: ServicePrincipalRef[] = [];
  for (const sp of deduped) {
    if (own !== "" && sp.appId === own) ownSps.push(sp);
    else if (isCriblNamed(sp)) cribl.push(sp);
    else rest.push(sp);
  }

  return [
    ...ownSps.sort(byDisplayName),
    ...cribl.sort(byDisplayName),
    ...rest.sort(byDisplayName),
  ];
}

/**
 * The object id to preselect: the OWN app's service principal when present
 * ("default to the App registration the app uses"), else empty so the operator
 * must choose - never silently pick an arbitrary directory principal.
 */
export function defaultServicePrincipalId(
  sorted: readonly ServicePrincipalRef[],
  ownAppId?: string,
): string {
  const own = ownAppId !== undefined && ownAppId.trim() !== "" ? ownAppId.trim() : "";
  if (own === "") return "";
  const match = sorted.find((sp) => sp.appId === own);
  return match?.id ?? "";
}

/**
 * Acquire the tenant's service principals through the port and return them in
 * picker order. The only async step is the injected port read; the caller
 * handles a rejection (permission/transport) by falling back to manual entry.
 */
export async function acquireServicePrincipals(
  graph: GraphDirectory,
  ownAppId?: string,
): Promise<ServicePrincipalRef[]> {
  const list = await graph.listServicePrincipals();
  return sortServicePrincipalsForPicker(list, ownAppId);
}
