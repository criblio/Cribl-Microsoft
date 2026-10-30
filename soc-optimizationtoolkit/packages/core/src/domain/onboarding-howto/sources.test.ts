import { describe, expect, it, vi } from "vitest";
import { COVERAGE_CATALOG, UNSUPPORTED_SOURCES } from "../coverage-model";
import { ENTRA_PROFILE_CATEGORIES } from "../entra-diagnostics/entra-categories";
import { itemAvailability } from "../onboarding-sections";
import { defaultPlanValues } from "./plan-values";
import {
  ONBOARDING_SOURCES,
  isAutomatable,
  isOnboardingSourceId,
  onboardingSource,
} from "./index";

describe("ONBOARDING_SOURCES", () => {
  it("is exactly the coverage catalog ids followed by vnetFlowLogs and nsgFlowLogs", () => {
    expect(ONBOARDING_SOURCES.map((s) => s.id)).toEqual([
      ...COVERAGE_CATALOG.map((i) => i.id),
      "vnetFlowLogs",
      "nsgFlowLogs",
    ]);
  });

  it("takes every title from the catalog or UNSUPPORTED_SOURCES, never retyped", () => {
    for (const s of ONBOARDING_SOURCES) {
      const want =
        COVERAGE_CATALOG.find((i) => i.id === s.id)?.title ??
        UNSUPPORTED_SOURCES.find((u) => u.id === s.id)?.title;
      expect(want, s.id).toBeDefined();
      expect(s.title).toBe(want);
    }
  });

  it("never uses the destination type azure_eventhub as an input type", () => {
    for (const s of ONBOARDING_SOURCES) {
      expect(s.criblInputType).not.toBe("azure_eventhub");
      expect(s.criblInputType).toBe(s.transport === "blob" ? "azure_blob" : "eventhub");
    }
    expect(ONBOARDING_SOURCES.filter((s) => s.transport === "blob").map((s) => s.id)).toEqual([
      "vnetFlowLogs",
      "nsgFlowLogs",
    ]);
  });

  it("gives blob sources no hub and a container, Event Hub sources a hub naming and no container", () => {
    for (const s of ONBOARDING_SOURCES) {
      if (s.transport === "blob") {
        expect(s.hubNaming).toBeNull();
        expect(s.defaultContainer).not.toBeNull();
      } else {
        expect(s.hubNaming).not.toBeNull();
        expect(s.defaultContainer).toBeNull();
      }
    }
  });

  it("expects the Entra Standard hubs from the profile categories, lowercased", () => {
    const entra = onboardingSource("entraId")!;
    const values = defaultPlanValues(null);
    expect(entra.expectedHubNames(values, ["Standard"])).toEqual(
      ENTRA_PROFILE_CATEGORIES.Standard.map((c) => `insights-logs-${c.toLowerCase()}`),
    );
    expect(entra.expectedHubNames(values, ["Standard"])).not.toContain(
      "insights-logs-noninteractiveusersigninlogs",
    );
    // Absent sub-selection means the catalog default (Standard).
    expect(entra.expectedHubNames(values, [])).toEqual(
      entra.expectedHubNames(values, ["Standard"]),
    );
  });

  it("expects the Defender export to write to the plan hub, and nothing when it is unset", () => {
    const d = onboardingSource("defenderExport")!;
    expect(d.hubNaming).toBe("named");
    expect(d.expectedHubNames({ ...defaultPlanValues(null), hubName: " h1 " }, [])).toEqual(["h1"]);
    expect(d.expectedHubNames(defaultPlanValues(null), [])).toEqual([]);
  });

  it("knows no hub names for policy initiatives, only the auto-created prefix", () => {
    for (const id of ["diagnosticSettingsInitiative", "communityPolicyInitiative"]) {
      const s = onboardingSource(id)!;
      expect(s.expectedHubNames({ ...defaultPlanValues(null), hubName: "x" }, ["All"])).toEqual([]);
      expect(s.autoCreatedHubPrefix).toBe("insights-logs-");
    }
  });

  it("looks up by id without throwing on an unknown id", () => {
    expect(onboardingSource("nope")).toBeUndefined();
    expect(isOnboardingSourceId("nope")).toBe(false);
    expect(isOnboardingSourceId("nsgFlowLogs")).toBe(true);
  });
});

describe("isAutomatable", () => {
  it("equals itemAvailability(id) === available for every source (derived, not copied)", () => {
    for (const s of ONBOARDING_SOURCES) {
      expect(isAutomatable(s.id), s.id).toBe(itemAvailability(s.id).status === "available");
    }
  });

  it("follows itemAvailability when it changes, so a copied literal fails", async () => {
    vi.resetModules();
    vi.doMock("../onboarding-sections", async (orig) => {
      const real = await orig<typeof import("../onboarding-sections")>();
      return {
        ...real,
        itemAvailability: (id: string) =>
          id === "entraId" ? { status: "available" } : real.itemAvailability(id),
      };
    });
    try {
      const fresh = await import("./sources");
      expect(fresh.isAutomatable("entraId")).toBe(true);
      expect(fresh.isAutomatable("defenderExport")).toBe(true);
      expect(fresh.isAutomatable("activityLog")).toBe(false);
    } finally {
      vi.doUnmock("../onboarding-sections");
      vi.resetModules();
    }
  });

  it("is today exactly the Defender export", () => {
    expect(ONBOARDING_SOURCES.filter((s) => isAutomatable(s.id)).map((s) => s.id)).toEqual([
      "defenderExport",
    ]);
  });
});

