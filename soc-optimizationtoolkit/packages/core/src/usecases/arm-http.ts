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
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

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
