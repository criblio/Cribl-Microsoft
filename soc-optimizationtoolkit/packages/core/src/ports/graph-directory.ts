/**
 * GraphDirectory port - the ONE seam for reading Microsoft Entra directory
 * objects (service principals / Enterprise Applications) from shared code. Its
 * only consumer today is the role-assignment step's ingestion-identity picker:
 * instead of typing the ingestion service principal's OBJECT id, the operator
 * picks it from a name-sorted dropdown (their own app's SP first, cribl-named
 * ones next).
 *
 * Adapters (bound by each shell, NOT here):
 * - Cloud shell: graph.microsoft.com through proxies.yml with a Graph-audience
 *   token injected server-side from KV (azureGraphToken); the browser never sets
 *   an Authorization header.
 * - Local shell: the Node host acquires the Graph token and does the fetch.
 *
 * The port is the INTERFACE only; all fetching lives in the shell adapters, so
 * this package stays zero-IO/zero-fetch. Requires the app registration to have
 * the Application.Read.All (or Directory.Read.All) permission consented; without
 * it the directory read is denied and the adapter rejects, so the picker falls
 * back to manual object-id entry (never worse than the plain text field).
 * `readSubscribedSkus` (the data-allowances licence read) needs the separate
 * LicenseAssignment.Read.All application permission; its refusal is returned,
 * not thrown, so the caller can say "not read" instead of "no licences".
 */

/** A service principal (Enterprise Application) as the picker needs it. */
export interface ServicePrincipalRef {
  /**
   * The service principal OBJECT id - exactly what a role assignment's
   * principalId needs (NOT the application/client id; confusing the two is the
   * classic ENG-37 mistake the picker exists to prevent).
   */
  id: string;
  /** The application (client) id of the associated app registration. */
  appId: string;
  /** Display name shown in the dropdown. */
  displayName: string;
}

/**
 * Read-only accessor over the tenant's directory. The single method is async and
 * rejects only on a genuine failure the caller should surface (transport down,
 * auth/permission rejected) - the picker catches and degrades to manual entry.
 */
export interface GraphDirectory {
  /**
   * List the tenant's service principals (Enterprise Applications). An empty
   * tenant resolves `[]`; a permission or transport failure rejects.
   */
  listServicePrincipals(): Promise<ServicePrincipalRef[]>;

  /**
   * Read the tenant's subscribed license SKUs (GET /v1.0/subscribedSkus: SKU
   * id, part number, status, purchased and consumed seats - never who holds
   * them). Resolves `denied` with the HTTP status and detail when Graph
   * refuses (typically 403: LicenseAssignment.Read.All not consented); rejects
   * only on a transport failure. `body` is the raw response, parsed by core.
   */
  readSubscribedSkus(): Promise<
    { kind: "read"; body: unknown } | { kind: "denied"; status: number; detail: string }
  >;
}
