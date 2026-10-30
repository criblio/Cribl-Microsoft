/**
 * ensure-secret usecase barrel (DBT-152): the one create-or-update of a named
 * Cribl text secret, which updates only a secret this app provably owns.
 */

export { ensureTextSecret } from "./ensure-text-secret";
export type { EnsureTextSecretInput, EnsureTextSecretOutcome } from "./ensure-text-secret";
