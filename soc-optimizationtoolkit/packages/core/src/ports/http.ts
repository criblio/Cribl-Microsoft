/**
 * Shared HTTP primitives used by the outbound-call ports (AzureManagement,
 * CriblClient). Kept minimal on purpose: ports describe intent, adapters own
 * transport details.
 */

/** HTTP verbs supported by the Phase-1 request ports. */
export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

/**
 * A raw HTTP-style response surfaced through a port.
 *
 * Ports resolve with this shape for ANY HTTP response the upstream service
 * returned, including 4xx/5xx. Callers inspect `status`; ports only reject on
 * transport-level failures (network unreachable, credential acquisition
 * failure, request never sent).
 */
export interface PortHttpResponse {
  /** HTTP status code as returned by the upstream service. */
  status: number;
  /** Parsed response body (JSON when the service returns JSON), or null/undefined when empty. */
  body: unknown;
}
