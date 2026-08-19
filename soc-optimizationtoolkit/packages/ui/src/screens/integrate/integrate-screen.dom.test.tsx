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
 * So this asserts almost nothing about behaviour on purpose. Its whole job is
 * to mount the component, which is the one thing the rest of the suite never
 * did. Behavioural pins belong in integrate-screen-state.test.ts, where they
 * run without a DOM.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("prefills the pack name before any solution is chosen", () => {
    // Proves the initializer ran and produced the documented default, which is
    // the exact line that crashed. The solution-derived form is pinned without
    // a DOM in integrate-screen-state.test.ts.
    renderScreen();
    const field = screen.getByDisplayValue("MS-Sentinel");
    expect(field).toBeTruthy();
  });
});
