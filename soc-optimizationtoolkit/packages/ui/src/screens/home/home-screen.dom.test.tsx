// @vitest-environment happy-dom
/**
 * DBT-246: Home renders the disconnected journey. The connect stage is
 * "Not needed" (the same tag Sentinel Integration uses for a not-needed
 * section), the readiness chips read "not used", and the next action no
 * longer tells the operator to enter an Azure identity.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { AzureConfig, JourneyFacts } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { HomeScreen } from "./home-screen";

afterEach(cleanup);

const CONFIG = {
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
} as unknown as AzureConfig;

const DISCONNECTED: JourneyFacts = {
  accepted: true,
  identityPresent: false,
  secretLive: "missing",
  scopeCommitted: false,
  connectivity: "disconnected",
  scopeNeed: "none",
  subscriptionChosen: false,
  tokenRequired: false,
};

function mount(facts: JourneyFacts): HTMLElement {
  const ports = { jobs: { list: vi.fn(async () => []) } } as unknown as UiPorts;
  return render(
    <PortsProvider ports={ports} config={CONFIG}>
      <HomeScreen facts={facts} onNavigate={() => {}} />
    </PortsProvider>,
  ).container;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Home while disconnected from Azure (DBT-246)", () => {
  it("does not ask for an Azure identity", () => {
    const text = mount(DISCONNECTED).textContent ?? "";
    expect(occurrences(text, "Enter your Azure identity")).toBe(0);
  });

  it("reads all three chips as 'not used'", () => {
    const container = mount(DISCONNECTED);
    const chips = Array.from(container.querySelectorAll(".readiness-chip-not-used"));
    expect(chips.map((c) => c.textContent)).toEqual([
      "Identity: not used",
      "Secret: not used",
      "Scope: not used",
    ]);
  });

  it("tags the not-needed stages 'Not needed'", () => {
    const container = mount(DISCONNECTED);
    const notNeeded = Array.from(container.querySelectorAll(".journey-step-not-needed"));
    expect(notNeeded.length).toBeGreaterThan(0);
    for (const li of notNeeded) {
      expect(li.querySelectorAll(".numbered-section-info-tag")).toHaveLength(1);
      expect(li.querySelector(".numbered-section-info-tag")?.textContent).toBe("Not needed");
    }
  });
});
