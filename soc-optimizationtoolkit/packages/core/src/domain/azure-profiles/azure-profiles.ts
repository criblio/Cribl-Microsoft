/**
 * Connection profiles - MULTI-PROFILE CONFIG STORE.
 *
 * A user can keep several named Azure connections (a lab, a prod tenant, a
 * customer environment) and switch between them. Each profile pairs a stable
 * `id` (minted by the shell - never here) and a display `name` with one
 * non-secret {@link AzureConfig}. The store also tracks which profile is
 * currently active.
 *
 * SECRET-EXCLUSION carries over from azure-config: a profile's config NEVER
 * carries the client secret. The secret lives only in the encrypted, write-only
 * `azureBasic` secrets-store entry, keyed per profile by the shell. Every config
 * that enters this store on parse is run back through {@link parseAzureConfig},
 * so a stray `clientSecret`/`accessToken` planted in a persisted blob is
 * stripped before it can surface.
 *
 * {@link parseProfileStore} is TOLERANT and TOTAL, mirroring parseAzureConfig:
 * any untrusted string (or null/undefined) yields a well-formed
 * {@link ProfileStore}, never throwing. Every mutating helper is PURE - it
 * returns a NEW store and never mutates its input.
 *
 * Pure: no IO, no fetch, no React. NO id generation here (the shell owns ids).
 */

import {
  EMPTY_AZURE_CONFIG,
  parseAzureConfig,
  serializeAzureConfig,
} from "../azure-config";
import type { AzureConfig } from "../azure-config";

/** A single named Azure connection. `id` is minted by the shell, not here. */
export interface ConnectionProfile {
  /** Stable identity of the profile. Opaque; assigned by the shell. */
  id: string;
  /** Human-facing display name. */
  name: string;
  /** The profile's non-secret Azure config. Never carries the client secret. */
  config: AzureConfig;
}

/** The persisted set of profiles plus which one is active. */
export interface ProfileStore {
  /** All known profiles, in insertion order. */
  profiles: ConnectionProfile[];
  /** The active profile's id, or null when none is selected. */
  activeProfileId: string | null;
}

/** The canonical empty store: no profiles, nothing active. */
export const EMPTY_PROFILE_STORE: ProfileStore = {
  profiles: [],
  activeProfileId: null,
};

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fresh empty store; never the shared EMPTY_PROFILE_STORE reference. */
function freshEmptyStore(): ProfileStore {
  return { profiles: [], activeProfileId: null };
}

/**
 * Run a config value back through the azure-config codec so exactly the six
 * known non-secret fields survive and any planted secret is stripped. Accepts
 * an already-typed config (serialize then parse) or an untrusted value pulled
 * from a parsed blob (stringify then parse).
 */
function canonicalizeConfig(config: AzureConfig): AzureConfig {
  return parseAzureConfig(serializeAzureConfig(config));
}

/**
 * Serialize a store to JSON, emitting only the known fields. Each profile's
 * config is canonicalized so a secret attached to an in-memory config object can
 * never be written out.
 */
export function serializeProfileStore(store: ProfileStore): string {
  const canonical: ProfileStore = {
    profiles: store.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      config: canonicalizeConfig(profile.config),
    })),
    activeProfileId: store.activeProfileId,
  };
  return JSON.stringify(canonical);
}

/**
 * Parse an untrusted store blob into a well-formed {@link ProfileStore}.
 *
 * TOLERANT and TOTAL - NEVER throws. Returns a fresh empty store for
 * null/undefined, blank strings, non-JSON text, or JSON that is not a plain
 * object. Profiles are kept only when both `id` and `name` are strings; each
 * kept profile's config is run through {@link parseAzureConfig} (stripping any
 * planted secret and defaulting missing fields). `activeProfileId` is coerced to
 * null unless it matches the id of a kept profile.
 */
export function parseProfileStore(
  raw: string | null | undefined,
): ProfileStore {
  if (typeof raw !== "string" || raw.trim() === "") {
    return freshEmptyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshEmptyStore();
  }

  if (!isPlainObject(parsed)) {
    return freshEmptyStore();
  }

  const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const profiles: ConnectionProfile[] = [];
  for (const entry of rawProfiles) {
    if (!isPlainObject(entry)) {
      continue;
    }
    if (typeof entry.id !== "string" || typeof entry.name !== "string") {
      continue;
    }
    // Stringify the nested config so it re-enters the azure-config codec, which
    // drops any planted clientSecret/accessToken. A non-object config (or a
    // missing one) stringifies to something parseAzureConfig rejects -> EMPTY.
    const config =
      entry.config === undefined
        ? { ...EMPTY_AZURE_CONFIG }
        : parseAzureConfig(JSON.stringify(entry.config));
    profiles.push({ id: entry.id, name: entry.name, config });
  }

  const activeCandidate = parsed.activeProfileId;
  const activeProfileId =
    typeof activeCandidate === "string" &&
    profiles.some((profile) => profile.id === activeCandidate)
      ? activeCandidate
      : null;

  return { profiles, activeProfileId };
}

/**
 * Insert `profile`, or replace the existing profile with the same id. Returns a
 * NEW store; the input is never mutated. `activeProfileId` is unchanged.
 */
export function upsertProfile(
  store: ProfileStore,
  profile: ConnectionProfile,
): ProfileStore {
  const next: ConnectionProfile = {
    id: profile.id,
    name: profile.name,
    config: profile.config,
  };
  const exists = store.profiles.some((p) => p.id === profile.id);
  const profiles = exists
    ? store.profiles.map((p) => (p.id === profile.id ? next : p))
    : [...store.profiles, next];
  return { profiles, activeProfileId: store.activeProfileId };
}

/**
 * Replace the ACTIVE profile's config. No-op (returns the store unchanged) when
 * no profile is active. Returns a NEW store; the input is never mutated.
 */
export function updateActiveConfig(
  store: ProfileStore,
  config: AzureConfig,
): ProfileStore {
  if (store.activeProfileId === null) {
    return store;
  }
  const profiles = store.profiles.map((profile) =>
    profile.id === store.activeProfileId ? { ...profile, config } : profile,
  );
  return { profiles, activeProfileId: store.activeProfileId };
}

/**
 * Rename the profile with `id`. No-op when no profile matches. Returns a NEW
 * store; the input is never mutated.
 */
export function renameProfile(
  store: ProfileStore,
  id: string,
  name: string,
): ProfileStore {
  const profiles = store.profiles.map((profile) =>
    profile.id === id ? { ...profile, name } : profile,
  );
  return { profiles, activeProfileId: store.activeProfileId };
}

/**
 * Remove the profile with `id`. If it was the active profile, `activeProfileId`
 * is reassigned to the first remaining profile, or null when none remain.
 * Returns a NEW store; the input is never mutated.
 */
export function removeProfile(store: ProfileStore, id: string): ProfileStore {
  const profiles = store.profiles.filter((profile) => profile.id !== id);
  let activeProfileId = store.activeProfileId;
  if (activeProfileId === id) {
    activeProfileId = profiles.length > 0 ? profiles[0].id : null;
  }
  return { profiles, activeProfileId };
}

/**
 * Select the profile with `id` as active. No-op (returns the store unchanged)
 * when no profile matches. Returns a NEW store otherwise.
 */
export function setActiveProfile(
  store: ProfileStore,
  id: string,
): ProfileStore {
  if (!store.profiles.some((profile) => profile.id === id)) {
    return store;
  }
  return { profiles: store.profiles, activeProfileId: id };
}

/** The active profile, or null when none is selected / found. */
export function getActiveProfile(store: ProfileStore): ConnectionProfile | null {
  if (store.activeProfileId === null) {
    return null;
  }
  return (
    store.profiles.find((profile) => profile.id === store.activeProfileId) ??
    null
  );
}

/**
 * The active profile's config, or a fresh {@link EMPTY_AZURE_CONFIG} when no
 * profile is active.
 */
export function getActiveConfig(store: ProfileStore): AzureConfig {
  const active = getActiveProfile(store);
  return active ? active.config : { ...EMPTY_AZURE_CONFIG };
}
