/**
 * A VERDICT-RETURNING ARM pager for the Azure Logging Map (AZR-19).
 *
 * WHY NOT `listAllPages`. The shared pager in `../azure-discovery` THROWS on
 * a bad page (non-2xx, or since DBT-148 a 2xx body with no array `value`) and
 * otherwise returns only the concatenated `value` items. The logging map needs
 * a VERDICT rather than a throw: it mints a verified zero from a completed
 * per-scope read (`toListingFromRead` in `domain/logging-map/list-read.ts`)
 * and must classify every failure (http / transport / unexpected-shape /
 * too-many-pages) to count it as unknown, without try/catch at every scope.
 * Both refuse a nextLink they cannot follow (`listAllPages` throws since
 * DBT-160). The two pagers are deliberately kept separate.
 *
 * THE CONTRACT of {@link readAllPages}:
 * - every page is checked with is2xx; a non-2xx is refused `http`, carrying
 *   the ARM error code and greppable error text;
 * - EVERY page body must carry an array `value`; otherwise the read is refused
 *   `unexpected-shape` and the rows of earlier pages are DISCARDED - a partial
 *   list is never returned as if it were whole;
 * - `nextLink` is followed via the optional `requestUrl` port method; when a
 *   nextLink exists and the adapter has no `requestUrl`, the read is refused
 *   `too-many-pages` with text "pagination unavailable" (the first page alone
 *   would be an undercount presented as complete);
 * - at most {@link MAX_LIST_PAGES} pages IN TOTAL are read (the shared
 *   constant; note `listAllPages` counts nextLinks FOLLOWED, one more page);
 *   a longer chain is refused `too-many-pages`;
 * - any rejection of the port is caught and refused `transport`. It never
 *   throws.
 *
 * Usecase layer: it imports `../arm-http` (domain code may not).
 */

import type {
  AzureManagement,
  AzureManagementRequest,
} from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import {
  readRefused,
  readRows,
  type ListRead,
  type Refusal,
  type RefusalReason,
} from "../../domain/logging-map/list-read";
import { armErrorCode, asString, httpErrorText, is2xx, prop } from "../arm-http";
import { MAX_LIST_PAGES } from "../azure-discovery";

/** The request as one greppable string: its path and its query. */
export function describeRequest(request: AzureManagementRequest): string {
  const query = request.query ?? {};
  const keys = Object.keys(query);
  if (keys.length === 0) return request.path;
  const qs = keys.map((k) => `${k}=${query[k] ?? ""}`).join("&");
  return `${request.path}?${qs}`;
}

function refusal(
  request: string,
  reason: RefusalReason,
  status: number | null,
  code: string,
  text: string,
): Refusal {
  return { request, status, code, text, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Attempt =
  | { readonly ok: true; readonly response: PortHttpResponse }
  | { readonly ok: false; readonly error: string };

async function attempt(call: () => Promise<PortHttpResponse>): Promise<Attempt> {
  try {
    return { ok: true, response: await call() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Read every page of an ARM list. See the module header for the contract.
 * `context` prefixes every error text (e.g. "policy assignments at <scope>").
 */
export async function readAllPages(
  azure: AzureManagement,
  request: AzureManagementRequest,
  context: string,
): Promise<ListRead<unknown>> {
  const described = describeRequest(request);
  const rows: unknown[] = [];
  let pages = 0;
  let next: (() => Promise<PortHttpResponse>) | null = () => azure.request(request);
  let currentLabel = described;

  while (next !== null) {
    if (pages >= MAX_LIST_PAGES) {
      return readRefused(
        refusal(
          described,
          "too-many-pages",
          null,
          "",
          `${context}: more than ${MAX_LIST_PAGES} pages - refusing to follow further`,
        ),
      );
    }
    pages += 1;
    const pageContext = pages === 1 ? context : `${context} (page ${pages})`;
    const a = await attempt(next);
    if (!a.ok) {
      return readRefused(refusal(currentLabel, "transport", null, "", `${pageContext}: ${a.error}`));
    }
    const { status, body } = a.response;
    if (!is2xx(status)) {
      return readRefused(
        refusal(currentLabel, "http", status, armErrorCode(body), httpErrorText(pageContext, status, body)),
      );
    }
    const value = prop(body, "value");
    if (!Array.isArray(value)) {
      return readRefused(
        refusal(
          currentLabel,
          "unexpected-shape",
          status,
          "",
          `${pageContext}: HTTP ${status} body has no array 'value'`,
        ),
      );
    }
    rows.push(...(value as unknown[]));
    const nextLink = asString(prop(body, "nextLink"));
    if (nextLink === "") {
      next = null;
    } else {
      const requestUrl = azure.requestUrl?.bind(azure);
      if (requestUrl === undefined) {
        return readRefused(
          refusal(described, "too-many-pages", status, "", `${context}: pagination unavailable`),
        );
      }
      currentLabel = nextLink;
      next = () => requestUrl({ method: "GET", url: nextLink });
    }
  }
  return readRows(rows);
}

/**
 * Read ONE resource with the same verdict shape: a 2xx whose body is an
 * object is `read` with that body as its single row; a non-object body is
 * `unexpected-shape`; a non-2xx is `http`; a rejection is `transport`.
 */
export async function readSingle(
  azure: AzureManagement,
  request: AzureManagementRequest,
  context: string,
): Promise<ListRead<unknown>> {
  const described = describeRequest(request);
  const a = await attempt(() => azure.request(request));
  if (!a.ok) return readRefused(refusal(described, "transport", null, "", `${context}: ${a.error}`));
  const { status, body } = a.response;
  if (!is2xx(status)) {
    return readRefused(
      refusal(described, "http", status, armErrorCode(body), httpErrorText(context, status, body)),
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return readRefused(
      refusal(described, "unexpected-shape", status, "", `${context}: HTTP ${status} body is not an object`),
    );
  }
  return readRows([body]);
}
