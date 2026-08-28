// Pins for the Entra ID tracer bullet (AZR-2, backlog.md#6b, LOG-07).
//
// Like AZR-0, the profile lists are pinned against the legacy script they were
// ported from, because a paraphrase here is invisible and expensive: a category
// silently dropped from a profile is telemetry an operator believes they turned
// on and did not.
//
// The rest pin the three things the card called non-negotiable: the volume
// warning rides its own checkbox, the UEBA consequence is stated per selection,
// and the directory-role precondition is modelled as UNMEASURABLE rather than
// as merely unmeasured.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ENTRA_CATEGORIES,
  ENTRA_PROFILES,
  ENTRA_PROFILE_CATEGORIES,
  categoriesForProfile,
  entraCategory,
  profileForSelection,
  uebaBoundTables,
  volumeWarnings,
} from "./entra-categories";
import {
  AADIAM_API_VERSION,
  DEFAULT_SETTING_NAME,
  ENTRA_DIRECTORY_PRECONDITION,
  buildEntraDiagnosticRequest,
  listSettingsUrl,
} from "./entra-diagnostic-setting";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(
  HERE,
  "..", "..", "..", "..", "..", "..",
  "deprecated", "Azure", "Azure-LogCollection", "core", "Deploy-EntraIDDiagnostics.ps1",
);

/** The script this was ported from. Fails loudly if it is gone - see AZR-0. */
function script(): string {
  try {
    return readFileSync(SCRIPT_PATH, "utf8");
  } catch {
    throw new Error(
      `The ported-from source is missing: ${SCRIPT_PATH}\n` +
        "entra-categories claims its profile lists are verbatim from it (AZR-2, LOG-07). " +
        "Either restore the file, or delete these provenance pins AND the claim together.",
    );
  }
}

/** Pull `$XLogCategories = @( @{ Category = "A" ... } ... )` out of the script. */
function legacyProfile(varName: string): string[] {
  const text = script();
  const start = text.indexOf(`$${varName} = @(`);
  if (start === -1) throw new Error(`No $${varName} in the legacy script.`);
  const end = text.indexOf("\n)", start);
  const block = text.slice(start, end);
  return [...block.matchAll(/Category\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("ENTRA_PROFILE_CATEGORIES - verbatim from the script that ran", () => {
  const MAP: Record<string, string> = {
    SecurityOnly: "SecurityLogCategories",
    Standard: "StandardLogCategories",
    HighVolume: "HighVolumeLogCategories",
  };

  for (const profile of ["SecurityOnly", "Standard", "HighVolume"] as const) {
    it(`carries ${profile} exactly as the legacy script defined it`, () => {
      expect(ENTRA_PROFILE_CATEGORIES[profile]).toEqual(legacyProfile(MAP[profile]));
    });
  }

  it("keeps the counts the census documents: 6, 9, 15", () => {
    // LOG-07's own numbers. A count is the cheapest thing to check and the
    // thing a reader of the census will compare against first.
    expect(categoriesForProfile("SecurityOnly")).toHaveLength(6);
    expect(categoriesForProfile("Standard")).toHaveLength(9);
    expect(categoriesForProfile("HighVolume")).toHaveLength(15);
  });

  it("RESOLVES THE LOG-07 DRIFT by offering all three profiles", () => {
    // resource-coverage.json's _profileOptions lists only Standard and
    // HighVolume; the census and the script both have SecurityOnly. AZR-2
    // called for resolving it, and the script is the thing that actually ran.
    expect(ENTRA_PROFILES).toEqual(["SecurityOnly", "Standard", "HighVolume"]);
  });

  it("has no category in a profile that is missing from the catalog", () => {
    for (const profile of ENTRA_PROFILES) {
      for (const name of categoriesForProfile(profile)) {
        expect(entraCategory(name), `${profile} -> ${name}`).toBeDefined();
      }
    }
  });

  it("has no catalog category that no profile uses", () => {
    // The other direction: an orphan category would be a checkbox no preset can
    // reach, which is either a typo or an invention.
    const inSomeProfile = new Set(ENTRA_PROFILES.flatMap((p) => [...categoriesForProfile(p)]));
    expect(ENTRA_CATEGORIES.filter((c) => !inSomeProfile.has(c.name))).toEqual([]);
  });
});

describe("the volume warning rides its own checkbox", () => {
  it("puts the 5-10x warning ON NonInteractiveUserSignInLogs", () => {
    // backlog.md#6b: "that warning belongs at the checkbox, not in a footnote".
    const cat = entraCategory("NonInteractiveUserSignInLogs");

    expect(cat?.volumeWarning).toContain("5-10x");
  });

  it("reports a warning only for the categories actually selected", () => {
    expect(volumeWarnings(["AuditLogs", "SignInLogs"])).toEqual([]);
    expect(volumeWarnings(categoriesForProfile("HighVolume")).map((w) => w.category)).toEqual([
      "NonInteractiveUserSignInLogs",
      "MicrosoftGraphActivityLogs",
    ]);
  });

  it("does NOT warn on Standard, which is the point of Standard", () => {
    expect(volumeWarnings(categoriesForProfile("Standard"))).toEqual([]);
  });

  it("keeps warnings rare, so they are not trained away", () => {
    // Two of fifteen. If this ever climbs, the warning stops being a signal -
    // which is why the number is pinned rather than left to drift upward one
    // sympathetic-looking category at a time.
    expect(ENTRA_CATEGORIES.filter((c) => c.volumeWarning !== null)).toHaveLength(2);
  });
});

describe("the UEBA consequence - a hard limit, stated per selection", () => {
  it("binds exactly the four tables Sentinel's UEBA engine reads", () => {
    // features/content-preserving-native-reroute.md names them. Rerouting these
    // through Cribl lands them in _CL and UEBA stops seeing them, permanently.
    const bound = ENTRA_CATEGORIES.filter((c) => c.uebaBoundTable !== null);

    expect(bound.map((c) => c.uebaBoundTable)).toEqual([
      "AuditLogs",
      "SigninLogs",
      "AADServicePrincipalSignInLogs",
      "AADManagedIdentitySignInLogs",
    ]);
  });

  it("names the table, so the warning is specific rather than about 'sign-ins'", () => {
    expect(uebaBoundTables(["SignInLogs"])).toEqual(["SigninLogs"]);
  });

  it("says nothing when no UEBA-bound category is ticked", () => {
    // A reachable, real answer - not an oversight. Warning unconditionally
    // would be false and would train people to ignore it.
    expect(uebaBoundTables(["ProvisioningLogs", "ADFSSignInLogs"])).toEqual([]);
  });

  it("warns on Standard, which contains all four", () => {
    expect(uebaBoundTables(categoriesForProfile("Standard"))).toHaveLength(4);
  });

  it("does NOT bind NonInteractiveUserSignInLogs, which UEBA never consumed", () => {
    // The trap: it is the loudest sign-in category, so it looks like it should
    // carry the warning. It does not, and saying it does would be a fabrication
    // that survives precisely because it sounds right.
    expect(entraCategory("NonInteractiveUserSignInLogs")?.uebaBoundTable).toBeNull();
  });
});

describe("profileForSelection - stop claiming a preset once a box moves", () => {
  it("names the preset when the selection is exactly one", () => {
    for (const p of ENTRA_PROFILES) {
      expect(profileForSelection(categoriesForProfile(p))).toBe(p);
    }
  });

  it("is order-independent", () => {
    expect(profileForSelection([...categoriesForProfile("Standard")].reverse())).toBe(
      "Standard",
    );
  });

  it("returns null the moment one box differs", () => {
    expect(
      profileForSelection([...categoriesForProfile("Standard"), "ADFSSignInLogs"]),
    ).toBeNull();
    expect(profileForSelection(categoriesForProfile("Standard").slice(1))).toBeNull();
  });

  it("returns null for an empty selection rather than inventing a preset", () => {
    expect(profileForSelection([])).toBeNull();
  });
});

describe("buildEntraDiagnosticRequest - the ARM PUT", () => {
  const input = {
    eventHubAuthorizationRuleId:
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns/authorizationRules/RootManageSharedAccessKey",
    eventHubName: "insights-logs",
    categories: ["AuditLogs", "SignInLogs"],
  };

  it("targets the TENANT-level aadiam path, with no subscription in it", () => {
    const req = buildEntraDiagnosticRequest(input);

    expect(req.method).toBe("PUT");
    expect(req.url).toBe(
      `https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings/${DEFAULT_SETTING_NAME}?api-version=${AADIAM_API_VERSION}`,
    );
    expect(req.url).not.toContain("subscriptions");
  });

  it("pins the api-version the legacy script used", () => {
    expect(AADIAM_API_VERSION).toBe("2017-04-01");
    expect(script()).toContain("api-version=2017-04-01");
  });

  it("uses the legacy default setting name", () => {
    expect(DEFAULT_SETTING_NAME).toBe("CriblEntraIDLogs");
    expect(script()).toContain('"CriblEntraIDLogs"');
  });

  it("sends EVERY category, with enabled reflecting the selection", () => {
    // The setting is a full replacement: a category omitted from `logs` keeps
    // whatever it had. Sending only the ticked ones could never turn anything
    // off, so an unticked category would keep flowing while the UI showed it as
    // off - the exact state AZR-1's contract is about making visible.
    const req = buildEntraDiagnosticRequest(input);

    expect(req.body.properties.logs).toHaveLength(ENTRA_CATEGORIES.length);
    expect(req.body.properties.logs.filter((l) => l.enabled).map((l) => l.category)).toEqual([
      "AuditLogs",
      "SignInLogs",
    ]);
    expect(req.body.properties.logs.some((l) => !l.enabled)).toBe(true);
  });

  it("carries the Event Hub target through unchanged", () => {
    const req = buildEntraDiagnosticRequest(input);

    expect(req.body.properties.eventHubAuthorizationRuleId).toBe(
      input.eventHubAuthorizationRuleId,
    );
    expect(req.body.properties.eventHubName).toBe("insights-logs");
  });

  it("honours a custom setting name and escapes it", () => {
    const req = buildEntraDiagnosticRequest({ ...input, settingName: "my setting" });

    expect(req.url).toContain("my%20setting");
  });

  it("drops an unknown category instead of taking the whole PUT down", () => {
    const req = buildEntraDiagnosticRequest({ ...input, categories: ["AuditLogs", "Ghost"] });

    expect(req.body.properties.logs.map((l) => l.category)).not.toContain("Ghost");
    expect(req.body.properties.logs.filter((l) => l.enabled).map((l) => l.category)).toEqual([
      "AuditLogs",
    ]);
  });

  it("lists existing settings at the same tenant path", () => {
    expect(listSettingsUrl()).toBe(
      `https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings?api-version=${AADIAM_API_VERSION}`,
    );
  });
});

describe("the precondition this app cannot measure", () => {
  it("is modelled as UNMEASURABLE, not as unmeasured", () => {
    // The distinction is the finding. "Unmeasured" invites someone to add a
    // probe; unmeasurable-by-this-evaluator tells them where to look instead.
    // Reporting it as an ordinary unchecked capability would be a preflight
    // returning green for something it never examined.
    expect(ENTRA_DIRECTORY_PRECONDITION.measurable).toBe(false);
  });

  it("says WHY the RBAC evaluator cannot see it", () => {
    expect(ENTRA_DIRECTORY_PRECONDITION.reason).toContain("Microsoft.Authorization/permissions");
    expect(ENTRA_DIRECTORY_PRECONDITION.reason).toContain("not ARM role assignments");
  });

  it("points at where it COULD be measured, so it reads as a pointer not a shrug", () => {
    expect(ENTRA_DIRECTORY_PRECONDITION.wouldNeed).toContain("Graph");
  });

  it("names the roles the legacy script required", () => {
    expect(ENTRA_DIRECTORY_PRECONDITION.requirement).toContain("Security Administrator");
    expect(ENTRA_DIRECTORY_PRECONDITION.requirement).toContain("Global Administrator");
  });
});
