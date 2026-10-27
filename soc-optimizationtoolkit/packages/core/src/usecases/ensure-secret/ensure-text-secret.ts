/**
 * ensure-text-secret - the ONE create-or-update of a named Cribl text secret
 * (DBT-152). Shared by the guided-deploy ensure-secret action
 * (ui screens/integrate/wiring-section.tsx, sentinel_client_secret) and the
 * AzureFlowLogs pack finish (provision-lab/deploy-flowlog-pack.ts,
 * Azure_vNet_Flowlogs_Secret). They used to carry two copies of the fallback,
 * and both overwrote whatever answered the 409; one also overwrote on a 400.
 *
 *   1. POST /system/secrets          - the stamped body (buildSecretBody).
 *                                      2xx: created. 409: step 2. Anything
 *                                      else, a 400 included: failed. A 400 is
 *                                      a rejected body, not a conflict.
 *   2. GET  /system/secrets/:id      - who owns the secret that is there?
 *                                      decideSecretConflict judges the read; a
 *                                      read that throws is passed as null.
 *                                      Foreign or unreadable: refused, and
 *                                      nothing is written.
 *   3. PATCH /system/secrets/:id     - only for a secret carrying this app's
 *                                      ownership stamp.
 *
 * The value is TRANSIENT: it is in the POST and PATCH bodies and nowhere else
 * - not in an outcome, a message, or a log line.
 *
 * Not used by create-cribl-source (whose 409 refuses: it never PATCHes) or
 * onboard-table (create-only, DBT-155).
 *
 * A POST or PATCH that throws rejects; the caller owns transport failure.
 * No commit: the callers commit (or not) as they did before.
 */

import type { CriblClient, CriblRequest } from "../../ports/cribl-client";
import { buildSecretBody, decideSecretConflict } from "../../domain/cribl-secrets";
import type { SecretConflictRead } from "../../domain/cribl-secrets";
import { is2xx } from "../arm-http";

export interface EnsureTextSecretInput {
  /** Worker group scope; omitted addresses the leader. */
  readonly groupId?: string;
  /** The secret id, e.g. sentinel_client_secret. */
  readonly id: string;
  /** TRANSIENT secret value - never logged or persisted. */
  readonly value: string;
  /** The human description; buildSecretBody appends the ownership stamp. */
  readonly description: string;
}

export type EnsureTextSecretOutcome =
  | { readonly kind: "created"; readonly secretId: string }
  | { readonly kind: "updated"; readonly secretId: string }
  /** A 409, and the secret there is not provably ours. Nothing was written. */
  | {
      readonly kind: "refused";
      readonly reason: "foreign" | "unreadable";
      readonly secretId: string;
      readonly message: string;
    }
  /** The create (any non-2xx but 409) or the update answered an error. */
  | {
      readonly kind: "failed";
      readonly step: "create" | "update";
      readonly status: number;
      readonly secretId: string;
      readonly message: string;
    };

function scoped(request: CriblRequest, groupId: string | undefined): CriblRequest {
  return groupId === undefined ? request : { ...request, groupId };
}

/** Create the named text secret, or update it only when it is provably this app's. */
export async function ensureTextSecret(
  cribl: CriblClient,
  input: EnsureTextSecretInput,
): Promise<EnsureTextSecretOutcome> {
  const secretId = input.id;
  const body = buildSecretBody({ id: secretId, value: input.value, description: input.description });
  const one = `/system/secrets/${encodeURIComponent(secretId)}`;

  const create = await cribl.request(scoped({ method: "POST", path: "/system/secrets", body }, input.groupId));
  if (is2xx(create.status)) return { kind: "created", secretId };
  if (create.status !== 409) {
    return {
      kind: "failed",
      step: "create",
      status: create.status,
      secretId,
      message: `store Cribl secret '${secretId}': HTTP ${create.status} ${JSON.stringify(create.body)}`,
    };
  }

  let read: SecretConflictRead | null;
  try {
    read = await cribl.request(scoped({ method: "GET", path: one }, input.groupId));
  } catch {
    read = null;
  }
  const decision = decideSecretConflict(secretId, read);
  if (decision.kind === "refuse") {
    return { kind: "refused", reason: decision.reason, secretId, message: decision.message };
  }

  const update = await cribl.request(scoped({ method: "PATCH", path: one, body }, input.groupId));
  if (is2xx(update.status)) return { kind: "updated", secretId };
  return {
    kind: "failed",
    step: "update",
    status: update.status,
    secretId,
    message: `update Cribl secret '${secretId}': HTTP ${update.status} ${JSON.stringify(update.body)}`,
  };
}
