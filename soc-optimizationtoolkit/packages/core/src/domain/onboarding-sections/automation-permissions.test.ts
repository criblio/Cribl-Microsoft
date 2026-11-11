// Pins for AZR-60: what each AUTOMATABLE onboarding source needs from Azure to
// be automated, and the banner the section shows from the CACHED audit.
//
// Each pin is aimed at one way the section could mislead an operator:
//   - a source made automatable with no declaration (the banner would never
//     appear for it, and silence reads as "fine");
//   - an unmeasured or never-checked capability worded as denied
//     (inventory-honesty: unknown is not denied);
//   - the grant-only write (automations/write evaluated above its resource
//     group) shown as denied, which nobody measured;
//   - a deploy caution for anything short of a measured, core denial;
//   - a denial of a capability deploy does not need cautioning deploy anyway.
// Nothing here ever disables Deploy: the audit informs, never forbids
// (operator decision 2026-11-03).

import { describe, expect, it } from "vitest";

import { AZURE_CAPABILITIES } from "../capabilities";
import type { CapabilityContext, CapabilitySet, CapabilityVerdict } from "../capabilities";
import {
  DEFENDER_AUTOMATIONS_READ,
  DEFENDER_AUTOMATIONS_WRITE,
  DEFENDER_NAMESPACE_ACTIONS,
  DEFENDER_PRICINGS_READ,
} from "../defender-export/defender-permissions";
import {
  AUTOMATION_PERMISSIONS,
  ITEM_AVAILABILITY,
  automationPermissionView,
  automationPermissionsFor,
  undeclaredAutomatableItems,
} from "./index";
import type { AutomationPermissions } from "./index";
import { LEAST_PRIVILEGE_OPERATIONS } from "../least-privilege";

describe("AUTOMATION_PERMISSIONS reads its roles from the least-privilege registry (architecture audit 2026-11-04)", () => {
  // AZR-60 and AZR-61 were built on parallel branches: the section table named
  // its own roles while AZR-61 made the registry the one source of them. Each
  // measured action must be a registry operation, and its role that operation's
  // least role, so the banner and the change requests cannot ask for different roles.
  it("names, for every measured action, the registry's least role for that action", () => {
    const wrong: string[] = [];
    for (const [item, p] of Object.entries(AUTOMATION_PERMISSIONS)) {
      for (const need of p?.measured ?? []) {
        const ops = Object.values(LEAST_PRIVILEGE_OPERATIONS).filter((op) => op.operation === need.action);
        if (ops.length === 0) wrong.push(`${item}: ${need.action} is not a registry operation`);
        else if (!ops.some((op) => op.leastRole === need.role)) {
          wrong.push(`${item}: ${need.action} names ${need.role}, the registry ${ops.map((op) => op.leastRole).join(" / ")}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

const CONNECTED: CapabilityContext = { azureIdentityPresent: true, criblReachable: true };
const NO_IDENTITY: CapabilityContext = { azureIdentityPresent: false, criblReachable: true };
const HOWTO_SECTION = 8;

function defender(): AutomationPermissions {
  const p = automationPermissionsFor("defenderExport");
  if (p === null) throw new Error("defenderExport has no declaration");
  return p;
}

/** An audited set: the three Defender verdicts as given, absent when undefined. */
function audited(verdicts: {
  plans?: CapabilityVerdict;
  read?: CapabilityVerdict;
  write?: CapabilityVerdict;
}): CapabilitySet {
  const v: CapabilitySet["verdicts"] = {
    ...(verdicts.plans === undefined ? {} : { "defender-plans.read": verdicts.plans }),
    ...(verdicts.read === undefined ? {} : { "defender-automation.read": verdicts.read }),
    ...(verdicts.write === undefined ? {} : { "defender-automation.write": verdicts.write }),
  };
  return { verdicts: v, auditedAt: "2026-11-03T10:00:00.000Z", connectionId: "conn" };
}

function view(
  capabilities: CapabilitySet | undefined,
  context: CapabilityContext | undefined = CONNECTED,
  extra: { auditKey?: string; nowIso?: string } = {},
) {
  return automationPermissionView({
    permissions: defender(),
    capabilities,
    context,
    howtoSection: HOWTO_SECTION,
    ...extra,
  });
}

const DENIAL_WORDS = /\bdenied\b|\bcannot\b|\brefused\b/i;

describe("the declaration", () => {
  it("declares every automatable item and no other", () => {
    const automatable = Object.entries(ITEM_AVAILABILITY)
      .filter(([, a]) => a.status === "available")
      .map(([id]) => id)
      .sort();
    expect(Object.keys(AUTOMATION_PERMISSIONS).sort()).toEqual(automatable);
    expect(undeclaredAutomatableItems(ITEM_AVAILABILITY, AUTOMATION_PERMISSIONS)).toEqual([]);
  });

  it("the coverage check fails when a source becomes automatable undeclared (the pin can fail)", () => {
    const planted = { ...ITEM_AVAILABILITY, entraId: { status: "available" as const } };
    expect(undeclaredAutomatableItems(planted, AUTOMATION_PERMISSIONS)).toEqual(["entraId"]);
  });

  it("a not-built source has no declaration: there is nothing to automate, so no banner", () => {
    for (const [id, a] of Object.entries(ITEM_AVAILABILITY)) {
      if (a.status === "not-built") expect(automationPermissionsFor(id), id).toBeNull();
    }
  });

  it("Defender measures exactly plans.read, automation.read and automation.write, keyed on the preflight's actions", () => {
    const p = defender();
    expect(p.measured.map((n) => n.capability)).toEqual([
      "defender-plans.read",
      "defender-automation.read",
      "defender-automation.write",
    ]);
    expect(p.measured.map((n) => n.action)).toEqual([
      DEFENDER_PRICINGS_READ,
      DEFENDER_AUTOMATIONS_READ,
      DEFENDER_AUTOMATIONS_WRITE,
    ]);
    for (const n of p.measured) {
      expect(AZURE_CAPABILITIES).toContain(n.capability);
      expect(n.does.length).toBeGreaterThan(0);
      expect(n.role.length).toBeGreaterThan(0);
    }
  });

  it("only the write is grant-only, and plans.read is the one capability deploy does not need", () => {
    const p = defender();
    expect(p.measured.filter((n) => n.grantOnly).map((n) => n.capability)).toEqual([
      "defender-automation.write",
    ]);
    expect(p.measured.filter((n) => n.necessity === "informational").map((n) => n.capability)).toEqual([
      "defender-plans.read",
    ]);
  });

  it("keeps the namespace listKeys listed as not measured", () => {
    const actions = defender().notMeasured.flatMap((g) => g.actions.map((a) => a.action));
    expect(actions).toEqual(DEFENDER_NAMESPACE_ACTIONS.map((a) => a.action));
    expect(actions[0]).toMatch(/listKeys\/action$/);
  });
});

describe("automationPermissionView", () => {
  it("granted: every row granted, no banner, no deploy caution", () => {
    const v = view(audited({ plans: "granted", read: "granted", write: "granted" }));
    expect(v.rows.map((r) => r.state)).toEqual(["granted", "granted", "granted"]);
    expect(v.banner).toBeNull();
    expect(v.deployCaution).toBeNull();
  });

  it("denied: an error banner naming the action, the role and the How-to section; a deploy caution with it", () => {
    const v = view(audited({ plans: "granted", read: "denied", write: "granted" }));
    expect(v.rows.map((r) => r.state)).toEqual(["granted", "denied", "granted"]);
    expect(v.banner?.kind).toBe("denied");
    expect(v.banner?.tone).toBe("error");
    expect(v.banner?.text).toContain("Azure will likely refuse");
    expect(v.banner?.text).not.toMatch(/cannot set .* up|blocked/);
    expect(v.banner?.offerRecheck).toBe(true);
    const text = v.banner?.text ?? "";
    expect(text).toContain("your Azure identity cannot list the subscription's continuous exports");
    expect(text).toContain("Defender for Cloud alert export");
    expect(text).toContain("section 8");
    expect(text).toContain("Security Reader");
    expect(v.deployCaution).toContain(DEFENDER_AUTOMATIONS_READ);
    expect(v.deployCaution).toContain("section 8");
  });

  it("denial copy says how to reach the How-to steps: the row must be switched to How-to first", () => {
    // The Defender row is in Automate mode while this section renders, and the
    // How-to section lists steps only for How-to rows.
    const v = view(audited({ read: "denied" }));
    expect(v.banner?.text).toContain("switch Defender for Cloud alert export to How-to in section 8");
    expect(v.deployCaution).toContain("switch it to How-to in section 8");
  });

  it("denial copy says how old the check is, and offers Re-check before anything else", () => {
    const v = view(audited({ read: "denied" }), CONNECTED, { nowIso: "2026-11-06T10:00:00.000Z" });
    expect(v.banner?.text).toMatch(/^The permission check 3 days ago found/);
    expect(v.deployCaution).toMatch(/^Azure will likely refuse this deploy: the permission check 3 days ago found/);
    expect(v.deployCaution).toContain("Deploy stays available");
    const reason = v.deployCaution ?? "";
    expect(reason.indexOf("Re-check permissions")).toBeGreaterThan(-1);
    expect(reason.indexOf("Re-check permissions")).toBeLessThan(reason.indexOf("How-to"));
    // Without a clock the copy still says it is the LAST check, not a present fact.
    expect(view(audited({ read: "denied" })).banner?.text).toMatch(/^The last permission check found/);
  });

  it("a set measured for ANOTHER connection is never-checked here: no denial wording and no caution", () => {
    // The audit hook keeps the previous connection's set until the new audit
    // lands; its verdicts answer a different question.
    const v = view(audited({ plans: "denied", read: "denied", write: "denied" }), CONNECTED, {
      auditKey: "other-connection",
    });
    expect(v.rows.map((r) => r.state)).toEqual(["never-checked", "never-checked", "never-checked"]);
    expect(v.banner?.kind).toBe("not-measured");
    expect(v.banner?.text).not.toMatch(DENIAL_WORDS);
    for (const r of v.rows) expect(r.stateLabel).not.toMatch(DENIAL_WORDS);
    expect(v.deployCaution).toBeNull();
    // The same set under its own key still cautions (the guard is not "never caution").
    expect(view(audited({ read: "denied" }), CONNECTED, { auditKey: "conn" }).deployCaution).not.toBeNull();
  });

  it("row labels stay short: a denial says Denied once, the grant-only miss names its kind", () => {
    const denied = view(audited({ read: "denied" })).rows.find((r) => r.state === "denied");
    expect(denied?.stateLabel).toBe("Denied");
    const grantOnly = view(audited({ read: "granted" })).rows.find((r) => r.need.grantOnly);
    expect(grantOnly?.stateLabel).toBe("Not measured (grant-only check)");
  });

  it("denied names every missing core action, and still cautions when the others are unmeasured", () => {
    // The write is grant-only, so a cached `denied` for it must not count;
    // automations/read alone is what cautions here.
    const v = view(audited({ read: "denied" }));
    expect(v.banner?.kind).toBe("denied");
    expect(v.rows.map((r) => r.state)).toEqual(["unknown", "denied", "unknown"]);
    expect(v.deployCaution).not.toBeNull();
  });

  it("unknown: the audit ran but did not measure these - a soft note with Re-check, never worded as denied", () => {
    const v = view(audited({}));
    expect(v.rows.map((r) => r.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(v.banner?.kind).toBe("not-measured");
    expect(v.banner?.tone).toBe("info");
    expect(v.banner?.offerRecheck).toBe(true);
    expect(v.banner?.text).not.toMatch(DENIAL_WORDS);
    for (const r of v.rows) expect(r.stateLabel).not.toMatch(DENIAL_WORDS);
    expect(v.deployCaution).toBeNull();
  });

  it("never-checked: no audit has run (an empty set, or no set wired) - a soft note, no deploy caution", () => {
    for (const set of [{ verdicts: {}, auditedAt: null, connectionId: null }, undefined]) {
      const v = view(set);
      expect(v.rows.map((r) => r.state)).toEqual(["never-checked", "never-checked", "never-checked"]);
      expect(v.banner?.kind).toBe("not-measured");
      expect(v.banner?.text).toMatch(/not been checked/);
      expect(v.banner?.text).not.toMatch(DENIAL_WORDS);
      expect(v.banner?.offerRecheck).toBe(true);
      expect(v.deployCaution).toBeNull();
    }
  });

  it("grant-only: a write that is not granted reads unknown, never denied, and never cautions deploy", () => {
    // What capability-mapping records for a miss (nothing), and a cached
    // `denied` from a set written before the grant-only rule - both unknown.
    for (const write of [undefined, "denied" as const]) {
      const v = view(audited({ plans: "granted", read: "granted", write }));
      const row = v.rows.find((r) => r.need.capability === "defender-automation.write");
      expect(row?.state).toBe("unknown");
      expect(row?.stateLabel).toMatch(/grant-only/);
      expect(v.banner?.text).toMatch(/resource group/);
      expect(row?.stateLabel).not.toMatch(DENIAL_WORDS);
      expect(v.banner?.kind).toBe("not-measured");
      expect(v.banner?.text).not.toMatch(DENIAL_WORDS);
      expect(v.deployCaution).toBeNull();
    }
  });

  it("no Azure identity: unreachable, said as a connection fact, no Re-check offered", () => {
    const v = view({ verdicts: {}, auditedAt: null, connectionId: null }, NO_IDENTITY);
    expect(v.rows.map((r) => r.state)).toEqual(["unreachable", "unreachable", "unreachable"]);
    expect(v.banner?.kind).toBe("not-measured");
    expect(v.banner?.offerRecheck).toBe(false);
    expect(v.banner?.text).toMatch(/No Azure identity is connected/);
    expect(v.deployCaution).toBeNull();
  });

  it("a denied capability deploy does not need warns without a deploy caution", () => {
    const v = view(audited({ plans: "denied", read: "granted", write: "granted" }));
    expect(v.banner?.kind).toBe("partial");
    expect(v.banner?.tone).toBe("warning");
    expect(v.banner?.text).toContain("read which Defender plans are enabled");
    expect(v.deployCaution).toBeNull();
  });
});

describe("the Activity Log declaration (AZR-98): nothing is measured, and the view says so", () => {
  function activityLog(): AutomationPermissions {
    const p = automationPermissionsFor("activityLog");
    if (p === null) throw new Error("activityLog has no declaration");
    return p;
  }

  it("lists the subscription and rule actions from the registry, all unmeasured", () => {
    const p = activityLog();
    expect(p.measured).toEqual([]);
    expect(p.notMeasured.map((g) => g.scope)).toEqual(["On the subscription", "On the Event Hub namespace rule"]);
    expect(p.notMeasured.flatMap((g) => g.actions.map((a) => a.action))).toEqual([
      LEAST_PRIVILEGE_OPERATIONS["activityLog.diagnosticSettings.read"].operation,
      LEAST_PRIVILEGE_OPERATIONS["activityLog.diagnosticSetting.write"].operation,
      LEAST_PRIVILEGE_OPERATIONS["eventhub.rule.listKeys"].operation,
    ]);
  });

  it("shows a not-measured banner whatever the cached set says - never silence, never a denial, never a caution", () => {
    const sets: (CapabilitySet | undefined)[] = [
      undefined,
      audited({ plans: "denied", read: "denied", write: "denied" }),
    ];
    for (const capabilities of sets) {
      const v = automationPermissionView({ permissions: activityLog(), capabilities, context: CONNECTED, howtoSection: HOWTO_SECTION });
      expect(v.banner?.kind).toBe("not-measured");
      expect(v.banner?.text).toContain("does not measure");
      expect(v.banner?.text).not.toMatch(DENIAL_WORDS);
      expect(v.deployCaution).toBeNull();
      expect(v.rows).toEqual([]);
    }
  });
});
