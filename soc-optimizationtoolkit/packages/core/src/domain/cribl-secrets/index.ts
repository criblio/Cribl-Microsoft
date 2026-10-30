/**
 * cribl-secrets domain barrel (DBT-163): the one Cribl text-secret body
 * builder and the app id its ownership stamp names; and (DBT-152) the one
 * decision on whether a secret a create conflicted with may be updated; and
 * (DBT-187) the one reader of a GET /system/secrets/:id answer. Pure.
 */

export { APP_ID, buildSecretBody } from "./secret-body";
export type { CriblTextSecretBody } from "./secret-body";
export { decideSecretConflict } from "./secret-conflict";
export type { SecretConflictDecision, SecretConflictRead } from "./secret-conflict";
export { findSecretRecord } from "./secret-record";
export type { SecretRecordLookup } from "./secret-record";
