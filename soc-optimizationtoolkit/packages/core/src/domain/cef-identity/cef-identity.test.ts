/**
 * Contract tests for the CEF identity override.
 *
 * The failure this guards is INVISIBLE: a vendor string that does not match what
 * the rules expect deploys cleanly, ingests cleanly, and never fires a rule. So
 * the pins are about not producing a confident wrong answer - never inventing an
 * expected value, and keeping "wrong casing" distinct from "wrong vendor".
 */
import { describe, expect, it } from "vitest";

import {
  CEF_IDENTITY_FIELDS,
  applyCefIdentityOverride,
  expectedCefIdentity,
  findCefIdentity,
  findCefIdentityAll,
  overrideChangesEvent,
  overrideValueFor,
  cefIdentityFindings,
  actionableCefIdentity,
  extractCefIdentityValues,
} from "./cef-identity";
import type { DiscriminatorValue } from "../coverage-analysis";

const rules = (...pairs: [string, string][]): DiscriminatorValue[] =>
  pairs.map(([field, value]) => ({ field, value }));

describe("expectedCefIdentity", () => {
  it("collects the literals the rules compare against, per field", () => {
    const expected = expectedCefIdentity(
      rules(
        ["DeviceVendor", "Palo Alto Networks"],
        ["DeviceProduct", "PAN-OS"],
        ["SourceIP", "10.0.0.1"],
      ),
    );
    expect(expected.DeviceVendor).toEqual(["Palo Alto Networks"]);
    expect(expected.DeviceProduct).toEqual(["PAN-OS"]);
  });

  it("dedupes case-insensitively but keeps first-seen spelling", () => {
    // Corpora lead with the canonical spelling, and a stable order keeps the
    // suggestion from changing between runs over the same content.
    const expected = expectedCefIdentity(
      rules(["DeviceVendor", "ZScaler"], ["DeviceVendor", "zscaler"]),
    );
    expect(expected.DeviceVendor).toEqual(["ZScaler"]);
  });

  it("ignores fields it does not govern", () => {
    const expected = expectedCefIdentity(rules(["DeviceAction", "block"]));
    expect(expected.DeviceVendor).toEqual([]);
    expect(expected.DeviceProduct).toEqual([]);
  });
});

describe("findCefIdentity", () => {
  it("reports a match when the sample already agrees", () => {
    const found = findCefIdentity("DeviceVendor", "ZScaler", ["ZScaler"]);
    expect(found.status).toBe("match");
    expect(found.suggested).toBeNull();
  });

  it("keeps WRONG CASING distinct from wrong vendor", () => {
    // `=~` rules match regardless; `==` rules do not. Calling this a mismatch
    // would send operators chasing a difference half the corpus ignores.
    const found = findCefIdentity("DeviceVendor", "zscaler", ["ZScaler"]);
    expect(found.status).toBe("case-mismatch");
    expect(found.suggested).toBe("ZScaler");
  });

  it("names what the rules expect on a real mismatch", () => {
    const found = findCefIdentity("DeviceVendor", "Acme", ["Palo Alto Networks"]);
    expect(found.status).toBe("mismatch");
    expect(found.suggested).toBe("Palo Alto Networks");
  });

  it("NEVER invents an expectation when the rules constrain nothing", () => {
    // The load-bearing pin. With no rule comparing this field there is no
    // requirement to meet, and suggesting one would manufacture a problem.
    const found = findCefIdentity("DeviceVendor", "Acme", []);
    expect(found.status).toBe("unknown");
    expect(found.suggested).toBeNull();
  });

  it("offers the expected value when the sample carries none", () => {
    const found = findCefIdentity("DeviceVendor", "", ["ZScaler"]);
    expect(found.status).toBe("absent");
    expect(found.suggested).toBe("ZScaler");
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(findCefIdentity("DeviceVendor", "  ZScaler  ", ["ZScaler"]).status).toBe(
      "match",
    );
  });
});

describe("findCefIdentityAll", () => {
  it("classifies both fields against one rule set", () => {
    const found = findCefIdentityAll(
      { DeviceVendor: "Acme", DeviceProduct: "PAN-OS" },
      rules(["DeviceVendor", "Palo Alto Networks"], ["DeviceProduct", "PAN-OS"]),
    );
    expect(found.map((f) => [f.field, f.status])).toEqual([
      ["DeviceVendor", "mismatch"],
      ["DeviceProduct", "match"],
    ]);
  });

  it("covers both fields in CEF header order, always", () => {
    const found = findCefIdentityAll({}, []);
    expect(found.map((f) => f.field)).toEqual([...CEF_IDENTITY_FIELDS]);
  });
});

describe("applyCefIdentityOverride", () => {
  it("replaces only what the override names", () => {
    const event = { DeviceVendor: "Acme", DeviceProduct: "Thing", Other: 1 };
    expect(
      applyCefIdentityOverride(event, { DeviceVendor: "ZScaler" }),
    ).toEqual({ DeviceVendor: "ZScaler", DeviceProduct: "Thing", Other: 1 });
  });

  it("never mutates the input", () => {
    const event = { DeviceVendor: "Acme" };
    applyCefIdentityOverride(event, { DeviceVendor: "ZScaler" });
    expect(event.DeviceVendor).toBe("Acme");
  });

  it("treats a blank override as 'leave it', never as 'clear it'", () => {
    // An empty DeviceVendor makes reconstructCefLine return null, so allowing a
    // blank to clear the field would be a silent way to break the pack.
    const event = { DeviceVendor: "Acme" };
    expect(applyCefIdentityOverride(event, { DeviceVendor: "   " })).toEqual({
      DeviceVendor: "Acme",
    });
    expect(applyCefIdentityOverride(event, {})).toEqual({ DeviceVendor: "Acme" });
  });
});

describe("overrideChangesEvent", () => {
  it("is false when the override matches what is already there", () => {
    expect(
      overrideChangesEvent({ DeviceVendor: "ZScaler" }, { DeviceVendor: "ZScaler" }),
    ).toBe(false);
  });

  it("is true when it would replace a value", () => {
    expect(
      overrideChangesEvent({ DeviceVendor: "Acme" }, { DeviceVendor: "ZScaler" }),
    ).toBe(true);
  });
});

describe("overrideValueFor - the ONE blank rule", () => {
  // Architecture audit 2026-08-10: this guard had been written out three times,
  // once across a module boundary (the pipeline emitter). If the copies drifted,
  // the analysis and the DEPLOYED pipeline would disagree about the same
  // override - the exact invisible split this feature exists to remove.
  it("returns the trimmed value, or null for anything blank", () => {
    expect(overrideValueFor({ DeviceVendor: "  ZScaler " }, "DeviceVendor")).toBe(
      "ZScaler",
    );
    expect(overrideValueFor({ DeviceVendor: "   " }, "DeviceVendor")).toBeNull();
    expect(overrideValueFor({}, "DeviceVendor")).toBeNull();
  });

  it("is what applyCefIdentityOverride and overrideChangesEvent both obey", () => {
    // Pinned as agreement rather than as three separate behaviours, so a future
    // change to the rule cannot land in one caller and not the others.
    for (const raw of ["ZScaler", "  ZScaler  ", "", "   ", undefined]) {
      const override = { DeviceVendor: raw } as { DeviceVendor?: string };
      const supplied = overrideValueFor(override, "DeviceVendor");
      const applied = applyCefIdentityOverride({ DeviceVendor: "Acme" }, override);
      expect(applied.DeviceVendor).toBe(supplied ?? "Acme");
      expect(overrideChangesEvent({ DeviceVendor: "Acme" }, override)).toBe(
        supplied !== null,
      );
    }
  });
});

describe("cefIdentityFindings + actionableCefIdentity - the analysis surface", () => {
  // The step that was missing between these primitives and any screen: nothing
  // turned a solution's rule queries into the literal set to compare against,
  // so the whole feature shipped in 1.5.0 unreachable.
  //
  // NO INJECTED EXTRACTOR. The first version took one as an argument, and the
  // first test passed it a plausible fake - which is precisely how it shipped
  // wired to coverage-analysis's extractDiscriminatorValues, a function that
  // scans LOG-TYPE discriminators and has never looked at DeviceVendor. The
  // real screen showed nothing about a real mismatch and every test was green.
  // These now exercise the extractor the app actually runs.

  // The genuine Zscaler ZIA rule text from a live workspace, trimmed. Note the
  // casing: the rule says "ZScaler" while the curated vendor list says
  // "Zscaler" - a real case-mismatch found only by reading the query.
  const ZSCALER_RULE = [
    "let connectionThreshold = 1;",
    'let riskyExtensions = dynamic([".bin",".exe",".dll"]);',
    "CommonSecurityLog",
    '| where DeviceVendor =~ "ZScaler"',
    '| where RequestURL has_any("media.discordapp.net", "cdn.discordapp.com")',
    '| where DeviceAction !~ "blocked"',
    "| summarize dcount(RequestURL) by DiscordServerId, DeviceProduct",
  ].join("\n");

  it("reads the vendor literal out of a REAL rule query", () => {
    const findings = cefIdentityFindings({ DeviceVendor: "Acme" }, [ZSCALER_RULE]);
    const vendor = findings.find((f) => f.field === "DeviceVendor");
    expect(vendor?.status).toBe("mismatch");
    expect(vendor?.suggested).toBe("ZScaler");
  });

  it("catches the CASE difference the curated vendor list introduces", () => {
    // The lab's actual situation: the app seeds "Zscaler", the rule wants
    // "ZScaler". =~ rules still match; == rules do not.
    const findings = cefIdentityFindings({ DeviceVendor: "Zscaler" }, [ZSCALER_RULE]);
    const [first] = actionableCefIdentity(findings);
    expect(first?.status).toBe("case-mismatch");
    expect(first?.suggested).toBe("ZScaler");
  });

  it("does NOT treat a grouping/projection field as an expectation", () => {
    // DeviceProduct appears in that rule's summarize and project clauses but is
    // never compared to a literal. There is no value to expect, so claiming one
    // would manufacture a problem.
    const findings = cefIdentityFindings({}, [ZSCALER_RULE]);
    const product = findings.find((f) => f.field === "DeviceProduct");
    expect(product?.status).toBe("unknown");
    expect(product?.suggested).toBeNull();
  });

  it("unions the literals across EVERY rule query", () => {
    const findings = cefIdentityFindings({ DeviceProduct: "Acme" }, [
      'CommonSecurityLog | where Foo == "bar"',
      'CommonSecurityLog | where DeviceProduct == "NSSWeblog"',
    ]);
    const product = findings.find((f) => f.field === "DeviceProduct");
    expect(product?.suggested).toBe("NSSWeblog");
  });

  it("reads an in~ SET as several candidates, first-seen order", () => {
    const findings = cefIdentityFindings({ DeviceProduct: "Acme" }, [
      `CommonSecurityLog | where DeviceProduct in~ ("NSSWeblog", "NSSFWlog")`,
    ]);
    const product = findings.find((f) => f.field === "DeviceProduct");
    expect(product?.expected).toEqual(["NSSWeblog", "NSSFWlog"]);
    expect(product?.suggested).toBe("NSSWeblog");
  });

  it("IGNORES has/contains - a substring test names no value", () => {
    // `DeviceProduct has "NSS"` says the value contains NSS, not that it IS
    // NSS. Offering the fragment as a replacement would invent a constant, the
    // same mistake the connector-KQL stem fix corrected.
    expect(
      extractCefIdentityValues('| where DeviceProduct has "NSS"'),
    ).toEqual([]);
  });

  it("ignores a literal inside a COMMENT", () => {
    expect(
      extractCefIdentityValues('// | where DeviceVendor == "Example"'),
    ).toEqual([]);
  });

  it("reports NOTHING actionable when the sample already agrees", () => {
    const findings = cefIdentityFindings({ DeviceVendor: "ZScaler" }, [ZSCALER_RULE]);
    expect(actionableCefIdentity(findings)).toEqual([]);
  });

  it("reports NOTHING actionable when no rule mentions the fields", () => {
    const findings = cefIdentityFindings({ DeviceVendor: "Acme" }, [
      "CommonSecurityLog | count",
    ]);
    expect(actionableCefIdentity(findings)).toEqual([]);
  });

  it("never offers a suggestion it did not read from the content", () => {
    const findings = cefIdentityFindings(
      { DeviceVendor: "Acme", DeviceProduct: "Thing" },
      ['where DeviceVendor == "ZScaler" and DeviceProduct == "NSSWeblog"'],
    );
    for (const f of actionableCefIdentity(findings)) {
      expect(f.suggested).not.toBeNull();
      expect(f.expected).toContain(f.suggested);
    }
  });
});
