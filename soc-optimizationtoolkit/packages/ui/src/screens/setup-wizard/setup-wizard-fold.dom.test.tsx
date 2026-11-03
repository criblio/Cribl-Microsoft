// @vitest-environment happy-dom
/**
 * DBT-248: the first-run wizard's steps fold like the Setup page. These mount
 * the REAL sections the cloud shell hands the wizard (not slots), because the
 * rules only mean something across them: each step owns one fold scope, opens
 * with only the section that needs the operator, and folds the rest as the
 * operator moves. Moving between wizard steps is not a fold event.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AzureConfig, ChangeRequestContext, JourneyFacts } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { SetupWizard } from "./setup-wizard";
import { AzureConnectivitySection } from "./azure-connectivity-section";
import { AzureConnectSection } from "./azure-connect-section";
import { AzureResourcesSection } from "./azure-resources-section";

afterEach(cleanup);

function configWith(over: Partial<AzureConfig>): AzureConfig {
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "abcd0000-0000-0000-0000-00000000wxyz",
    subscriptionId: "22222222-2222-2222-2222-222222222222",
    resourceGroup: "rg-sentinel",
    workspaceName: "law-main",
    setupPath: "existing",
    connectivity: "full",
    allowedPermissions: ["Reader"],
    ...over,
  } as AzureConfig;
}

function factsWith(over: Partial<JourneyFacts>): JourneyFacts {
  return {
    accepted: true,
    identityPresent: true,
    secretLive: "live",
    scopeCommitted: true,
    connectivity: "full",
    scopeNeed: "workspace",
    subscriptionChosen: true,
    tokenRequired: true,
    tokenPresent: true,
    ...over,
  } as JourneyFacts;
}

interface Setup {
  store: Map<string, unknown>;
  config?: AzureConfig;
  hasPat?: boolean;
  facts: JourneyFacts;
  onGetStarted?: () => void;
}

function ports(s: Setup): UiPorts {
  return {
    azure: { request: () => new Promise(() => undefined) },
    githubPat: {
      status: vi.fn(async () => ({ hasPat: s.hasPat ?? true, login: "octo" })),
      validateAndStore: vi.fn(),
      clear: vi.fn(),
    },
    content: {
      getCommitSha: vi.fn(async () => "abc"),
      listSolutions: vi.fn(async () => []),
      listRepoFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => null),
    },
    contentCache: {
      get: async (k: string) => s.store.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        s.store.set(k, v);
      },
    },
    user: { current: async () => ({ id: "u1" }) },
  } as unknown as UiPorts;
}

/** The connectivity section over real state, so choosing a radio takes effect. */
function StatefulConnectivity({ initial }: { initial: AzureConfig }) {
  const [config, setConfig] = useState(initial);
  return (
    <AzureConnectivitySection
      config={config}
      onChange={setConfig}
      storedIdentity={config.clientId !== ""}
      onClearIdentity={() => {}}
    />
  );
}

function mount(s: Setup) {
  const config = s.config ?? configWith({});
  const ctx: ChangeRequestContext = { appName: "test", config };
  return render(
    <PortsProvider ports={ports(s)} config={config}>
      <SetupWizard
        capabilities={{ hasCribl: true, hasAzure: true }}
        contentPlatform="cloud"
        initialTarget="cribl-hosted"
        lockTarget
        installedInLeader
        foldFacts={s.facts}
        onGetStarted={s.onGetStarted ?? (() => {})}
        azureConnectivitySection={
          <StatefulConnectivity initial={config} />
        }
        azureConnectSection={
          <AzureConnectSection
            tenantId={config.tenantId}
            onTenantIdChange={() => {}}
            clientId={config.clientId}
            onClientIdChange={() => {}}
            setupPath={config.setupPath}
            onSetupPathChange={() => {}}
            secretLive={s.facts.secretLive === "live"}
            ctx={ctx}
            onConnect={async () => ({ ok: true, secretStored: true, message: "" })}
            storageNote="note"
          />
        }
        azureResourcesSection={
          <AzureResourcesSection
            clientId={config.clientId}
            tenantId={config.tenantId}
            setupPath={config.setupPath}
            subscriptionId={config.subscriptionId}
            onSubscriptionIdChange={() => {}}
            rgName={config.resourceGroup}
            onRgNameChange={() => {}}
            workspaceName={config.workspaceName}
            onWorkspaceNameChange={() => {}}
            connectNonce={0}
            ctx={ctx}
          />
        }
      />
    </PortsProvider>,
  );
}

const sectionOf = (title: string) =>
  screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;
const isFolded = (title: string) =>
  sectionOf(title).classList.contains("numbered-section-collapsed");

const GITHUB_TITLES = [
  "GitHub personal access token",
  "Sentinel content",
  "Schema tables (KQL validation)",
];
const AZURE_TITLES = [
  "App registration and connect",
  "Select resources and grant permissions",
];
const open = (titles: string[]) =>
  titles.filter((t) => screen.queryByRole("heading", { name: t }) !== null && !isFolded(t));

const next = () => fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
const back = () => fireEvent.click(screen.getByRole("button", { name: /^back$/i }));

describe("wizard GitHub step folding (DBT-248)", () => {
  it("opens with only the token section open when no token is saved", async () => {
    mount({ store: new Map(), hasPat: false, facts: factsWith({ tokenPresent: false }) });
    await waitFor(() => expect(open(GITHUB_TITLES)).toEqual(["GitHub personal access token"]));
    expect(isFolded("Sentinel content")).toBe(true);
    expect(isFolded("Schema tables (KQL validation)")).toBe(true);
  });

  it("opens everything folded once a token is saved", async () => {
    mount({ store: new Map(), facts: factsWith({ tokenPresent: true }) });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "GitHub personal access token" })).toBeTruthy(),
    );
    expect(open(GITHUB_TITLES)).toEqual([]);
  });

  it("a move to another section folds the one that was open", async () => {
    // Facts say no token (so the token section is current) while the port
    // reports one, which un-gates the sections behind it for the move.
    mount({ store: new Map(), hasPat: true, facts: factsWith({ tokenPresent: false }) });
    await waitFor(() => expect(open(GITHUB_TITLES)).toEqual(["GitHub personal access token"]));
    // The real gesture: the press lands first (and moves), then the click opens.
    const expand = screen.getByRole("button", { name: "Expand Sentinel content" });
    fireEvent.pointerDown(expand);
    fireEvent.click(expand);
    await waitFor(() => expect(open(GITHUB_TITLES)).toEqual(["Sentinel content"]));
  });

  it("Next still moves on with the sections folded", async () => {
    mount({ store: new Map(), facts: factsWith({ tokenPresent: true }) });
    await waitFor(() => expect(open(GITHUB_TITLES)).toEqual([]));
    next();
    expect(screen.getByRole("heading", { name: /^connect azure$/i })).toBeTruthy();
  });
});

describe("wizard Connect Azure step folding (DBT-248)", () => {
  function onAzureStep(s: Setup) {
    mount(s);
    next();
    expect(screen.getByRole("heading", { name: /^connect azure$/i })).toBeTruthy();
  }

  it("opens with only the connect section open when the secret is missing", () => {
    onAzureStep({ store: new Map(), facts: factsWith({ secretLive: "missing" }) });
    expect(open(AZURE_TITLES)).toEqual(["App registration and connect"]);
  });

  it("opens with only the resources section open when connected but no target", () => {
    onAzureStep({
      store: new Map(),
      config: configWith({ workspaceName: "", resourceGroup: "" }),
      facts: factsWith({ scopeCommitted: false, subscriptionChosen: false }),
    });
    expect(open(AZURE_TITLES)).toEqual(["Select resources and grant permissions"]);
  });

  it("opens everything folded when nothing is left to do", () => {
    onAzureStep({ store: new Map(), facts: factsWith({}) });
    expect(open(AZURE_TITLES)).toEqual([]);
  });

  it("a move folds the other open section", async () => {
    onAzureStep({ store: new Map(), facts: factsWith({ secretLive: "missing" }) });
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Select resources and grant permissions" }),
    );
    fireEvent.pointerDown(
      within(sectionOf("Select resources and grant permissions")).getByRole("button", {
        name: "Discover / refresh from Azure",
      }),
    );
    await waitFor(() =>
      expect(open(AZURE_TITLES)).toEqual(["Select resources and grant permissions"]),
    );
  });

  it("the connectivity radios are always visible, whatever is folded", () => {
    onAzureStep({ store: new Map(), facts: factsWith({}) });
    expect(
      screen.getByRole("radiogroup", { name: "How will this app work with Azure?" }),
    ).toBeTruthy();
  });

  it("Disconnected renders no connect or resources sections", () => {
    onAzureStep({
      store: new Map(),
      config: configWith({ connectivity: "disconnected" }),
      facts: factsWith({ connectivity: "disconnected" }),
    });
    expect(screen.queryByRole("heading", { name: "App registration and connect" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Select resources and grant permissions" }),
    ).toBeNull();
    expect(
      screen.getByRole("radiogroup", { name: "How will this app work with Azure?" }),
    ).toBeTruthy();
  });

  it("Back and Get Started still work with sections folded", async () => {
    const onGetStarted = vi.fn();
    onAzureStep({ store: new Map(), facts: factsWith({}), onGetStarted });
    expect(open(AZURE_TITLES)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));
    await waitFor(() => expect(onGetStarted).toHaveBeenCalled());
    back();
    expect(screen.getByRole("heading", { name: "Connect GitHub content" })).toBeTruthy();
  });

  it("moving between steps is not a fold event: the step mounts fresh with its own current section", () => {
    onAzureStep({ store: new Map(), facts: factsWith({ secretLive: "missing" }) });
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Select resources and grant permissions" }),
    );
    back();
    next();
    expect(open(AZURE_TITLES)).toEqual(["App registration and connect"]);
  });
});

const badgeOf = (title: string) =>
  sectionOf(title).querySelector(".numbered-section-badge")?.getAttribute("aria-label");
const PINS_KEY = "wizard-pinned-sections:u1";

describe("wizard badge numbers (DBT-248 final review)", () => {
  function partialAzureStep() {
    mount({
      store: new Map(),
      config: configWith({ connectivity: "partial", workspaceName: "", resourceGroup: "" }),
      facts: factsWith({
        connectivity: "partial",
        secretLive: "missing",
        scopeCommitted: false,
        subscriptionChosen: false,
      }),
    });
    next();
  }

  it("Partially Connected numbers the checklist, connect and resources 1, 2, 3 - no repeats", () => {
    partialAzureStep();
    expect(badgeOf("What this app may do in Azure")).toBe("Section 1");
    expect(badgeOf("App registration and connect")).toBe("Section 2");
    expect(badgeOf("Select resources and grant permissions")).toBe("Section 3");
  });

  it("the checklist is folded behind the radios while connect is current", () => {
    partialAzureStep();
    expect(isFolded("What this app may do in Azure")).toBe(true);
    expect(isFolded("App registration and connect")).toBe(false);
  });

  it("Fully Connected numbers connect and resources 1, 2", () => {
    mount({
      store: new Map(),
      config: configWith({ workspaceName: "", resourceGroup: "" }),
      facts: factsWith({ secretLive: "missing", scopeCommitted: false, subscriptionChosen: false }),
    });
    next();
    expect(badgeOf("App registration and connect")).toBe("Section 1");
    expect(badgeOf("Select resources and grant permissions")).toBe("Section 2");
  });

  it("the GitHub step numbers its three sections 1, 2, 3", async () => {
    mount({ store: new Map(), facts: factsWith({ tokenPresent: false }), hasPat: false });
    await waitFor(() => expect(badgeOf("Sentinel content")).toBe("Section 2"));
    expect(badgeOf("GitHub personal access token")).toBe("Section 1");
    expect(badgeOf("Schema tables (KQL validation)")).toBe("Section 3");
  });
});

describe("wizard checklist opens when chosen (DBT-248 final review)", () => {
  it("choosing Partially Connected opens the checklist it reveals", () => {
    mount({ store: new Map(), facts: factsWith({}) });
    next();
    expect(screen.queryByRole("heading", { name: "What this app may do in Azure" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Partially Connected" }));
    expect(isFolded("What this app may do in Azure")).toBe(false);
  });
});

describe("wizard pins and anchors (DBT-248 final review)", () => {
  it("a stored pin under the wizard key reopens its section", async () => {
    const store = new Map<string, unknown>([[PINS_KEY, JSON.stringify(["sentinel-content"])]]);
    mount({ store, hasPat: false, facts: factsWith({ tokenPresent: false }) });
    await waitFor(() =>
      expect(open(GITHUB_TITLES)).toEqual(["GitHub personal access token", "Sentinel content"]),
    );
  });

  it("a pin set in the GitHub step survives a pin saved from the Azure step", async () => {
    const store = new Map<string, unknown>();
    mount({ store, facts: factsWith({ tokenPresent: true, secretLive: "missing" }) });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "GitHub personal access token" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin Sentinel content open" }));
    await waitFor(() => expect(JSON.parse(store.get(PINS_KEY) as string)).toEqual(["sentinel-content"]));
    next();
    // The Azure step loads the shared list before it saves.
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin App registration and connect open" })).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Pin App registration and connect open" }));
    await waitFor(() =>
      expect((JSON.parse(store.get(PINS_KEY) as string) as string[]).sort()).toEqual([
        "azure-connect",
        "sentinel-content",
      ]),
    );
  });

  it("wizard sections carry wizard-prefixed DOM ids, not bare ones", () => {
    mount({ store: new Map(), facts: factsWith({ secretLive: "missing" }) });
    next();
    expect(sectionOf("App registration and connect").id).toBe("wizard-section-azure-connect");
    expect(document.getElementById("azure-connect")).toBeNull();
  });
});
