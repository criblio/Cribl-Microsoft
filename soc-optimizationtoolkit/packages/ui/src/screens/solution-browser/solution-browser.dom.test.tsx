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

  /**
   * DBT-75. The card must not print an ADDRESS.
   *
   * It used to render `Deep link: #/?solution=<name>` as a copyable chip - a
   * bare fragment with no base on the only shipped shell, so an operator who
   * copied it got nothing. The reasoning is on the component; what is pinned
   * here is the outcome, because the failure was pure copy and nothing in the
   * suite ever read the loaded card's text.
   *
   * TWO WAYS THIS PIN COULD LIE, both closed below. It could pass VACUOUSLY by
   * asserting absence against a card that never reached the loaded phase, so
   * the positive assertions come first and name the exact fetch result. And it
   * could pass against a re-added chip under a friendlier label, so the word
   * "Deep link" is not the only negative.
   *
   * THE SHAPE NEGATIVE IS DELIBERATELY WIDER THAN THE BUILDER. This pin first
   * shipped asserting `#/?solution=` - the one shape buildSolutionDeepLink
   * emits - under a docblock claiming "any re-advertisement has to print
   * #/?solution= to be worth printing". That was false: parseSolutionDeepLink
   * accepts THREE shapes (browser-state.ts:139-143, pinned at
   * browser-state.test.ts:144-148), so a chip printing
   * `#/integrate?solution=<name>` would be just as usable and just as wrong.
   * Measured 2026-09-02 by re-adding exactly that chip: the file stayed at 13
   * passed and this pin never fired. The assertion is now on `?solution=`, the
   * substring every accepted shape carries, plus a STRUCTURAL negative that
   * depends on no string at all.
   *
   * ...AND WIDER THAN TEXT, which is where it lied next. Everything above
   * reads textContent, which sees nothing an element carries in an ATTRIBUTE.
   * Measured 2026-09-03 against the pin as it then stood (the text negatives
   * plus a `.code-chip` count) by adding
   * `<a href={buildSolutionDeepLink(selected.name)}>Copy link to this
   * solution</a>` to the loaded block: 14 passed, 0 failed, nothing fired - an
   * address re-advertised through an href hands the operator the same false
   * promise as one printed as text. With the attribute scan below in place the
   * same mutation fails: re-measured 2026-09-03 at 13 passed, 1 failed, on
   * "expected '#/?solution=Palo%20Alto%20Cortex%20XDR' not to contain
   * '?solution='".
   *
   * ...AND WIDER THAN THE DOM, which is where it lied after that. A CONTROL can
   * hold the address in a closure, where neither text nor attributes reach it.
   * Measured 2026-09-03 by adding a button labelled "Copy link to this
   * solution" whose onClick writes buildSolutionDeepLink to the clipboard: 14
   * passed, 0 failed, every negative above silent - and an operator handed
   * exactly the unreachable fragment the chip used to print. The property being
   * pinned is the CLASS - nothing on this card offers an address - and text,
   * attributes and controls are the three ways to offer one, so the last
   * assertion below is the card's whole control set.
   */
  it("prints the connector detail without advertising an address", async () => {
    await selectSolution(
      contentWith(async () => [FILE], async () => PUSH_JSON),
      ABSENT,
    );
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected")?.textContent,
      ).toContain("1 connector file");
    });
    const card = document.querySelector(".solution-browser-selected");
    if (card === null) {
      throw new Error("the selected-solution card did not render");
    }
    const text = card.textContent ?? "";
    // The card really is in the loaded phase, so the negatives below mean
    // "the chip is gone" and not "nothing rendered".
    expect(text).toContain(ABSENT);
    expect(text).toContain("1 connector file");
    expect(text).toContain("Clear selection");
    // The claim itself: no label, no fragment, no element for it. Matched
    // case-insensitively because "Copy deep link" advertises exactly what
    // "Deep link:" did. Measured 2026-09-03 with a button under that label and
    // this line in its original exact-case form: it stayed silent, and only the
    // control assertion at the end of this test caught the button.
    expect(text.toLowerCase()).not.toContain("deep link");
    // Every shape parseSolutionDeepLink accepts carries this substring; the
    // `#/` prefix this used to assert only covered the builder's own output.
    expect(text).not.toContain("?solution=");
    // THE ATTRIBUTE HALF. Same negatives, over every attribute value on the
    // card - href, title, aria-label, data-*, whatever a future chip picks -
    // because a link is an address whether it is printed or carried.
    const attributeValues = [card, ...card.querySelectorAll("*")].flatMap(
      (el) => el.getAttributeNames().map((name) => el.getAttribute(name) ?? ""),
    );
    // Non-vacuity for the scan itself: an empty collection would satisfy every
    // negative in the loop below without looking at anything. Measured
    // 2026-09-03, the loaded card carries 10 attribute values - nine class
    // names and the badge's title - so the floor sits well under that (a
    // cosmetic class change must not fail this pin) and well over zero.
    expect(attributeValues.length).toBeGreaterThan(3);
    for (const value of attributeValues) {
      expect(value).not.toContain("?solution=");
      expect(value.toLowerCase()).not.toContain("deep link");
    }
    // THE STRUCTURAL HALF, independent of any string a future chip picks. The
    // loaded card is a label, the solution name, its badges, the connector
    // count, the Clear button and its warning: nothing on it navigates and
    // nothing on it is a code chip, so an element of either kind appearing
    // here IS an address being advertised. If a genuine link is ever wanted on
    // this card - a GitHub URL for the solution, say - the fix is to assert
    // that its href is not a deep link, not to drop this line.
    expect(card.querySelectorAll("a, [href]").length).toBe(0);
    expect(card.querySelectorAll(".code-chip").length).toBe(0);
    expect(card.querySelector(".solution-browser-deeplink")).toBeNull();
    // THE CONTROL HALF, which the two scans above cannot reach: a button whose
    // onClick copies buildSolutionDeepLink carries the address in a CLOSURE,
    // printing nothing and setting no attribute. So the assertion is the card's
    // whole control set, measured 2026-09-03 in this exact case: one button,
    // reading "Clear selection". Asserting the LIST rather than a count keeps it
    // non-vacuous - an empty card fails this line too. When a control is
    // genuinely wanted here, add it to this list and assert what it does with
    // the address; do not delete the line, which is how the class stops being
    // held.
    const controls = [
      ...card.querySelectorAll("button, a, input, [role='button']"),
    ].map((el) => (el.textContent ?? "").trim());
    expect(controls).toEqual(["Clear selection"]);
  });

  /**
   * The other half of the same fix: removing the CLAIM must not remove the
   * MECHANISM. select() still writes the hash, which is what the mount read
   * and the SIEM-migration pivot both hand off through - so a future cleanup
   * that deletes buildSolutionDeepLink along with the chip breaks Unit 26
   * rather than this card, and would otherwise do it silently.
   */
  it("still writes the solution into the hash when one is selected", async () => {
    await selectSolution(contentWith(async () => []), ABSENT);
    await waitFor(() => {
      expect(document.querySelector(".solution-browser-selected")).toBeTruthy();
    });
    expect(window.location.hash).toBe("#/?solution=Palo%20Alto%20Cortex%20XDR");
  });

  /**
   * ...and the READ half, which is the one that was unpinned and the one that
   * matters. The write pin above catches a cleanup that deletes
   * buildSolutionDeepLink; it says nothing about the MOUNT READ, and the read
   * is what the SIEM-migration pivot and the refresh-restore both actually
   * depend on, since each of them only ever writes a hash and navigates.
   *
   * Measured 2026-09-02: inverting the `typeof window !== "undefined"` guard on
   * the deepLinkName initializer (solution-browser.tsx:179) disables the read
   * outright, and the whole packages/ui suite still passed at 80 files / 1343
   * tests. No test in the package set a solution hash and asserted a preselect.
   * Re-measured 2026-09-03 with this pin in place: the same inversion fails
   * this test and ONLY this test - 1 failed, 13 passed in the file, 1 failed
   * file of 80 in the package - so the 1343 above is this pin's own absence,
   * not a suite that was looking elsewhere.
   *
   * It also settles the mechanism the DBT-75 note on the component argues over:
   * a fragment present BEFORE the first render is consumed normally. First-visit
   * mounting is what makes that read fire, not what prevents it.
   *
   * The hash is written as a LITERAL rather than through buildSolutionDeepLink,
   * so this pin still fails if a cleanup deletes the builder and the read
   * together - which is precisely the cleanup it exists to catch.
   */
  it("preselects the solution named in the hash present at first render", async () => {
    window.location.hash = "#/?solution=Palo%20Alto%20Cortex%20XDR";
    render(
      <PortsProvider
        ports={{ content: contentWith(async () => []) } as unknown as UiPorts}
        config={CONFIG}
      >
        <SolutionBrowser />
      </PortsProvider>,
    );
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected-name")?.textContent,
      ).toBe(ABSENT);
    });
    // A SELECTION, not a browse list that happens to contain the name: the
    // list is hidden once something is selected, and the selection is what the
    // pivot hands off. Without this a rendered list would satisfy the name
    // assertion if it were ever scoped more loosely.
    expect(document.querySelector(".solution-browser-list")).toBeNull();
  });
});
