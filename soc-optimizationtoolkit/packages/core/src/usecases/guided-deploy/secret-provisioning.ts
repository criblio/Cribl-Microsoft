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
 *     exists via the Cribl secrets API before the destination goes live, through
 *     ensureTextSecret (usecases/ensure-secret, DBT-152): POST, and on a 409
 *     PATCH only a secret carrying this app's ownership stamp. The real secret
 *     is TRANSIENT input, written once to Cribl, never persisted in job
 *     records/artifacts/logs.
 *
 *   - AIR-GAP path: no Cribl to write a secret into, so the exported destination
 *     JSON keeps the literal `<replace me>` placeholder
 *     ({@link SENTINEL_SECRET_PLACEHOLDER} from sentinel-destination) for the
 *     operator to fill in by hand. That placeholder survives ONLY in air-gap
 *     artifacts (see air-gap-export.ts).
 *
 * This module owns the CONNECTED path's NAMES (secret id, reference,
 * description); ensureTextSecret owns the requests and the body. It used to
 * shape the POST and the PATCH here too, and the PATCH went out on any 409
 * with no ownership check (DBT-152). The air-gap path is just the destination
 * builder's default (omit the secret -> placeholder). Both are tested.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

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

/**
 * The description the named secret is written with; buildSecretBody (inside
 * ensureTextSecret) appends the app's ownership stamp to it (DBT-163), and a
 * later 409 updates the secret only when that stamp is there (DBT-152).
 */
export const SENTINEL_CLIENT_SECRET_DESCRIPTION = "Client secret for the Sentinel destinations";
