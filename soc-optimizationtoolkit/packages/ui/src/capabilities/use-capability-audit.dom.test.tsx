// @vitest-environment happy-dom
/**
 * DOM tests for useCapabilityAudit - the wiring the pure modules cannot pin.
 *
 * What matters here is REQUEST BEHAVIOUR over a component lifecycle, which only
 * a mounted hook can show:
 *   - a second mount against a cached connection issues no requests (the plan's
 *     conservation decision, invisible to any pure test);
 *   - a scope change re-audits, because the key moved;
 *   - secret re-entry re-audits even though the key did not - the trigger the
 *     effect alone would never fire.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  CAPABILITY_AUDIT_CACHE_KEY,
  EMPTY_AZURE_CONFIG,
  FakeAzureManagement,
  FakeContentCache,
  FakeCriblClient,
} from "@soc/core";
import type { AzureConfig } from "@soc/core";
import type { UiPorts } from "../ports-context";
import { useCapabilityAudit } from "./use-capability-audit";
import type { CapabilityAuditState } from "./use-capability-audit";

afterEach(cleanup);

const CONFIG: AzureConfig = {
  ...EMPTY_AZURE_CONFIG,
  tenantId: "tenant-a",
  clientId: "client-a",
  subscriptionId: "sub-a",
  resourceGroup: "rg-a",
  workspaceName: "ws-a",
};

const NOW = () => "2026-08-06T12:00:00Z";
const OWNER_PERMS = {
  status: 200,
  body: { value: [{ actions: ["*"], notActions: [], dataActions: [], notDataActions: [] }] },
};
const OK = { status: 200, body: {} };

/** Ports whose Azure answers as Owner and whose Cribl is never called (cloud). */
function makePorts(cache: FakeContentCache): {
  ports: UiPorts;
  azure: FakeAzureManagement;
} {
  const azure = new FakeAzureManagement();
  azure.respondWith(OWNER_PERMS, OK, OK, OK);
  const ports = {
    azure,
    cribl: new FakeCriblClient(),
    contentCache: cache,
  } as unknown as UiPorts;
  return { ports, azure };
}

/** Render the hook and expose its latest value. */
function renderAudit(ports: UiPorts, config: AzureConfig) {
  const seen: { current: CapabilityAuditState | null } = { current: null };
  function Probe() {
    seen.current = useCapabilityAudit({
      ports,
      config,
      criblShellMode: "cloud",
      setupPath: "existing-rg",
      criblReachable: true,
      now: NOW,
    });
    return null;
  }
  const view = render(<Probe />);
  return { seen, view };
}

describe("useCapabilityAudit", () => {
  it("audits on first mount and reports the measured capabilities", async () => {
    const { ports, azure } = makePorts(new FakeContentCache());
    const { seen } = renderAudit(ports, CONFIG);

    await waitFor(() => expect(seen.current?.running).toBe(false));
    expect(azure.calls.length).toBeGreaterThan(0);
    expect(seen.current?.capabilities.verdicts["dcr.write"]).toBe("granted");
    expect(seen.current?.view.status).toBe("current");
    expect(seen.current?.view.label).toContain("just now");
  });

  it("issues NO requests on a second mount against the cached connection", async () => {
    // The conservation decision, and the only place it is observable: a pure
    // test can assert the decision, but not that nothing was sent.
    const cache = new FakeContentCache();
    const first = makePorts(cache);
    const firstRender = renderAudit(first.ports, CONFIG);
    await waitFor(() => expect(firstRender.seen.current?.running).toBe(false));
    expect(await cache.get(CAPABILITY_AUDIT_CACHE_KEY)).not.toBeNull();
    cleanup();

    const second = makePorts(cache);
    const { seen } = renderAudit(second.ports, CONFIG);
    await waitFor(() => expect(seen.current?.running).toBe(false));

    expect(second.azure.calls).toHaveLength(0);
    expect(seen.current?.capabilities.verdicts["dcr.write"]).toBe("granted");
  });

  it("re-audits when the scope changes", async () => {
    const cache = new FakeContentCache();
    const first = makePorts(cache);
    const firstRender = renderAudit(first.ports, CONFIG);
    await waitFor(() => expect(firstRender.seen.current?.running).toBe(false));
    cleanup();

    const second = makePorts(cache);
    const { seen } = renderAudit(second.ports, { ...CONFIG, resourceGroup: "rg-other" });
    await waitFor(() => expect(seen.current?.running).toBe(false));

    // The key moved, so the cached answer addresses a different question.
    expect(second.azure.calls.length).toBeGreaterThan(0);
  });

  it("re-audits on secret re-entry, which the key cannot reveal", async () => {
    const cache = new FakeContentCache();
    const first = makePorts(cache);
    const firstRender = renderAudit(first.ports, CONFIG);
    await waitFor(() => expect(firstRender.seen.current?.running).toBe(false));
    cleanup();

    const second = makePorts(cache);
    const { seen } = renderAudit(second.ports, CONFIG);
    await waitFor(() => expect(seen.current?.running).toBe(false));
    expect(second.azure.calls).toHaveLength(0); // cached, as expected

    act(() => seen.current?.audit("secret-entry"));
    await waitFor(() => expect(seen.current?.running).toBe(false));
    expect(second.azure.calls.length).toBeGreaterThan(0);
  });

  it("re-audits when the operator asks", async () => {
    const cache = new FakeContentCache();
    const first = makePorts(cache);
    const firstRender = renderAudit(first.ports, CONFIG);
    await waitFor(() => expect(firstRender.seen.current?.running).toBe(false));
    cleanup();

    const second = makePorts(cache);
    const { seen } = renderAudit(second.ports, CONFIG);
    await waitFor(() => expect(seen.current?.running).toBe(false));

    act(() => seen.current?.refresh());
    await waitFor(() => expect(seen.current?.running).toBe(false));
    expect(second.azure.calls.length).toBeGreaterThan(0);
  });

  it("does not audit until the config is trustworthy", async () => {
    // Live regression 2026-08-06: mounted before the connection store hydrated,
    // the hook audited the EMPTY config and cached the result under that config's
    // key. The hydrated audit then missed, and on the next launch the unhydrated
    // audit overwrote the cache before the hydrated one could use it - so the
    // cache never hit and launch conservation never engaged at all.
    const cache = new FakeContentCache();
    const { ports, azure } = makePorts(cache);

    // The shells' real shape: config arrives with `ready`, in one re-render.
    function Probe({ isReady, cfg }: { isReady: boolean; cfg: AzureConfig }) {
      useCapabilityAudit({
        ports,
        config: cfg,
        ready: isReady,
        criblShellMode: "cloud",
        setupPath: "existing-rg",
        criblReachable: true,
        now: NOW,
      });
      return null;
    }

    const { rerender } = render(<Probe isReady={false} cfg={EMPTY_AZURE_CONFIG} />);
    expect(azure.calls).toHaveLength(0);
    expect(await cache.get(CAPABILITY_AUDIT_CACHE_KEY)).toBeNull();

    rerender(<Probe isReady={true} cfg={CONFIG} />);
    await waitFor(() => expect(azure.calls.length).toBeGreaterThan(0));

    // Exactly one audit, against the real config - not one per hydration step.
    const stored = await cache.get(CAPABILITY_AUDIT_CACHE_KEY);
    expect((stored as { connectionId: string }).connectionId).toContain("tenant-a");
  });

  it("reports an unconfigured connection as unreachable, not denied", async () => {
    const { ports } = makePorts(new FakeContentCache());
    const { seen } = renderAudit(ports, EMPTY_AZURE_CONFIG);
    await waitFor(() => expect(seen.current?.running).toBe(false));

    expect(seen.current?.context.azureIdentityPresent).toBe(false);
    expect(seen.current?.capabilities.verdicts["dcr.write"]).not.toBe("denied");
  });
});
