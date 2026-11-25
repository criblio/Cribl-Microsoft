// @vitest-environment happy-dom
/**
 * DOM pins for RbacPreflightPanel's capability-audit WRITE (DBT-181).
 *
 * Once both sides resolve, the panel feeds the app-level capability cache so
 * the check the operator just ran counts. That write is fire-and-forget and
 * stays so - the report must never wait on the store - but since DBT-145 a
 * refused KV write throws, and saveCapabilityAudit only LOGGED it: the panel
 * showed a finished check while its record was silently not kept, so the app
 * re-measured at next launch with nothing on screen having said why. The
 * refusal is now said beside the report, with its reason, and only for the run
 * it belongs to.
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
  capabilityAuditCacheKey,
  EMPTY_AZURE_CONFIG,
  FakeAzureManagement,
  FakeContentCache,
  FakeCriblClient,
} from "@soc/core";
import type { AzureConfig, ContentCache } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { RbacPreflightPanel } from "./rbac-preflight-panel";

afterEach(cleanup);

const CONFIG: AzureConfig = {
  ...EMPTY_AZURE_CONFIG,
  tenantId: "tenant-a",
  clientId: "client-a",
  subscriptionId: "sub-a",
  resourceGroup: "rg-a",
  workspaceName: "ws-a",
};

const OWNER_PERMS = {
  status: 200,
  body: { value: [{ actions: ["*"], notActions: [], dataActions: [], notDataActions: [] }] },
};
const OK = { status: 200, body: {} };

function makePorts(cache: ContentCache): UiPorts {
  const azure = new FakeAzureManagement();
  azure.respondWith(OWNER_PERMS, OK, OK, OK, OWNER_PERMS, OK, OK, OK);
  return {
    azure,
    cribl: new FakeCriblClient(),
    contentCache: cache,
  } as unknown as UiPorts;
}

function mount(cache: ContentCache) {
  return render(
    <PortsProvider ports={makePorts(cache)} config={CONFIG}>
      <RbacPreflightPanel criblShellMode="cloud" />
    </PortsProvider>,
  );
}

const unsaved = () => document.querySelectorAll(".preflight-audit-unsaved");

describe("RbacPreflightPanel - a refused capability-audit write (DBT-181)", () => {
  it("says the record was not saved, with the reason, once", async () => {
    const set = vi.fn(async (_key: string, _value: unknown) => {
      throw new Error("KV write refused (403)");
    });
    const cache = { get: vi.fn(async () => null), set } as unknown as ContentCache;
    mount(cache);
    await waitFor(() => {
      expect(unsaved()).toHaveLength(1);
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe(capabilityAuditCacheKey("tenant-a"));
    const text = unsaved()[0].textContent ?? "";
    expect(text).toContain("KV write refused (403)");
    expect(text).toMatch(/could not be saved/);
    // The note renders ABOVE the two sides, so it must not point "above" at
    // them (DBT-181 review B1).
    expect(text).toMatch(/This check's results stand/);
    expect(text).not.toMatch(/above/);
    // The report itself still rendered: the write never blocks it.
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a refused read-before-merge skips the write, and that is said too", async () => {
    // CAP-11: the save merges over the stored set, so an unreadable store is
    // not written (it would erase the other writer's verdicts). The record is
    // then just as unsaved as after a refused write, and must say so.
    const set = vi.fn(async () => undefined);
    const cache = {
      get: vi.fn(async () => {
        throw new Error("KV read refused (403)");
      }),
      set,
    } as unknown as ContentCache;
    mount(cache);
    await waitFor(() => {
      expect(unsaved()).toHaveLength(1);
    });
    expect(set).not.toHaveBeenCalled();
    const text = unsaved()[0].textContent ?? "";
    expect(text).toContain("KV read refused (403)");
    expect(text).toMatch(/could not be saved/);
  });

  it("says nothing when the store accepts the write", async () => {
    const cache = new FakeContentCache();
    mount(cache);
    await waitFor(async () => {
      expect(await cache.get(capabilityAuditCacheKey("tenant-a"))).not.toBeNull();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unsaved()).toHaveLength(0);
  });

  it("a Retry clears the old refusal; a late one from the last run is not said", async () => {
    // First write: refused, but only once the second run has started.
    const pending: Array<() => void> = [];
    let calls = 0;
    const set = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((_resolve, reject) => {
          pending.push(() => reject(new Error("KV write refused (403)")));
        });
      }
      return Promise.resolve();
    });
    const cache = { get: vi.fn(async () => null), set } as unknown as ContentCache;
    mount(cache);
    await waitFor(() => {
      expect(set).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => {
      expect(set).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      pending[0]();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unsaved()).toHaveLength(0);
  });
});
