// @vitest-environment happy-dom
/**
 * Surface pin for the delivery-fit badge column (DBT-15).
 *
 * The derivation is pinned without a DOM in
 * packages/core/src/domain/sentinel-content/delivery-fit-badge.test.ts. What
 * that cannot see is the half that actually shipped the defect: the JSX
 * rendered the badge behind `ingestion !== null &&`, so a solution the shipped
 * map does not cover produced no element at all. A correct derivation wired
 * behind that guard is still a blank cell, which is why the invariant pinned
 * here is counted over the RENDERED rows: every row, one badge, non-empty text.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AzureConfig,
  SentinelContent,
  SolutionFileRef,
  SolutionRef,
} from "@soc/core";
import {
  DELIVERY_FIT_MEASURING_LABEL,
  DELIVERY_FIT_NO_CONNECTOR_LABEL,
  DELIVERY_FIT_UNMEASURED_LABEL,
  lookupSolutionIngestion,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { SolutionBrowser } from "./solution-browser";

afterEach(cleanup);

// Selecting a solution WRITES the deep link into window.location.hash, and the
// browser reads that hash on mount. Without this the second test in the file
// would boot with the first test's selection already made.
beforeEach(() => {
  window.location.hash = "#/";
});

/**
 * One solution per badge state, using REAL names from the shipped
 * classification map so the fixture cannot drift from the thing under test.
 * The last is the live report's own row: absent from the map because the
 * generator found no parseable connector JSON for it.
 */
const SOLUTIONS: SolutionRef[] = [
  { name: "AbnormalSecurity", path: "Solutions/AbnormalSecurity" },
  { name: "1Password", path: "Solutions/1Password" },
  { name: "Agent 365", path: "Solutions/Agent 365" },
  { name: "Palo Alto Cortex XDR", path: "Solutions/Palo Alto Cortex XDR" },
];

const content: SentinelContent = {
  async getCommitSha(): Promise<string | null> {
    return "abcdef012345";
  },
  async listSolutions(): Promise<SolutionRef[]> {
    return SOLUTIONS;
  },
} as unknown as SentinelContent;

const CONFIG = {
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
} as unknown as AzureConfig;

async function renderList(): Promise<HTMLElement[]> {
  render(
    <PortsProvider ports={{ content } as unknown as UiPorts} config={CONFIG}>
      <SolutionBrowser />
    </PortsProvider>,
  );
  await waitFor(() => {
    expect(screen.getByText("Palo Alto Cortex XDR")).toBeTruthy();
  });
  // Scoped to the list on purpose: the legend renders one specimen badge per
  // state, so a document-wide count would pass with every row still blank.
  const items = document.querySelectorAll<HTMLElement>(
    ".solution-browser-list .solution-browser-item",
  );
  return [...items];
}

describe("SolutionBrowser delivery-fit column (DBT-15)", () => {
  it("gives EVERY row exactly one badge, and none of them are blank", async () => {
    const rows = await renderList();
    expect(rows.length).toBe(SOLUTIONS.length);
    for (const row of rows) {
      const badges = row.querySelectorAll(".ingestion-badge");
      expect(badges.length).toBe(1);
      expect((badges[0].textContent ?? "").trim()).not.toBe("");
    }
  });

  it("says NOT MEASURED on the row the shipped map does not cover", async () => {
    const rows = await renderList();
    const row = rows.find((r) =>
      (r.textContent ?? "").includes("Palo Alto Cortex XDR"),
    );
    expect(row).toBeTruthy();
    const badge = row?.querySelector(".ingestion-badge");
    expect(badge?.textContent).toBe(DELIVERY_FIT_UNMEASURED_LABEL);
    // The tooltip must carry the distinction, not just the label: the point of
    // the state is that it is an absence of evidence, not a verdict of no fit.
    expect(badge?.getAttribute("title")).toMatch(/not measured/i);
    expect(badge?.getAttribute("title")).toMatch(
      /not the same as a poor fit or no fit/i,
    );
  });

  it("still shows the three measured tiers on the rows that have them", async () => {
    // Guards the pin above. A regression that labelled the whole column "Not
    // measured" would satisfy "every row has a badge" and destroy the feature.
    const rows = await renderList();
    const labelFor = (name: string) =>
      rows
        .find((r) => (r.textContent ?? "").includes(name))
        ?.querySelector(".ingestion-badge")?.textContent;
    expect(labelFor("AbnormalSecurity")).toBe("Recommended");
    expect(labelFor("1Password")).toBe("Supported");
    expect(labelFor("Agent 365")).toBe("Legacy");
  });

  it("styles the unmeasured badge as its own state, not as a tier", async () => {
    // A shared class with legacy would read as "the worst tier" rather than
    // "no measurement", so the class the stylesheet keys off is pinned.
    const rows = await renderList();
    const badge = rows
      .find((r) => (r.textContent ?? "").includes("Palo Alto Cortex XDR"))
      ?.querySelector(".ingestion-badge");
    expect(badge?.className).toContain("ingestion-badge-unmeasured");
    expect(badge?.className).not.toContain("ingestion-badge-legacy");
  });
});

/**
 * The SELECTED-SOLUTION CARD (review findings 1 and 2, 2026-09-01).
 *
 * WHY THIS BLOCK EXISTS AT ALL. The first attempt fixed both halves of the
 * screen and pinned one. A reviewer reverted the card's badge to the shipped
 * defect shape - `badge.measured ? <span/> : null` - and the ENTIRE ui suite
 * still passed, because nothing above this line ever selects a solution. Half a
 * fix with a green suite is worse than no fix: it reads as protected.
 *
 * WHY IT DRIVES THE REAL FETCH. The card's badge depends on the phase of a
 * live per-solution fetch, and the phase is exactly what the derivation pins
 * cannot see. Each case below stubs listConnectorFiles/readFile to produce ONE
 * real phase - in flight, complete with none, complete but unreadable, thrown,
 * complete and classified - and reads the badge off the DOM.
 */
describe("SolutionBrowser selected-solution card (DBT-15)", () => {
  // Absent from the shipped map (pinned below), so the LIVE fetch is what
  // decides the badge - which is the whole point of these cases.
  const ABSENT = "Palo Alto Cortex XDR";
  // Present in the map as Recommended - used only for the override case.
  const SHIPPED = "AbnormalSecurity";

  const FILE: SolutionFileRef = {
    name: "connector.json",
    path: `Solutions/${ABSENT}/Data Connectors/connector.json`,
    size: 10,
  };
  // A CCF Push connector: classifyConnectorIngestion reads the `kind` off a
  // record that also carries `properties`, and answers `recommended`.
  const PUSH_JSON = JSON.stringify({ kind: "Push", properties: { title: "x" } });
  // Never settles - holds the fetch in flight for the whole test.
  const PENDING: Promise<SolutionFileRef[]> = new Promise(() => {});

  function contentWith(
    listConnectorFiles: () => Promise<SolutionFileRef[]>,
    readFile: () => Promise<string | null> = async () => null,
  ): SentinelContent {
    return {
      async getCommitSha(): Promise<string | null> {
        return "abcdef012345";
      },
      async listSolutions(): Promise<SolutionRef[]> {
        return SOLUTIONS;
      },
      listConnectorFiles,
      readFile,
    } as unknown as SentinelContent;
  }

  async function selectSolution(
    content: SentinelContent,
    name: string,
  ): Promise<void> {
    render(
      <PortsProvider ports={{ content } as unknown as UiPorts} config={CONFIG}>
        <SolutionBrowser />
      </PortsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(name)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(name));
    await waitFor(() => {
      expect(document.querySelector(".solution-browser-selected")).toBeTruthy();
    });
  }

  function cardBadges(): HTMLElement[] {
    return [
      ...document.querySelectorAll<HTMLElement>(
        ".solution-browser-selected .ingestion-badge",
      ),
    ];
  }

  it("keeps its fixture honest: the card's solution really is unmapped", () => {
    // If a regenerated asset ever classifies it, every case below silently
    // stops testing the live path. The FIXTURE is then what should change.
    expect(lookupSolutionIngestion(ABSENT)).toBeNull();
    expect(lookupSolutionIngestion(SHIPPED)?.tier).toBe("recommended");
  });

  it("renders exactly ONE non-blank badge in every fetch phase", async () => {
    // The direct answer to finding 1. Four of these five phases produce a badge
    // with measured === false, so the reviewer's `badge.measured ? ... : null`
    // reversion removes the element and this fails four times over.
    const cases = [
      { phase: "in flight", content: contentWith(() => PENDING), label: DELIVERY_FIT_MEASURING_LABEL },
      { phase: "complete, no connectors", content: contentWith(async () => []), label: DELIVERY_FIT_NO_CONNECTOR_LABEL },
      { phase: "complete, unreadable", content: contentWith(async () => [FILE]), label: DELIVERY_FIT_UNMEASURED_LABEL },
      {
        phase: "threw",
        content: contentWith(() => {
          throw new Error("connector listing refused");
        }),
        label: DELIVERY_FIT_UNMEASURED_LABEL,
      },
      {
        phase: "complete, classified",
        content: contentWith(async () => [FILE], async () => PUSH_JSON),
        label: "Recommended",
      },
    ];
    for (const c of cases) {
      await selectSolution(c.content, ABSENT);
      await waitFor(() => {
        expect(cardBadges()[0]?.textContent, c.phase).toBe(c.label);
      });
      expect(cardBadges().length, c.phase).toBe(1);
      expect((cardBadges()[0].textContent ?? "").trim(), c.phase).not.toBe("");
      cleanup();
      window.location.hash = "#/";
    }
  });

  it("calls a COMPLETED listing of zero connectors measured, not unknown", async () => {
    // Finding 2. The fetch has finished and found nothing; saying "Not
    // measured" here reports an unknown for something the app just measured -
    // the mirror image of the defect this card was opened for.
    await selectSolution(contentWith(async () => []), ABSENT);
    await waitFor(() => {
      expect(cardBadges()[0]?.textContent).toBe(DELIVERY_FIT_NO_CONNECTOR_LABEL);
    });
    const badge = cardBadges()[0];
    expect(badge.textContent).not.toBe(DELIVERY_FIT_UNMEASURED_LABEL);
    expect(badge.className).toContain("ingestion-badge-no-connector");
    // The assertion is that this reads as something we CHECKED rather than
    // something unknown - "Checked:" replaced "Measured:" when review showed
    // the adapter also resolves [] for a folder it never opened, so claiming a
    // measurement of the folder was itself an overclaim. The PROPERTY the pin
    // exists for is unchanged: a completed listing of zero must not render as
    // "Not measured", which the second assertion nails down directly.
    expect(badge.getAttribute("title")).toMatch(/^Checked:/);
    expect(badge.getAttribute("title")).not.toMatch(/not measured/i);
    expect(badge.getAttribute("title")).not.toMatch(/not measured/i);
  });

  it("never tells the card the fit is measured 'when the solution is selected'", async () => {
    // The sentence the review caught, on the screen where it is false: the
    // solution IS selected and the classification HAS run. Checked in the two
    // phases the card can rest in with no tier - complete-with-none, and thrown.
    for (const content of [
      contentWith(async () => []),
      contentWith(() => {
        throw new Error("connector listing refused");
      }),
    ]) {
      await selectSolution(content, ABSENT);
      await waitFor(() => {
        expect(cardBadges()[0]?.textContent).not.toBe(DELIVERY_FIT_MEASURING_LABEL);
      });
      expect(cardBadges()[0].getAttribute("title")).not.toMatch(
        /when the solution is selected/i,
      );
      cleanup();
      window.location.hash = "#/";
    }
    // The BROWSE ROW still says it, because there the look really is pending.
    render(
      <PortsProvider
        ports={{ content: contentWith(async () => []) } as unknown as UiPorts}
        config={CONFIG}
      >
        <SolutionBrowser />
      </PortsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(ABSENT)).toBeTruthy();
    });
    // Scoped to the row, not the document: the legend carries a specimen badge
    // of the same state and would answer for it.
    const rowBadge = [
      ...document.querySelectorAll<HTMLElement>(
        ".solution-browser-list .solution-browser-item",
      ),
    ]
      .find((r) => (r.textContent ?? "").includes(ABSENT))
      ?.querySelector(".ingestion-badge");
    expect(rowBadge?.textContent).toBe(DELIVERY_FIT_UNMEASURED_LABEL);
    expect(rowBadge?.getAttribute("title")).toMatch(/when the solution is selected/i);
  });

  it("says a measurement is UNDERWAY while the fetch is in flight", async () => {
    await selectSolution(contentWith(() => PENDING), ABSENT);
    await waitFor(() => {
      expect(cardBadges()[0]?.textContent).toBe(DELIVERY_FIT_MEASURING_LABEL);
    });
    // Not the same claim as "nobody looked": a look is happening right now.
    expect(cardBadges()[0].className).toContain("ingestion-badge-measuring");
  });

  it("shows the LIVE tier for a solution the shipped map never classified", async () => {
    await selectSolution(
      contentWith(async () => [FILE], async () => PUSH_JSON),
      ABSENT,
    );
    await waitFor(() => {
      expect(cardBadges()[0]?.textContent).toBe("Recommended");
    });
    expect(cardBadges()[0].getAttribute("title")).toMatch(
      /own connector files/i,
    );
  });

  it("agrees with the connector count printed beneath it", async () => {
    // A shipped tier plus a completed listing of zero used to put "Recommended"
    // directly above "0 connector files" on the same card. The empty listing
    // falsifies the premise the shipped entry was written under, so it wins.
    await selectSolution(contentWith(async () => []), SHIPPED);
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected")?.textContent,
      ).toContain("0 connector files");
    });
    expect(cardBadges()[0]?.textContent).toBe(DELIVERY_FIT_NO_CONNECTOR_LABEL);
    expect(cardBadges()[0]?.textContent).not.toBe("Recommended");
  });
});
