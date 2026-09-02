// @vitest-environment happy-dom
/**
 * SMOKE PIN: the Integrate screen must RENDER.
 *
 * Added 2026-08-11 after shipping a version that crashed this screen on every
 * render - a `useState` initializer read a `const` declared 40 lines further
 * down, which is a temporal-dead-zone ReferenceError the moment the component
 * mounts. It reached main.
 *
 * NOTHING CAUGHT IT. Typecheck passes because the read sits inside a closure,
 * where TypeScript cannot know when it runs; `useState(() => ...)` happens to
 * run it immediately. All 2,826 core and 672 UI tests passed, because not one
 * of them rendered this screen - the flagship of the app. The state module
 * beside it is thoroughly unit-tested, which is exactly what made the gap
 * invisible: the file with tests was not the file that crashed.
 *
 * So the first group asserts almost nothing about behaviour on purpose. Its
 * whole job is to mount the component, which is the one thing the rest of the
 * suite never did. Behavioural pins belong in integrate-screen-state.test.ts,
 * where they run without a DOM.
 *
 * THE EXCEPTION, added 2026-08-20: WIRING between the sample-source picker and
 * the acquisition panels below it. That wiring lives only in this file's
 * component - no pure module can see it - and it had gone wrong in the way a
 * smoke test cannot notice, because the screen still mounted perfectly. The
 * selected source was held twice (a string choice and a resolved entry) and the
 * group/mode handlers cleared only the string, so CapturePanel stayed mounted
 * against the PREVIOUS worker group while the dropdown showed nothing selected.
 * A capture from there POSTs to /m/{oldGroup}/system/capture filtered on an
 * __inputId that group need not contain: empty, and reported as an idle source.
 * Those pins mount the whole screen because a stale MOUNT is the defect.
 *
 * TWO MORE EXCEPTIONS, added 2026-08-31, and both for the same reason - the
 * decision lives in this component and nowhere a pure module can reach:
 *
 *   DBT-53  WHAT the sample-source picker is gated on. Also a mount, because
 *           the defect is a panel that never mounts at all.
 *   DBT-43  what an EMPTY DCR listing means for a pack build. Pinned against
 *           the exported pure helper rather than a mount: reaching the build
 *           callback needs an approved gap analysis, which no test here has.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DEFAULT_CRIBL_OPTIONS, emptyCapabilitySet } from "@soc/core";
import type {
  AzureConfig,
  CapabilityContext,
  CapabilitySet,
  CapabilityVerdict,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { IntegrateScreen, dcrInventoryReadNotice } from "./integrate-screen";

afterEach(cleanup);

/**
 * Ports stub. The screen fetches on mount (worker groups, pack conflicts); the
 * calls are allowed to fail, because a mount that survives its own failed
 * fetches is exactly what this pin is about.
 */
const PORTS = {
  azure: { request: vi.fn().mockRejectedValue(new Error("offline")) },
  cribl: { request: vi.fn().mockRejectedValue(new Error("offline")) },
  packs: { list: vi.fn().mockRejectedValue(new Error("offline")) },
  packInstall: { list: vi.fn().mockRejectedValue(new Error("offline")) },
  jobs: { list: vi.fn().mockResolvedValue([]) },
} as unknown as UiPorts;

/** A blank-but-complete Azure config: the screen trims these fields on render. */
const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
};

function renderScreen(props: Record<string, unknown> = {}) {
  return render(
    <PortsProvider ports={PORTS} config={CONFIG}>
      <IntegrateScreen
        toolkitVersion="9.9.9-test"
        scopeCommitted
        offline={false}
        onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
        criblDefaults={DEFAULT_CRIBL_OPTIONS}
        {...props}
      />
    </PortsProvider>,
  );
}

describe("IntegrateScreen - renders", () => {
  it("MOUNTS without throwing", () => {
    // The pin. A ReferenceError here is a blank screen for every user.
    expect(() => renderScreen()).not.toThrow();
    // Screen-owned content, not the shell's page heading - this pin must fail
    // when the SCREEN breaks, not when the frame around it changes.
    expect(screen.getByText(/Select Sentinel Solution/i)).toBeTruthy();
  });

  it("mounts with no optional props at all", () => {
    // The defaults path: an omitted criblDefaults must not become an
    // undefined-read somewhere downstream.
    expect(() =>
      render(
        <PortsProvider ports={PORTS} config={CONFIG}>
          <IntegrateScreen
            toolkitVersion="9.9.9-test"
      scopeCommitted={false}
            offline
            onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          />
        </PortsProvider>,
      ),
    ).not.toThrow();
  });

  it("renders the log-type recommendation in the Sample Data section", () => {
    // Wiring pin, in the spirit of this file: the panel's own behaviour is
    // covered by log-type-recommendation.dom.test.tsx, but a component that is
    // built, tested and never actually mounted is exactly the gap this smoke
    // test exists for. With no solution chosen there is nothing read yet, so
    // "unknown" is the honest state and the one that must reach the DOM.
    const { container } = renderScreen();
    const panel = container.querySelector(".log-type-recommendation");
    expect(panel).toBeTruthy();
    expect(panel?.getAttribute("data-status")).toBe("unknown");
  });

  it("renders the sample-source picker", () => {
    // Wiring pin, same reason as the one above: the picker must actually be on
    // screen. WHICH state it is in is a Cribl fact, pinned in its own describe
    // below - this stub has no listGroups, so the listing fails and "empty"
    // ("Nothing could be listed from Cribl") is the honest answer here.
    const { container } = renderScreen({ scopeCommitted: false });
    const picker = container.querySelector(".sample-source-picker");
    expect(picker).toBeTruthy();
    expect(picker?.getAttribute("data-status")).not.toBe("idle");
  });

  it("prefills the pack name before any solution is chosen", () => {
    // Proves the initializer ran and produced the documented default, which is
    // the exact line that crashed. The solution-derived form is pinned without
    // a DOM in integrate-screen-state.test.ts.
    renderScreen();
    const field = screen.getByDisplayValue("MS-Sentinel");
    expect(field).toBeTruthy();
  });
});

/**
 * DBT-43: AN EMPTY DCR LISTING IS NOT A ZERO.
 *
 * docs/inventory-standard.md is BINDING here, and this is the instance where
 * being wrong costs more than a sentence. ARM answers 200 with an empty array
 * when RBAC filters the caller out; the build then hands that empty list to
 * resolveDestinations, which reports "no Data Collection Rule in this resource
 * group routes it" for every table, and assemblePack bakes
 * dcr-00000000000000000000000000000000 into outputs.yml. The pack installs
 * cleanly and sends nowhere - the 2026-08-11 user report, re-entered through
 * the one door destination-resolution.ts could not close. "Read 0 deployed
 * DCR(s)" was the line that made it look like a fact about Azure.
 *
 * Pinned against the pure helper rather than a mounted build, because the build
 * callback needs an approved gap analysis and a resolved content plan to reach
 * and no mount-level test has one. Hardcoding the old sentence kills four of
 * the five pins below.
 */
const AUDITED_RG = "rg-soc-prod";

function auditedAs(verdict: CapabilityVerdict): CapabilitySet {
  return {
    verdicts: { "dcr.read": verdict },
    auditedAt: "2026-08-31T00:00:00.000Z",
    connectionId: "conn-1",
  };
}

/** Connected to Azure - so an unmeasured capability reads `unknown`, not `unreachable`. */
const CONNECTED: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};

describe("dcrInventoryReadNotice - the pack build's DCR listing", () => {
  const notice = (capabilities: CapabilitySet, count = 0): string =>
    dcrInventoryReadNotice({
      count,
      resourceGroup: AUDITED_RG,
      capabilities,
      context: CONNECTED,
    });

  it("reports the count when there are rows - permission is self-evident", () => {
    expect(notice(emptyCapabilitySet(), 3)).toContain(
      `Read 3 deployed DCR(s) from ${AUDITED_RG}`,
    );
  });

  it("calls an empty listing a zero ONLY when dcr.read was VERIFIED", () => {
    const text = notice(auditedAs("granted"));
    expect(text).toContain(
      `No deployed Data Collection Rules found in ${AUDITED_RG}`,
    );
    // A measured grant has earned the right to say none, so it must NOT hedge -
    // otherwise the honest cases below stop being distinguishable from it.
    expect(text).not.toMatch(/NOT confirmation/);
    expect(text).toContain("PLACEHOLDER destination values");
  });

  it("does NOT claim a zero when dcr.read was DENIED", () => {
    const text = notice(auditedAs("denied"));
    expect(text).toContain("does not have permission to read them");
    expect(text).toContain("NOT confirmation that it is");
    // Both shapes of the confident wrong answer, in the order they shipped.
    expect(text).not.toMatch(/Read 0 deployed DCR\(s\)/);
    expect(text).not.toMatch(/No deployed Data Collection Rules found/);
  });

  it("does NOT claim a zero when NOTHING has measured dcr.read", () => {
    // The common state, not an edge case: the audit runs on connection change,
    // so a healthy unaudited connection is normal. `unknown` is its own answer
    // and must collapse into neither of the other two.
    const text = notice(emptyCapabilitySet());
    expect(text).toContain("run the permission check to find out");
    expect(text).not.toMatch(/Read 0 deployed DCR\(s\)/);
    expect(text).not.toMatch(/No deployed Data Collection Rules found/);
  });

  it("names the consequence: the rules may exist where we cannot see them", () => {
    // The half the operator acts on. Without it the hedge is a permissions
    // aside; with it, it says why the pack about to be built points nowhere.
    const text = notice(emptyCapabilitySet());
    expect(text).toContain("PLACEHOLDER destination values");
    expect(text).toContain("may already exist where this identity cannot see them");
  });
});

/**
 * A Cribl workspace with two Stream worker groups holding DIFFERENT sources.
 * Different is the whole point: a source id that exists in both groups would
 * make a stale target indistinguishable from a correct one.
 */
const SOURCES: Record<string, unknown[]> = {
  default: [{ id: "in_syslog", type: "syslog" }],
  grp2: [{ id: "in_other", type: "http" }],
};

/**
 * Two PAN-OS AUTH events. AUTH is genuinely undictionaried - Palo Alto publishes
 * no AUTH log type, so the toolkit declines to guess one - and these parse
 * to POSITIONAL columns - which is what makes a capture of them something the
 * operator must be offered a chance to name (see the commit-wiring pin below).
 */
const PANOS_AUTH = [
  "1,2026/08/13 10:49:02,013201031064,AUTH,0,2817,2026/08/13 10:48:54,vsys1,user1",
  "1,2026/08/13 10:49:06,013201031064,AUTH,0,2818,2026/08/13 10:48:58,vsys1,user2",
];

/**
 * Ports whose Cribl answers the two discovery stages, plus a capture that
 * returns real positional events, and nothing else.
 */
function discoveryPorts() {
  const request = vi.fn(
    async (opts: { method: string; path: string; groupId?: string }) => {
      if (opts.path === "/system/inputs") {
        return { status: 200, body: { items: SOURCES[opts.groupId ?? ""] ?? [] } };
      }
      if (opts.path === "/system/capture") {
        return { status: 200, body: PANOS_AUTH.map((raw) => ({ _raw: raw })) };
      }
      if (opts.path.startsWith("/products/lake/")) {
        return { status: 200, body: { items: [{ id: "Corelight" }] } };
      }
      // Everything else this screen reaches for is beside the point here, and a
      // mount that survives its own failed fetches is already pinned above.
      throw new Error("offline");
    },
  );
  return {
    azure: { request: vi.fn().mockRejectedValue(new Error("offline")) },
    cribl: {
      request,
      listGroups: vi.fn().mockResolvedValue([
        { id: "default", product: "stream" },
        { id: "grp2", product: "stream" },
      ]),
    },
    packs: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    packInstall: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    jobs: { list: vi.fn().mockResolvedValue([]) },
    samples: memorySampleStore(),
  } as unknown as UiPorts;
}

/** An in-memory TaggedSampleStore, keyed by log type like the real ones. */
function memorySampleStore() {
  const byType = new Map<string, { logType: string }>();
  return {
    upsert: async (sample: { logType: string }) => {
      byType.set(sample.logType, sample);
    },
    get: async (logType: string) => byType.get(logType) ?? null,
    list: async () => [...byType.values()],
    remove: async (logType: string) => {
      byType.delete(logType);
    },
  };
}

function renderWithDiscovery() {
  const ports = discoveryPorts();
  const { container } = render(
    <PortsProvider ports={ports} config={CONFIG}>
      <IntegrateScreen
        toolkitVersion="9.9.9-test"
        scopeCommitted
        offline={false}
        onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
        criblDefaults={DEFAULT_CRIBL_OPTIONS}
      />
    </PortsProvider>,
  );
  const picker = () =>
    container.querySelector(".sample-source-picker") as HTMLElement;
  /** The picker's own comboboxes, in render order: worker group, then source. */
  const combos = () =>
    [...picker().querySelectorAll(".searchable-select-control")] as HTMLElement[];
  return { container, ports, picker, combos };
}

/** Open one combobox and click the option whose text contains `label`. */
function pickOption(combo: HTMLElement, label: string): void {
  const root = combo.closest(".searchable-select");
  if (root === null) throw new Error("combobox is not inside a searchable-select");
  fireEvent.click(combo);
  const option = [...root.querySelectorAll(".searchable-select-option")].find((o) =>
    o.textContent?.includes(label),
  );
  if (option === undefined) throw new Error(`no option matching "${label}"`);
  fireEvent.click(option);
}

/** Get as far as a mounted CapturePanel aimed at "in_syslog" in "default". */
async function selectSourceInDefaultGroup() {
  const view = renderWithDiscovery();
  await waitFor(() => {
    expect(screen.getByText("Capture from a live source")).toBeTruthy();
  });
  fireEvent.click(screen.getByText("Capture from a live source"));
  pickOption(view.combos()[0], "default");
  await waitFor(() => {
    expect(view.combos()).toHaveLength(2);
  });
  pickOption(view.combos()[1], "in_syslog");
  const panel = view.container.querySelector(".capture-panel");
  expect(panel).toBeTruthy();
  expect(panel?.querySelector(".capture-filter")?.textContent).toContain("in_syslog");
  return view;
}

/**
 * DBT-53: WHAT THE SAMPLE-SOURCE DISCOVERY IS GATED ON.
 *
 * Every route behind that picker is Cribl (worker groups, /system/inputs, Lake
 * datasets), but the screen passed `scopeCommitted` - three non-empty AZURE
 * strings - into both the hook and the panel. An operator who had not yet
 * committed a subscription got a picker frozen on "idle", telling them to
 * connect the one system that was connected, and neither CapturePanel nor
 * LakePanel could ever mount. The gate lives only in this component, so this is
 * the only file that can pin it.
 *
 * Two pins, because one alone is passable by cheating: the first fails if the
 * gate goes back to an Azure fact, the second fails if the gate is simply
 * removed.
 */
describe("IntegrateScreen - sample-source discovery is gated on CRIBL", () => {
  function renderGated(opts: { scopeCommitted: boolean; criblReachable: boolean }) {
    const ports = discoveryPorts();
    const { container } = render(
      // D-3: capabilityContext reaches the screen through PortsContext now.
      <PortsProvider
        ports={ports}
        config={CONFIG}
        capabilityContext={{
          azureIdentityPresent: opts.scopeCommitted,
          criblReachable: opts.criblReachable,
        }}
      >
        <IntegrateScreen
          toolkitVersion="9.9.9-test"
          scopeCommitted={opts.scopeCommitted}
          offline={false}
          onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          criblDefaults={DEFAULT_CRIBL_OPTIONS}
        />
      </PortsProvider>,
    );
    return {
      ports,
      status: () =>
        container
          .querySelector(".sample-source-picker")
          ?.getAttribute("data-status"),
    };
  }

  it("discovers with NO Azure scope committed - nothing here is an Azure read", async () => {
    const view = renderGated({ scopeCommitted: false, criblReachable: true });

    // `awaiting-mode` is only reachable through the hook's own group listing
    // (derivePickerView needs groups !== null && groups.ok), so this is the
    // listing having gone out - which the old gate stopped outright.
    await waitFor(() => {
      expect(view.status()).toBe("awaiting-mode");
    });
    // And the acquisition path is actually open: the mode chooser is what the
    // frozen "idle" picker never rendered, so neither panel below it could
    // ever mount.
    expect(screen.getByText("Capture from a live source")).toBeTruthy();
  });

  it("stays idle when the shell reports Cribl unreachable, whatever Azure says", async () => {
    // The other half. Azure is fully committed here, so a gate that returned to
    // `scopeCommitted` - or was deleted for a bare `enabled={true}` - would
    // discover, and this pin fails.
    const view = renderGated({ scopeCommitted: true, criblReachable: false });

    expect(view.status()).toBe("idle");
    // Settle on the screen's OWN worker-group dropdown, which has no gate at
    // all: the Cribl port is live and being used, and the picker still declines
    // to look. That is what makes this "idle" a decision rather than a frame
    // before a listing.
    await waitFor(() => {
      expect(view.ports.cribl.listGroups).toHaveBeenCalled();
    });
    expect(view.status()).toBe("idle");
    expect(screen.queryByText("Capture from a live source")).toBeNull();
  });
});

describe("IntegrateScreen - the acquisition panel follows the picker", () => {
  it("takes the capture panel down when the WORKER GROUP changes", async () => {
    // The defect this pins is invisible to a label check: CapturePanel is keyed
    // on the source id, so a target change does not even remount it - the panel
    // would sit there unchanged, still carrying the old group. Asserting it is
    // GONE is what distinguishes a cleared selection from a stale one.
    const view = await selectSourceInDefaultGroup();

    pickOption(view.combos()[0], "grp2");
    expect(view.container.querySelector(".capture-panel")).toBeNull();

    // And still gone once the new group's listing lands - the moment a stale
    // entry would otherwise be re-derived against a fresh inventory.
    await waitFor(() => {
      expect(view.combos()).toHaveLength(2);
    });
    expect(view.container.querySelector(".capture-panel")).toBeNull();
  });

  it("retargets to the NEW group's source, never the old one", async () => {
    // The other half: the panel must come back aimed at what was actually
    // picked. The filter names the source, and a capture that keeps the old
    // __inputId returns nothing from a group that never had it.
    const view = await selectSourceInDefaultGroup();

    pickOption(view.combos()[0], "grp2");
    await waitFor(() => {
      expect(view.combos()).toHaveLength(2);
    });
    pickOption(view.combos()[1], "in_other");

    const filter = view.container
      .querySelector(".capture-panel")
      ?.querySelector(".capture-filter")?.textContent;
    expect(filter).toContain("in_other");
    expect(filter).not.toContain("in_syslog");
  });

  it("takes the capture panel down when the MODE changes to lake-query", async () => {
    // Otherwise the operator reads a capture panel sitting over a Lake
    // inventory - two mutually exclusive acquisition paths on screen at once,
    // one of them addressing a worker group this mode does not even use.
    const view = await selectSourceInDefaultGroup();

    fireEvent.click(screen.getByText("Query a Cribl Lake dataset"));
    expect(view.container.querySelector(".capture-panel")).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("Lake dataset")).toBeTruthy();
    });
    expect(view.container.querySelector(".capture-panel")).toBeNull();
    // Nothing is picked in the new mode yet, so no panel replaces it either.
    expect(view.container.querySelector(".lake-panel")).toBeNull();
  });
});

/**
 * THE WIRE, end to end, and the reason it is pinned at SCREEN level rather than
 * only inside the intake section.
 *
 * The acquisition panels are siblings of the Sample Data section, so committing
 * a sample and OFFERING TO NAME its positional columns are two different
 * components' jobs. This screen is the only place they meet: it writes the
 * batch to the shared store and then announces the arrival, and the section
 * opens the column dialog. Wire only the first half - which is exactly what
 * shipped - and the samples land in silence, which is the live 2026-08-25
 * report ("it adds them but doesn't give me the preview to modify them").
 *
 * Both panels commit through ONE callback so they cannot drift apart again; the
 * capture path is driven here because this file already gets to a mounted
 * CapturePanel. What the section then does with the announcement - one turn per
 * headerless sample, nothing at all when none are - is pinned in
 * sample-intake-section.dom.test.tsx.
 */
describe("IntegrateScreen - an acquired sample reaches the column dialog", () => {
  it("offers header resolution after a CAPTURE commits positional events", async () => {
    const view = await selectSourceInDefaultGroup();

    await act(async () => {
      fireEvent.click(screen.getByText("Run capture"));
    });
    // The capture produced something to commit - otherwise the assertion below
    // would pass for a screen that captured nothing at all.
    expect(view.container.querySelectorAll(".capture-results li")).toHaveLength(1);
    expect(view.container.querySelector(".csv-dialog")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("Add these as samples"));
    });

    expect(view.container.querySelector(".csv-dialog")).toBeTruthy();
    expect(
      view.container.querySelector(".csv-dialog-title")?.textContent,
    ).toContain("Headerless CSV detected");
  });
});

/**
 * Export instead of deploy (DBT-35). These are WIRING pins in the spirit of
 * this file: buildAirGapArchive and buildArmTemplate are pinned thoroughly in
 * @soc/core, but the control that reaches them lives only here, and the whole
 * point of the feature is that it is reachable from THIS screen. A handler
 * that is written, typechecked and never rendered is the gap this file exists
 * for.
 */
describe("IntegrateScreen - export instead of deploy", () => {
  function exportButton(): HTMLButtonElement {
    const found = screen
      .getAllByRole("button")
      .find((b) => /export instead of deploy/i.test(b.textContent ?? ""));
    if (found === undefined) {
      throw new Error("the export control is not rendered");
    }
    return found as HTMLButtonElement;
  }

  it("renders the export control in the Deploy section", () => {
    renderScreen();
    expect(exportButton()).toBeTruthy();
  });

  it("names the missing prerequisite instead of failing silently", () => {
    // CONFIG has no subscription and no table, and the stub host has no
    // artifacts port. Disabled is correct - saying WHY is the requirement.
    renderScreen();
    const button = exportButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("This host cannot save files.");
  });

  it("asks for the scope once the host CAN save, rather than the deploy fields", () => {
    // The distinction the feature turns on: an export needs a scope to read
    // schemas from, NOT a worker group or an ingestion client id. If this pin
    // ever reports one of those, the export has been re-gated on writing.
    const withSink = {
      ...(PORTS as unknown as Record<string, unknown>),
      artifacts: { save: vi.fn().mockResolvedValue(undefined) },
    } as unknown as UiPorts;
    render(
      <PortsProvider ports={withSink} config={CONFIG}>
        <IntegrateScreen
          toolkitVersion="9.9.9-test"
          scopeCommitted
          offline={false}
          onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          criblDefaults={DEFAULT_CRIBL_OPTIONS}
        />
      </PortsProvider>,
    );
    const button = exportButton();
    // The blank CONFIG has no subscription, so THAT is the honest first
    // unmet prerequisite - and it is a READ prerequisite.
    expect(button.getAttribute("title")).toBe(
      "Select a subscription, resource group and workspace first.",
    );
    // The load-bearing half: never a write prerequisite. If this ever names a
    // worker group or an ingestion client id, the export has been re-gated on
    // deploying, which is the whole thing the feature exists to avoid.
    expect(button.getAttribute("title")).not.toMatch(/worker group|client id/i);
  });
});

/**
 * HON-7: THE FALLBACK OFFER HAS A BUTTON.
 *
 * Rule 2 of the capability model says every blocked action falls back to a
 * downloadable artifact. FallbackNotice has supported a control since the model
 * shipped and its own pins have always exercised one - but the single
 * production caller (the RBAC preflight panel) passed no `onProduce`, so the
 * rule had no button anywhere in the app. The component was not the defect; the
 * call sites were, which is why the pin has to mount a SCREEN.
 *
 * D-2 (backlog section 16) put the offer on all three deploy surfaces, each
 * wiring its own producer. Here the producer is the export run - the same
 * deploy stopping before every write - so the artifact the offer names is
 * genuinely what the click produces.
 */
const DENIED_DCR_WRITE: CapabilitySet = {
  verdicts: { "dcr.write": "denied" },
  auditedAt: "2026-08-31T00:00:00.000Z",
  connectionId: "conn-1",
};

/** A committed scope, so the export's READ prerequisites are all met. */
const SCOPED_CONFIG: AzureConfig = {
  clientId: "client-1",
  tenantId: "tenant-1",
  subscriptionId: "sub-1",
  resourceGroup: "rg-soc-prod",
  workspaceName: "law-soc",
  setupPath: "existing",
};

describe("IntegrateScreen - the blocked deploy offers an artifact (HON-7)", () => {
  function renderAudited(capabilities: CapabilitySet) {
    const ports = {
      ...(PORTS as unknown as Record<string, unknown>),
      artifacts: { save: vi.fn().mockResolvedValue(undefined) },
    } as unknown as UiPorts;
    return render(
      // D-3: the measured audit reaches the screen through PortsContext.
      <PortsProvider
        ports={ports}
        config={SCOPED_CONFIG}
        capabilities={capabilities}
        capabilityContext={CONNECTED}
      >
        <IntegrateScreen
          toolkitVersion="9.9.9-test"
          scopeCommitted
          offline={false}
          onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          criblDefaults={DEFAULT_CRIBL_OPTIONS}
        />
      </PortsProvider>,
    );
  }

  /** The offer's control, by the label the artifact catalog gives its kind. */
  function offerButton(): HTMLButtonElement | undefined {
    return screen
      .getAllByRole("button")
      .find((b) =>
        /download the arm request bodies/i.test(b.textContent ?? ""),
      ) as HTMLButtonElement | undefined;
  }

  it("renders a CONTROL on the offer, not just the artifact's name", () => {
    // The defect, stated: a measured denial produced a notice with no way to
    // act on it. Enabled matters as much as present - a permanently disabled
    // control is the same dead end wearing a button.
    renderAudited(DENIED_DCR_WRITE);
    const button = offerButton();
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(false);
  });

  it("starts the export run when the offer is taken", () => {
    // What makes the button worth having. The producer is the export run, and
    // its first line names the tables it is collecting - so this fails if
    // onProduce is dropped again, and equally if it is wired to something that
    // does not produce the artifact the offer named.
    renderAudited(DENIED_DCR_WRITE);
    fireEvent.click(offerButton()!);
    expect(screen.getByText(/Collecting ARM resources for SecurityEvent/)).toBeTruthy();
  });

  it("leaves the live deploy exactly as available - it annotates, never removes", () => {
    // Rule 3. A denied verdict is evidence, not a gate: Azure's own 403 is the
    // gate, and a stale audit must not talk anyone out of an attempt that would
    // have worked. If this ever fails, the offer has started hiding the action.
    renderAudited(DENIED_DCR_WRITE);
    const deploy = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Deploy");
    expect(deploy).toBeTruthy();
  });

  it("offers NOTHING when no write has been measured", () => {
    // The other half, and the one that keeps the offer meaningful: `unknown` is
    // the normal state of a healthy unaudited connection. Offering there would
    // assert a block nobody measured - the exact collapse of "not measured"
    // into "denied" the capability model is built to prevent.
    renderAudited(emptyCapabilitySet());
    expect(offerButton()).toBeUndefined();
  });
});
