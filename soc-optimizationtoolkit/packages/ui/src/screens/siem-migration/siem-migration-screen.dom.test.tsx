// @vitest-environment happy-dom
/**
 * DBT-102: the SIEM pivot deletes every acquired sample and its own button
 * said nothing.
 *
 * WHY THE PIN IS HERE AND NOT ONLY IN THE STATE MODULE. Everything this file
 * asserts is COPY sitting next to a control, and the state module beside it
 * (siem-migration-state.ts, thoroughly unit-tested) cannot see a word of it.
 * That is the exact shape of the gap the integrate-screen smoke pin was opened
 * for: the file with tests was not the file with the defect. Before this file
 * existed nothing in the repo rendered SiemMigrationScreen at all.
 *
 * WHAT IS BEING PROTECTED, and it is a property rather than a sentence. The
 * pivot is presented as navigation and is not only navigation: on the Integrate
 * side it reaches handleSolutionChange, which removes every tagged sample when
 * the solution really changes. The DBT-72 decision accepted that deletion at
 * Clear selection - a button whose own copy says so (DBT-9) - and did not make
 * every route allowed to delete silently. So the assertions below are "this
 * control's block names the deletion, names samples, and points at the button
 * that already carries the same warning", not "this control's block contains
 * the following paragraph". A wording edit must not fail this; dropping the
 * warning must.
 *
 * THE DELETION ITSELF is pinned on the other side of the handoff, in
 * integrate-screen.dom.test.tsx - the copy here is only honest if that keeps
 * passing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { serializeMigrationPlan } from "@soc/core";
import type { AzureConfig, MigrationPlan } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { SIEM_MIGRATION_PLAN_KEY } from "./siem-migration-state";
import { SiemMigrationScreen } from "./siem-migration-screen";

afterEach(cleanup);

// The pivot WRITES the hash, so a leftover from one case would be the next
// case's starting state.
beforeEach(() => {
  window.location.hash = "#/";
});

const CONFIG = {
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
} as unknown as AzureConfig;

/**
 * A restored plan with two mapped solutions, so "the warning renders once, not
 * once per card" is a claim with something to be wrong about. "Cisco ASA" is
 * the knowledge base's own string for a `cisco_` Splunk macro with no direct
 * entry of its own, and the repo folder it has to reach is "CiscoASA" - the
 * pair DBT-28 defect (1) is about, kept here so the two cards stay describing
 * one product path. The plan is written out rather than produced by the
 * analyzer, so a knowledge-base correction (DBT-103 is editing that table now)
 * changes nothing here.
 */
const PLAN: MigrationPlan = {
  platform: "splunk",
  fileName: "savedsearches.json",
  totalRules: 4,
  enabledRules: 4,
  buildingBlocks: 0,
  dataSources: [
    {
      id: "cisco_firewall",
      name: "cisco_firewall",
      platform: "splunk",
      platformIdentifiers: ["cisco_firewall"],
      ruleCount: 3,
      rules: ["Firewall deny spike"],
      mitreTactics: [],
      mitreTechniques: [],
      sentinelSolution: "Cisco ASA",
      sentinelTable: "CommonSecurityLog",
      confidence: "medium",
      sentinelAnalyticRules: [],
    },
    {
      id: "zscaler_web",
      name: "zscaler_web",
      platform: "splunk",
      platformIdentifiers: ["zscaler_web"],
      ruleCount: 1,
      rules: ["Web proxy anomaly"],
      mitreTactics: [],
      mitreTechniques: [],
      sentinelSolution: "Zscaler",
      sentinelTable: "CommonSecurityLog",
      confidence: "high",
      sentinelAnalyticRules: [],
    },
  ],
  unmappedRules: [],
  mitreCoverage: [],
  totalSentinelRules: 0,
};

function portsWith(planJson: string | null): UiPorts {
  return {
    contentCache: {
      get: vi.fn(async (key: string) =>
        key === SIEM_MIGRATION_PLAN_KEY ? planJson : null,
      ),
      set: vi.fn().mockResolvedValue(undefined),
    },
    artifacts: { save: vi.fn().mockResolvedValue(undefined) },
  } as unknown as UiPorts;
}

async function renderWithPlan(onOpenIntegration = vi.fn()) {
  render(
    <PortsProvider
      ports={portsWith(serializeMigrationPlan(PLAN))}
      config={CONFIG}
    >
      <SiemMigrationScreen onOpenIntegration={onOpenIntegration} />
    </PortsProvider>,
  );
  await waitFor(() => {
    expect(screen.getAllByText("Open in Sentinel Integration").length).toBe(2);
  });
  return onOpenIntegration;
}

function warning(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".siem-pivot-warning");
}

describe("SiemMigrationScreen pivot warning (DBT-102)", () => {
  it("warns that the pivot DELETES samples, and names the button that already said so", async () => {
    await renderWithPlan();
    const block = warning();
    expect(block).toBeTruthy();
    const text = block?.textContent ?? "";
    // The destructive claim itself. Loose on wording, exact on substance: the
    // block has to name the act and the thing destroyed.
    expect(text).toMatch(/delet/i);
    expect(text).toMatch(/samples?/i);
    // ...and tie it to the one place the product already warns about the same
    // deletion, so an operator who has read one recognises the other. This is
    // the DBT-9 copy, verbatim vocabulary.
    expect(text).toMatch(/clear selection/i);
    // The other half of the honesty, which is DBT-28 defect (2) said out loud
    // rather than fixed: the switch is inert once Integrate is already mounted.
    expect(text).toMatch(
      /has not been opened|already been there|nothing on that screen changes/i,
    );
    // AND THAT INERTNESS IS NOT AN ABSOLUTION (review 2026-09-04). The copy
    // used to end at "this button navigates and leaves the selection alone",
    // which is true only at the instant of the click: openInIntegration writes
    // the hash unconditionally, nothing consumes or clears it while the route
    // is mounted, so the press ARMS the switch for the next fresh load.
    // Measured on the Integrate side - inert now, applied and destructive on a
    // fresh mount carrying the same hash - and pinned there. Asserted on
    // substance, not wording: the block has to say the press still changes the
    // link, and that a later load applies it.
    expect(text).toMatch(/still rewrites|still changes|nothing clears it/i);
    expect(text).toMatch(/next time the app loads|later load|next load/i);
    expect(text).toMatch(/never a no-op|is never a no op/i);
  });

  it("puts the warning ONCE, ahead of every pivot button", async () => {
    await renderWithPlan();
    // Once, not once per card - two cards render here, so a per-card warning
    // would show up as two nodes.
    expect(document.querySelectorAll(".siem-pivot-warning").length).toBe(1);
    const block = warning();
    const buttons = screen.getAllByText("Open in Sentinel Integration");
    expect(buttons.length).toBe(2);
    // AHEAD of them in document order: a warning an operator reaches after
    // pressing the button is not a warning. DOCUMENT_POSITION_FOLLOWING is set
    // on the argument when it comes after the reference node.
    for (const button of buttons) {
      expect(
        (block?.compareDocumentPosition(button) ?? 0) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("does not warn about a pivot when there is no plan to pivot from", async () => {
    // NON-VACUITY for the two pins above. A warning hard-coded into the page
    // frame would satisfy both while shouting at an operator who has not
    // uploaded anything yet.
    render(
      <PortsProvider ports={portsWith(null)} config={CONFIG}>
        <SiemMigrationScreen onOpenIntegration={vi.fn()} />
      </PortsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Upload detection rules/i)).toBeTruthy();
    });
    expect(warning()).toBeNull();
    expect(screen.queryByText("Open in Sentinel Integration")).toBeNull();
  });

  it("still performs the handoff the warning describes", async () => {
    // The warning must not be describing a control that stopped working. Both
    // halves of the pivot are asserted: the deep link is written FIRST (the
    // Integrate screen reads the hash in its mount initializer, so a navigate
    // that beat the write would hand over nothing), then the shell navigates.
    const onOpen = await renderWithPlan();
    const buttons = screen.getAllByText("Open in Sentinel Integration");
    fireEvent.click(buttons[0]);
    expect(window.location.hash).toBe("#/?solution=Cisco%20ASA");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
