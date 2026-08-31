// @vitest-environment happy-dom
/**
 * RENDER pins for the targeting screen. Two unrelated defects live here, and
 * both share one reason for needing a render: each was invisible to a pure test
 * of the same screen's extracted logic.
 *
 *   1. The ONE loader effect torn down mid-fetch (2026-08-27) - below.
 *   2. The OFFLINE branch calling ARM anyway (DBT-45, 2026-08-31) - the last
 *      describe block in this file.
 *
 * Pins for the targeting screen's ONE loader effect being torn down mid-fetch.
 *
 * WHY THIS FILE EXISTS. The loader claims a key before awaiting, so a
 * concurrent render cannot start a second fetch for the same data. Its cleanup
 * cancels the run - and the claim was being left behind, so the next run skipped
 * a fetch nobody was waiting for. The panel sat on "Checking Azure
 * permissions..." and "Loading subscriptions..." with no request in flight and
 * no error, until someone pressed Refresh from Azure, which only worked because
 * it bumps reloadNonce and therefore changes the key. Found live 2026-08-27.
 *
 * WHY IT DRIVES THE TEARDOWN EXPLICITLY rather than leaning on StrictMode.
 * StrictMode's mount/unmount/remount is what exposed this in the product, and
 * the first attempt at this file used it - but whether the cancelled run's
 * continuation interleaves before or after the second run's is React's business,
 * not ours, and the pins passed against deliberately broken code. A pin that
 * depends on someone else's scheduling is not a pin. So the teardown is caused
 * here, deterministically: re-render with a NEW ports object while the first
 * fetch is still in flight. `ports.azure` is in the effect's dependency array
 * and is NOT part of the loader keys, so the effect re-runs with identical keys
 * - which is precisely the shape StrictMode produced.
 *
 * THE PURE PINS WERE NOT ENOUGH, and that is the lesson. The claim ledger was
 * extracted to targeting-state and pinned there; those pins passed while the
 * product was still broken, because a cancelled run kept RUNNING past its await
 * and claimed the dependents key on the way out, where nothing could release it.
 * A ledger test cannot see that. Only a render can.
 *
 * WHAT THESE PINS DO AND DO NOT COVER - stated because a pin nobody has tried to
 * break is a guess, and half of this one was a guess until it was tried.
 *
 *   COVERED: deleting the release in `releaseClaimOnCancel` fails the first test
 *   here. Mutation-checked 2026-08-27.
 *
 *   NOT COVERED: deleting the `if (cancelled) return` guard before the
 *   dependents block does NOT fail either test. Three scenarios were tried -
 *   StrictMode's own double-invoke, an async fake, and this explicit teardown -
 *   and none reproduces the interleaving where the cancelled run reaches the
 *   dependents block before the live one does. That guard is verified in the
 *   live product (2026-08-27: "Loading workspaces..." stranded without it,
 *   law-jpederson-eastus loaded with it) and is NOT unit-pinned. Do not read the
 *   green here as cover for it, and do not delete it on the strength of these
 *   tests passing.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AzureConfig, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { AzureTargetingScreen } from "./azure-targeting-screen";

afterEach(cleanup);

const CONFIG = {
  tenantId: "tenant",
  clientId: "client",
  subscriptionId: "sub-1",
  resourceGroup: "rg-1",
  workspaceName: "law-1",
  location: "eastus",
} as unknown as AzureConfig;

const ok = (body: unknown): PortHttpResponse =>
  ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;

function bodyFor(path: string): unknown {
  if (path === "/subscriptions") {
    return {
      value: [
        { subscriptionId: "sub-1", displayName: "Pay-As-You-Go", state: "Enabled" },
      ],
    };
  }
  if (path.includes("/providers/Microsoft.OperationalInsights/workspaces")) {
    return {
      value: [
        {
          name: "law-1",
          id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/x/law-1",
          location: "eastus",
        },
      ],
    };
  }
  return { value: [{ name: "rg-1", location: "eastus" }] };
}

/**
 * An ARM stub whose responses are released ON DEMAND, so a fetch can be held
 * open across a re-render. Auto-resolving would close the window the defect
 * lives in.
 */
function makeAzure() {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  return {
    calls,
    releaseAll(): void {
      const waiting = pending.splice(0, pending.length);
      for (const release of waiting) release();
    },
    port: {
      async request(opts: { path: string }): Promise<PortHttpResponse> {
        calls.push(opts.path);
        await new Promise<void>((resolve) => pending.push(resolve));
        return ok(bodyFor(opts.path));
      },
    },
  };
}

const countOf = (calls: string[], needle: string): number =>
  calls.filter((p) => p.includes(needle)).length;

const WORKSPACES = "/providers/Microsoft.OperationalInsights/workspaces";

describe("AzureTargetingScreen - a run torn down mid-fetch does not strand the panel", () => {
  it("still reaches Connected when the first subscriptions fetch is cancelled", async () => {
    // THE DEFECT, first half: the cancelled run kept its claim, the re-run
    // skipped the fetch, and the status bar never left "Checking Azure
    // permissions...".
    const azure = makeAzure();
    const tree = (ports: UiPorts) => (
      <PortsProvider ports={ports} config={CONFIG}>
        <AzureTargetingScreen
          offline={false}
          onCommitScope={async () => ({ committed: true, notice: "" })}
        />
      </PortsProvider>
    );

    const fresh = () =>
      ({ azure: { request: azure.port.request } }) as unknown as UiPorts;
    const { rerender } = render(tree(fresh()));
    await waitFor(() => {
      expect(countOf(azure.calls, "/subscriptions")).toBeGreaterThanOrEqual(1);
    });

    // Tear the run down mid-flight: a new ports identity, same loader keys.
    rerender(tree(fresh()));

    // Drain on every poll: each released wave starts the next one, and a single
    // release would leave the follow-up fetch pending and read as the defect.
    await waitFor(
      () => {
        azure.releaseAll();
        expect(
          screen.getByText(/Connected - 1 subscription\(s\) visible\./),
        ).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("still loads the DEPENDENT workspaces after the same teardown", async () => {
    // THE DEFECT, second half - the one the ledger pins could not see. Guarding
    // only the setState calls fixed subscriptions and left this stranded on
    // "Loading workspaces...", because the cancelled run walked past its await,
    // claimed the dependents key, and took that claim to the grave.
    const azure = makeAzure();
    const tree = (ports: UiPorts) => (
      <PortsProvider ports={ports} config={CONFIG}>
        <AzureTargetingScreen
          offline={false}
          onCommitScope={async () => ({ committed: true, notice: "" })}
        />
      </PortsProvider>
    );

    const fresh = () =>
      ({ azure: { request: azure.port.request } }) as unknown as UiPorts;
    const { rerender } = render(tree(fresh()));
    await waitFor(() => {
      expect(countOf(azure.calls, "/subscriptions")).toBeGreaterThanOrEqual(1);
    });

    rerender(tree(fresh()));

    // Asserted on the rendered OUTCOME, not merely on a request having been
    // made: in the broken build the request WAS made - by the cancelled run,
    // whose answer was thrown away - so counting calls would pass while the
    // operator stared at a spinner.
    await waitFor(
      () => {
        azure.releaseAll();
        expect(screen.queryByText("Loading workspaces...")).toBeNull();
      },
      { timeout: 3000 },
    );
    expect(countOf(azure.calls, WORKSPACES)).toBeGreaterThanOrEqual(1);
  });
});

/**
 * An ARM stub that answers IMMEDIATELY and records every path it was asked for.
 * Deliberately NOT makeAzure: the teardown pins above need a request held open,
 * but a pin asserting ZERO calls must let every call that would happen actually
 * happen, or it proves only that nothing had finished yet.
 */
function makeRecordingAzure() {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async request(opts: { path: string }): Promise<PortHttpResponse> {
        calls.push(opts.path);
        return ok(bodyFor(opts.path));
      },
    },
  };
}

/**
 * Give an effect that WOULD fetch every chance to do so before asserting zero.
 * A "no calls" assertion is worth exactly the time it allows: flushing
 * microtasks and one macrotask inside act() means a call that merely started
 * late is still counted rather than silently missed.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

const SENTINEL_SOLUTION = "/providers/Microsoft.OperationsManagement/solutions/";

/**
 * Pins for DBT-45: the offline branch called ARM anyway.
 *
 * THE DEFECT. The Sentinel auto-check effect was guarded only on the three
 * scope fields being non-empty. `offline` appeared neither in its body nor in
 * its dependency array, and hooks run ABOVE the `if (offline)` early return - so
 * the air-gapped branch issued one ARM GET on mount with a committed scope, and
 * another on every keystroke in the workspace field. Nothing on screen said so:
 * the offline JSX renders neither sentinelStatus nor sentinelError, so the
 * evidence was thrown away as fast as it arrived.
 *
 * WHY A RENDER, and why the existing offline pin does not count. targeting-state
 * already has "fetches NOTHING in the offline branch" - but that pins
 * buildLoaderPlan, a PURE function this effect never calls. It was green through
 * the entire life of the defect and could not have been otherwise. The claim
 * "offline fetches nothing" is about the COMPONENT, so only mounting the
 * component can hold it.
 */
describe("AzureTargetingScreen - the offline branch reaches NO port", () => {
  const tree = (ports: UiPorts, offline: boolean) => (
    <PortsProvider ports={ports} config={CONFIG}>
      <AzureTargetingScreen
        offline={offline}
        onCommitScope={async () => ({ committed: true, notice: "" })}
      />
    </PortsProvider>
  );

  const recordingPorts = (azure: ReturnType<typeof makeRecordingAzure>): UiPorts =>
    ({ azure: { request: azure.port.request } }) as unknown as UiPorts;

  it("CONTROL: the same committed scope DOES auto-check Sentinel when ONLINE", async () => {
    // Without this the zeros below would be worth nothing - they would pass just
    // as well for a component that mounted nothing, a CONFIG whose scope was too
    // incomplete to trigger the check, or a port the provider never handed over.
    // CONFIG is a complete sub/rg/workspace, so the auto-check fires on mount:
    // exactly one solution GET, which is the call the offline pins deny.
    const azure = makeRecordingAzure();
    render(tree(recordingPorts(azure), false));
    await waitFor(() => {
      expect(countOf(azure.calls, SENTINEL_SOLUTION)).toBe(1);
    });
  });

  it("makes ZERO ports.azure calls on mount with a committed scope", async () => {
    const azure = makeRecordingAzure();
    render(tree(recordingPorts(azure), true));
    await settle();
    // Assert the offline branch really rendered, so an exception swallowed
    // somewhere cannot masquerade as "no calls were made".
    expect(screen.getByText("Azure targeting (offline)")).toBeTruthy();
    // Every path, not a filtered count: offline promises no ARM traffic AT ALL,
    // so naming which calls are forbidden would let a new one through.
    expect(azure.calls).toEqual([]);
  });

  it("makes ZERO ports.azure calls while the workspace name is typed", async () => {
    // The per-keystroke half. Clearing and retyping walks the field back through
    // "complete scope" on every character, which is what fired a GET per key.
    const azure = makeRecordingAzure();
    render(tree(recordingPorts(azure), true));
    await settle();

    const workspace = screen.getByLabelText(
      "Log Analytics workspace",
    ) as HTMLInputElement;
    for (const value of ["", "l", "la", "law", "law-2"]) {
      fireEvent.change(workspace, { target: { value } });
    }
    await settle();

    expect(workspace.value).toBe("law-2");
    expect(azure.calls).toEqual([]);
  });

  it("checks Sentinel as soon as offline is lifted, with the scope unchanged", async () => {
    // THE DEPENDENCY ARRAY, pinned so it is load-bearing rather than decorative.
    // The guard alone would satisfy the two pins above, and a body that reads
    // `offline` without listing it is the same class of bug one level down: the
    // effect would keep the offline run's decision forever and the operator
    // would sit on an unchecked scope after connecting. The SAME ports object is
    // reused on purpose - a fresh one would re-run the effect through
    // ports.azure and prove nothing about `offline`.
    const azure = makeRecordingAzure();
    const ports = recordingPorts(azure);
    const { rerender } = render(tree(ports, true));
    await settle();
    expect(azure.calls).toEqual([]);

    rerender(tree(ports, false));
    await waitFor(() => {
      expect(countOf(azure.calls, SENTINEL_SOLUTION)).toBe(1);
    });
  });
});

/**
 * Pin for DBT-52, added after review: the core fix had no render pin.
 *
 * DBT-52's defect is stated as OPERATOR-VISIBLE TEXT - a denied Sentinel check
 * rendering "Sentinel is not enabled on this workspace - Enable it above", which
 * invites a WRITE off the back of a DENIED READ. The fix landed in
 * `checkSentinelEnabled` (azure-discovery.ts), which now throws on a non-2xx
 * that is not 404, and four core pins cover its three outcomes.
 *
 * NONE OF THEM CAN SEE THE SYMPTOM. They stop at the return value. The honesty
 * the operator experiences rests on this screen catching that throw and
 * rendering the error branch instead of the disabled one - so changing the
 * catch at :237-241 to `setSentinelStatus("disabled")` would restore the
 * defect in full with all 38 core tests still green. That is the gap this
 * closes: it asserts the RENDERED WORDS, and it asserts the absence of the
 * harmful sentence directly rather than behind a precondition that could mask
 * it.
 */
describe("AzureTargetingScreen - a DENIED Sentinel check never reads as 'not enabled'", () => {
  /** ARM stub that denies only the Sentinel solutions read. */
  function makeDenyingAzure() {
    return {
      async request(opts: { path: string }): Promise<PortHttpResponse> {
        if (opts.path.includes(SENTINEL_SOLUTION)) {
          return {
            ok: false,
            status: 403,
            body: { error: { message: "denied by RBAC" } },
          } as unknown as PortHttpResponse;
        }
        return ok(bodyFor(opts.path));
      },
    };
  }

  const denyingTree = () => (
    <PortsProvider
      ports={{ azure: makeDenyingAzure() } as unknown as UiPorts}
      config={CONFIG}
    >
      <AzureTargetingScreen offline={false} onCommitScope={async () => ({ committed: true, notice: "" })} />
    </PortsProvider>
  );

  it("does NOT tell the operator Sentinel is off when the read was refused", async () => {
    // THE ASSERTION THAT MATTERS, and deliberately FIRST with no precondition
    // ahead of it: a masking read-count assertion would stop the run before
    // this ever executed, which is exactly how a sibling pin lost its teeth.
    render(denyingTree());
    await waitFor(() => {
      expect(screen.queryByText(/Could not check Sentinel status/)).toBeTruthy();
    });
    expect(screen.queryByText(/Sentinel is not enabled on this workspace/)).toBeNull();
  });

  it("says the check FAILED, and carries the reason", async () => {
    render(denyingTree());
    await waitFor(() => {
      expect(screen.getByText(/Could not check Sentinel status/)).toBeTruthy();
    });
    // The operator gets the real status back, not a sanitised one.
    expect(screen.getByText(/403|denied by RBAC/)).toBeTruthy();
  });
});
