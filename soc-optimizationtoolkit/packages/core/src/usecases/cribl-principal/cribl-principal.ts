/**
 * The Cribl service principal: tie its client id to its object id through the
 * Entra directory, and refuse this app's own principal (ADR 0008 section 2).
 *
 * ONE PLACE for two callers. The Cribl source plan (plan-cribl-source) reads
 * the receive role for an OBJECT id while the input signs in as a CLIENT id,
 * so it cross-checks the pair ({@link crossCheckPrincipal}, moved here
 * unchanged from that file). The Data Receiver grant (AZR-103) assigns the
 * role to an object id, and may have to find it from the client id
 * ({@link resolveCriblPrincipal}).
 *
 * NEVER A GUESS. No directory, a refused read, or a listing that does not
 * hold the client id (it may be truncated, or the principal may live in
 * another tenant) is "not cross-checked" for a typed object id, and
 * "unresolved" when there is no object id to fall back on - never a match and
 * never an object id the app made up.
 *
 * Pure orchestration over the optional GraphDirectory port: no IO of its own.
 */

import type { GraphDirectory, ServicePrincipalRef } from "../../ports/graph-directory";
import { isGuid } from "../../domain/name-based-guid/name-based-guid";

/** Whether the directory confirmed the client id and object id are one principal. */
export type PrincipalCheck = "matched" | "not-cross-checked";

/** Why a principal is refused. */
export type PrincipalRefusalReason = "principal-mismatch" | "app-principal";

/**
 * Tie the client id the input signs in as to the object id whose role the
 * plan reads, through the directory (AZR-59 review). A directory entry for the
 * client id with ANOTHER object id refuses; the object id being this app's own
 * service principal refuses. No directory, a refused read, or a client id the
 * listing does not hold (it may be truncated, or the principal may live in
 * another tenant) is "not-cross-checked", never a match.
 *
 * `appClientId` is trimmed and lower-cased by the caller; empty means unknown.
 */
export async function crossCheckPrincipal(
  graph: GraphDirectory | undefined,
  clientId: string,
  objectId: string,
  appClientId: string,
): Promise<
  | { readonly kind: "ok"; readonly check: PrincipalCheck }
  | { readonly kind: "refused"; readonly reason: PrincipalRefusalReason; readonly detail: string }
> {
  if (graph === undefined) return { kind: "ok", check: "not-cross-checked" };
  let sps: readonly ServicePrincipalRef[];
  try {
    sps = await graph.listServicePrincipals();
  } catch {
    return { kind: "ok", check: "not-cross-checked" };
  }
  return crossCheckAgainst(sps, clientId, objectId, appClientId);
}

const lc = (v: string): string => v.trim().toLowerCase();

function crossCheckAgainst(
  sps: readonly ServicePrincipalRef[],
  clientId: string,
  objectId: string,
  appClientId: string,
):
  | { readonly kind: "ok"; readonly check: PrincipalCheck }
  | { readonly kind: "refused"; readonly reason: PrincipalRefusalReason; readonly detail: string } {
  const obj = lc(objectId);
  if (appClientId !== "" && sps.some((sp) => lc(sp.appId) === appClientId && lc(sp.id) === obj)) {
    return {
      kind: "refused",
      reason: "app-principal",
      detail:
        `Object ID ${objectId} is this app's own service principal. Its secret in a Cribl secret would give the worker group ` +
        "this app's Azure rights; use a service principal dedicated to Cribl.",
    };
  }
  const byClient = sps.find((sp) => lc(sp.appId) === lc(clientId));
  if (byClient === undefined) return { kind: "ok", check: "not-cross-checked" };
  if (lc(byClient.id) !== obj) {
    return {
      kind: "refused",
      reason: "principal-mismatch",
      detail:
        `Client ID ${clientId} belongs to the service principal with object ID ${byClient.id}, not ${objectId}. ` +
        "The role would be checked for one principal while the source signs in as another. " +
        "Set the Cribl principal object ID in the plan values to the one that matches the client ID.",
    };
  }
  return { kind: "ok", check: "matched" };
}

/** How the Data Receiver grant came by the object id it assigns the role to. */
export type PrincipalSource =
  /** Typed in the plan values, and the directory confirmed it belongs to the client id. */
  | "typed-matched"
  /** Typed in the plan values; the directory could not confirm it (said in the confirm). */
  | "typed-not-cross-checked"
  /** Not typed: the directory listed exactly one service principal for the client id. */
  | "directory";

/** What {@link resolveCriblPrincipal} returns. */
export type ResolvedCriblPrincipal =
  | {
      readonly kind: "resolved";
      readonly objectId: string;
      readonly source: PrincipalSource;
      /** The directory's display name, when it listed the principal. */
      readonly displayName: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: PrincipalRefusalReason | "principal-unresolved" | "principal-invalid";
      readonly detail: string;
    };

/** Where an operator finds the object id, for the unresolved copy. */
const WHERE_OBJECT_ID =
  "Enter it as the Cribl service principal object ID in the plan values (Microsoft Entra ID, Enterprise applications, the Cribl application, Object ID).";

/**
 * The object id the Data Receiver grant assigns the role to (AZR-103).
 *
 *   - A typed object id must be a GUID; it is then cross-checked against the
 *     client id exactly as the Cribl source plan does
 *     ({@link crossCheckPrincipal}), with the same refusals.
 *   - A blank object id is looked up by client id in the directory. Exactly
 *     one listed service principal resolves it; anything else - no
 *     directory, a refused read, no match, more than one - is
 *     `principal-unresolved` with the reason, and nothing is guessed.
 *   - This app's own registration (by client id, or by object id when the
 *     directory lists it) is refused on every path.
 *
 * `appClientId` is this app's own client id (any case; empty when unknown).
 * Never throws: a rejected directory read is an answer, not an error.
 */
export async function resolveCriblPrincipal(
  graph: GraphDirectory | undefined,
  input: { readonly objectId: string; readonly clientId: string; readonly appClientId: string },
): Promise<ResolvedCriblPrincipal> {
  const objectId = input.objectId.trim();
  const clientId = input.clientId.trim();
  const appClientId = lc(input.appClientId);
  if (appClientId !== "" && lc(clientId) === appClientId) {
    return {
      kind: "refused",
      reason: "app-principal",
      detail:
        `Client ID ${clientId} is this app's own registration. Granting it the receive role would let this app's ` +
        "identity read the hub as Cribl; use a service principal dedicated to Cribl.",
    };
  }
  if (objectId !== "" && !isGuid(objectId)) {
    return {
      kind: "refused",
      reason: "principal-invalid",
      detail: `The Cribl service principal object ID "${objectId}" is not a GUID, so it cannot be assigned a role.`,
    };
  }
  if (objectId === "" && clientId === "") {
    return {
      kind: "refused",
      reason: "principal-unresolved",
      detail: `The Cribl service principal's object ID is not known: neither it nor its client ID is in the plan values. ${WHERE_OBJECT_ID}`,
    };
  }

  let sps: readonly ServicePrincipalRef[] | null = null;
  let unread = "";
  if (graph === undefined) {
    unread = "the directory cannot be read from this app";
  } else {
    try {
      sps = await graph.listServicePrincipals();
    } catch (error) {
      unread = `the directory read was refused or failed (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  if (objectId !== "") {
    if (sps === null) {
      return { kind: "resolved", objectId, source: "typed-not-cross-checked", displayName: "" };
    }
    const tie = clientId === "" ? null : crossCheckAgainst(sps, clientId, objectId, appClientId);
    if (tie?.kind === "refused") return { kind: "refused", reason: tie.reason, detail: tie.detail };
    // With no client id there is nothing to tie, but this app's own principal
    // is still refused when the directory lists it.
    if (tie === null && appClientId !== "" && sps.some((sp) => lc(sp.appId) === appClientId && lc(sp.id) === lc(objectId))) {
      return {
        kind: "refused",
        reason: "app-principal",
        detail: `Object ID ${objectId} is this app's own service principal; use a service principal dedicated to Cribl.`,
      };
    }
    const listed = sps.find((sp) => lc(sp.id) === lc(objectId));
    return {
      kind: "resolved",
      objectId,
      source: tie?.kind === "ok" && tie.check === "matched" ? "typed-matched" : "typed-not-cross-checked",
      displayName: listed?.displayName ?? "",
    };
  }

  // No object id: look it up by client id, or say why it cannot be.
  if (sps === null) {
    return {
      kind: "refused",
      reason: "principal-unresolved",
      detail: `The object ID of client ID ${clientId} could not be looked up: ${unread}. ${WHERE_OBJECT_ID}`,
    };
  }
  const matches = sps.filter((sp) => lc(sp.appId) === lc(clientId));
  if (matches.length !== 1) {
    return {
      kind: "refused",
      reason: "principal-unresolved",
      detail:
        (matches.length === 0
          ? `The directory listing holds no service principal for client ID ${clientId} (it may live in another tenant, or the listing may be incomplete). `
          : `The directory listing holds ${matches.length} service principals for client ID ${clientId}, so which one is meant is not known. `) +
        WHERE_OBJECT_ID,
    };
  }
  const only = matches[0] as ServicePrincipalRef;
  return { kind: "resolved", objectId: only.id, source: "directory", displayName: only.displayName };
}
