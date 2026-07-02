/**
 * AzureManagement port: raw access to the Azure Resource Manager (ARM) REST
 * surface. Domain code composes ARM paths and payloads; adapters own the
 * transport.
 *
 * Implementations:
 * - Cloud shell: adapter over the Cribl App Platform's locked fetch, routed
 *   through the app's declared proxies.
 * - Local shell: the Node host performs outbound HTTPS directly.
 *
 * Adapters own authentication end to end: token acquisition, caching, and
 * refresh against Entra ID never surface through this interface. Helpers for
 * ARM long-running operations (202 + polling) arrive in Phase 2; Phase-1
 * callers see raw responses only.
 */

import type { HttpMethod, PortHttpResponse } from './http';

/** A single ARM request. */
export interface AzureManagementRequest {
  /** HTTP verb. */
  method: HttpMethod;
  /**
   * Path relative to the ARM base URL (https://management.azure.com), e.g.
   * "/subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.Insights/dataCollectionRules/{name}".
   * Callers must NOT include a host or the api-version query parameter.
   */
  path: string;
  /** ARM api-version, appended by the adapter as the api-version query parameter. */
  apiVersion: string;
  /** JSON-serializable request body for PUT/POST/PATCH. */
  body?: unknown;
  /** Extra query parameters (api-version is supplied separately). */
  query?: Record<string, string>;
}

/**
 * Minimal ARM client.
 *
 * Error semantics: resolves with `{status, body}` for every HTTP response,
 * including 4xx/5xx ARM errors - callers branch on `status`. Rejects only on
 * transport failure (network error, token acquisition failure).
 */
export interface AzureManagement {
  /** Execute one ARM request. See {@link AzureManagementRequest}. */
  request(opts: AzureManagementRequest): Promise<PortHttpResponse>;
}
