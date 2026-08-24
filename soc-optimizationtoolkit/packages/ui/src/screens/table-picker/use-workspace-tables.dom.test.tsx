// @vitest-environment happy-dom
/**
 * Pins for the workspace table listing.
 *
 * MOVED HERE 2026-08-18 from table-picker-section.dom.test.tsx, which went with
 * the panel it tested. The panel listed every table in the workspace so one
 * could be chosen for the whole analysis; once the choice became per log type it
 * kept a filter box, an ~842-row list and a count line that nobody could act on.
 * The FETCH survived, as a hook, and so does every behavioural pin - what is
 * gone is the rendering they used to reach through.
 *
 * The three capability rules, and where each one now lives:
 *
 *   1. A denied verdict never removes the attempt. There is no button left to
 *      disable, so this is now structural - but it is still pinned, because
 *      "structural" is a claim about code that can be edited.
 *   2. Reads have no fallback artifact: the note offers a retry and nothing else.
 *   3. An empty listing is only a zero once the read was verified.
 *
 * The hook is exercised through a probe component rather than renderHook, so
 * these run against a real render/effect cycle - which is where the once-per-
 * workspace and no-retry-on-failure guards actually live.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyCapabilitySet } from "@soc/core";
import type { AzureConfig, CapabilitySet } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { useWorkspaceTables } from "./use-workspace-tables";

afterEach(cleanup);

const TARGET = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law-test",
};

const CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "sub",
  resourceGroup: "rg",
  workspaceName: "law-test",
  setupPath: "existing",
};

/** ARM list response shaped as the parser expects. */
function tablesResponse(names: string[]) {
  return {
    status: 200,
    body: {
      value: names.map((name) => ({
        name,
        properties: { plan: "Analytics", retentionInDays: 90 },
      })),
    },
  };
}

/** A request that never settles - pins the in-flight render deterministically. */
function pendingRequest() {
  return vi.fn().mockReturnValue(new Promise(() => {}));
}

/**
 * Renders what the hook returns, so the pins assert on behaviour rather than on
 * a panel that no longer exists.
 */
function Probe({
  capabilities,
  enabled = true,
}: {
  capabilities: CapabilitySet;
  enabled?: boolean;
}) {
  // THE TARGET IS A FRESH OBJECT LITERAL EVERY RENDER, deliberately. The screen
  // builds it inline from three config fields, so its identity changes on every
  // parent render and any effect keyed on the object itself re-fires constantly.
  // An earlier version of these pins held it constant, which made a broken guard
  // look correct - the mutation test passed. Matching production is what gives
  // the no-retry pin teeth.
  const state = useWorkspaceTables({
    target: { ...TARGET },
    capabilities,
    capabilityContext: { azureIdentityPresent: true, criblReachable: true },
    enabled,
  });
  return (
    <div>
      <ul data-testid="names">
        {state.names.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      {state.note !== null && (
        <div>
          <p data-testid="note">{state.note.text}</p>
          <button type="button" onClick={state.note.onRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function renderProbe(opts: {
  capabilities?: CapabilitySet;
  request?: ReturnType<typeof vi.fn>;
  enabled?: boolean;
}) {
  const request = opts.request ?? vi.fn().mockResolvedValue(tablesResponse([]));
  const ports = {
    azure: { request },
    jobs: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as UiPorts;
  const tree = () => (
    <PortsProvider ports={ports} config={CONFIG}>
      <Probe
        capabilities={opts.capabilities ?? emptyCapabilitySet()}
        enabled={opts.enabled ?? true}
      />
    </PortsProvider>
  );
  const { rerender } = render(tree());
  return { request, rerender: () => rerender(tree()) };
}

describe("useWorkspaceTables - it lists without being asked", () => {
  it("lists the workspace tables on mount", async () => {
    // The listing exists to fill the per-log-type Destination selectors. Behind
    // a click, those selectors offered four hardcoded natives and nothing said a
    // prerequisite existed - reported live 2026-08-18.
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["SecurityEvent", "App_CL"]));
    renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("lists ONCE across parent re-renders", async () => {
    // The screen rebuilds `target` inline every render, so an effect keyed on
    // the object re-fires constantly. Listing 842 tables on every keystroke
    // elsewhere on the page is the failure mode; the ref key is the workspace
    // string, not the object.
    const request = vi.fn().mockResolvedValue(tablesResponse(["SecurityEvent"]));
    const probe = renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    probe.rerender();
    probe.rerender();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hands the names up in ARM's order", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["App_CL", "SecurityEvent"]));
    renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByText("App_CL")).toBeTruthy();
    });
    const rendered = [...screen.getByTestId("names").querySelectorAll("li")].map(
      (li) => li.textContent,
    );
    expect(rendered).toEqual(["App_CL", "SecurityEvent"]);
  });
});

describe("useWorkspaceTables - rule 1: a denied verdict never removes the attempt", () => {
  it("lists on the WORST verdict available", async () => {
    // An empty capability set is the worst verdict there is, and the listing
    // must still be attempted - Azure's 403 is the real gate, not our audit.
    // Once there was a button this was about `disabled`; now there is no gate at
    // all, and this pin is what stops one being reintroduced.
    const { request } = renderProbe({ capabilities: emptyCapabilitySet() });
    await waitFor(() => {
      expect(request).toHaveBeenCalled();
    });
  });

  it("reaches the port rather than being swallowed by a guard", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(tablesResponse(["SecurityEvent"]));
    renderProbe({ capabilities: emptyCapabilitySet(), request });
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
  });

  it("waits for a WORKSPACE, which is not the same as waiting for a verdict", async () => {
    // The one legitimate reason not to list: there is no address yet. Gating on
    // the scope is fine; gating on the audit's expectation is rule 1's failure,
    // and these two must not be confused when someone edits the guard.
    const { request, rerender } = renderProbe({ enabled: false });
    await waitFor(() => {
      expect(screen.queryByTestId("note")).toBeNull();
    });
    expect(request).not.toHaveBeenCalled();
    rerender();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceTables - the note is the whole surface", () => {
  it("says NOTHING while the listing is in flight", () => {
    // Rule 3's near-miss: emptiness before a listing completes is not a finding
    // about the workspace and must not be reported as one. With the panel gone,
    // saying nothing is how that is expressed.
    renderProbe({ request: pendingRequest() });
    expect(screen.queryByTestId("note")).toBeNull();
  });

  it("says NOTHING on a successful listing", () => {
    // The tables in the dropdowns are the only evidence that matters. A "loaded
    // 842 tables" line is the busy-ness this refactor removed.
    const request = vi.fn().mockResolvedValue(tablesResponse(["SecurityEvent"]));
    renderProbe({ request });
    return waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
      expect(screen.queryByTestId("note")).toBeNull();
    });
  });

  it("surfaces a 403 VERBATIM rather than as an empty workspace", async () => {
    // Folding this into the empty state would be the confident wrong answer
    // docs/inventory-standard.md was written against.
    const request = vi.fn().mockRejectedValue(new Error("403 Forbidden: denied"));
    renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByTestId("note").textContent).toContain("403 Forbidden");
    });
  });

  it("names the consequence, not just the error", async () => {
    // The operator needs to know what the failure COST them: the selectors fall
    // back to the solution's tables and the common natives.
    const request = vi.fn().mockRejectedValue(new Error("403 Forbidden: denied"));
    renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByTestId("note").textContent).toContain("destination selectors");
    });
  });

  it("distinguishes a VERIFIED empty workspace from an unverified one", async () => {
    // Rule 3. An RBAC-filtered 200 [] is byte-identical to a genuinely empty
    // workspace; only a measured table.read may call it a zero.
    renderProbe({ request: vi.fn().mockResolvedValue(tablesResponse([])) });
    await waitFor(() => {
      expect(screen.getByTestId("note")).toBeTruthy();
    });
  });
});

describe("useWorkspaceTables - failure is not retried behind the operator's back", () => {
  it("does not re-attempt a FAILED listing on re-render", async () => {
    // The load clears `loaded` on error, so a guard keyed on that state re-fires
    // as soon as anything re-renders the parent - turning one 403 into a request
    // storm. Driving real re-renders is what distinguishes the two guards.
    const request = vi.fn().mockRejectedValue(new Error("403 Forbidden: denied"));
    const probe = renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByTestId("note")).toBeTruthy();
    });
    probe.rerender();
    probe.rerender();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries when the operator asks", async () => {
    // Rule 2: the note offers a retry and nothing else, because a listing has no
    // offline substitute to offer instead.
    const request = vi.fn().mockRejectedValue(new Error("403 Forbidden: denied"));
    renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByTestId("note")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it("clears the note when a retry succeeds", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("403 Forbidden: denied"))
      .mockResolvedValue(tablesResponse(["SecurityEvent"]));
    renderProbe({ request });
    await waitFor(() => {
      expect(screen.getByTestId("note")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByText("SecurityEvent")).toBeTruthy();
    });
    expect(screen.queryByTestId("note")).toBeNull();
  });
});
