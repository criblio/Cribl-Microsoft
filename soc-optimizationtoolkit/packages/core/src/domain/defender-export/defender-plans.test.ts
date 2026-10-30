// Pins for Defender plan detection (AZR-3).
//
// Two things here are expensive to get wrong and invisible when they are:
// a plan list paraphrased from the script it was ported from, and a summary
// that says "no paid plan" when it did not actually look - or looked and
// skipped something. Legacy did the second twice (a swallowed error, and
// names outside its map dropped). The last pin is the structural promise that
// the app never enables a paid plan: no file that names the pricings resource
// may pair it with a write verb.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFENDER_PLANS,
  SECURITY_PRICINGS_API_VERSION,
  anyStandard,
  buildPricingsListRequest,
  parsePricings,
} from "./defender-plans";
import type { PricingsRead } from "./defender-plans";

const HERE = dirname(fileURLToPath(import.meta.url));
// A FROZEN COPY inside the app (DBT-132), held byte-equal to the original for
// as long as the original exists beside it.
const SCRIPT_PATH = join(HERE, "legacy", "Deploy-DefenderExport.ps1");
const ORIGINAL_PATH = join(
  HERE,
  "..", "..", "..", "..", "..", "..",
  "deprecated", "Azure", "Azure-LogCollection", "core", "Deploy-DefenderExport.ps1",
);

describe("the frozen legacy copy (DBT-132)", () => {
  it.runIf(existsSync(ORIGINAL_PATH))("is byte-for-byte the ported-from script", () => {
    expect(readFileSync(SCRIPT_PATH, "utf8")).toBe(readFileSync(ORIGINAL_PATH, "utf8"));
  });
});

/** The script this was ported from. Fails loudly if it is gone. */
function script(): string {
  try {
    return readFileSync(SCRIPT_PATH, "utf8");
  } catch {
    throw new Error(
      `The ported-from source is missing: ${SCRIPT_PATH}\n` +
        "defender-plans claims DEFENDER_PLANS is verbatim from it (AZR-3). " +
        "Either restore the file, or delete these provenance pins AND the claim together.",
    );
  }
}

/** `"Name" = @{ DisplayName = "X"; ...}` entries of `$DefenderPlans = @{ ... }`. */
function legacyPlans(): { name: string; displayName: string }[] {
  const text = script();
  const start = text.indexOf("$DefenderPlans = @{");
  if (start === -1) throw new Error("No $DefenderPlans in the legacy script.");
  const end = text.indexOf("\n}", start);
  const block = text.slice(start, end);
  return [...block.matchAll(/"([^"]+)"\s*=\s*@\{\s*DisplayName\s*=\s*"([^"]+)"/g)].map((m) => ({
    name: m[1],
    displayName: m[2],
  }));
}

function ok(value: unknown[]): { status: number; body: unknown } {
  return { status: 200, body: { value } };
}

function pricing(name: string, pricingTier: string): unknown {
  return { id: `/subscriptions/s/providers/Microsoft.Security/pricings/${name}`, name, properties: { pricingTier } };
}

function read(response: { status: number; body: unknown }): PricingsRead {
  const result = parsePricings(response);
  if (result.kind !== "read") throw new Error(`expected read, got ${JSON.stringify(result)}`);
  return result;
}

describe("DEFENDER_PLANS - verbatim from the script that ran", () => {
  it("is the 12 plans of $DefenderPlans, names and display names, in order", () => {
    const legacy = legacyPlans();
    expect(legacy).toHaveLength(12);
    expect(DEFENDER_PLANS.map((p) => ({ name: p.name, displayName: p.displayName }))).toEqual(legacy);
  });
});

describe("buildPricingsListRequest", () => {
  it("is a GET of the subscription's pricings collection", () => {
    expect(buildPricingsListRequest("sub-1")).toEqual({
      method: "GET",
      path: "/subscriptions/sub-1/providers/Microsoft.Security/pricings",
      apiVersion: SECURITY_PRICINGS_API_VERSION,
    });
  });
});

describe("parsePricings - read", () => {
  it("splits Standard, Free and an unknown name into enabled, disabled and unrecognized", () => {
    const result = read(
      ok([pricing("VirtualMachines", "Standard"), pricing("Dns", "Free"), pricing("CloudPosture", "Free")]),
    );

    expect(result.enabled.map((p) => p.name)).toEqual(["VirtualMachines"]);
    expect(result.enabled[0]?.displayName).toBe("Defender for Servers");
    expect(result.disabled.map((p) => p.name)).toEqual(["Dns"]);
    expect(result.unrecognized).toEqual([{ name: "CloudPosture", tier: "Free" }]);
  });

  it("reads the tier case-insensitively, as legacy's -eq did", () => {
    expect(read(ok([pricing("Arm", "standard")])).enabled.map((p) => p.name)).toEqual(["Arm"]);
  });

  it("orders known plans by DEFENDER_PLANS, not by response order", () => {
    const result = read(ok([pricing("Api", "Standard"), pricing("VirtualMachines", "Standard")]));
    expect(result.enabled.map((p) => p.name)).toEqual(["VirtualMachines", "Api"]);
  });
});

describe("anyStandard - the only source of 'is a paid plan on?'", () => {
  it("is true for an UNRECOGNIZED pricing on Standard, with no known plan on", () => {
    // Catches a false "no paid plan": legacy dropped names outside its map.
    const result = read(ok([pricing("Dns", "Free"), pricing("CloudPosture", "Standard")]));
    expect(result.enabled).toEqual([]);
    expect(anyStandard(result)).toBe(true);
  });

  it("is true for a known plan on Standard", () => {
    expect(anyStandard(read(ok([pricing("KeyVaults", "Standard")])))).toBe(true);
  });

  it("is false only when every pricing, known or not, is on another tier", () => {
    expect(anyStandard(read(ok([pricing("Dns", "Free"), pricing("CloudPosture", "Free")])))).toBe(false);
  });
});

describe("parsePricings - unreadable, never 'no plans'", () => {
  it("gives unreadable for a 403 with Azure's code and message", () => {
    expect(
      parsePricings({
        status: 403,
        body: { error: { code: "AuthorizationFailed", message: "no access" } },
      }),
    ).toEqual({ kind: "unreadable", status: 403, code: "AuthorizationFailed", message: "no access" });
  });

  it("carries MissingSubscriptionRegistration so the caller can say 'not registered'", () => {
    const result = parsePricings({
      status: 409,
      body: { error: { code: "MissingSubscriptionRegistration", message: "register it" } },
    });
    expect(result.kind === "unreadable" && result.code).toBe("MissingSubscriptionRegistration");
  });

  it("gives unreadable for a 500 with no ARM error body", () => {
    const result = parsePricings({ status: 500, body: "upstream exploded" });
    expect(result).toMatchObject({ kind: "unreadable", status: 500, code: "" });
  });

  it("gives unreadable for a 200 without a value array", () => {
    expect(parsePricings({ status: 200, body: { values: [] } })).toMatchObject({
      kind: "unreadable",
      status: 200,
    });
  });

  it("gives unreadable for a 200 with one entry missing its tier", () => {
    // "No paid plan" is a claim about every entry; one unreadable entry voids it.
    const result = parsePricings(ok([pricing("Dns", "Free"), { name: "VirtualMachines", properties: {} }]));
    expect(result).toMatchObject({ kind: "unreadable", status: 200 });
  });
});

/** Every non-test .ts file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("the app never writes a Defender plan", () => {
  // The toolkit's source roots: core, ui and the Cribl app shell.
  const TOOLKIT = join(HERE, "..", "..", "..", "..", "..");
  const ROOTS = [
    join(TOOLKIT, "packages", "core", "src"),
    join(TOOLKIT, "packages", "ui", "src"),
    join(TOOLKIT, "apps", "cribl-app", "src"),
  ].filter((root) => existsSync(root));

  it("scans real source, including this module", () => {
    // Guards the scan below against passing because it read nothing.
    const files = ROOTS.flatMap(sourceFiles);
    expect(files.some((f) => f.endsWith("defender-plans.ts"))).toBe(true);
  }, 30000);

  it("has no source file that names the pricings resource and a write verb", () => {
    const offenders = ROOTS.flatMap(sourceFiles).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /pricings/i.test(text) && /method:\s*["'](PUT|PATCH|DELETE)["']/.test(text);
    });
    expect(offenders).toEqual([]);
  }, 30000);
});
