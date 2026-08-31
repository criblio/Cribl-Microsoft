// @vitest-environment happy-dom
/**
 * Surface pins for Enable Sentinel Content (DBT-47).
 *
 * The gate being pinned is what ARMS an install. `scopeCommitted` is nothing
 * but three non-empty Azure config strings an operator can type with no
 * connection at all, so a gate built from it alone offered every install action
 * on a build with no identity to install with - and the only feedback was the
 * eventual auth failure.
 *
 * The correction has TWO halves, and a pin that only checks the first would
 * license the wrong fix: the action must be blocked, AND it must still be
 * there. The capability model's rule is that a denied verdict ANNOTATES and
 * never removes the attempt, so the button stays rendered and reachable with
 * the reason on it - never hidden.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AzureConfig,
  PortHttpResponse,
  SentinelContent,
  SolutionFileRef,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { ContentInstallSection } from "./content-install-section";

afterEach(cleanup);

const SOLUTION = "CrowdStrike Falcon Endpoint Protection";
const WORKBOOK = "FalconOverview";

/** A committed scope WITH an Azure identity - the connected case. */
const CONNECTED = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
  setupPath: "existing",
} as unknown as AzureConfig;

/**
 * The DBT-47 shape: the same three scope strings, typed with no connection.
 * This is reachable today - the targeting form does not require an identity to
 * commit a scope - which is why it is the case that needed the pin.
 */
const NO_IDENTITY = {
  ...CONNECTED,
  tenantId: "",
  clientId: "",
} as unknown as AzureConfig;

const armOk: PortHttpResponse = {
  ok: true,
  status: 200,
  body: { value: [] },
} as unknown as PortHttpResponse;

/**
 * Content with exactly one workbook and nothing else. Workbooks are the group
 * used here because every one of them is selectable - a rule can be an
 * unsupported managed type, which would disable the install button for a reason
 * that has nothing to do with the gate under test.
 */
const content: SentinelContent = {
  async listSolutionFiles(
    _solution: string,
    subDir: string,
  ): Promise<SolutionFileRef[]> {
    return subDir === "Workbooks"
      ? [
          {
            name: `${WORKBOOK}.json`,
            path: `Solutions/${SOLUTION}/Workbooks/${WORKBOOK}.json`,
            size: 12,
          },
        ]
      : [];
  },
  async readFile(): Promise<string | null> {
    return '{"version":"Notebook/1.0","items":[]}';
  },
} as unknown as SentinelContent;

function makePorts(): UiPorts {
  return {
    azure: {
      async request(): Promise<PortHttpResponse> {
        return armOk;
      },
    },
    content,
    mintAssignmentName: () => "33333333-3333-3333-3333-333333333333",
  } as unknown as UiPorts;
}

/** Render, load the solution content, and select the one workbook. */
async function renderAndSelect(config: AzureConfig) {
  const view = render(
    <PortsProvider ports={makePorts()} config={config}>
      <ContentInstallSection solutionName={SOLUTION} scopeCommitted={true} />
    </PortsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load solution content" }));
  await waitFor(() => {
    expect(screen.getByText(WORKBOOK)).toBeTruthy();
  });
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  // Guard the pin itself: an unselected list disables the button for its own
  // reason, which would make the assertions below pass against the bug.
  const install = screen.getByRole("button", {
    name: "Install selected (1)",
  }) as HTMLButtonElement;
  return { ...view, install };
}

describe("ContentInstallSection install gate (DBT-47)", () => {
  it("does NOT arm the install when the scope was typed with no Azure identity", async () => {
    const { install } = await renderAndSelect(NO_IDENTITY);
    expect(install.disabled).toBe(true);
  });

  it("keeps the blocked install REACHABLE and says why - never hidden", async () => {
    // The capability rule: a denied verdict annotates, it never removes the
    // attempt. A fix that hid the button would satisfy the test above and
    // break the model, so the button's presence is pinned too.
    const { install } = await renderAndSelect(NO_IDENTITY);
    expect(install.isConnected).toBe(true);
    expect(install.title).toMatch(/No Azure identity is connected/);
    // And the reason is readable without hovering - beside the button, and in
    // the section notice.
    expect(
      screen.getAllByText(/No Azure identity is connected/).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("arms the install once the config names an identity", async () => {
    const { install } = await renderAndSelect(CONNECTED);
    expect(install.disabled).toBe(false);
    expect(install.title).toBe("");
    expect(screen.queryByText(/No Azure identity is connected/)).toBeNull();
  });

  it("still previews the solution's content with no identity", async () => {
    // The gate is about INSTALLING. Reading the repo needs no Azure at all, so
    // gating the load too would have been the over-correction.
    await renderAndSelect(NO_IDENTITY);
    expect(screen.getByText(WORKBOOK)).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Load solution content",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DBT-44: an empty installed-content listing is an unknown, not a zero
// ---------------------------------------------------------------------------

/**
 * The defect: ARM answers a list with 200 and an empty `value` when RBAC
 * filters the caller out, and the section read that as a measured
 * "<solution> <version> - not installed." with an Install button on the end of
 * the sentence. So an operator was invited to install a solution that may
 * already be there and merely invisible to them (docs/inventory-standard.md,
 * BINDING).
 *
 * These pin BOTH directions, because a fix that only satisfies the first would
 * be worse than the bug: hedging unconditionally makes the caveat permanent
 * furniture that gets skipped, and hiding the button would break the capability
 * model's rule 3 - annotate, never remove.
 */
const CATALOG_ENTRY = {
  name: "crowdstrike.pkg",
  properties: {
    contentId: "crowdstrike-content-id",
    displayName: SOLUTION,
    version: "3.0.0",
  },
};

/** An ARM fake that answers per PATH, so each listing can be scripted apart. */
function makeListingPorts(opts: {
  contentPackages: unknown[];
  workbooks: unknown[];
  /**
   * The alertRules listing. Scriptable because the rules group carries the
   * SAME hedge as workbooks and nothing pinned it: the shared `content`
   * fixture returns no rules, so `ruleSplit.installable.length > 0` was never
   * true and the caveat's own guard short-circuited before it could be
   * observed. Deleting that entire caveat prop left the suite green (review,
   * 2026-08-31).
   */
  alertRules?: unknown[];
  /** Content port override, for the fixture that ships a rule. */
  content?: SentinelContent;
}): UiPorts {
  const page = (value: unknown[]): PortHttpResponse =>
    ({ ok: true, status: 200, body: { value } }) as unknown as PortHttpResponse;
  return {
    azure: {
      async request(req: { path: string }): Promise<PortHttpResponse> {
        // contentProductPackages FIRST - "/contentPackages" is not a substring
        // of it, but the reverse order would still be a trap worth avoiding.
        if (req.path.includes("/contentProductPackages")) return page([CATALOG_ENTRY]);
        if (req.path.includes("/contentPackages")) return page(opts.contentPackages);
        if (req.path.includes("/alertRules")) return page(opts.alertRules ?? []);
        if (req.path.includes("/Microsoft.Insights/workbooks")) return page(opts.workbooks);
        // The workspace GET (region lookup).
        return { ok: true, status: 200, body: { location: "eastus" } } as unknown as PortHttpResponse;
      },
    },
    content: opts.content ?? content,
    mintAssignmentName: () => "33333333-3333-3333-3333-333333333333",
  } as unknown as UiPorts;
}

async function renderAndLoad(ports: UiPorts) {
  render(
    <PortsProvider ports={ports} config={CONNECTED}>
      <ContentInstallSection solutionName={SOLUTION} scopeCommitted={true} />
    </PortsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load solution content" }));
  // Wait on the SOLUTION control, which only renders once the catalog lookup
  // resolved - waiting on the repo workbook would pass before the ARM listings
  // came back and race every assertion below.
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Install solution" })).toBeTruthy();
  });
}

describe("ContentInstallSection: empty installed-content listings (DBT-44)", () => {
  it("does not claim 'not installed' when the packages listing saw nothing", async () => {
    await renderAndLoad(makeListingPorts({ contentPackages: [], workbooks: [] }));
    // The confident wrong answer is GONE. Asserted first: it is the defect, and
    // a later failure must never be what stops this from running.
    expect(screen.queryByText(/not installed\./)).toBeNull();
    expect(
      screen.getByText(
        /Cannot confirm there are no installed solutions - no permission check covers this list/,
      ),
    ).toBeTruthy();
  });

  it("hedges WITHOUT sending the operator to a check that cannot settle it", async () => {
    // The choice of hedge is load-bearing. No capability in the settled
    // taxonomy covers a SecurityInsights content read, so "run the permission
    // check" - the wording for a merely unaudited scope - would send the
    // operator to do work whose result they would then read as confirmation.
    await renderAndLoad(makeListingPorts({ contentPackages: [], workbooks: [] }));
    const hint = screen.getByText(/Cannot confirm there are no installed solutions/);
    expect(hint.textContent).not.toMatch(/run the permission check/);
    expect(hint.textContent).toMatch(/may already be installed/);
  });

  it("keeps the install REACHABLE and armed under the hedge", async () => {
    // Rule 3: an unmeasured verdict annotates the attempt, it never removes it.
    // A fix that hid or disabled the button would pass the first pin here and
    // break the capability model.
    await renderAndLoad(makeListingPorts({ contentPackages: [], workbooks: [] }));
    const install = screen.getByRole("button", {
      name: "Install solution",
    }) as HTMLButtonElement;
    expect(install.isConnected).toBe(true);
    expect(install.disabled).toBe(false);
  });

  it("DOES say 'not installed' when the listing proved it could see packages", async () => {
    // Someone else's package in the page: the read is proved and our solution
    // is genuinely absent. Hedging here too would make the caveat furniture.
    await renderAndLoad(
      makeListingPorts({
        contentPackages: [{ properties: { contentId: "some-other-solution" } }],
        workbooks: [],
      }),
    );
    expect(screen.getByText(/not installed\./)).toBeTruthy();
    expect(screen.queryByText(/Cannot confirm there are no installed solutions/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Install solution" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("caveats the workbook group the same way, and only while it is unproved", async () => {
    // The workbook split makes the claim silently: an unverified-empty listing
    // marks every workbook installable, with no sentence to correct.
    await renderAndLoad(makeListingPorts({ contentPackages: [], workbooks: [] }));
    expect(screen.getByText(/Cannot confirm there are no installed workbooks/)).toBeTruthy();
    expect(screen.getByText(WORKBOOK)).toBeTruthy();

    cleanup();
    await renderAndLoad(
      makeListingPorts({
        contentPackages: [],
        // A workbook we could see, under a name the repo does not ship - the
        // repo one stays installable, so the ONLY difference is the evidence.
        workbooks: [{ properties: { displayName: "Some other workbook" } }],
      }),
    );
    expect(screen.queryByText(/Cannot confirm there are no installed workbooks/)).toBeNull();
    expect(screen.getByText(WORKBOOK)).toBeTruthy();
  });
});

/**
 * The rules half of DBT-44's hedge, pinned after review found it undefended.
 *
 * `content-install-section.tsx` puts the SAME caveat on the Analytics rules
 * group as on Workbooks, and nothing tested it: the shared `content` fixture
 * lists files only under "Workbooks", so `ruleSplit.installable.length > 0`
 * was false in every case and the caveat's guard short-circuited. Deleting the
 * whole `caveat={...}` prop from the rules group left the suite reporting
 * 9 passed. So one of the three hedges could be removed - or inverted - with
 * CI silent.
 */
const RULE_YAML = `id: 8b8b1234-0000-4a4a-9c9c-abcdef012345
name: "Suspicious sign-in from new location"
severity: High
tactics:
  - InitialAccess
query: |
  SigninLogs
  | where ResultType == "0"
`;

/** Content that ships ONE analytic rule as well as the workbook. */
const contentWithRule = {
  async listSolutions(): Promise<unknown[]> {
    return [];
  },
  async listSolutionFiles(
    _solution: string,
    subDir: string,
  ): Promise<SolutionFileRef[]> {
    if (subDir === "Workbooks") {
      return [
        {
          name: `${WORKBOOK}.json`,
          path: `Solutions/${SOLUTION}/Workbooks/${WORKBOOK}.json`,
          size: 12,
        },
      ];
    }
    if (subDir === "Analytic Rules") {
      return [
        {
          name: "SuspiciousSignIn.yaml",
          path: `Solutions/${SOLUTION}/Analytic Rules/SuspiciousSignIn.yaml`,
          size: 200,
        },
      ];
    }
    return [];
  },
  async readFile(path: string): Promise<string | null> {
    return path.endsWith(".yaml")
      ? RULE_YAML
      : '{"version":"Notebook/1.0","items":[]}';
  },
} as unknown as SentinelContent;

describe("ContentInstallSection: the RULES hedge is defended too (DBT-44)", () => {
  it("caveats the rules group when the alertRules listing saw nothing", async () => {
    await renderAndLoad(
      makeListingPorts({
        contentPackages: [],
        workbooks: [],
        alertRules: [],
        content: contentWithRule,
      }),
    );
    // The hedge itself, asserted FIRST and with no precondition ahead of it -
    // a read-count or presence check in front would stop the run before the
    // assertion that matters, which is how the sibling pin lost its teeth.
    expect(
      screen.getByText(/Rules offered below may already be in the workspace/),
    ).toBeTruthy();
  });

  it("drops the caveat once the listing returned someone else's rule", async () => {
    // A listing that came back with rows PROVES the read worked, so the hedge
    // must go - otherwise it is furniture and the operator learns to skip it.
    await renderAndLoad(
      makeListingPorts({
        contentPackages: [],
        workbooks: [],
        alertRules: [{ name: "someone-elses-rule", properties: { displayName: "Other" } }],
        content: contentWithRule,
      }),
    );
    expect(
      screen.queryByText(/Rules offered below may already be in the workspace/),
    ).toBeNull();
  });

  it("still OFFERS the rule in both cases - the hedge annotates, never removes", async () => {
    await renderAndLoad(
      makeListingPorts({
        contentPackages: [],
        workbooks: [],
        alertRules: [],
        content: contentWithRule,
      }),
    );
    expect(screen.getByText(/Suspicious sign-in from new location/)).toBeTruthy();
  });
});
