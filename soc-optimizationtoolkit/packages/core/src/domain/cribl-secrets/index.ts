/**
 * cribl-secrets domain barrel (DBT-163): the one Cribl text-secret body
 * builder and the app id its ownership stamp names; and (DBT-152) the one
 * decision on whether a secret a create conflicted with may be updated. Pure.
 */

export { APP_ID, buildSecretBody } from "./secret-body";
export type { CriblTextSecretBody } from "./secret-body";
export { decideSecretConflict } from "./secret-conflict";
export type { SecretConflictDecision, SecretConflictRead } from "./secret-conflict";
