/**
 * KV KEY GUARD (AZR-125) - every app KV document key the code reads and writes
 * is named by the least-privilege inventory's cribl.kv.read and cribl.kv.write
 * audit lists.
 *
 * Three keys (azure-onboarding-flow-last-seen, azure-credential-lease,
 * azure-credential-owner) and, found while pinning them, a fourth
 * (tenant-cribl-mapping) were missing because the lists are prose copied from
 * a dated audit and nothing tied them to the constants the code uses.
 *
 * WHERE THE KEYS COME FROM. There is no registry of KV keys in the code: each
 * document's key is a `*_KEY` string constant exported from its own domain
 * module and re-exported from the @soc/core barrel. So the source this guard
 * derives from is the BARREL ITSELF - every exported string constant whose
 * name ends in `_KEY` - not a list kept beside it. A new key constant fails
 * the second pin until it is either named by the audit lists (and so here) or
 * listed in NOT_KV_DOCUMENT_KEYS with the reason it is not a KV document key.
 *
 * DERIVED KEYS (review round 1). The tenant-scoped documents (ADR 0009) also
 * have a one-time migration claim, `{base}-migrated` (tenantMigrationClaimKey),
 * which loadTenantDocument reads and writes. Those are not `*_KEY` constants,
 * so the guard derives them from TENANT_SCOPED_BASES through the same function
 * the code uses. The per-tenant `{base}.{tenantId}` keys are covered by the
 * addendum's note rather than by name, since the tenant id is runtime data.
 *
 * WHAT IT CANNOT SEE: a key spelled inline rather than as an exported `*_KEY`
 * constant, and keys owned by @soc/ui (appTheme, which the list names) or the
 * shell (the secret keys, which it names too). Keys that go through
 * ContentCache are stored under content-cache-<hex> and named by that row.
 */
import { describe, expect, it } from "vitest";

import * as core from "../../index";
import { LEAST_PRIVILEGE_OPERATIONS } from "./operations";

/**
 * Barrel `*_KEY` string constants that are NOT app KV document keys, each with
 * why. Everything else ending in `_KEY` must be in both audit lists.
 */
const NOT_KV_DOCUMENT_KEYS: Readonly<Record<string, string>> = {
  CAPABILITY_AUDIT_CACHE_KEY:
    "a ContentCache key; the shell stores it under content-cache-<hex>, which the lists name as content-cache-*",
  TOOLKIT_MARKER_KEY: "a field the toolkit stamps on Cribl objects it writes, not a KV key",
  FLOW_EVENTS_KEY: "a metric field name in the onboarding flow query, not a KV key",
};

/**
 * The document keys stored per tenant through loadTenantDocument (ADR 0009):
 * the only callers pass these two (azure-onboarding-screen.tsx), and each
 * one's migration claim is a KV document of its own.
 */
const TENANT_SCOPED_BASES = ["COVERAGE_SELECTION_KEY", "ONBOARDING_PROGRESS_KEY"] as const;

/** The barrel's exported `*_KEY` string constants, by export name. */
function barrelKeyConstants(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(core)) {
    if (/_KEY$/.test(name) && typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * The app KV document keys: the barrel's `*_KEY` constants less the exclusions,
 * plus each tenant-scoped base's migration claim (named `claim(BASE)`).
 */
function kvDocumentKeys(): Record<string, string> {
  const constants = barrelKeyConstants();
  const claims = TENANT_SCOPED_BASES.map((name) => [
    `claim(${name})`,
    core.tenantMigrationClaimKey(constants[name] ?? `missing ${name}`),
  ]);
  return Object.fromEntries([
    ...Object.entries(constants).filter(([name]) => NOT_KV_DOCUMENT_KEYS[name] === undefined),
    ...claims,
  ]);
}

/** Every key an audit list names: the text after " - " in each cited row, split on commas and semicolons. */
function namedKeys(id: "cribl.kv.read" | "cribl.kv.write"): Set<string> {
  const names = new Set<string>();
  for (const row of LEAST_PRIVILEGE_OPERATIONS[id].audit) {
    const list = row.slice(row.indexOf(" - ") + 3);
    for (const part of list.split(/[,;]/)) {
      names.add(part.replace(/\(encrypted\)/, "").trim());
    }
  }
  return names;
}

describe("app KV document keys against the least-privilege audit lists (AZR-125)", () => {
  it("derives exactly the known document keys from the barrel", () => {
    // Pinned so the derivation itself cannot quietly go empty and pass.
    expect(kvDocumentKeys()).toEqual({
      COVERAGE_SELECTION_KEY: "azure-coverage-selection",
      CREDENTIAL_LEASE_KEY: "azure-credential-lease",
      CREDENTIAL_OWNER_KEY: "azure-credential-owner",
      FLOW_LAST_SEEN_KEY: "azure-onboarding-flow-last-seen",
      ONBOARDING_PROGRESS_KEY: "azure-onboarding-progress",
      TENANT_CRIBL_MAPPING_KEY: "tenant-cribl-mapping",
      TENANT_GAP_READS_KEY: "tenant-gap-reads",
      "claim(COVERAGE_SELECTION_KEY)": "azure-coverage-selection-migrated",
      "claim(ONBOARDING_PROGRESS_KEY)": "azure-onboarding-progress-migrated",
    });
  });

  it("lists in NOT_KV_DOCUMENT_KEYS only constants the barrel still exports", () => {
    const exported = barrelKeyConstants();
    expect(Object.keys(NOT_KV_DOCUMENT_KEYS).filter((name) => exported[name] === undefined)).toEqual([]);
  });

  for (const id of ["cribl.kv.read", "cribl.kv.write"] as const) {
    it(`names every document key in ${id}`, () => {
      const named = namedKeys(id);
      const missing = Object.entries(kvDocumentKeys())
        .filter(([, key]) => !named.has(key))
        .map(([name, key]) => `${name} (${key})`);
      expect(missing).toEqual([]);
    });
  }
});
