/**
 * ARM/HTTP idioms - the ONE home for the micro-helpers every usecase needs
 * when talking to ARM (or any HTTP surface) through a port. Before this
 * module existed the same six functions were copy-pasted across a dozen
 * usecase files (is2xx twelve times, prop fourteen); the greppable
 * error-text CONVENTION now lives here, stated once.
 *
 * These are usecase-layer helpers: domain modules stay dependency-free and
 * keep their own tiny local coercions by design (purity over DRY at that
 * layer). update-dcr keeps a local `prop` on purpose - its variant excludes
 * arrays, a different contract.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto. The one exception in
 * spirit is {@link safeAzureManagement}, which performs no IO itself but
 * wraps the port that does, so its callers cannot be reached by a rejection.
 */

import type {
  AzureManagement,
  AzureManagementRequest,
} from "../ports/azure-management";
import type { PortHttpResponse } from "../ports/http";

/** True for any 2xx HTTP status. */
export function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Read a property of an unknown value, or undefined when not an object. */
export function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Coerce an unknown field to a string, '' for anything not a string. */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Render an HTTP failure as raw, greppable error text:
 * `<context>: HTTP <status> <json body>`. The body is stringified verbatim
 * so ARM's error.code/error.message stay searchable in run logs.
 */
export function httpErrorText(context: string, status: number, body: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(body);
  } catch {
    raw = String(body);
  }
  return `${context}: HTTP ${status} ${raw ?? ""}`.trim();
}

/**
 * Extract the ARM error code from a response body. ARM errors arrive as
 * `{ error: { code, message } }`; some proxies flatten to `{ code }`.
 * Returns '' when no code is present.
 */
export function armErrorCode(body: unknown): string {
  const code = asString(prop(prop(body, "error"), "code"));
  return code !== "" ? code : asString(prop(body, "code"));
}

/** Case-insensitive ARM error-code comparison. */
export function isErrorCode(body: unknown, expected: string): boolean {
  return armErrorCode(body).toLowerCase() === expected.toLowerCase();
}

/**
 * Merge the tags already on a resource (from its GET body) with desired
 * tags; the desired tags win on conflict, non-string existing values drop.
 */
export function mergedTags(
  existingBody: unknown,
  desired: Record<string, string>,
): Record<string, string> {
  const existing = prop(existingBody, "tags");
  const merged: Record<string, string> = {};
  if (typeof existing === "object" && existing !== null) {
    for (const [key, value] of Object.entries(existing as Record<string, unknown>)) {
      if (typeof value === "string") {
        merged[key] = value;
      }
    }
  }
  return { ...merged, ...desired };
}

/**
 * The outcome of ONE ARM call made through {@link SafeAzureManagement}:
 * either the response the transport produced, or the text of the reason it
 * produced none.
 *
 * A non-2xx ANSWER is `ok: true` - ARM said something, and the caller branches
 * on `status` exactly as before. `ok: false` means there is no answer at all
 * (dropped socket, DNS, an expired token, a proxy that throws). Blurring the
 * two would be worse than the convention this replaces: "ARM refused" and "ARM
 * was never reached" are different operator actions.
 */
export type ArmAttempt =
  | { ok: true; response: PortHttpResponse }
  | { ok: false; error: string };

/**
 * DBT-56: an ARM view that CANNOT reject, so the never-rejects contract
 * documented on onboardBatch stops being a convention retyped at every
 * call site.
 *
 * It was prose plus a habit: FOUR try blocks around the batch's ARM calls, and
 * DBT-48 existed because one call had been added without one. The measurement
 * that motivated this (2026-09-01): with the ensure-dce, associate-ampls and
 * per-table guards made transparent to a rejection - exactly what a call site
 * added without a guard looks like - the whole core suite still passed, 3511
 * tests. Only the fetch-workspace call was pinned, and only because it is the
 * FIRST call, so a transport that rejects on everything can never reach the
 * six behind it.
 *
 * As a TYPE the omission is a compile error: an {@link ArmAttempt} has no
 * `.status`, so nothing reaches a response without naming what happens when
 * there is none.
 *
 * WHAT IT DOES NOT DO: it does not make throwing impossible in its callers.
 * The batch's StepFailure is still raised deliberately and still needs its
 * enclosing guard, and the child `onboardTable` call is not an ARM call and
 * carries its own rejection shape. It removes ONE class of escape - the
 * transport's - which is the class that produced DBT-48.
 *
 * Deliberately NOT a superset of {@link AzureManagement}: no `requestUrl`,
 * because the batch makes no paginated ARM calls and a view offering a method
 * nobody needs is an invitation to reach for the unsafe one.
 *
 * DBT-74: content-install uses it too, for its single-request installs
 * (onboarding, rules, workbooks, parsers, solutions). Its own `ok` is a
 * DIFFERENT word - "the step succeeded", decided by is2xx above this view -
 * so a 403 is an ArmAttempt `ok: true` and a content-install `ok: false`.
 * Its paginated listings still need `requestUrl` and keep their own guards.
 */
export interface SafeAzureManagement {
  /** Execute one ARM request. Never rejects; see {@link ArmAttempt}. */
  request(opts: AzureManagementRequest): Promise<ArmAttempt>;
}

/**
 * Compose the never-rejecting view over an {@link AzureManagement} (in
 * onboardBatch: over the PACED port, so the safe view inherits the budget).
 */
export function safeAzureManagement(
  azure: AzureManagement,
): SafeAzureManagement {
  return {
    request: async (opts: AzureManagementRequest): Promise<ArmAttempt> => {
      try {
        return { ok: true, response: await azure.request(opts) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
