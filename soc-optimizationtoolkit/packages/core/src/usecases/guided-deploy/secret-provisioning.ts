/**
 * Sentinel client-secret provisioning - porting-plan Unit 20 task item 5, and
 * the RESOLVED secret convention (porting-plan "DECISIONS RESOLVED 2026-07-03"
 * item 2).
 *
 * ONE secret-placeholder convention, two delivery paths:
 *
 *   - CONNECTED path: the Cribl Sentinel destination references a NAMED Cribl
 *     secret object, `!{sentinel_client_secret}` (this is
 *     {@link SENTINEL_CLIENT_SECRET_REFERENCE}, the exact string the legacy pack
 *     outputs.yml embedded - pack-builder.ts 2573). The app ENSURES that secret
 *     exists via the Cribl secrets API (POST/PATCH /system/secrets) before the
 *     destination goes live. The real secret is TRANSIENT input, written once to
 *     Cribl, never persisted in job records/artifacts/logs.
 *
 *   - AIR-GAP path: no Cribl to write a secret into, so the exported destination
 *     JSON keeps the literal `<replace me>` placeholder
 *     ({@link SENTINEL_SECRET_PLACEHOLDER} from sentinel-destination) for the
 *     operator to fill in by hand. That placeholder survives ONLY in air-gap
 *     artifacts (see air-gap-export.ts).
 *
 * This module owns the CONNECTED path's request shaping; the air-gap path is
 * just the destination builder's default (omit the secret -> placeholder). Both
 * are tested.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random. The usecase
 * performs the request through the CriblClient port.
 */

import type { CriblRequest } from "../../ports/cribl-client";
import { CRIBL_SECRET_REFERENCE } from "../../domain/pack-assembly";

/** The Cribl secret object name the Sentinel destinations reference. */
export const SENTINEL_CLIENT_SECRET_NAME = "sentinel_client_secret";

/**
 * The reference the destination `secret` field carries on the connected path:
 * `!{sentinel_client_secret}`. Re-exported from pack-assembly's
 * CRIBL_SECRET_REFERENCE so the outputs.yml serializer and this ensure-secret
 * step can never disagree about the name.
 */
export const SENTINEL_CLIENT_SECRET_REFERENCE = CRIBL_SECRET_REFERENCE;

/** Cribl API path for text secrets (porting-plan external surface). */
export const SECRETS_API_PATH = "/system/secrets";

/**
 * Shape the create request for the named Sentinel client secret. Cribl text
 * secrets are created with POST /system/secrets carrying `{ id, type: 'text',
 * value }`; a 409/conflict means the secret already exists and the shell should
 * fall back to {@link buildUpdateSecretRequest} (create-or-update).
 *
 * @param secretValue TRANSIENT client secret - never logged or persisted.
 * @param groupId Optional worker group scope for the secret.
 */
export function buildEnsureSecretRequest(
  secretValue: string,
  groupId?: string,
): CriblRequest {
  const request: CriblRequest = {
    method: "POST",
    path: SECRETS_API_PATH,
    body: {
      id: SENTINEL_CLIENT_SECRET_NAME,
      type: "text",
      value: secretValue,
    },
  };
  if (groupId !== undefined) {
    request.groupId = groupId;
  }
  return request;
}

/**
 * Shape the update request for the named secret (PATCH /system/secrets/{id}),
 * used when {@link buildEnsureSecretRequest} conflicts with an existing secret.
 */
export function buildUpdateSecretRequest(
  secretValue: string,
  groupId?: string,
): CriblRequest {
  const request: CriblRequest = {
    method: "PATCH",
    path: `${SECRETS_API_PATH}/${SENTINEL_CLIENT_SECRET_NAME}`,
    body: {
      id: SENTINEL_CLIENT_SECRET_NAME,
      type: "text",
      value: secretValue,
    },
  };
  if (groupId !== undefined) {
    request.groupId = groupId;
  }
  return request;
}
