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
import { DEFAULT_CRIBL_OPTIONS } from "@soc/core";
import type { AzureConfig } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { IntegrateScreen } from "./integrate-screen";

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

  it("renders the sample-source picker, idle before the scope is committed", () => {
    // Wiring pin, same reason as the one above. `idle` is the honest state with
    // no Cribl address yet - it must not read as "nothing found", which would
    // blame the workspace for our own missing connection.
    const { container } = renderScreen({ scopeCommitted: false });
    const picker = container.querySelector(".sample-source-picker");
    expect(picker).toBeTruthy();
    expect(picker?.getAttribute("data-status")).toBe("idle");
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
