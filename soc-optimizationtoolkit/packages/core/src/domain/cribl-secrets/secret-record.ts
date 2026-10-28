/**
 * The ONE reader of a GET /system/secrets/:id answer (DBT-187): which record,
 * if any, the answer's `items` holds for the secret id asked about.
 *
 * Two callers read that answer: decideSecretConflict (may ensureTextSecret
 * PATCH a secret its POST conflicted with?) and classifyExistingSecret (what
 * does the onboarding source planner find under its secret id?). Each used to
 * pick the record out of `items` itself, with different rules, so the same
 * answer could be ours to one and unreadable to the other:
 *
 *   entry that is not an object  conflict SKIPPED it; the planner refused,
 *                                but only if it came before the match
 *   two entries with the id      both took the first
 *
 * THE STRICTER RULE WINS, on every shape:
 *
 *   found      `items` is an array of objects, and exactly one has this id
 *   missing    `items` is an array of objects, and none has this id
 *   malformed  `items` is not an array; ANY entry is not an object (wherever
 *              it sits, before or after the match); or more than one entry
 *              has this id
 *
 * Why stricter: a GET by id answers one record. An answer with junk in it, or
 * two records under one id, is not an answer this app understands, and both
 * callers act on the read - one PATCHes a secret, the other plans a create or
 * calls the secret ours. A misread there overwrites or claims a secret another
 * admin owns; a refusal costs only a re-run once the answer is sane. So an
 * unexpected answer is malformed, never quietly reduced to the first match.
 *
 * `missing` is not decided here to mean "absent": the planner reads a 404 as
 * an empty `items` (absent, create it), while a 2xx after a 409 that names no
 * such secret is unreadable to the conflict decision. The reader reports the
 * shape; each caller says what the shape means for it.
 *
 * `detail` reads after "the read" or "the secret read" in a caller's message.
 *
 * Pure: no IO, no Date, no randomness.
 */

export type SecretRecordLookup =
  | { readonly kind: "found"; readonly record: Record<string, unknown> }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly detail: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The record for `secretId` in `items`, the `items` field of a GET
 * /system/secrets/:id answer exactly as received (undefined when the answer
 * had none).
 */
export function findSecretRecord(items: unknown, secretId: string): SecretRecordLookup {
  if (!Array.isArray(items)) return { kind: "malformed", detail: "answered without an items array" };
  if (!items.every(isRecord)) return { kind: "malformed", detail: "has an entry that is not an object" };
  const matches = items.filter((item) => item["id"] === secretId);
  if (matches.length > 1) {
    return { kind: "malformed", detail: `has ${matches.length} entries for secret '${secretId}'` };
  }
  const [record] = matches;
  return record === undefined ? { kind: "missing" } : { kind: "found", record };
}
