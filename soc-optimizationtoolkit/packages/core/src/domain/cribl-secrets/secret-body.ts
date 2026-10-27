/**
 * The ONE Cribl text-secret body builder (DBT-163).
 *
 * Every POST /system/secrets and PATCH /system/secrets/:id body the app sends
 * is built here: the onboarding source (create-cribl-source), the Sentinel
 * destination client secret (onboard-table), and ensureTextSecret
 * (usecases/ensure-secret, DBT-152), which carries both the guided-deploy
 * ensure-secret and the AzureFlowLogs pack collector secret
 * (deploy-flowlog-pack). There were three builders and
 * only the onboarding one stamped ownership; DBT-151 had to fix `secretType`
 * in each of them separately. secret-body-scan.test.ts holds the line.
 *
 * `secretType`, NEVER `type`: RestSecret requires `id` and `secretType`
 * (packages/core/assets/cribl-openapi.json RestSecret.required).
 *
 * The description carries the kit's ownership stamp for {@link APP_ID}, which
 * classify-existing.ts proveOwnership reads (kit/config-writes/ownership.ts,
 * config-plane-writes rule 11). A secret written without it can never be
 * proven to be this app's.
 *
 * Pure: no IO, no Date, no randomness, no crypto.
 */

import { stampDescription } from "../../kit/config-writes/ownership";

/**
 * The app id the description stamp names: the cribl-app package name
 * (apps/cribl-app/package.json "name"). Changing it orphans every object
 * already stamped, so it is a constant, not configuration.
 */
export const APP_ID = "soc-optimizationtoolkit";

/** A Cribl text-secret body, as POST and PATCH /system/secrets take it. */
export interface CriblTextSecretBody {
  id: string;
  secretType: "text";
  value: string;
  description: string;
}

/**
 * The text-secret body for POST /system/secrets and PATCH
 * /system/secrets/:id. THE ONLY BODY THAT CARRIES A CREDENTIAL. `secretType`,
 * never `type` (RestSecret.required); the description is stamped with
 * {@link APP_ID}.
 */
export function buildSecretBody(spec: {
  readonly id: string;
  readonly value: string;
  readonly description: string;
}): CriblTextSecretBody {
  return {
    id: spec.id,
    secretType: "text",
    value: spec.value,
    description: stampDescription(spec.description, APP_ID),
  };
}
