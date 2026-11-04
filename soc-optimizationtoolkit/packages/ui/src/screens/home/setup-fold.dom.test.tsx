// @vitest-environment happy-dom
/**
 * DBT-248: the Setup page folds like Sentinel Integration. These pins mount the
 * real composition the cloud shell builds (HomeScreen over the three Azure
 * sections and the Repositories screen), because the rules only mean something
 * across all of them: ONE fold instance owns every section on the page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AzureConfig, ChangeRequestContext, JourneyFacts } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { HomeScreen } from "./home-screen";
import { AzureConnectivitySection } from "../setup-wizard/azure-connectivity-section";
import { AzureConnectSection } from "../setup-wizard/azure-connect-section";
import { AzureResourcesSection } from "../setup-wizard/azure-resources-section";
import { RepositoriesScreen } from "../repositories/repositories-screen";

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

const JOB = (id: string) => ({
  id,
  kind: "onboard-table",
  status: "succeeded",
  updatedAt: "2026-11-02T00:00:00Z",
  input: { table: "SecurityEvent" },
  steps: [],
});

interface Setup {
  store: Map<string, unknown>;
  config?: AzureConfig;
  hasPat?: boolean;
  userId?: string | null;
  jobs?: unknown[] | "fail";
  onConnect?: () => Promise<{ ok: boolean; secretStored: boolean; message: string }>;
}

function ports(s: Setup): UiPorts {
  return {
    jobs: {
      list: vi.fn(async () => {
        if (s.jobs === "fail") throw new Error("store down");
        return s.jobs ?? [];
      }),
    },
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
    user: {
      current: async () => {
        if (s.userId === null) throw new Error("no identity");
        return { id: s.userId ?? "u1" };
      },
    },
  } as unknown as UiPorts;
}

/** The connectivity section over real state, so choosing a radio takes effect. */
function StatefulConnectivity({
  initial,
  onChosen,
}: {
  initial: AzureConfig;
  onChosen?: (c: AzureConfig) => void;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <AzureConnectivitySection
      config={config}
      onChange={(c) => {
        setConfig(c);
        onChosen?.(c);
      }}
      storedIdentity={config.clientId !== ""}
      onClearIdentity={() => {}}
    />
  );
}

function mount(s: Setup, initialFacts: JourneyFacts, followConnectivity = false) {
  return render(<Root s={s} initialFacts={initialFacts} follow={followConnectivity} />);
}

function Root({ s, initialFacts, follow }: { s: Setup; initialFacts: JourneyFacts; follow: boolean }) {
  const [facts, setFacts] = useState(initialFacts);
  const config = s.config ?? configWith({});
  const ctx: ChangeRequestContext = { appName: "test", config };
  const sections = (
    <>
      <StatefulConnectivity
        initial={config}
        onChosen={follow ? (c) => setFacts((f) => ({ ...f, connectivity: c.connectivity })) : undefined}
      />
      <AzureConnectSection
        tenantId={config.tenantId}
        onTenantIdChange={() => {}}
        clientId={config.clientId}
        onClientIdChange={() => {}}
        setupPath={config.setupPath}
        onSetupPathChange={() => {}}
        secretLive={facts.secretLive === "live"}
        ctx={ctx}
        onConnect={s.onConnect ?? (async () => ({ ok: true, secretStored: true, message: "" }))}
        storageNote="note"
      />
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
      <RepositoriesScreen platform="cloud" />
    </>
  );
  return (
    <PortsProvider ports={ports(s)} config={config}>
      <HomeScreen
        facts={facts}
        links={{
          connect: { routeId: "home", hint: "h" },
          github: { routeId: "home" },
        }}
        onNavigate={() => {}}
        setupSections={sections}
      />
    </PortsProvider>
  );
}

/** The section element whose header carries `title`. */
function sectionOf(title: string): HTMLElement {
  const h = screen.getByRole("heading", { name: title });
  return h.closest("section") as HTMLElement;
}

function isFolded(title: string): boolean {
  return sectionOf(title).classList.contains("numbered-section-collapsed");
}

const TITLES = [
  "Journey",
  "App registration and connect",
  "Select resources and grant permissions",
  "GitHub personal access token",
  "Sentinel content",
  "Schema tables (KQL validation)",
  "Recent runs",
];

function openTitles(): string[] {
  return TITLES.filter((t) => screen.queryByRole("heading", { name: t }) !== null && !isFolded(t));
}

const summaryOf = (t: string) =>
  sectionOf(t).querySelector(".numbered-section-summary")?.textContent;

/** Let the first jobs load and the token status read settle. */
async function settle(): Promise<void> {
  await waitFor(() => expect(summaryOf("Recent runs")).toBeTruthy());
}

describe("Setup page folding (DBT-248)", () => {
  it("opens with only the current section open, beside Next action", async () => {
    // Identity present, secret missing: the next action is Connect.
    mount({ store: new Map() }, factsWith({ secretLive: "missing" }));
    await settle();
    expect(screen.getByRole("heading", { name: "Next action" })).toBeTruthy();
    expect(openTitles()).toEqual(["App registration and connect"]);
  });

  it("opens only the GitHub token section when that is the next action", async () => {
    mount({ store: new Map(), hasPat: false }, factsWith({ tokenPresent: false }));
    await settle();
    expect(openTitles()).toEqual(["GitHub personal access token"]);
  });

  it("folds every section when nothing is current", async () => {
    mount({ store: new Map() }, factsWith({}));
    await settle();
    expect(openTitles()).toEqual([]);
  });

  it("a move folds the other open sections", async () => {
    mount({ store: new Map() }, factsWith({ secretLive: "missing" }));
    await settle();
    expect(openTitles()).toEqual(["App registration and connect"]);
    fireEvent.click(screen.getByRole("button", { name: "Expand Sentinel content" }));
    // Opening is not a move; working inside the section is.
    expect(openTitles()).toEqual(["App registration and connect", "Sentinel content"]);
    // findBy: Refresh renders after the section loads its data (DBT-298).
    fireEvent.pointerDown(
      await within(sectionOf("Sentinel content")).findByRole("button", { name: "Refresh" }),
    );
    await waitFor(() => expect(openTitles()).toEqual(["Sentinel content"]));
  });

  it("a pinned section survives a move", async () => {
    mount({ store: new Map() }, factsWith({ secretLive: "missing" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Pin App registration and connect open" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Sentinel content" }));
    // An unpinned open section that the move MUST fold, so this cannot pass vacuously.
    fireEvent.click(screen.getByRole("button", { name: "Expand Recent runs" }));
    expect(isFolded("Recent runs")).toBe(false);
    // findBy: Refresh renders after the section loads its data (DBT-298).
    fireEvent.pointerDown(
      await within(sectionOf("Sentinel content")).findByRole("button", { name: "Refresh" }),
    );
    await waitFor(() =>
      expect(openTitles()).toEqual(["App registration and connect", "Sentinel content"]),
    );
    expect(isFolded("Recent runs")).toBe(true);
  });

  it("a stored pin opens its section on load, under a per-user key", async () => {
    const store = new Map<string, unknown>();
    mount({ store }, factsWith({ secretLive: "missing" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Pin Recent runs open" }));
    await waitFor(() => expect([...store.keys()]).toEqual(["setup-pinned-sections:u1"]));
    cleanup();
    mount({ store }, factsWith({ secretLive: "missing" }));
    await waitFor(() =>
      expect(openTitles()).toEqual(["App registration and connect", "Recent runs"]),
    );
  });

  it("with no identity, pins are session-only and write no shared key", async () => {
    const store = new Map<string, unknown>();
    mount({ store, userId: null }, factsWith({ secretLive: "missing" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Pin Recent runs open" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin Recent runs" })).toBeTruthy(),
    );
    expect(store.size).toBe(0);
  });

  it("shows each folded section's one-line summary", async () => {
    mount({ store: new Map(), hasPat: true, jobs: [JOB("a"), JOB("b")] }, factsWith({}));
    await waitFor(() => expect(summaryOf("Recent runs")).toBe("2 runs"));
    expect(summaryOf("Journey")).toBe("Setup complete");
    expect(summaryOf("App registration and connect")).toBe("Connected - client abcd...wxyz");
    expect(summaryOf("Select resources and grant permissions")).toBe("law-main in rg-sentinel");
    await waitFor(() =>
      expect(summaryOf("GitHub personal access token")).toBe("Token saved (octo)"),
    );
    expect(summaryOf("Sentinel content")).toBeTruthy();
    expect(summaryOf("Schema tables (KQL validation)")).toBe("Not checked yet");
  });

  it("summarises an unconnected, empty install", async () => {
    mount(
      { store: new Map(), config: configWith({ resourceGroup: "", workspaceName: "" }) },
      // The GitHub token is the next action, so Connect stays folded.
      factsWith({ secretLive: "missing", scopeCommitted: false, tokenPresent: false }),
    );
    await settle();
    expect(summaryOf("App registration and connect")).toBe("Not connected");
    expect(summaryOf("Select resources and grant permissions")).toBe("No target yet");
    expect(summaryOf("Recent runs")).toBe("No runs yet");
  });

  it("the Next action button opens its folded target", async () => {
    mount({ store: new Map(), hasPat: false }, factsWith({ tokenPresent: false }));
    await settle();
    // Fold the current section by moving elsewhere, then use the button.
    fireEvent.click(screen.getByRole("button", { name: "Expand Sentinel content" }));
    // findBy: Refresh renders after the section loads its data (DBT-298).
    fireEvent.pointerDown(
      await within(sectionOf("Sentinel content")).findByRole("button", { name: "Refresh" }),
    );
    await waitFor(() => expect(isFolded("GitHub personal access token")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Save a GitHub token" }));
    await waitFor(() => expect(openTitles()).toEqual(["GitHub personal access token"]));
  });

  it("a journey link opens the folded section its stage lives in", async () => {
    mount({ store: new Map(), hasPat: false }, factsWith({ tokenPresent: false }));
    await settle();
    expect(isFolded("App registration and connect")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand Journey" }));
    let connect: HTMLElement | undefined;
    await waitFor(() => {
      connect = screen
        .getAllByRole("button")
        .find(
          (b) => b.classList.contains("journey-step-main") && /^\d+Connect$/.test(b.textContent ?? ""),
        );
      expect(connect).toBeTruthy();
    });
    fireEvent.click(connect as HTMLElement);
    await waitFor(() => expect(isFolded("App registration and connect")).toBe(false));
    expect(isFolded("GitHub personal access token")).toBe(true);
  });

  it("keeps collapsed bodies mounted", async () => {
    mount({ store: new Map() }, factsWith({}));
    await settle();
    expect(isFolded("App registration and connect")).toBe(true);
    expect(screen.getByText("Directory (tenant) ID")).toBeTruthy();
  });

  it("Disconnected renders no Azure connect or resources section at all", async () => {
    mount(
      { store: new Map(), config: configWith({ connectivity: "disconnected" }) },
      factsWith({
        connectivity: "disconnected",
        identityPresent: false,
        secretLive: "missing",
        scopeCommitted: false,
      }),
    );
    await settle();
    expect(screen.queryByRole("heading", { name: "App registration and connect" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Select resources and grant permissions" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "What this app may do in Azure" })).toBeNull();
  });

  it("Partially Connected folds the checklist behind the radios, summarised by the request", async () => {
    mount(
      { store: new Map(), config: configWith({ connectivity: "partial" }) },
      factsWith({ connectivity: "partial" }),
    );
    await settle();
    expect(
      screen.getByRole("radiogroup", { name: "How will this app work with Azure?" }),
    ).toBeTruthy();
    expect(isFolded("What this app may do in Azure")).toBe(true);
    expect(summaryOf("What this app may do in Azure")).toMatch(/^Requesting: /);
  });

  it("choosing Partially Connected opens the checklist it reveals", async () => {
    mount({ store: new Map() }, factsWith({}));
    await settle();
    expect(screen.queryByRole("heading", { name: "What this app may do in Azure" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Partially Connected" }));
    expect(isFolded("What this app may do in Azure")).toBe(false);
  });

  it("choosing Partially Connected counts as a move: the checklist stays open when current follows the choice", async () => {
    // Disconnected -> Partial with the secret missing: current goes from none to connect.
    mount(
      { store: new Map(), config: configWith({ connectivity: "disconnected" }) },
      factsWith({ connectivity: "disconnected", secretLive: "missing" }),
      true,
    );
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: "Partially Connected" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "What this app may do in Azure" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(isFolded("What this app may do in Azure")).toBe(false);
  });

  it("a move during an in-flight Save and connect does not fold the connect section", async () => {
    mount(
      { store: new Map(), onConnect: () => new Promise(() => undefined) },
      factsWith({ secretLive: "missing" }),
    );
    await settle();
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Expand Sentinel content" }));
    // findBy: Refresh renders after the section loads its data (DBT-298).
    fireEvent.pointerDown(
      await within(sectionOf("Sentinel content")).findByRole("button", { name: "Refresh" }),
    );
    await waitFor(() =>
      expect(openTitles()).toEqual(["App registration and connect", "Sentinel content"]),
    );
  });

  it("a failure after the section was folded reopens it", async () => {
    let fail!: () => void;
    mount(
      {
        store: new Map(),
        onConnect: () =>
          new Promise((resolve) => {
            fail = () => resolve({ ok: false, secretStored: false, message: "bad secret" });
          }),
      },
      factsWith({ secretLive: "missing" }),
    );
    await settle();
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Collapse App registration and connect" }));
    expect(isFolded("App registration and connect")).toBe(true);
    fail();
    await waitFor(() => expect(isFolded("App registration and connect")).toBe(false));
    expect(screen.getByText(/bad secret/)).toBeTruthy();
  });

  it("says so when the run list could not be loaded", async () => {
    mount({ store: new Map(), jobs: "fail" }, factsWith({}));
    await waitFor(() => expect(summaryOf("Recent runs")).toBe("Could not load runs"));
  });

  it("lists the runs directly inside the fold, with no second dropdown", async () => {
    mount({ store: new Map(), jobs: [JOB("a")] }, factsWith({}));
    await waitFor(() => expect(summaryOf("Recent runs")).toBe("1 run"));
    expect(sectionOf("Recent runs").querySelector("details")).toBeNull();
  });

  it("only the section the journey points at wears the current badge", async () => {
    mount({ store: new Map(), hasPat: false }, factsWith({ tokenPresent: false }));
    await settle();
    expect(sectionOf("GitHub personal access token").className).toContain("numbered-section-current");
    expect(sectionOf("Sentinel content").className).toContain("numbered-section-available");
  });
});
