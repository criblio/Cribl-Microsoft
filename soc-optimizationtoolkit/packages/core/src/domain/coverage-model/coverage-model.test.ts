// Pins for the resource-coverage.json port (AZR-0, backlog.md#6).
//
// The card's instruction is "port it, do not invent one", so the first block of
// pins reads the REAL legacy file off disk and proves the catalog matches it
// field by field. A port that drifts from its source is not a port, and nothing
// else here would notice: every other test would happily pass against an
// invented catalog.
//
// Reading the filesystem is fine in a test - @soc/core's purity rule is about
// the shipped module, and the architecture audit exempts *.test.ts explicitly.
// The shipped catalog is a TS constant with no IO in it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COVERAGE_CATALOG,
  DEFAULT_ENABLED,
  UNSUPPORTED_SOURCES,
  XDR_TABLES_NOT_SUPPORTED,
  coverageItem,
  itemsByMethod,
} from "./coverage-catalog";
import {
  COVERAGE_SELECTION_KEY,
  decodeSelection,
  defaultSelection,
  encodeSelection,
  resolvedSubSelection,
  selectedItemIds,
} from "./coverage-selection";
import { deployPlan } from "../onboarding-selection";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "deprecated",
  "Azure",
  "Azure-LogCollection",
  "core",
  "resource-coverage.json",
);

/**
 * The file this catalog was ported FROM. If it is gone, this fails loudly and
 * on purpose rather than skipping: a provenance pin that quietly opts out when
 * its source disappears proves nothing, and the port's claim to be a port would
 * outlive the only evidence for it.
 */
function legacy(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(LEGACY_PATH, "utf8");
  } catch {
    throw new Error(
      `The ported-from source is missing: ${LEGACY_PATH}\n` +
        "COVERAGE_CATALOG claims to be a verbatim port of it (AZR-0, backlog.md#6). " +
        "Either restore the file, or delete these provenance pins AND the " +
        "'ported not invented' claim in coverage-catalog.ts together - the claim " +
        "must not outlive its evidence.",
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Walk a dotted path like `scriptBasedDeployment.entraId`. */
function at(root: unknown, path: string): Record<string, unknown> | undefined {
  let node: unknown = root;
  for (const seg of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "object" && node !== null
    ? (node as Record<string, unknown>)
    : undefined;
}

describe("COVERAGE_CATALOG - ported, not invented", () => {
  it("every catalog item resolves to a real node in the legacy file", () => {
    const src = legacy();

    for (const item of COVERAGE_CATALOG) {
      expect(at(src, item.source), `${item.id} -> ${item.source}`).toBeDefined();
    }
  });

  it("carries each item's description, note and method VERBATIM", () => {
    // The whole point of the instruction. A paraphrase here is an invention
    // wearing a port's clothes, and it is invisible without this comparison.
    const src = legacy();

    for (const item of COVERAGE_CATALOG) {
      const node = at(src, item.source);
      expect(node?.["description"], `${item.id} description`).toBe(item.description);
      expect(node?.["method"], `${item.id} method`).toBe(item.method);
      expect(node?.["note"] ?? null, `${item.id} note`).toBe(item.note);
      expect(node?.["resourceCount"] ?? null, `${item.id} resourceCount`).toBe(
        item.resourceCount,
      );
    }
  });

  it("ports the legacy `enabled: true` flags as the DEFAULT selection", () => {
    // The flags are defaults, not state - but they must still be the legacy
    // defaults, so a first run proposes what the legacy tool proposed.
    const src = legacy();
    const enabledInLegacy = COVERAGE_CATALOG.filter(
      (i) => at(src, i.source)?.["enabled"] === true,
    ).map((i) => i.id);

    expect([...DEFAULT_ENABLED].sort()).toEqual(enabledInLegacy.sort());
  });

  it("keeps the community tier options verbatim, All included", () => {
    // backlog.md#6 names the tier/profile sub-selections as one of two things
    // not to paraphrase.
    const src = legacy();
    const legacyTiers = at(src, "communityPolicyInitiative.tiers")?.["_options"];
    const ported = coverageItem("communityPolicyInitiative")?.subSelection?.options.map(
      (o) => o.key,
    );

    expect(ported).toEqual(legacyTiers);
  });

  it("keeps every community tier's detail text verbatim", () => {
    const src = legacy();
    const details = at(src, "communityPolicyInitiative.tiers.tierDetails") ?? {};
    const ported = coverageItem("communityPolicyInitiative")?.subSelection?.options ?? [];

    for (const option of ported) {
      if (option.key === "All") continue; // no legacy tierDetails entry; ours is a gloss
      expect(option.detail, `tier ${option.key}`).toBe(details[option.key]);
    }
    // And the gloss is the only thing we added.
    expect(ported.filter((o) => details[o.key] === undefined).map((o) => o.key)).toEqual([
      "All",
    ]);
  });

  it("keeps the Entra profile options verbatim", () => {
    const src = legacy();
    const legacyProfiles = at(src, "scriptBasedDeployment.entraId")?.["_profileOptions"];
    const ported = coverageItem("entraId")?.subSelection?.options.map((o) => o.key);

    expect(ported).toEqual(legacyProfiles);
  });

  it("ports the notSupported block entry for entry - none missing, none invented", () => {
    // backlog.md#6e: these stay so an operator looking for VNet Flow Logs finds
    // them and is told what to use instead. Dropping one makes the screen
    // silently incomplete.
    const src = legacy();
    const legacyKeys = Object.keys((src["notSupported"] ?? {}) as object).filter(
      (k) => !k.startsWith("_"),
    );

    expect(UNSUPPORTED_SOURCES.map((u) => u.id).sort()).toEqual(legacyKeys.sort());

    for (const u of UNSUPPORTED_SOURCES) {
      const node = at(src, u.source);
      expect(node?.["description"], `${u.id} description`).toBe(u.description);
      expect(node?.["alternative"], `${u.id} alternative`).toBe(u.alternative);
    }
  });

  it("ports the XDR unsupported-tables list and its reason verbatim", () => {
    const src = legacy();
    const node = at(src, "defenderXDR.xdrStreaming.tablesNotSupported");

    expect(XDR_TABLES_NOT_SUPPORTED.tables).toEqual(node?.["tables"]);
    expect(XDR_TABLES_NOT_SUPPORTED.reason).toBe(node?.["reason"]);
  });

  it("ports EVERY enabled-flag-bearing source, so nothing was quietly skipped", () => {
    // The other direction: the pins above prove what IS here matches. This one
    // proves nothing is MISSING, which is the failure mode a per-item loop
    // cannot see.
    const src = legacy();
    const found: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== "object" || node === null) return;
      const rec = node as Record<string, unknown>;
      if (typeof rec["enabled"] === "boolean" && typeof rec["method"] === "string") {
        if (rec["method"] !== "none") found.push(path);
        return;
      }
      for (const [k, v] of Object.entries(rec)) {
        if (k.startsWith("_")) continue;
        walk(v, path === "" ? k : `${path}.${k}`);
      }
    };
    walk(src, "");

    expect([...COVERAGE_CATALOG].map((i) => i.source).sort()).toEqual(found.sort());
  });

  it("groups by method, and the methods ARE the section keys", () => {
    // backlog.md#6: "Its `method` values ARE the section keys."
    expect(itemsByMethod("built-in-policy").map((i) => i.id)).toEqual([
      "diagnosticSettingsInitiative",
      "activityLog",
    ]);
    expect(itemsByMethod("custom-initiative").map((i) => i.id)).toEqual([
      "communityPolicyInitiative",
    ]);
    expect(itemsByMethod("script").map((i) => i.id)).toEqual(["entraId", "defenderExport"]);
    expect(itemsByMethod("guided-portal").map((i) => i.id)).toEqual(["xdrStreaming"]);
  });

  it("does NOT invent sections 6d and 6f, which the legacy file has no entry for", () => {
    // The honest gap. The legacy tool did not do pull collectors or agent-based
    // collection, so a catalog claiming to be a port cannot carry them. AZR-7
    // and AZR-9 add them. An empty stub section here would report coverage the
    // port cannot back.
    expect(itemsByMethod("none")).toEqual([]);
    expect(COVERAGE_CATALOG.every((i) => i.method !== "none")).toBe(true);
  });

  it("gives every item a unique id", () => {
    const ids = COVERAGE_CATALOG.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("decodeSelection - a KV value outlives the code that wrote it", () => {
  it("round-trips a selection unchanged", () => {
    const original = defaultSelection();
    const { selection, dropped, usedDefaults } = decodeSelection(encodeSelection(original));

    expect(selection).toEqual(original);
    expect(dropped).toEqual([]);
    expect(usedDefaults).toBe(false);
  });

  it("REPORTS an id the catalog no longer has, rather than dropping it silently", () => {
    // Silence here manufactures the exact confusion AZR-1's contract exists to
    // prevent: the box shows unticked while the thing is still deployed.
    const stored = JSON.stringify({ version: 1, mode: "Centralized", enabled: ["entraId", "retiredThing"] });
    const { selection, dropped } = decodeSelection(stored);

    expect(selection.enabled).toEqual(["entraId"]);
    expect(dropped).toContain("retiredThing");
  });

  it("falls back to DEFAULTS on unparseable text, and says it did", () => {
    const { selection, usedDefaults } = decodeSelection("{not json");

    expect(selection).toEqual(defaultSelection());
    expect(usedDefaults).toBe(true);
  });

  it("falls back to DEFAULTS when nothing is stored at all", () => {
    for (const empty of [null, undefined, 42, []]) {
      expect(decodeSelection(empty).usedDefaults, String(empty)).toBe(true);
    }
  });

  it("keeps a deliberately EMPTY selection as empty, not as the defaults", () => {
    // "Onboard nothing" is a real choice. Turning it into the defaults would
    // silently re-tick four sources the operator switched off.
    const { selection, usedDefaults } = decodeSelection(
      JSON.stringify({ version: 1, mode: "Centralized", enabled: [] }),
    );

    expect(selection.enabled).toEqual([]);
    expect(usedDefaults).toBe(false);
  });

  it("rejects an unknown deployment mode and reports it", () => {
    const { selection, dropped } = decodeSelection(
      JSON.stringify({ mode: "Galactic", enabled: [] }),
    );

    expect(selection.mode).toBe("Centralized");
    expect(dropped).toContain("mode:Galactic");
  });

  it("falls back to a sub-selection's DEFAULT when every stored option is gone", () => {
    // Not to empty: an initiative with no tiers selected deploys no policies,
    // which looks like success and collects nothing.
    const { selection, dropped } = decodeSelection(
      JSON.stringify({
        enabled: ["communityPolicyInitiative"],
        subSelections: { communityPolicyInitiative: ["Atlantis"] },
      }),
    );

    expect(selection.subSelections["communityPolicyInitiative"]).toEqual(["All"]);
    expect(dropped).toContain("communityPolicyInitiative.Atlantis");
  });

  it("keeps the valid half of a partly-stale sub-selection", () => {
    const { selection, dropped } = decodeSelection(
      JSON.stringify({
        enabled: ["communityPolicyInitiative"],
        subSelections: { communityPolicyInitiative: ["Storage", "Atlantis"] },
      }),
    );

    expect(selection.subSelections["communityPolicyInitiative"]).toEqual(["Storage"]);
    expect(dropped).toEqual(["communityPolicyInitiative.Atlantis"]);
  });

  it("de-duplicates a repeated id instead of ticking it twice", () => {
    const { selection } = decodeSelection(
      JSON.stringify({ enabled: ["entraId", "entraId"] }),
    );

    expect(selection.enabled).toEqual(["entraId"]);
  });

  it("never throws, whatever it is handed", () => {
    const nasty: unknown[] = [
      "",
      "null",
      '"a string"',
      "[1,2,3]",
      JSON.stringify({ enabled: "not-an-array" }),
      JSON.stringify({ subSelections: "not-an-object" }),
      JSON.stringify({ enabled: [1, 2, null] }),
      { mode: 7 },
    ];

    for (const input of nasty) {
      expect(() => decodeSelection(input), JSON.stringify(input)).not.toThrow();
    }
  });
});

describe("resolvedSubSelection - the All shorthand stops here", () => {
  it("expands All to every real tier, so nothing downstream knows the shorthand", () => {
    const resolved = resolvedSubSelection("communityPolicyInitiative", defaultSelection());

    expect(resolved).not.toContain("All");
    expect(resolved).toContain("Storage");
    expect(resolved).toHaveLength(8);
  });

  it("passes an explicit selection through untouched", () => {
    const selection = {
      ...defaultSelection(),
      subSelections: { communityPolicyInitiative: ["Storage", "Networking"] },
    };

    expect(resolvedSubSelection("communityPolicyInitiative", selection)).toEqual([
      "Storage",
      "Networking",
    ]);
  });

  it("returns nothing for an item that has no sub-selection", () => {
    expect(resolvedSubSelection("activityLog", defaultSelection())).toEqual([]);
    expect(resolvedSubSelection("nope", defaultSelection())).toEqual([]);
  });
});

describe("the seam into AZR-1's additive-only contract", () => {
  it("turns a selection into a deploy plan that cannot remove anything", () => {
    // The two halves meeting. Unticking everything must leave what is deployed
    // exactly where it is - the contract, exercised through the real selection
    // type rather than through hand-made id lists.
    const everything = defaultSelection();
    const deployed = selectedItemIds(everything);

    const untickedAll = deployPlan(
      selectedItemIds({ ...everything, enabled: [] }),
      deployed,
    );

    expect(untickedAll.add).toEqual([]);
    expect([...untickedAll.leftInPlace].sort()).toEqual([...deployed].sort());
    expect(Object.keys(untickedAll)).not.toContain("remove");
  });

  it("adds only the newly ticked item", () => {
    const before = { ...defaultSelection(), enabled: ["entraId"] };
    const after = { ...defaultSelection(), enabled: ["entraId", "defenderExport"] };

    const plan = deployPlan(selectedItemIds(after), selectedItemIds(before));

    expect(plan.add).toEqual(["defenderExport"]);
    expect(plan.unchanged).toEqual(["entraId"]);
  });
});

describe("the KV contract", () => {
  it("persists under one stable key", () => {
    // Changing this orphans every saved selection in the field, so it is worth
    // a pin rather than a comment.
    expect(COVERAGE_SELECTION_KEY).toBe("azure-coverage-selection");
  });

  it("encodes deterministically, so an unchanged selection is not a rewrite", () => {
    const s = defaultSelection();
    expect(encodeSelection(s)).toBe(encodeSelection(s));
    expect(encodeSelection({ ...s, enabled: [...s.enabled].reverse() })).toBe(
      encodeSelection(s),
    );
  });
});
