// @vitest-environment happy-dom
/**
 * DOM tests for the frame's capability annotation (capability-model-plan step 3).
 *
 * The plan calls this the highest-risk step because it INVERTS behaviour: the
 * frame used to HIDE what the mode could not use, and now shows everything with
 * a note. The pure rules are pinned in domain/capabilities; what only a rendered
 * frame can pin is that the inversion actually reaches the screen -
 *
 *   - every route is in the sidebar, whatever the capabilities say;
 *   - a denied route is still CLICKABLE and still renders its screen;
 *   - "unchecked" never renders as "no access".
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyCapabilitySet } from "@soc/core";
import type { CapabilityContext, CapabilitySet } from "@soc/core";
import { AppFrame } from "./app-frame";
import type { AppRoute } from "./app-frame";

afterEach(cleanup);

const ROUTES: AppRoute[] = [
  { id: "home", label: "Setup", requires: [], section: "journey", render: () => <p>home screen</p> },
  {
    id: "integrate",
    label: "Sentinel Integration",
    requires: ["dcr.write"],
    section: "journey",
    render: () => <p>integrate screen</p>,
  },
  {
    id: "packs",
    label: "Pack Maintenance",
    requires: ["pack.manage"],
    section: "journey",
    render: () => <p>packs screen</p>,
  },
];

const connected: CapabilityContext = {
  azureIdentityPresent: true,
  criblReachable: true,
};

const audited = (verdicts: CapabilitySet["verdicts"]): CapabilitySet => ({
  verdicts,
  auditedAt: "2026-08-06T00:00:00Z",
  connectionId: "conn-1",
});

function renderFrame(
  capabilities: CapabilitySet,
  context: CapabilityContext = connected,
) {
  return render(
    <AppFrame
      title="Toolkit"

      routes={ROUTES}
      capabilities={capabilities}
      capabilityContext={context}
      initialRouteId="home"
    />,
  );
}

describe("the nav never hides a route", () => {
  it("renders every route even when every capability is denied", () => {
    // The inversion, on screen. Under filterNavItems these two vanished.
    renderFrame(audited({ "dcr.write": "denied", "pack.manage": "denied" }));
    expect(screen.getByText("Setup")).toBeTruthy();
    expect(screen.getByText("Sentinel Integration")).toBeTruthy();
    expect(screen.getByText("Pack Maintenance")).toBeTruthy();
  });

  it("renders every route with no connection at all", () => {
    renderFrame(emptyCapabilitySet(), {
      azureIdentityPresent: false,
      criblReachable: false,
    });
    expect(screen.getByText("Sentinel Integration")).toBeTruthy();
    expect(screen.getByText("Pack Maintenance")).toBeTruthy();
  });
});

describe("annotation wording", () => {
  it("flags a denied route as 'no access' and says why", () => {
    renderFrame(audited({ "dcr.write": "denied" }));
    expect(screen.getByText("no access")).toBeTruthy();
    const button = screen.getByText("Sentinel Integration").closest("button");
    expect(button?.getAttribute("title")).toContain("still try");
  });

  it("flags an unaudited route as 'unchecked', never as denial", () => {
    // The distinction the whole model exists to preserve.
    renderFrame(emptyCapabilitySet());
    // Both capability-requiring routes are unmeasured; the third needs nothing.
    expect(screen.getAllByText("unchecked")).toHaveLength(2);
    expect(screen.queryByText("no access")).toBeNull();
    const button = screen.getByText("Sentinel Integration").closest("button");
    expect(button?.getAttribute("title")).toContain("Not checked yet");
    expect(button?.getAttribute("title")).not.toContain("cannot");
  });

  it("flags a disconnected route as 'not connected'", () => {
    renderFrame(emptyCapabilitySet(), {
      azureIdentityPresent: false,
      criblReachable: true,
    });
    expect(screen.getByText("not connected")).toBeTruthy();
    const button = screen.getByText("Sentinel Integration").closest("button");
    expect(button?.getAttribute("title")).toContain("Connect Azure");
  });

  it("gives an available route no flag at all", () => {
    renderFrame(audited({ "dcr.write": "granted", "pack.manage": "granted" }));
    expect(screen.queryByText("no access")).toBeNull();
    expect(screen.queryByText("unchecked")).toBeNull();
    expect(screen.queryByText("not connected")).toBeNull();
  });
});

describe("the audit informs, it never forbids", () => {
  it("opens a denied route when clicked", () => {
    // Rule 3 on screen: annotation is not gating, and Azure's own 403 is the
    // real gate. A wrong or stale audit must not cost the operator the attempt.
    renderFrame(audited({ "dcr.write": "denied" }));
    fireEvent.click(screen.getByText("Sentinel Integration"));
    expect(screen.getByText("integrate screen")).toBeTruthy();
  });

  it("opens an unreachable route too", () => {
    // Even here the frame does not block: the screen itself explains, and the
    // nav's job was only ever to say so up front.
    renderFrame(emptyCapabilitySet(), {
      azureIdentityPresent: false,
      criblReachable: false,
    });
    fireEvent.click(screen.getByText("Pack Maintenance"));
    expect(screen.getByText("packs screen")).toBeTruthy();
  });

  it("never renders a disabled nav button", () => {
    renderFrame(
      audited({ "dcr.write": "denied", "pack.manage": "denied" }),
      { azureIdentityPresent: false, criblReachable: false },
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(false);
    }
  });
});

describe("degradation", () => {
  it("treats absent capabilities as unchecked rather than refused", () => {
    // A shell that has not wired the audit yet must not have its whole nav
    // read as denied.
    render(
      <AppFrame title="Toolkit" routes={ROUTES} initialRouteId="home" />,
    );
    expect(screen.getByText("Sentinel Integration")).toBeTruthy();
    expect(screen.queryByText("no access")).toBeNull();
  });
});
