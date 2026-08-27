// @vitest-environment happy-dom
/**
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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
