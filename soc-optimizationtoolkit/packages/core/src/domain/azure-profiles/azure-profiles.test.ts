/**
 * Unit tests for the connection-profiles store, grouped by contract:
 *   - round-trip fidelity of the store (profiles + activeProfileId)
 *   - the TOLERANT/TOTAL parse rules (never throws; empty store for junk)
 *   - the SECRET-EXCLUSION invariant carried over from azure-config: a planted
 *     config.clientSecret is stripped by the nested parseAzureConfig
 *   - purity + reassignment rules of the mutating helpers
 *   - active-profile accessors
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE_STORE,
  getActiveConfig,
  getActiveProfile,
  parseProfileStore,
  removeProfile,
  renameProfile,
  serializeProfileStore,
  setActiveProfile,
  updateActiveConfig,
  upsertProfile,
} from "./index";
import type { ConnectionProfile, ProfileStore } from "./index";
import { EMPTY_AZURE_CONFIG } from "../azure-config";
import type { AzureConfig } from "../azure-config";

const CONFIG_A: AzureConfig = {
  clientId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  tenantId: "tttttttt-tttt-tttt-tttt-tttttttttttt",
  subscriptionId: "ssssssss-ssss-ssss-ssss-ssssssssssss",
  resourceGroup: "rg-a",
  workspaceName: "law-a",
  setupPath: "existing",
};

const CONFIG_B: AzureConfig = {
  clientId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  tenantId: "uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "lab-new-rg",
};

const PROFILE_A: ConnectionProfile = { id: "id-a", name: "Prod", config: CONFIG_A };
const PROFILE_B: ConnectionProfile = { id: "id-b", name: "Lab", config: CONFIG_B };

const TWO_PROFILE_STORE: ProfileStore = {
  profiles: [PROFILE_A, PROFILE_B],
  activeProfileId: "id-a",
};

describe("serializeProfileStore / parseProfileStore round-trip", () => {
  it("round-trips a populated store", () => {
    const parsed = parseProfileStore(serializeProfileStore(TWO_PROFILE_STORE));
    expect(parsed).toEqual(TWO_PROFILE_STORE);
  });

  it("round-trips the empty store", () => {
    const parsed = parseProfileStore(serializeProfileStore(EMPTY_PROFILE_STORE));
    expect(parsed).toEqual(EMPTY_PROFILE_STORE);
  });
});

describe("parseProfileStore is tolerant and total (never throws)", () => {
  it("returns an empty store for null / undefined / blank / junk", () => {
    for (const input of [null, undefined, "", "   ", "not json", "[1,2]", "42", "null"]) {
      expect(parseProfileStore(input)).toEqual(EMPTY_PROFILE_STORE);
    }
  });

  it("never returns the shared EMPTY_PROFILE_STORE reference (no mutation risk)", () => {
    const parsed = parseProfileStore(null);
    expect(parsed).not.toBe(EMPTY_PROFILE_STORE);
    parsed.profiles.push(PROFILE_A);
    expect(EMPTY_PROFILE_STORE.profiles).toHaveLength(0);
  });

  it("drops profiles missing a string id or name", () => {
    const raw = JSON.stringify({
      profiles: [
        { id: "keep", name: "Keep", config: CONFIG_A },
        { id: 42, name: "NoId", config: CONFIG_A },
        { id: "noname", config: CONFIG_A },
        "not an object",
      ],
      activeProfileId: "keep",
    });
    const parsed = parseProfileStore(raw);
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0].id).toBe("keep");
    expect(parsed.activeProfileId).toBe("keep");
  });

  it("coerces activeProfileId to null when it matches no kept profile", () => {
    const raw = JSON.stringify({
      profiles: [{ id: "id-a", name: "Prod", config: CONFIG_A }],
      activeProfileId: "does-not-exist",
    });
    expect(parseProfileStore(raw).activeProfileId).toBeNull();
  });

  it("defaults a missing or non-object profile config to the empty config", () => {
    const raw = JSON.stringify({
      profiles: [
        { id: "no-config", name: "NoConfig" },
        { id: "bad-config", name: "BadConfig", config: "nope" },
      ],
      activeProfileId: null,
    });
    const parsed = parseProfileStore(raw);
    expect(parsed.profiles[0].config).toEqual(EMPTY_AZURE_CONFIG);
    expect(parsed.profiles[1].config).toEqual(EMPTY_AZURE_CONFIG);
  });
});

describe("SECRET-EXCLUSION: nested parseAzureConfig strips planted secrets", () => {
  it("strips a clientSecret planted on a profile config", () => {
    const raw = JSON.stringify({
      profiles: [
        {
          id: "id-a",
          name: "Prod",
          config: { ...CONFIG_A, clientSecret: "super-secret", accessToken: "ey.token" },
        },
      ],
      activeProfileId: "id-a",
    });
    const parsed = parseProfileStore(raw);
    expect(parsed.profiles[0].config).toEqual(CONFIG_A);
    expect(Object.keys(parsed.profiles[0].config)).not.toContain("clientSecret");
    expect(JSON.stringify(parsed)).not.toContain("super-secret");
    expect(JSON.stringify(parsed)).not.toContain("ey.token");
  });

  it("does not emit a secret attached to an in-memory config on serialize", () => {
    const polluted: ProfileStore = {
      profiles: [
        {
          id: "id-a",
          name: "Prod",
          config: { ...CONFIG_A, clientSecret: "super-secret" } as unknown as AzureConfig,
        },
      ],
      activeProfileId: "id-a",
    };
    const json = serializeProfileStore(polluted);
    expect(json).not.toContain("super-secret");
    expect(json).not.toContain("clientSecret");
  });
});

describe("mutating helpers are pure (return a new store, never mutate)", () => {
  it("upsertProfile appends a new profile", () => {
    const start: ProfileStore = { profiles: [PROFILE_A], activeProfileId: "id-a" };
    const next = upsertProfile(start, PROFILE_B);
    expect(next).not.toBe(start);
    expect(start.profiles).toHaveLength(1);
    expect(next.profiles.map((p) => p.id)).toEqual(["id-a", "id-b"]);
    expect(next.activeProfileId).toBe("id-a");
  });

  it("upsertProfile replaces an existing profile by id", () => {
    const start: ProfileStore = { profiles: [PROFILE_A], activeProfileId: "id-a" };
    const renamed: ConnectionProfile = { ...PROFILE_A, name: "Renamed" };
    const next = upsertProfile(start, renamed);
    expect(next.profiles).toHaveLength(1);
    expect(next.profiles[0].name).toBe("Renamed");
  });

  it("updateActiveConfig replaces only the active profile's config", () => {
    const next = updateActiveConfig(TWO_PROFILE_STORE, CONFIG_B);
    expect(next.profiles[0].config).toEqual(CONFIG_B);
    expect(next.profiles[1].config).toEqual(CONFIG_B);
    // id-b was already CONFIG_B; assert id-a actually changed away from CONFIG_A.
    expect(next.profiles[0].config).not.toEqual(CONFIG_A);
    expect(TWO_PROFILE_STORE.profiles[0].config).toEqual(CONFIG_A);
  });

  it("updateActiveConfig is a no-op when no profile is active", () => {
    const start: ProfileStore = { profiles: [PROFILE_A], activeProfileId: null };
    const next = updateActiveConfig(start, CONFIG_B);
    expect(next).toEqual(start);
    expect(next.profiles[0].config).toEqual(CONFIG_A);
  });

  it("renameProfile renames the matching profile only", () => {
    const next = renameProfile(TWO_PROFILE_STORE, "id-b", "Lab v2");
    expect(next.profiles[0].name).toBe("Prod");
    expect(next.profiles[1].name).toBe("Lab v2");
    expect(TWO_PROFILE_STORE.profiles[1].name).toBe("Lab");
  });

  it("removeProfile reassigns activeProfileId to the first remaining profile", () => {
    const next = removeProfile(TWO_PROFILE_STORE, "id-a");
    expect(next.profiles.map((p) => p.id)).toEqual(["id-b"]);
    expect(next.activeProfileId).toBe("id-b");
  });

  it("removeProfile nulls activeProfileId when the last profile is removed", () => {
    const start: ProfileStore = { profiles: [PROFILE_A], activeProfileId: "id-a" };
    const next = removeProfile(start, "id-a");
    expect(next.profiles).toHaveLength(0);
    expect(next.activeProfileId).toBeNull();
  });

  it("removeProfile keeps activeProfileId when a non-active profile is removed", () => {
    const next = removeProfile(TWO_PROFILE_STORE, "id-b");
    expect(next.activeProfileId).toBe("id-a");
  });

  it("setActiveProfile selects a known id", () => {
    const start: ProfileStore = { profiles: [PROFILE_A, PROFILE_B], activeProfileId: "id-a" };
    expect(setActiveProfile(start, "id-b").activeProfileId).toBe("id-b");
  });

  it("setActiveProfile ignores an unknown id (no-op)", () => {
    const next = setActiveProfile(TWO_PROFILE_STORE, "ghost");
    expect(next).toEqual(TWO_PROFILE_STORE);
    expect(next.activeProfileId).toBe("id-a");
  });
});

describe("active-profile accessors", () => {
  it("getActiveProfile returns the active profile or null", () => {
    expect(getActiveProfile(TWO_PROFILE_STORE)).toEqual(PROFILE_A);
    expect(getActiveProfile(EMPTY_PROFILE_STORE)).toBeNull();
    expect(
      getActiveProfile({ profiles: [PROFILE_A], activeProfileId: null }),
    ).toBeNull();
  });

  it("getActiveConfig returns the active config or a fresh EMPTY_AZURE_CONFIG", () => {
    expect(getActiveConfig(TWO_PROFILE_STORE)).toEqual(CONFIG_A);
    const empty = getActiveConfig(EMPTY_PROFILE_STORE);
    expect(empty).toEqual(EMPTY_AZURE_CONFIG);
    expect(empty).not.toBe(EMPTY_AZURE_CONFIG);
  });
});
