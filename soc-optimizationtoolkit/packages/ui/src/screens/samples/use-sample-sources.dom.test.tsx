// @vitest-environment happy-dom
/**
 * Pins for sample-source discovery - the REQUEST BEHAVIOUR no pure test can see.
 *
 * The hook's whole reason to exist is what it does NOT send. The first cut
 * fanned out across every Stream worker group on load; this workspace has 15+,
 * so up to nine requests went out before the operator had done anything, against
 * a proxy budget shared with the rest of the page. What replaced it is three
 * rules, and all three are statements about traffic:
 *
 *   1. ON LOAD: the worker group listing, and NOTHING else. One request, once -
 *      never once per render, whatever re-fires the effect.
 *   2. THE MODE DECIDES the second read, and switching mode DROPS the other
 *      surface's inventory rather than showing it under a new heading.
 *   3. A FAILURE STAYS FAILED. One 403 must not become a request storm, so
 *      nothing is retried until the operator asks.
 *
 * Every one of those is invisible to a test that only inspects returned values,
 * which is why this runs the hook through a probe component and counts calls -
 * the idiom use-workspace-tables.dom.test.tsx and use-capability-audit.dom.test
 * .tsx already established for this layer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { EMPTY_AZURE_CONFIG, sectionFor } from "@soc/core";
import type { AzureConfig, CriblRequest, PortHttpResponse } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { useSampleSources } from "./use-sample-sources";
import type { SampleSourcesState } from "./use-sample-sources";

afterEach(cleanup);

const CONFIG: AzureConfig = { ...EMPTY_AZURE_CONFIG };

const LAKE_PATH = "/products/lake/lakes/default/datasets";
const INPUTS_PATH = "/system/inputs";

/** Sources per worker group, deliberately different between the two. */
const SOURCES: Record<string, unknown[]> = {
  default: [{ id: "in_syslog", type: "syslog" }],
  grp2: [{ id: "in_other", type: "http" }],
};

/** A Cribl stub that answers both stages and records every call. */
function okCribl() {
  return {
    listGroups: vi.fn(async () => [
      { id: "default", product: "stream" },
      { id: "grp2", product: "stream" },
      { id: "default_search", product: "search" },
    ]),
    // The body is `unknown` on purpose: individual tests swap in a 403 whose
    // body is a string, and a narrower inference would reject the very failure
    // shapes these pins exist for.
    request: vi.fn(async (opts: CriblRequest): Promise<PortHttpResponse> => {
      if (opts.path === INPUTS_PATH) {
        return { status: 200, body: { items: SOURCES[opts.groupId ?? ""] ?? [] } };
      }
      if (opts.path === LAKE_PATH) {
        return { status: 200, body: { items: [{ id: "Corelight" }] } };
      }
      throw new Error(`unexpected ${opts.method} ${opts.path}`);
    }),
  };
}

type CriblStub = ReturnType<typeof okCribl>;

/**
 * Render the hook and expose its latest value, plus the three ways this effect
 * can be re-fired: a plain re-render, an enablement flicker, and a ports object
 * rebuilt by the shell (App.tsx memoizes cloudPorts on the tenant id, so a new
 * identity is a real event, not a test-only contrivance).
 */
function renderProbe(opts: { cribl?: CriblStub; enabled?: boolean } = {}) {
  const cribl = opts.cribl ?? okCribl();
  const startEnabled = opts.enabled ?? true;
  let ports = { cribl } as unknown as UiPorts;
  const seen: { current: SampleSourcesState | null } = { current: null };

  function Probe({ enabled }: { enabled: boolean }) {
    seen.current = useSampleSources({ enabled });
    return null;
  }

  const tree = (enabled: boolean) => (
    <PortsProvider ports={ports} config={CONFIG}>
      <Probe enabled={enabled} />
    </PortsProvider>
  );
  const { rerender } = render(tree(startEnabled));

  return {
    cribl,
    seen,
    /** Re-render with the same ports; `enabled` defaults to the initial value. */
    rerender: (enabled: boolean = startEnabled) => rerender(tree(enabled)),
    /** Swap in a fresh ports object, which changes every callback's identity. */
    rebuildPorts: (enabled: boolean = startEnabled) => {
      ports = { cribl } as unknown as UiPorts;
      rerender(tree(enabled));
    },
    /** The state, asserted non-null so the tests read as one expression. */
    state: (): SampleSourcesState => {
      if (seen.current === null) throw new Error("probe never rendered");
      return seen.current;
    },
  };
}

/** Paths of every stage-two request made so far, in call order. */
function paths(cribl: CriblStub): string[] {
  return cribl.request.mock.calls.map((c) => c[0].path);
}

describe("useSampleSources - stage one is the whole of the load", () => {
  it("lists the worker groups and reads NO surface", async () => {
    // The lazy rule, stated as traffic: one request on load. A surface nobody
    // has asked about must not be read, and must not be reported either.
    const probe = renderProbe();
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    expect(probe.cribl.listGroups).toHaveBeenCalledTimes(1);
    expect(probe.cribl.request).toHaveBeenCalledTimes(0);
    expect(probe.state().groups?.streamGroupIds).toEqual(["default", "grp2"]);
    // The Search group is resolved HERE so the UI can say up front whether a
    // Lake dataset is queryable at all - it is not a Stream worker group.
    expect(probe.state().groups?.searchGroupId).toBe("default_search");
    expect(probe.state().inventory).toBeNull();
    expect(probe.state().mode).toBeNull();
  });

  it("sends nothing at all with no Cribl address", async () => {
    // Not looking is a different state from looking and finding nothing, and
    // this is the one that must stay silent: `enabled` is false because there is
    // no address yet, which blames nobody.
    const probe = renderProbe({ enabled: false });
    probe.rerender();
    await waitFor(() => expect(probe.state().loadingGroups).toBe(false));

    expect(probe.cribl.listGroups).toHaveBeenCalledTimes(0);
    expect(probe.cribl.request).toHaveBeenCalledTimes(0);
    expect(probe.state().groups).toBeNull();
    expect(probe.state().notes).toEqual([]);
  });

  it("lists ONCE however the effect is re-fired", async () => {
    // The `started` ref, and the three things that reach it. A plain re-render
    // cannot re-fire the effect while the ports are stable, so the teeth are in
    // the other two: enablement flickering, and a rebuilt ports object changing
    // loadGroups' identity. Without the ref each of those re-lists.
    const probe = renderProbe();
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    probe.rerender();
    probe.rerender(false);
    probe.rerender(true);
    probe.rebuildPorts();

    expect(probe.cribl.listGroups).toHaveBeenCalledTimes(1);
  });
});

describe("useSampleSources - the mode decides what is read", () => {
  it("reads Lake datasets from the LEADER route, with no worker group", async () => {
    // Listing Lake datasets is a leader route (verified live 2026-08-19). A
    // groupId here would address the wrong API and answer 404.
    const probe = renderProbe();
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    act(() => probe.state().selectMode("lake-query"));
    await waitFor(() => expect(probe.state().inventory).not.toBeNull());

    expect(paths(probe.cribl)).toEqual([LAKE_PATH]);
    expect(probe.cribl.request.mock.calls[0][0].groupId).toBeUndefined();
    const lake = sectionFor(probe.state().inventory!, "lake-dataset");
    expect(lake?.status).toBe("ok");
    expect(lake?.entries.map((e) => e.id)).toEqual(["Corelight"]);
    // The surface nobody asked about stays PENDING - never a claim of empty.
    expect(sectionFor(probe.state().inventory!, "cribl-source")?.status).toBe(
      "pending",
    );
  });

  it("reads nothing for capture until a worker group is picked", async () => {
    // Capture has no address until the group is chosen, so choosing the mode is
    // free. This is what stops the mode buttons costing a request each.
    const probe = renderProbe();
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    act(() => probe.state().selectMode("live-capture"));
    expect(probe.cribl.request).toHaveBeenCalledTimes(0);

    act(() => probe.state().selectGroup("default"));
    await waitFor(() => expect(probe.state().inventory).not.toBeNull());

    expect(paths(probe.cribl)).toEqual([INPUTS_PATH]);
    expect(probe.cribl.request.mock.calls[0][0].groupId).toBe("default");
    expect(
      sectionFor(probe.state().inventory!, "cribl-source")?.entries.map((e) => e.id),
    ).toEqual(["in_syslog"]);
  });

  it("DROPS the other surface's inventory when the mode changes", async () => {
    // The defect this prevents: Lake datasets still listed under the capture
    // heading, so the operator picks a "source" that is a dataset. Dropping it
    // is what makes the empty gap between modes honest.
    const probe = renderProbe();
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    act(() => probe.state().selectMode("lake-query"));
    await waitFor(() => expect(probe.state().inventory).not.toBeNull());

    act(() => probe.state().selectMode("live-capture"));
    expect(probe.state().inventory).toBeNull();
    // And the switch itself costs nothing - capture still has no address.
    expect(paths(probe.cribl)).toEqual([LAKE_PATH]);
  });

  it("forgets the worker group when the mode changes", async () => {
    // A group is a capture-mode fact. Carrying it into Lake mode and back would
    // re-list a group the operator never re-chose.
    const probe = renderProbe();
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    act(() => probe.state().selectMode("live-capture"));
    act(() => probe.state().selectGroup("default"));
    await waitFor(() => expect(probe.state().inventory).not.toBeNull());
    expect(probe.state().selectedGroupId).toBe("default");

    act(() => probe.state().selectMode("lake-query"));
    expect(probe.state().selectedGroupId).toBe("");
  });

  it("re-reads the chosen group when the group changes", async () => {
    // Each group is its own listing; the previous group's sources are not
    // addressable through the new one.
    const probe = renderProbe();
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    act(() => probe.state().selectMode("live-capture"));
    act(() => probe.state().selectGroup("default"));
    await waitFor(() => expect(probe.state().inventory).not.toBeNull());

    act(() => probe.state().selectGroup("grp2"));
    await waitFor(() =>
      expect(
        sectionFor(probe.state().inventory!, "cribl-source")?.entries.map((e) => e.id),
      ).toEqual(["in_other"]),
    );
    expect(probe.cribl.request.mock.calls.map((c) => c[0].groupId)).toEqual([
      "default",
      "grp2",
    ]);
  });
});

describe("useSampleSources - a failure stays failed until asked again", () => {
  it("reports a failed group listing as a FAILURE, not an empty workspace", async () => {
    // Rule that outranks tidiness: `ok: false` with a note, never a clean empty
    // list. An operator told "no worker groups" goes looking in Cribl; one told
    // the listing failed goes looking at credentials.
    const cribl = okCribl();
    cribl.listGroups.mockRejectedValue(new Error("403 Forbidden"));
    const probe = renderProbe({ cribl });

    await waitFor(() => expect(probe.state().groups).not.toBeNull());
    expect(probe.state().groups?.ok).toBe(false);
    expect(probe.state().notes.join(" ")).toContain("403 Forbidden");
    // Every dead end still ends with the path that needs no Cribl access.
    expect(probe.state().notes.join(" ")).toContain("Uploading samples still works");
  });

  it("does NOT re-list after the group listing fails", async () => {
    // The deliberate rule (source: "NOT AUTO-RETRIED. A failure stays failed
    // until the operator asks again; one 403 must not become a request storm").
    // `started` is set BEFORE the await and never cleared on error, which is the
    // difference between this and the guard that re-fires on every re-render.
    const cribl = okCribl();
    cribl.listGroups.mockRejectedValue(new Error("403 Forbidden"));
    const probe = renderProbe({ cribl });
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    probe.rerender();
    probe.rerender(false);
    probe.rerender(true);
    probe.rebuildPorts();

    expect(cribl.listGroups).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-read a surface whose listing failed", async () => {
    // Same rule one stage down. A 403 on /system/inputs leaves a FAILED section
    // - which the picker reads as "this may be a permission problem", not "this
    // group has no sources" - and nothing goes back for more on its own.
    const cribl = okCribl();
    cribl.request.mockResolvedValue({ status: 403, body: "" });
    const probe = renderProbe({ cribl });
    await waitFor(() => expect(probe.state().groups).not.toBeNull());

    act(() => probe.state().selectMode("live-capture"));
    act(() => probe.state().selectGroup("default"));
    await waitFor(() => expect(probe.state().inventory).not.toBeNull());
    expect(sectionFor(probe.state().inventory!, "cribl-source")?.status).toBe(
      "failed",
    );

    probe.rerender();
    probe.rerender(false);
    probe.rerender(true);
    probe.rebuildPorts();

    expect(cribl.request).toHaveBeenCalledTimes(1);
  });

  it("retries the failed stage, and only that stage, when the operator asks", async () => {
    // Rule 3's other half: `reload` is the ONLY retry, and it re-runs whichever
    // stage is relevant rather than starting the whole cascade again.
    const cribl = okCribl();
    cribl.listGroups.mockRejectedValueOnce(new Error("403 Forbidden"));
    const probe = renderProbe({ cribl });
    await waitFor(() => expect(probe.state().groups).not.toBeNull());
    expect(probe.state().groups?.ok).toBe(false);

    act(() => probe.state().reload());
    await waitFor(() => expect(probe.state().groups?.ok).toBe(true));
    expect(cribl.listGroups).toHaveBeenCalledTimes(2);
    // Stage one was what failed, so stage two is not dragged along behind it.
    expect(cribl.request).toHaveBeenCalledTimes(0);

    act(() => probe.state().selectMode("live-capture"));
    act(() => probe.state().selectGroup("default"));
    await waitFor(() => expect(probe.state().inventory).not.toBeNull());

    act(() => probe.state().reload());
    await waitFor(() => expect(cribl.request).toHaveBeenCalledTimes(2));
    // Re-reading the surface must not re-list the groups behind it.
    expect(cribl.listGroups).toHaveBeenCalledTimes(2);
  });
});
