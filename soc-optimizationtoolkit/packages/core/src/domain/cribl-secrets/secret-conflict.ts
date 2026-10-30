/**
 * The ONE answer to "POST /system/secrets said 409: may we PATCH it?" (DBT-152).
 *
 * The ensure-secret callers used to PATCH the named secret on any 409 - and
 * deploy-flowlog-pack on a 400 too - without asking who made it. A fixed
 * secret id another admin or app uses was silently replaced, and since DBT-163
 * the PATCH body also stamped it as this app's. Now a 409 is followed by a GET
 * of the secret, and that read is judged here:
 *
 *   patch   the secret's description carries this app's ownership stamp
 *           ({@link stampFor} of {@link APP_ID}, written by buildSecretBody)
 *   refuse  foreign: it does not; unreadable: the read was refused, failed,
 *           or did not name the secret. An unknown owner is not ours.
 *
 * WHY THE STAMP ALONE, not proveOwnership's three signals: these ids
 * (sentinel_client_secret, Azure_vNet_Flowlogs_Secret) are fixed by the
 * destination and pack that reference them, so "the id is in our manifest" is
 * always true and proves nothing, and neither caller keeps a KV record of the
 * write. The stamp is the one signal that separates a secret this app wrote
 * from one an admin made under the same name. It can be copied by hand; that
 * is an admin claiming the secret for the app, which is theirs to do.
 *
 * A 400 is not decided here: it never reaches this module, because it is an
 * error (a malformed body is not a conflict), never an overwrite.
 *
 * Pure: no IO, no Date, no randomness.
 */

import { stampFor } from "../../kit/config-writes/ownership";
import { APP_ID } from "./secret-body";

/** The GET /system/secrets/:id that followed a 409; `null` when the call itself threw. */
export interface SecretConflictRead {
  readonly status: number;
  readonly body: unknown;
}

export type SecretConflictDecision =
  | { readonly kind: "patch" }
  | {
      readonly kind: "refuse";
      readonly reason: "foreign" | "unreadable";
      /** Operator-facing: names the secret id and says it was left unchanged. */
      readonly message: string;
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function unreadable(secretId: string, detail: string): SecretConflictDecision {
  return {
    kind: "refuse",
    reason: "unreadable",
    message: `Cribl secret '${secretId}' already exists and its owner could not be read (${detail}); it was left unchanged.`,
  };
}

/**
 * Decide whether the secret `secretId` that a POST answered 409 for may be
 * PATCHed, from the GET that followed (`null`: the GET threw). Only a 2xx read
 * whose `items` holds an entry with this id and a stamped description is ours.
 */
export function decideSecretConflict(secretId: string, read: SecretConflictRead | null): SecretConflictDecision {
  if (read === null) return unreadable(secretId, "the read failed");
  if (read.status < 200 || read.status >= 300) return unreadable(secretId, `HTTP ${read.status}`);
  const items = isRecord(read.body) ? read.body["items"] : undefined;
  if (!Array.isArray(items)) return unreadable(secretId, "the read answered without an items array");
  const found = items.find((item) => isRecord(item) && item["id"] === secretId) as Record<string, unknown> | undefined;
  if (found === undefined) return unreadable(secretId, `the read named no secret '${secretId}'`);
  const description = found["description"];
  const stamp = stampFor(APP_ID);
  if (typeof description === "string" && description.includes(stamp)) return { kind: "patch" };
  // The evidence is only that the stamp is absent, so the message says that and
  // no more: the secret may be another admin's, or one this app wrote before it
  // stamped its secrets (DBT-163). Either way it is not overwritten.
  return {
    kind: "refuse",
    reason: "foreign",
    message:
      `Cribl secret '${secretId}' already exists and this app cannot show it wrote it ` +
      `(its description carries no ${stamp} stamp); it was left unchanged. ` +
      `If it is yours to replace, delete it in Cribl or add ${stamp} to its description, then run this again.`,
  };
}
