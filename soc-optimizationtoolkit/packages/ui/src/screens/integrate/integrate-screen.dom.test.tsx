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
import {
  DEFAULT_CRIBL_OPTIONS,
  TAGGED_SAMPLE_MAX_BYTES,
  capTaggedSampleBytes,
  emptyCapabilitySet,
  toListing,
} from "@soc/core";
import type {
  AzureConfig,
  CapabilityContext,
  CapabilitySet,
  CapabilityVerdict,
  SolutionRef,
  TaggedSample,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { panosCefCaptureBody } from "../samples/panos-cef-capture-test-fixture";
import {
  IntegrateScreen,
  dcrInventoryReadNotice,
  shouldCheckRoutablePrerequisites,
} from "./integrate-screen";

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
function discoveryPorts(
  overrides: { captureBody?: unknown; samples?: unknown } = {},
) {
  const request = vi.fn(
    async (opts: { method: string; path: string; groupId?: string }) => {
      if (opts.path === "/system/inputs") {
        return { status: 200, body: { items: SOURCES[opts.groupId ?? ""] ?? [] } };
      }
      if (opts.path === "/system/capture") {
        return {
          status: 200,
          body:
            overrides.captureBody ?? PANOS_AUTH.map((raw) => ({ _raw: raw })),
        };
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
      listGroups: vi.fn().mockResolvedValue(
        toListing([
          { id: "default", product: "stream" },
          { id: "grp2", product: "stream" },
        ]),
      ),
    },
    packs: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    packInstall: { list: vi.fn().mockRejectedValue(new Error("offline")) },
    jobs: { list: vi.fn().mockResolvedValue([]) },
    samples: overrides.samples ?? memorySampleStore(),
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

function renderWithDiscovery(ports: UiPorts = discoveryPorts()) {
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
async function selectSourceInDefaultGroup(ports?: UiPorts) {
  const view = renderWithDiscovery(ports);
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
 * DBT-197, AT THE SCREEN, because the read-back that finds a trim lives in this
 * component's commit callback and nowhere a pure module can see it.
 *
 * The UAT: "Captured 100 events", then a chip reading "captured 9 events" and a
 * commit headline of "Added 1 sample from this capture." - 91 events gone with
 * no reason given. The reason is the cloud store's byte cap, so the store here
 * caps the way the adapter does (core capTaggedSampleBytes, at the budget the
 * adapter tries after one 413). The count is pinned at all three places the
 * operator reads it: the capture headline, the commit headline, the chip.
 */
describe("IntegrateScreen - a trimmed capture says what the store kept", () => {
  /** Keyed by log type like the real stores, and byte-capped like the KV one. */
  function byteCappedSampleStore() {
    const byType = new Map<string, TaggedSample>();
    return {
      upsert: async (sample: TaggedSample) => {
        const capped = capTaggedSampleBytes(sample, TAGGED_SAMPLE_MAX_BYTES / 2);
        byType.set(sample.logType, JSON.parse(JSON.stringify(capped.sample)));
      },
      get: async (logType: string) => byType.get(logType) ?? null,
      list: async () => [...byType.values()],
      remove: async (logType: string) => {
        byType.delete(logType);
      },
    };
  }

  it("reports 14 of 50 kept per log type in the commit headline and on the chips", async () => {
    const view = await selectSourceInDefaultGroup(
      discoveryPorts({
        captureBody: panosCefCaptureBody(100),
        samples: byteCappedSampleStore(),
      }),
    );
    const panel = () => view.container.querySelector(".capture-panel") as HTMLElement;

    await act(async () => {
      fireEvent.click(screen.getByText("Run capture"));
    });
    expect(panel().querySelector(".panel-desc")?.textContent).toBe(
      "Captured 100 events in 2 log types (cef).",
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Add these as samples"));
    });

    await waitFor(() => {
      expect(
        panel().querySelector('[data-testid="capture-outcome"] .panel-desc')
          ?.textContent,
      ).toBe(
        'Added 2 samples from this capture. "THREAT" kept 14 of its 50 events: the sample store limits how large one log type\'s sample can be, and these events are large. Its field list was still read from all 50. "TRAFFIC" kept 14 of its 50 events: the sample store limits how large one log type\'s sample can be, and these events are large. Its field list was still read from all 50.',
      );
    });
    // DBT-196 split the capture by PAN-OS header TYPE: one chip per type,
    // each byte-capped on its own.
    const chips = [...view.container.querySelectorAll(".sample-chip-counts")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual([
      "14 events, 115 fields, time: PanTimeHighRes",
      "14 events, 115 fields, time: PanTimeHighRes",
    ]);
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

/**
 * DBT-102: what the SIEM pivot actually costs, driven end to end.
 *
 * WHY IT IS PINNED AND NOT ARGUED. The warning added to the SIEM screen says
 * the pivot deletes samples. That sentence is only allowed to exist if the
 * deletion is real, and the only place it can be SEEN is a mount: the deep link
 * arrives in a mount initializer inside SolutionBrowser, the previous solution
 * arrives from an async contentCache read inside this screen, and the deletion
 * is the interaction of the two. No pure module sees any of it - which is
 * exactly why the behaviour shipped with a button that said nothing.
 *
 * THE SETUP IS THE PIVOT, not a proxy for it. The hash is what
 * siem-migration-screen's openInIntegration writes, "CiscoASA" is the solution
 * the content cache is holding from before, and "Zscaler" is where the pivot
 * lands. handleSolutionChange then sees a real change and takes the branch that
 * removes every tagged sample (integrate-screen.tsx:652-665).
 *
 * WHAT THIS PIN DOES NOT SAY. It does not endorse the deletion - the DBT-72
 * decision settled that samples are cheap to re-acquire. It says the
 * destructive path is REACHABLE from a button labelled "Open in Sentinel
 * Integration", which is the whole claim the warning makes.
 *
 * IT USED TO CARVE OUT THE ORDERING, AND THAT CARVE-OUT IS GONE (review
 * 2026-09-04). This block said the deletion was not guaranteed "because the
 * previous solution has to have been restored before the deep link resolves and
 * those are two independent async paths". Measured, that was not a caveat about
 * a warning being approximate - it was a second failure hiding behind one: with
 * a 200ms delay on the stored-selection read the deep link landed first, the
 * restore's continuation then overwrote the host's solution with the STORED
 * name while the browser's card still showed the deep-linked one, so the page
 * named TWO different solutions at once and removed nothing (remove calls 0,
 * against 1 with the same fixture and no delay). The screen now re-checks after
 * that await and replays the late restore through handleSolutionChange, so both
 * orderings end in the same state - which is what makes the warning true as
 * written rather than true when it happens to win a race. The delayed ordering
 * is pinned below beside the immediate one.
 */
describe("IntegrateScreen - the solution handoff deletes samples (DBT-102)", () => {
  const SAMPLE = {
    logType: "CISCO_ASA",
    format: "syslog",
    rawEvents: ["%ASA-6-302013: Built outbound TCP connection"],
    parsed: {
      format: "syslog",
      records: [{ msg: "Built outbound TCP connection" }],
      eventCount: 1,
      fields: [],
      rawEvents: ["%ASA-6-302013: Built outbound TCP connection"],
      sourceName: "asa.log",
      errors: [],
    },
  } as unknown as TaggedSample;

  const INDEX: SolutionRef[] = [
    { name: "CiscoASA", path: "Solutions/CiscoASA" },
    { name: "Zscaler", path: "Solutions/Zscaler" },
  ];

  function renderPivotedInto(
    hash: string,
    storedSolution: string,
    // Delays ONLY the stored-selection read, which is how the two async paths
    // are put in a chosen order. Undefined leaves it resolving immediately -
    // the ordering every other case in this describe runs in.
    restoreDelayMs?: number,
  ) {
    window.location.hash = hash;
    const remove = vi.fn().mockResolvedValue(undefined);
    const ports = {
      ...(PORTS as unknown as Record<string, unknown>),
      content: {
        getCommitSha: vi.fn().mockResolvedValue("abcdef012345"),
        listSolutions: vi.fn().mockResolvedValue(INDEX),
        listConnectorFiles: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(null),
      },
      contentCache: {
        // Only the selected-solution entry is seeded; every other key (the
        // solution index cache) reads as a miss so the index is fetched.
        get: vi.fn(async (key: string) => {
          if (!key.includes("selected-solution")) {
            return null;
          }
          if (restoreDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, restoreDelayMs));
          }
          return storedSolution;
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      samples: {
        list: vi.fn().mockResolvedValue([SAMPLE]),
        get: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
        remove,
      },
    } as unknown as UiPorts;
    render(
      <PortsProvider ports={ports} config={SCOPED_CONFIG}>
        <IntegrateScreen
          toolkitVersion="9.9.9-test"
          scopeCommitted
          offline={false}
          onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          criblDefaults={DEFAULT_CRIBL_OPTIONS}
        />
      </PortsProvider>,
    );
    return remove;
  }

  afterEach(() => {
    window.location.hash = "#/";
  });

  it("REMOVES every tagged sample when the pivot lands on a different solution", async () => {
    const remove = renderPivotedInto("#/?solution=Zscaler", "CiscoASA");
    // The handoff really landed - without this the removal assertion could pass
    // for some unrelated reason while the pivot silently did nothing.
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected-name")?.textContent,
      ).toBe("Zscaler");
    });
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("CISCO_ASA");
    });
    // One store entry, one removal: the branch walks the whole list.
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("REMOVES them on the same pivot when the stored read comes back LATE", async () => {
    // THE ORDERING THIS SCREEN USED TO LOSE SILENTLY. Everything is identical
    // to the case above except that the stored-selection read takes 200ms, so
    // the deep link resolves first. Measured before the fix with exactly this
    // fixture: card "Zscaler", pack name "MS-Sentinel-CiscoASA", remove calls
    // 0 - the page naming two solutions at once with nothing deleted, and no
    // notice of either. What makes that zero a measurement rather than a blind
    // spot is the case above: the same harness, one line different, seeing a
    // removal.
    const remove = renderPivotedInto("#/?solution=Zscaler", "CiscoASA", 200);
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected-name")?.textContent,
      ).toBe("Zscaler");
    });
    await waitFor(
      () => {
        expect(remove).toHaveBeenCalledWith("CISCO_ASA");
      },
    );
    expect(remove).toHaveBeenCalledTimes(1);
    // ONE SOLUTION ON THE PAGE. The pack name is derived from the HOST's
    // `solution` state and the card from the BROWSER's, so the two disagreeing
    // is how the split reached the screen - and it is invisible to any
    // assertion that reads only the card.
    const packField = screen.getByDisplayValue(/^MS-Sentinel/);
    expect((packField as HTMLInputElement).value).toBe("MS-Sentinel-Zscaler");
  });

  it("makes good on what the UNRESOLVED-RESTORE notice says picking will cost", async () => {
    // The notice this screen's browser raises when the RESTORED name matches
    // nothing (DBT-28 defect (1), second caller) tells the operator that
    // picking a solution here deletes the samples acquired for the restored
    // one. That is a claim about THIS screen, made from a component that
    // cannot see it, so it is pinned on this side: the browser is entitled to
    // say it only while this stays green.
    const remove = renderPivotedInto("#/", "Cisco ASA Legacy");
    await waitFor(() => {
      expect(document.querySelector(".solution-browser-unresolved")).toBeTruthy();
    });
    // The split the notice describes: the browse list is up here while the
    // host is still scoped to the restored name (the pack name proves it).
    expect(document.querySelector(".solution-browser-list")).toBeTruthy();
    expect(
      (screen.getByDisplayValue(/^MS-Sentinel/) as HTMLInputElement).value,
    ).toBe("MS-Sentinel-Cisco-ASA");
    fireEvent.click(screen.getByText("Zscaler"));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("CISCO_ASA");
    });
  });

  it("removes NOTHING when the pivot lands on the solution already selected", async () => {
    // NON-VACUITY, and the honest boundary of the warning: re-opening the same
    // solution is not destructive, because handleSolutionChange returns early
    // when prevName === nextName. A pin that fired here would be describing a
    // screen that deletes on every navigation.
    const remove = renderPivotedInto("#/?solution=CiscoASA", "CiscoASA");
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected-name")?.textContent,
      ).toBe("CiscoASA");
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("IGNORES a deep link written after it is already mounted - and keeps it", async () => {
    // The other half of the SIEM screen's warning, and the half its copy used
    // to end on: pressing the pivot while Sentinel Integration is already
    // mounted changes nothing NOW. Nothing in this package listens for
    // hashchange - the hash is read in a mount initializer
    // (solution-browser.tsx) - so the write lands in the address and stops
    // there.
    //
    // WHAT THAT IS NOT is harmless, which is why the copy no longer says the
    // click "leaves the selection alone" and stops. The hash is not consumed
    // and nothing clears it, so the pivot stays ARMED: the next FRESH mount
    // carrying it applies the switch and takes the deletion with it. That
    // second half is not asserted here by inspection - it is the two tests
    // above, which are this same fixture mounted fresh on this same hash.
    const remove = renderPivotedInto("#/", "CiscoASA");
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected-name")?.textContent,
      ).toBe("CiscoASA");
    });
    act(() => {
      window.location.hash = "#/?solution=Zscaler";
      window.dispatchEvent(new Event("hashchange"));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      document.querySelector(".solution-browser-selected-name")?.textContent,
    ).toBe("CiscoASA");
    expect(remove).not.toHaveBeenCalled();
    // The write SURVIVES - it is what a later mount reads. If some cleanup
    // ever consumed or cleared it here, the warning's "applied on the next
    // load" clause would be the false half instead.
    expect(window.location.hash).toBe("#/?solution=Zscaler");
  });

  it("resolves the handoff through a punctuation variant - and still deletes", async () => {
    // DBT-28 defect (1) and DBT-102 meeting on one path, which is the reason
    // the two cards were read together. "Cisco ASA" is the string the SIEM
    // knowledge base hands over for a `cisco_` macro with no direct entry of
    // its own; "CiscoASA" is the folder. The pair is hard-coded rather than
    // imported, so a knowledge-base correction (DBT-103) leaves this pin
    // describing the same defect class.
    // Before the resolver collapsed separators this link resolved to
    // nothing and was consumed in silence - so the fix turns a silent no-op
    // into a working pivot that IS destructive, and the warning is what makes
    // that trade honest rather than a new surprise.
    const remove = renderPivotedInto("#/?solution=Cisco%20ASA", "Zscaler");
    await waitFor(() => {
      expect(
        document.querySelector(".solution-browser-selected-name")?.textContent,
      ).toBe("CiscoASA");
    });
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("CISCO_ASA");
    });
  });
});

/**
 * GEN-16: the routable pack's worker-group prerequisite.
 *
 * Most of this decision is pinned as a pure function in core
 * (routable-prerequisites.test.ts, mutation-checked six ways). What lives ONLY
 * here is the GUARD in front of it, and the guard is the half that can produce
 * a false STATEMENT rather than a missing one - which is why it gets a mount.
 *
 * THESE PINS USE THEIR OWN PORTS STUB, and that is the point rather than a
 * convenience. The file's shared stub fails every Cribl call, so no worker
 * group is ever selected and the panel cannot render for any reason at all.
 * Written against it, the first pin below passed with the guard DELETED -
 * vacuous, asserting only that an unreachable panel was absent. This stub makes
 * the panel reachable, so the assertion that it stays away is about the guard.
 */
const ROUTABLE_OUTPUTS = {
  status: 200,
  body: { items: [{ id: "MS-Sentinel-CommonSecurityLog-dest", url: "" }] },
};

function renderWithGroup(request = vi.fn().mockResolvedValue(ROUTABLE_OUTPUTS)) {
  const ports = {
    ...(PORTS as unknown as Record<string, unknown>),
    cribl: {
      request,
      // The screen filters to Stream groups; an undefined product qualifies.
      listGroups: vi
        .fn()
        .mockResolvedValue(toListing([{ id: "AzureManaged", name: "AzureManaged" }])),
    },
  } as unknown as UiPorts;
  const utils = render(
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
  return { ...utils, request };
}

/** Switch the Pack wiring control to the routable shape. */
async function chooseRoutable(container: HTMLElement) {
  const wiring = [...container.querySelectorAll("select")].find((sel) =>
    [...sel.options].some((o) => o.value === "routable"),
  );
  expect(wiring).toBeTruthy();
  await act(async () => {
    fireEvent.change(wiring as HTMLSelectElement, {
      target: { value: "routable" },
    });
  });
  expect((wiring as HTMLSelectElement).value).toBe("routable");
  return wiring as HTMLSelectElement;
}

describe("IntegrateScreen - routable pack prerequisites (GEN-16)", () => {
  it("selects a worker group, so the panel these pins forbid is REACHABLE", async () => {
    // The guard against the vacuity described above. If the screen ever stops
    // selecting a group from this stub, the two pins below would go back to
    // asserting the absence of something that could not appear, and would keep
    // passing while the behaviour they cover rotted. This fails first instead.
    renderWithGroup();
    // The screen states its own committed target, which is the observable that
    // does not depend on how the group picker is built.
    await waitFor(() => {
      expect(screen.getByText(/worker group: AzureManaged/i)).toBeTruthy();
    });
    expect(screen.queryByText(/worker group: \(none selected\)/i)).toBeNull();
  });

  it("says NOTHING about destinations when there are no tables to check", async () => {
    // The failure this forbids is a VACUOUS REASSURANCE. With no gap analysis
    // run there are no destination tables, so the check has nothing to compare;
    // without the guard the report is trivially satisfied and the panel would
    // announce that every destination it needs is already present - true only
    // because it needs none. An operator reading that goes on to build a
    // routable pack believing the group is ready.
    const { container, request } = renderWithGroup();
    await waitFor(() => {
      expect(screen.getByText(/worker group: AzureManaged/i)).toBeTruthy();
    });
    await chooseRoutable(container);
    await waitFor(() => {
      expect(screen.queryByText(/Destinations this pack will need/i)).toBeNull();
    });
    expect(screen.queryByText(/are already in/i)).toBeNull();
    // And it does not ASK, either: a listing with nothing to compare it against
    // is a request per group change that can only produce the claim above.
    expect(
      request.mock.calls.filter(
        (c) => (c[0] as { path?: string })?.path === "/system/outputs",
      ),
    ).toHaveLength(0);
  });

  it("names Deploy as what puts the destination in the worker group", async () => {
    // The whole reported defect was that nothing connected the two actions.
    // The hint may be reworded; it may not stop naming Deploy, because that is
    // the only place the operator can act on what this control just told them.
    const { container } = renderWithGroup();
    await chooseRoutable(container);
    const hint = [...container.querySelectorAll(".field-hint")].find((el) =>
      /must already exist in the worker group/i.test(el.textContent ?? ""),
    );
    expect(hint).toBeTruthy();
    expect(hint?.textContent).toMatch(/Deploy is what puts it there/i);
  });
});

/**
 * DBT-134 WIRING: the Cribl config section's worker-group field and the
 * fan-out under it render through the shared WorkerGroupField. What the field
 * says per state is pinned in worker-group-field.dom.test.tsx; these prove the
 * screen hands it the listing rather than a filtered array again.
 */
describe("IntegrateScreen - worker-group listing states (DBT-134)", () => {
  function renderListing(listGroups: ReturnType<typeof vi.fn>) {
    const ports = {
      ...(PORTS as unknown as Record<string, unknown>),
      cribl: { request: vi.fn().mockRejectedValue(new Error("offline")), listGroups },
    } as unknown as UiPorts;
    const utils = render(
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
    const section = utils.container.querySelector<HTMLElement>(
      "#integrate-section-cribl-config",
    );
    expect(section).not.toBeNull();
    return section!;
  }

  function fanOut() {
    fireEvent.click(screen.getByLabelText(/Deploy the pack to multiple worker groups/));
  }

  it("hedges an EMPTY listing - no empty select, no 'No matches'", async () => {
    const section = renderListing(vi.fn().mockResolvedValue(toListing([])));
    await waitFor(() =>
      expect(section.textContent).toMatch(/Cribl returned no worker groups this account can see/),
    );
    expect(section.textContent).not.toMatch(/No matches/);
    expect(section.querySelector(".searchable-select")).toBeNull();
    expect(
      section.querySelector('button[aria-label="Retry loading groups"]'),
    ).not.toBeNull();
  });

  it("names the groups when the listing holds only Edge / Search groups", async () => {
    const section = renderListing(
      vi.fn().mockResolvedValue(
        toListing([
          { id: "default_fleet", product: "edge" },
          { id: "default_search", product: "search" },
        ]),
      ),
    );
    await waitFor(() =>
      expect(section.textContent).toMatch(/none is a Stream worker group/),
    );
    expect(section.textContent).toMatch(/default_fleet \(edge\), default_search \(search\)/);
  });

  it("shows a refused listing as an error in the fan-out too, never an endless Loading", async () => {
    const section = renderListing(
      vi.fn().mockRejectedValue(new Error("GET /master/groups: HTTP 403")),
    );
    await waitFor(() =>
      expect(section.textContent).toMatch(/Could not list worker groups/),
    );
    fanOut();
    expect(section.textContent).not.toMatch(/Loading worker groups/);
    // Once for the primary picker, once for the fan-out under it.
    expect(
      section.querySelectorAll('button[aria-label="Retry loading groups"]'),
    ).toHaveLength(2);
    expect(section.textContent?.match(/Could not list worker groups/g)).toHaveLength(2);
  });

  it("says which group is the only one, rather than that none are available", async () => {
    const section = renderListing(
      vi.fn().mockResolvedValue(toListing([{ id: "default", product: "stream" }])),
    );
    await waitFor(() =>
      expect(screen.getByText(/worker group: default/i)).toBeTruthy(),
    );
    fanOut();
    expect(section.textContent).toMatch(
      /default is the only Stream worker group Cribl returned/,
    );
    expect(section.textContent).toMatch(/Groups your Cribl role cannot see are not listed/);
    expect(section.textContent).not.toMatch(/No other worker groups are available/);
  });
});

describe("shouldCheckRoutablePrerequisites (GEN-16)", () => {
  // Pinned as a pure function because the mount above can only reach the
  // no-tables branch; with tables it needs an approved gap analysis. Each case
  // names the false statement it prevents, because "returns false" is not the
  // point - not saying a specific wrong thing is.
  it("runs for a routable pack with a group and tables to check", () => {
    expect(shouldCheckRoutablePrerequisites("routable", "AzureManaged", 2)).toBe(true);
  });

  it("does NOT run for an all-inclusive pack, which carries its own destination", () => {
    // Reporting the group's destination as missing would describe a problem the
    // operator does not have: the pack ships the destination and its secret.
    expect(shouldCheckRoutablePrerequisites("all-inclusive", "AzureManaged", 2)).toBe(false);
  });

  it("does NOT run with no worker group, where 'missing' would be about nowhere", () => {
    expect(shouldCheckRoutablePrerequisites("routable", "", 2)).toBe(false);
  });

  it("does NOT run with no tables, where the report is trivially satisfied", () => {
    // The vacuous reassurance: "all destinations present" is true only because
    // none is needed, and an operator reads it as the group being ready.
    expect(shouldCheckRoutablePrerequisites("routable", "AzureManaged", 0)).toBe(false);
  });
});

describe("IntegrateScreen - fold as you go (DBT-127)", () => {
  // The pieces are pinned where they live (sectionForPill in core, the
  // summary in integrate-screen-state, the frame in numbered-section). This
  // pins the WIRING the screen owns - the part that, deleted, would leave every
  // piece green and the page inert.
  function scrolledTo(): string[] {
    return (Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>).mock.contexts.map(
      (el) => (el as Element).id,
    );
  }

  it("Done folds the section to its summary and scrolls to the next one", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = renderScreen();
    const sections = [...container.querySelectorAll<HTMLElement>("section[id^='integrate-section-']")];
    expect(sections[0]?.id).toBe("integrate-section-solution");
    const nextId = sections[1]?.id;
    expect(nextId).toBe("integrate-section-sample-data");

    const done = sections[0]!.querySelector<HTMLButtonElement>(".numbered-section-done")!;
    fireEvent.click(done);

    expect(sections[0]!.querySelector(".numbered-section-summary")?.textContent).toBe(
      "no solution selected",
    );
    await waitFor(() => expect(scrolledTo()).toEqual([nextId]));
  });

  it("a footer pill opens its section and scrolls to it", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = renderScreen();
    const solution = container.querySelector<HTMLElement>("#integrate-section-solution")!;
    fireEvent.click(solution.querySelector<HTMLButtonElement>(".numbered-section-done")!);
    expect(solution.querySelector(".numbered-section-summary")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Go to Solution" }));
    expect(solution.querySelector(".numbered-section-summary")).toBeNull();
    await waitFor(() =>
      expect(scrolledTo().at(-1)).toBe("integrate-section-solution"),
    );
  });
});

describe("IntegrateScreen - removing one log type reaches both sections (DBT-143)", () => {
  // The two sections are siblings: a removal from either has to cross this
  // component, and that crossing is the part no section-level test can see.
  function jsonSample(logType: string, record: Record<string, string>): TaggedSample {
    const raw = JSON.stringify(record);
    return {
      logType,
      format: "json",
      rawEvents: [raw],
      parsed: {
        format: "json",
        records: [record],
        eventCount: 1,
        fields: Object.keys(record).map((name) => ({
          name,
          type: "string",
          examples: [record[name]],
        })),
        rawEvents: [raw],
        sourceName: `${logType}.json`,
        errors: [],
      },
    } as unknown as TaggedSample;
  }

  it("the gap card's Remove deletes the sample, its chip and its card", async () => {
    const byType = new Map(
      [
        jsonSample("Traffic", { src: "10.0.0.1", action: "allow" }),
        jsonSample("Decryption", { src: "10.0.0.2", tls: "1.3" }),
      ].map((s) => [s.logType, s]),
    );
    const remove = vi.fn(async (logType: string) => {
      byType.delete(logType);
    });
    const ports = {
      ...(PORTS as unknown as Record<string, unknown>),
      samples: {
        list: vi.fn(async () => [...byType.values()]),
        get: vi.fn(async (t: string) => byType.get(t) ?? null),
        upsert: vi.fn(async (s: TaggedSample) => {
          byType.set(s.logType, s);
        }),
        remove,
      },
    } as unknown as UiPorts;
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
    const chips = () =>
      [...container.querySelectorAll(".sample-chip-name")].map((n) => n.textContent);
    const cards = () =>
      [...container.querySelectorAll(".mapping-review-logtype")].map(
        (n) => n.textContent,
      );

    await waitFor(() => expect(chips()).toEqual(["Traffic", "Decryption"]));
    const analyze = [...container.querySelectorAll(".mapping-review-analyze button")][0];
    await act(async () => {
      fireEvent.click(analyze);
    });
    await waitFor(() => expect(cards()).toEqual(["Traffic", "Decryption"]));

    await act(async () => {
      fireEvent.click(
        container.querySelector('button[aria-label="Remove Decryption sample"]')!,
      );
    });

    await waitFor(() => expect(cards()).toEqual(["Traffic"]));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("Decryption");
    expect(chips()).toEqual(["Traffic"]);
    expect(container.textContent).not.toMatch(/re-analyze to refresh/i);
  });
});

/**
 * GEN-21: AN EXISTING CRIBL SENTINEL DESTINATION INSTEAD OF AZURE.
 *
 * The picker, its listing states and the gate live in this component; what
 * each state SAYS is pinned in existing-destination-state.test.ts. These pin
 * the wiring: the offline preselect, that the listing reaches the screen in
 * every state, that no Azure call is made on the path - with an Azure port
 * that throws if it is ever touched - and that the gate the operator reads
 * never asks for a client id.
 */
describe("IntegrateScreen - an existing Sentinel destination (GEN-21)", () => {
  const PAN_CSL = {
    id: "PAN-CSL",
    type: "sentinel",
    endpointURLConfiguration: "ID",
    dcrID: "dcr-0123456789abcdef0123456789abcdef",
    streamName: "Custom-dev-TMNA-PaloAltoNetworks-Firewall-stream",
    client_id: "'11111111-2222-3333-4444-555555555555'",
    secret: "!{pan_csl_secret}",
  };

  function renderExisting(opts: {
    outputs: () => Promise<{ status: number; body: unknown }>;
    offline?: boolean;
    /** Defaults to a scope AND an identity; the UAT's org had neither. */
    config?: AzureConfig;
    scopeCommitted?: boolean;
  }) {
    const azure = vi.fn(async () => {
      throw new Error("Azure must not be called on the existing-destination path");
    });
    const request = vi.fn(async (req: { path: string }) => {
      if (req.path === "/system/outputs") return opts.outputs();
      throw new Error("offline");
    });
    const ports = {
      ...(PORTS as unknown as Record<string, unknown>),
      azure: { request: azure },
      cribl: {
        request,
        listGroups: vi
          .fn()
          .mockResolvedValue(toListing([{ id: "TMNA_POV", product: "stream" }])),
      },
    } as unknown as UiPorts;
    const view = render(
      // A scope AND an identity are configured, so every Azure read on the
      // page has what it needs to fire - only the path may stop it.
      <PortsProvider ports={ports} config={opts.config ?? SCOPED_CONFIG}>
        <IntegrateScreen
          toolkitVersion="9.9.9-test"
          scopeCommitted={opts.scopeCommitted ?? true}
          offline={opts.offline ?? true}
          onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          criblDefaults={DEFAULT_CRIBL_OPTIONS}
        />
      </PortsProvider>,
    );
    const listing = () =>
      view.container.querySelector(
        '[data-testid="existing-destination-listing"]',
      ) as HTMLElement | null;
    const radios = () =>
      [
        ...view.container.querySelectorAll(
          'input[name="integrate-destination-mode"]',
        ),
      ] as HTMLInputElement[];
    return { ...view, azure, request, listing, radios };
  }

  const read = (items: unknown[], status = 200) => async () => ({
    status,
    body: { items },
  });

  it("opens on the existing destination when offline", async () => {
    const view = renderExisting({ outputs: read([PAN_CSL]) });
    expect(view.radios().map((r) => r.checked)).toEqual([false, true]);
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("rows"));
  });

  it("opens on create when connected, and reads nothing for the picker", async () => {
    const view = renderExisting({ outputs: read([PAN_CSL]), offline: false });
    expect(view.radios().map((r) => r.checked)).toEqual([true, false]);
    await waitFor(() => {
      expect(screen.getByText(/worker group: TMNA_POV/i)).toBeTruthy();
    });
    expect(view.listing()).toBeNull();
    expect(
      view.request.mock.calls.filter((c) => c[0].path === "/system/outputs"),
    ).toHaveLength(0);
  });

  it("lists the group's Sentinel destinations with stream and DCR, never the secret", async () => {
    const view = renderExisting({
      outputs: read([{ id: "S3", type: "s3" }, PAN_CSL]),
    });
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("rows"));
    expect(view.listing()?.textContent).toBe(
      "1 Microsoft Sentinel destination in TMNA_POV.",
    );
    expect(view.container.textContent).toContain(
      "PAN-CSL - stream Custom-dev-TMNA-PaloAltoNetworks-Firewall-stream, DCR dcr-0123456789abcdef0123456789abcdef",
    );
    expect(view.container.textContent).not.toContain("pan_csl_secret");
    expect(view.container.textContent).not.toContain("11111111-2222");
  });

  it("states a FAILED read as failed", async () => {
    const view = renderExisting({ outputs: read([], 403) });
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("failed"));
    expect(view.listing()?.textContent).toMatch(
      /^Could not read TMNA_POV's destinations: The outputs listing returned HTTP 403\./,
    );
  });

  it("states an EMPTY read as unverified", async () => {
    const view = renderExisting({ outputs: read([]) });
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("empty"));
    expect(view.listing()?.textContent).toMatch(
      /is not confirmation that TMNA_POV has none\.$/,
    );
  });

  it("states outputs with no Sentinel one as a measured none", async () => {
    const view = renderExisting({ outputs: read([{ id: "S3", type: "s3" }]) });
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("none"));
    expect(view.listing()?.textContent).toMatch(
      /^TMNA_POV has 1 destination, and none is a Microsoft Sentinel destination\./,
    );
  });

  it("never calls Azure, and reads the outputs once per group", async () => {
    const view = renderExisting({ outputs: read([PAN_CSL]) });
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("rows"));
    // Let any effect that would read Azure after the listing settle first.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.azure).not.toHaveBeenCalled();
    expect(
      view.request.mock.calls.filter((c) => c[0].path === "/system/outputs"),
    ).toHaveLength(1);
  });

  it("asks for the gap analysis, never a client id; Azure Resources is not needed", async () => {
    const view = renderExisting({ outputs: read([PAN_CSL]) });
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("rows"));
    const hint = view.container.querySelector(".readiness-footer-hint");
    expect(hint?.textContent).toBe(
      "Run the DCR Gap Analysis (section 3) - its tables decide what the existing destination must feed.",
    );
    expect(view.container.textContent).not.toMatch(/ingestion client id/i);
    // Select Azure Resources holds no cascade, no capability rows, no Reload.
    expect(view.container.textContent).toContain(
      "Not needed with an existing destination.",
    );
    expect(view.container.textContent).not.toMatch(/Always on/);
    // The shape is not a choice on this path.
    const shape = [...view.container.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "routable"),
    ) as HTMLSelectElement;
    expect(shape.value).toBe("routable");
    expect(shape.disabled).toBe(true);
  });

  it("in the UAT's org - no identity, no scope - still asks only for the gap analysis", async () => {
    // With no identity the native run's own gate reads "Enter an ingestion
    // client id"; the scoped config above hides that, because its client id
    // prefills the field. This is the shape the operator actually had.
    const view = renderExisting({
      outputs: read([PAN_CSL]),
      config: CONFIG,
      scopeCommitted: false,
    });
    await waitFor(() => expect(view.listing()?.dataset.status).toBe("rows"));
    const hint = view.container.querySelector(".readiness-footer-hint");
    expect(hint?.textContent).toBe(
      "Run the DCR Gap Analysis (section 3) - its tables decide what the existing destination must feed.",
    );
    expect(view.container.textContent).not.toMatch(/client id/i);
    expect(view.azure).not.toHaveBeenCalled();
  });
});

/**
 * DBT-200: the client-id hint promised "Defaults to the active connection"
 * with no identity connected.
 */
describe("IntegrateScreen - the client-id hint (DBT-200)", () => {
  function renderWith(config: AzureConfig) {
    return render(
      <PortsProvider ports={PORTS} config={config}>
        <IntegrateScreen
          toolkitVersion="9.9.9-test"
          scopeCommitted={false}
          offline={false}
          onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          criblDefaults={DEFAULT_CRIBL_OPTIONS}
        />
      </PortsProvider>,
    );
  }

  it("promises no default when no identity is connected", () => {
    const { container } = renderWith(CONFIG);
    expect(container.textContent).not.toContain("Defaults to the active connection.");
    expect(container.textContent).toContain(
      "No Azure identity is connected, so there is no default - enter the app registration's client id.",
    );
  });

  it("names the default when one exists", () => {
    const { container } = renderWith(SCOPED_CONFIG);
    expect(container.textContent).toContain("Defaults to the active connection.");
  });
});

/**
 * DBT-201: the pack's worker group follows the group the samples were
 * captured on, not the saved Options default.
 */
describe("IntegrateScreen - the pack group follows the capture (DBT-201)", () => {
  it("moves Configure Cribl to the capture group", async () => {
    const ports = discoveryPorts();
    const view = render(
      <PortsProvider ports={ports} config={CONFIG}>
        <IntegrateScreen
          toolkitVersion="9.9.9-test"
          scopeCommitted
          offline={false}
          onCommitScope={vi.fn().mockResolvedValue({ ok: true } as never)}
          criblDefaults={{ ...DEFAULT_CRIBL_OPTIONS, workerGroup: "grp2" }}
        />
      </PortsProvider>,
    );
    // The saved default preselects first...
    await waitFor(() => {
      expect(screen.getByText(/worker group: grp2/i)).toBeTruthy();
    });
    // ...then a capture source in "default" moves the pack there.
    fireEvent.click(screen.getByText("Capture from a live source"));
    const picker = view.container.querySelector(".sample-source-picker") as HTMLElement;
    const combos = () =>
      [...picker.querySelectorAll(".searchable-select-control")] as HTMLElement[];
    pickOption(combos()[0], "default");
    await waitFor(() => expect(combos()).toHaveLength(2));
    pickOption(combos()[1], "in_syslog");
    await waitFor(() => {
      expect(screen.getByText(/worker group: default/i)).toBeTruthy();
    });
  });
});
