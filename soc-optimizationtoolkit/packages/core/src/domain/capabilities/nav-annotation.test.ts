/**
 * Contract tests for nav annotation (capability-model-plan step 3).
 *
 * This module replaces filterNavItems, and the replacement INVERTS the
 * behaviour, so the pins are mostly about what must NOT happen:
 *   - nothing is ever hidden, in any state, for any reason;
 *   - `unknown` never renders as `denied`;
 *   - a denied item stays attemptable and names its fallback;
 *   - a read capability's denial honestly admits there is no substitute.
 */
import { describe, expect, it } from "vitest";

import {
  annotateNavItems,
  unavailableCount,
  type NavItemCapabilities,
} from "./nav-annotation";
import { emptyCapabilitySet } from "./capabilities";
import type { CapabilityContext, CapabilitySet } from "./capabilities";
import { AZURE_CAPABILITIES, CRIBL_CAPABILITIES } from "./capabilities";
import { fallbackFor } from "./fallbacks";

const connected: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};
const disconnected: CapabilityContext = {
  azureIdentityPresent: false,
  criblReachable: false,
};

const audited = (verdicts: CapabilitySet["verdicts"]): CapabilitySet => ({
  verdicts,
  auditedAt: "2026-08-06T00:00:00Z",
  connectionId: "conn-1",
});

const ROUTES: NavItemCapabilities[] = [
  { id: "home", requires: [] },
  { id: "integrate", requires: ["dcr.write", "pack.manage"] },
  { id: "dcr-automation", requires: ["dcr.write"] },
  { id: "packs", requires: ["pack.manage"] },
  { id: "preflight", requires: ["workspace.read"] },
];

const byId = <T extends NavItemCapabilities>(
  annotated: ReturnType<typeof annotateNavItems<T>>,
  id: string,
) => annotated.find((entry) => entry.item.id === id)!;

// ---------------------------------------------------------------------------
// Nothing is ever hidden
// ---------------------------------------------------------------------------

describe("no route is ever hidden", () => {
  it("returns every item in input order, whatever the state", () => {
    // The inversion, stated as a test. filterNavItems removed items; this must
    // never remove one, in ANY state - including the worst one.
    const states: [CapabilitySet, CapabilityContext][] = [
      [emptyCapabilitySet(), connected],
      [emptyCapabilitySet(), disconnected],
      [audited({ "dcr.write": "denied", "pack.manage": "denied" }), connected],
      [audited({ "dcr.write": "granted", "pack.manage": "granted" }), connected],
    ];
    for (const [set, context] of states) {
      const annotated = annotateNavItems(ROUTES, set, context);
      expect(annotated).toHaveLength(ROUTES.length);
      expect(annotated.map((entry) => entry.item.id)).toEqual(
        ROUTES.map((route) => route.id),
      );
    }
  });

  it("keeps items available when they need nothing", () => {
    // The generation-only surfaces: they worked air-gapped before and must
    // still read as fully available with no connection at all.
    const annotated = annotateNavItems(ROUTES, emptyCapabilitySet(), disconnected);
    const home = byId(annotated, "home");
    expect(home.availability).toBe("available");
    expect(home.reason).toBeNull();
    expect(home.attemptable).toBe(true);
  });

  it("preserves the original item untouched", () => {
    const annotated = annotateNavItems(ROUTES, emptyCapabilitySet(), connected);
    expect(annotated[0]!.item).toBe(ROUTES[0]);
  });
});

// ---------------------------------------------------------------------------
// unknown never reads as denied
// ---------------------------------------------------------------------------

describe("unknown never renders as denied", () => {
  it("is 'unknown' when connected but unaudited", () => {
    const annotated = annotateNavItems(ROUTES, emptyCapabilitySet(), connected);
    const integrate = byId(annotated, "integrate");
    expect(integrate.availability).toBe("unknown");
    expect(integrate.reason).toContain("Not checked yet");
    expect(integrate.reason).not.toContain("cannot");
  });

  it("offers no fallback for an unmeasured capability", () => {
    // An unmeasured capability has not been shown to need a workaround, and
    // offering one would imply we know it is blocked.
    const annotated = annotateNavItems(ROUTES, emptyCapabilitySet(), connected);
    expect(byId(annotated, "integrate").fallback).toBeNull();
  });

  it("never reports 'denied' from an empty set, in any context", () => {
    for (const context of [connected, disconnected]) {
      const annotated = annotateNavItems(ROUTES, emptyCapabilitySet(), context);
      for (const entry of annotated) {
        expect(entry.availability).not.toBe("denied");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Denied informs and offers - it never forbids
// ---------------------------------------------------------------------------

describe("a denied item still works", () => {
  it("stays attemptable", () => {
    // Rule 3. Azure's own 403 is the real gate; a wrong or stale audit must not
    // cost the operator the ability to try.
    const annotated = annotateNavItems(
      ROUTES,
      audited({ "dcr.write": "denied" }),
      connected,
    );
    const dcr = byId(annotated, "dcr-automation");
    expect(dcr.availability).toBe("denied");
    expect(dcr.attemptable).toBe(true);
  });

  it("names its fallback artifact", () => {
    const annotated = annotateNavItems(
      ROUTES,
      audited({ "dcr.write": "denied" }),
      connected,
    );
    const dcr = byId(annotated, "dcr-automation");
    expect(dcr.fallback?.kind).toBe("dcr-arm-bodies");
    expect(dcr.reason).toContain("still try");
    expect(dcr.reason?.toLowerCase()).toContain("dcr arm request bodies");
  });

  it("reports which capabilities are missing", () => {
    const annotated = annotateNavItems(
      ROUTES,
      audited({ "dcr.write": "denied", "pack.manage": "granted" }),
      connected,
    );
    expect(byId(annotated, "integrate").missing).toEqual(["dcr.write"]);
  });

  it("admits when a blocked READ has no substitute", () => {
    // The plan is explicit: without live read access discovery cannot run, and
    // the honest UI says so rather than inventing an offline artifact.
    const annotated = annotateNavItems(
      ROUTES,
      audited({ "workspace.read": "denied" }),
      connected,
    );
    const preflight = byId(annotated, "preflight");
    expect(preflight.fallback).toBeNull();
    expect(preflight.reason).toContain("no offline substitute");
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe("the worst verdict governs", () => {
  it("ranks unreachable above denied", () => {
    // Telling someone their permissions are missing when they never connected
    // sends them to the wrong place entirely.
    const annotated = annotateNavItems(
      [{ id: "mixed", requires: ["dcr.write", "pack.manage"] }],
      audited({ "dcr.write": "denied" }),
      { azureIdentityPresent: true, criblReachable: false },
    );
    expect(annotated[0]!.availability).toBe("unreachable");
    expect(annotated[0]!.reason).toContain("Connect Cribl");
  });

  it("ranks denied above unknown", () => {
    const annotated = annotateNavItems(
      [{ id: "mixed", requires: ["dcr.write", "table.write"] }],
      audited({ "dcr.write": "denied" }),
      connected,
    );
    expect(annotated[0]!.availability).toBe("denied");
  });

  it("is available only when EVERY requirement is granted", () => {
    const set = audited({ "dcr.write": "granted" });
    const annotated = annotateNavItems(ROUTES, set, connected);
    expect(byId(annotated, "dcr-automation").availability).toBe("available");
    // integrate also needs pack.manage, which is unmeasured.
    expect(byId(annotated, "integrate").availability).toBe("unknown");
  });

  it("names both sides when both are unreachable", () => {
    const annotated = annotateNavItems(
      [{ id: "mixed", requires: ["dcr.write", "pack.manage"] }],
      emptyCapabilitySet(),
      disconnected,
    );
    expect(annotated[0]!.reason).toContain("Connect Azure and Cribl");
  });
});

// ---------------------------------------------------------------------------
// The no-identity offer
// ---------------------------------------------------------------------------

describe("no identity at all", () => {
  it("offers the app-registration request", () => {
    // A different situation from a denied permission: nobody can grant you
    // anything until the App registration exists.
    const annotated = annotateNavItems(
      ROUTES,
      emptyCapabilitySet(),
      { azureIdentityPresent: false, criblReachable: true },
    );
    const dcr = byId(annotated, "dcr-automation");
    expect(dcr.availability).toBe("unreachable");
    expect(dcr.fallback?.kind).toBe("app-registration-request");
    expect(dcr.attemptable).toBe(false);
  });

  it("does not offer it for a Cribl-only requirement", () => {
    const annotated = annotateNavItems(
      ROUTES,
      emptyCapabilitySet(),
      { azureIdentityPresent: false, criblReachable: false },
    );
    expect(byId(annotated, "packs").fallback).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fallback coverage
// ---------------------------------------------------------------------------

describe("fallback catalog", () => {
  it("covers every WRITE/manage capability", () => {
    // Rule 2: nothing may be merely disabled. Every capability that changes
    // something must have an artifact someone else could run.
    const writes = [...AZURE_CAPABILITIES, ...CRIBL_CAPABILITIES].filter(
      (capability) => !capability.endsWith(".read"),
    );
    for (const capability of writes) {
      expect(fallbackFor(capability), capability).not.toBeNull();
    }
  });

  it("deliberately covers no READ capability", () => {
    const reads = AZURE_CAPABILITIES.filter((c) => c.endsWith(".read"));
    expect(reads.length).toBeGreaterThan(0);
    for (const capability of reads) {
      expect(fallbackFor(capability), capability).toBeNull();
    }
  });
});

describe("unavailableCount", () => {
  it("counts without removing anything", () => {
    const annotated = annotateNavItems(ROUTES, emptyCapabilitySet(), disconnected);
    expect(annotated).toHaveLength(ROUTES.length);
    // Every route except 'home' needs something.
    expect(unavailableCount(annotated)).toBe(ROUTES.length - 1);
  });
});
