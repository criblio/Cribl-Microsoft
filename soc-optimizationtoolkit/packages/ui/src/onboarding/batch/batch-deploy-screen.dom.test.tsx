// @vitest-environment happy-dom
/**
 * HON-7 / D-2: THE BATCH SCREEN'S FALLBACK OFFER.
 *
 * This screen had no DOM test at all, and that is exactly the gap HON-7 is
 * about: `FallbackNotice` was thoroughly pinned as a COMPONENT while no
 * production surface passed it a producer, so rule 2 ("every blocked action
 * falls back to a downloadable artifact") had no button anywhere in the app.
 * Pinning the component again would not have caught that; only mounting a
 * screen does.
 *
 * This surface is pinned rather than the other two because it is the one where
 * BOTH answers a producer may give are live at once (D-2, backlog section 16):
 * it STARTS the template-only run for the ARM bodies it collects, and POINTS at
 * another screen's run for the pack, which it does not build. A producer that
 * quietly assembled the pack here would be the failure the decision names.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { emptyCapabilitySet } from "@soc/core";
import type {
  AzureConfig,
  BatchPacing,
  Capability,
  CapabilityContext,
  CapabilitySet,
} from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { FALLBACK_POINTER_LABEL } from "../../capabilities/fallback-notice-state";
import { BatchDeployScreen } from "./batch-deploy-screen";

afterEach(cleanup);

/** A committed scope - a run needs one, and the offer's run is still a run. */
const CONFIG: AzureConfig = {
  clientId: "client-1",
  tenantId: "tenant-1",
  subscriptionId: "sub-1",
  resourceGroup: "rg-soc-prod",
  workspaceName: "law-soc",
  setupPath: "existing",
};

/** Both sides connected, so an unmeasured capability reads `unknown`. */
const CONNECTED: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};

const PACING: BatchPacing = { now: () => 0, sleep: async () => {} };

function auditedDenied(capability: Capability): CapabilitySet {
  return {
    verdicts: { [capability]: "denied" },
    auditedAt: "2026-08-31T00:00:00.000Z",
    connectionId: "conn-1",
  };
}

/**
 * Ports whose JobStore records the parent job, which is where the run's
 * effective options land - the one place a test can read what the offer
 * actually started. Azure is offline on purpose: the run fails after the job
 * is created, and the options are already recorded by then.
 */
function batchPorts() {
  return {
    azure: { request: vi.fn().mockRejectedValue(new Error("offline")) },
    cribl: {
      request: vi.fn().mockRejectedValue(new Error("offline")),
      listGroups: vi
        .fn()
        .mockResolvedValue([{ id: "default", product: "stream" }]),
    },
    artifacts: { save: vi.fn().mockResolvedValue(undefined) },
    jobs: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        id: "job-1",
        kind: "onboard-batch",
        status: "running",
        input: {},
        steps: [],
      }),
      update: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      appendStep: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as UiPorts;
}

function renderBatch(capabilities: CapabilitySet) {
  const ports = batchPorts();
  render(
    // D-3: the audit reaches the screen through PortsContext, not props.
    <PortsProvider
      ports={ports}
      config={CONFIG}
      capabilities={capabilities}
      capabilityContext={CONNECTED}
    >
      <BatchDeployScreen pacing={PACING} />
    </PortsProvider>,
  );
  return ports;
}

/** List one table, which is what makes the offer's run have anything to do. */
function listOneTable(): void {
  fireEvent.change(screen.getByPlaceholderText(/SecurityEvent/), {
    target: { value: "SecurityEvent" },
  });
}

/** Find a button by a fragment of its label, or undefined. */
function buttonMatching(pattern: RegExp): HTMLButtonElement | undefined {
  return screen
    .getAllByRole("button")
    .find((b) => pattern.test(b.textContent ?? "")) as
    | HTMLButtonElement
    | undefined;
}

describe("BatchDeployScreen - the blocked write offers an artifact", () => {
  it("renders a CONTROL on the offer once a write is measured denied", () => {
    // The defect, stated for this surface: a measured denial used to produce
    // nothing at all here, and the component that could have said something
    // was never mounted with a producer.
    renderBatch(auditedDenied("dcr.write"));
    listOneTable();
    const button = buttonMatching(/download the arm request bodies/i);
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(false);
  });

  it("names the missing prerequisite instead of disabling silently", () => {
    // No table listed: the run has nothing to collect. Disabled is right;
    // saying why is the requirement, and the reason must be the OFFER's own
    // prerequisite, never a write prerequisite the artifact does not need.
    renderBatch(auditedDenied("dcr.write"));
    const button = buttonMatching(/download the arm request bodies/i);
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("title")).toMatch(/List at least one table/);
    expect(button?.getAttribute("title")).not.toMatch(/worker group|client id/i);
  });

  it("starts a TEMPLATE-ONLY run, so taking the offer writes nothing", async () => {
    // The load-bearing pin. The artifact only exists if the run collects
    // instead of deploying, and the operator's override select may say
    // otherwise - so the producer forces the flag for this run. If this ever
    // reports false, the offer deploys to Azure on behalf of someone the audit
    // just said cannot deploy to Azure.
    const ports = renderBatch(auditedDenied("dcr.write"));
    listOneTable();
    fireEvent.click(buttonMatching(/download the arm request bodies/i)!);
    const create = (ports.jobs as unknown as { create: ReturnType<typeof vi.fn> })
      .create;
    await waitFor(() => {
      expect(create).toHaveBeenCalled();
    });
    const input = create.mock.calls[0][1] as { options: { templateOnly: boolean } };
    expect(input.options.templateOnly).toBe(true);
  });

  it("POINTS at the pack's run instead of pretending to build one here", async () => {
    // The other branch, and the objection D-2 answered: a batch run never
    // assembles a Cribl pack. The control says so rather than promising a
    // download, the answer names the surface that does build it, and - the
    // half that would rot silently - no run is started.
    const ports = renderBatch(auditedDenied("destination.manage"));
    listOneTable();
    const button = buttonMatching(new RegExp(FALLBACK_POINTER_LABEL, "i"));
    expect(button).toBeTruthy();
    expect(button?.textContent).not.toMatch(/download/i);
    fireEvent.click(button!);
    expect(screen.getByText(/Sentinel Integration's Deploy section/)).toBeTruthy();
    const create = (ports.jobs as unknown as { create: ReturnType<typeof vi.fn> })
      .create;
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves Run batch onboarding exactly as available - it annotates, never removes", () => {
    // Rule 3. The audit informs and offers; Azure's own refusal is the gate.
    renderBatch(auditedDenied("dcr.write"));
    listOneTable();
    expect(buttonMatching(/^Run batch onboarding$/)).toBeTruthy();
  });

  it("offers NOTHING when no write has been measured", () => {
    // `unknown` is the normal state of a healthy unaudited connection, and it
    // must not collapse into `denied`.
    renderBatch(emptyCapabilitySet());
    listOneTable();
    expect(buttonMatching(/download the arm request bodies/i)).toBeUndefined();
    expect(buttonMatching(new RegExp(FALLBACK_POINTER_LABEL, "i"))).toBeUndefined();
  });
});
