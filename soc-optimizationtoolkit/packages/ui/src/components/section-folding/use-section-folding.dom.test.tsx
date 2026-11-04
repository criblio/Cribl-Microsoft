// @vitest-environment happy-dom
/**
 * The shared fold controller on a tiny fixture page (DBT-248 Task A): the
 * load fold, the move fold, pins that survive a reload, and the per-user pin
 * key. Integrate's own dom tests cover the same rules through the real screen.
 */

import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EMPTY_AZURE_CONFIG } from "@soc/core";
import { PortsProvider } from "../../ports-context";
import type { UiPorts } from "../../ports-context";
import { useSectionFolding } from "./use-section-folding";

afterEach(cleanup);

const IDS = ["one", "two", "three"];

function makePorts(opts: {
  store: Map<string, unknown>;
  userId?: string | null;
}): UiPorts {
  return {
    contentCache: {
      get: async (k: string) => opts.store.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        opts.store.set(k, v);
      },
    },
    user: {
      current: async () => {
        if (opts.userId === null || opts.userId === undefined) throw new Error("no identity");
        return { id: opts.userId };
      },
    },
  } as unknown as UiPorts;
}

function Page(props: { currentId: string | undefined; keepOpen?: string[] }): ReactElement {
  const f = useSectionFolding({
    ids: IDS,
    currentId: props.currentId,
    pinPrefix: "fixture-pinned",
    keepOpen: props.keepOpen,
  });
  return (
    <div>
      {IDS.map((id) => (
        <section key={id} id={id}>
          <button type="button" data-testid={`move-${id}`} onClick={() => f.moveTo(id)} />
          <button type="button" data-testid={`open-${id}`} onClick={() => f.setCollapsed(id, false)} />
          <button type="button" data-testid={`pin-${id}`} onClick={() => f.setPinned(id, !f.pinned.has(id))} />
          <span data-testid={`state-${id}`}>{f.collapsed.has(id) ? "folded" : "open"}</span>
        </section>
      ))}
    </div>
  );
}

function mount(ports: UiPorts, ui: ReactElement) {
  return render(
    <PortsProvider ports={ports} config={EMPTY_AZURE_CONFIG}>
      {ui}
    </PortsProvider>,
  );
}

const state = (id: string): string | null => screen.getByTestId(`state-${id}`).textContent;

describe("useSectionFolding", () => {
  it("opens collapsed: only the current section is open", () => {
    mount(makePorts({ store: new Map() }), <Page currentId="two" />);
    expect([state("one"), state("two"), state("three")]).toEqual(["folded", "open", "folded"]);
  });

  it("re-derives the load fold when current changes before the first move", () => {
    const ports = makePorts({ store: new Map() });
    const { rerender } = mount(ports, <Page currentId="one" />);
    rerender(
      <PortsProvider ports={ports} config={EMPTY_AZURE_CONFIG}>
        <Page currentId="three" />
      </PortsProvider>,
    );
    expect([state("one"), state("two"), state("three")]).toEqual(["folded", "folded", "open"]);
  });

  it("an explicit open ends the load fold too: current advancing does not shut it (DBT-256)", () => {
    const ports = makePorts({ store: new Map() });
    const { rerender } = mount(ports, <Page currentId="one" />);
    fireEvent.click(screen.getByTestId("open-two"));
    rerender(
      <PortsProvider ports={ports} config={EMPTY_AZURE_CONFIG}>
        <Page currentId="three" />
      </PortsProvider>,
    );
    // Opening is not a move, so nothing else folded; and the load fold stopped.
    expect([state("one"), state("two"), state("three")]).toEqual(["open", "open", "folded"]);
  });

  it("stops following current after the first move, and the move folds the others", () => {
    const ports = makePorts({ store: new Map() });
    const { rerender } = mount(ports, <Page currentId="one" />);
    fireEvent.click(screen.getByTestId("move-one"));
    rerender(
      <PortsProvider ports={ports} config={EMPTY_AZURE_CONFIG}>
        <Page currentId="three" />
      </PortsProvider>,
    );
    expect([state("one"), state("two"), state("three")]).toEqual(["open", "folded", "folded"]);
  });

  it("a move folds every other open unpinned section; pinned ones stay", async () => {
    const store = new Map<string, unknown>([["fixture-pinned:u-1", JSON.stringify(["three"])]]);
    mount(makePorts({ store, userId: "u-1" }), <Page currentId="one" />);
    await waitFor(() => expect(state("three")).toBe("open"));
    fireEvent.click(screen.getByTestId("move-two"));
    expect([state("one"), state("two"), state("three")]).toEqual(["folded", "folded", "open"]);
  });

  it("keeps a keepOpen section open through a move", async () => {
    // Load with two current, then move to one: two is running, so it stays.
    mount(makePorts({ store: new Map() }), <Page currentId="two" keepOpen={["two"]} />);
    fireEvent.click(screen.getByTestId("move-one"));
    expect([state("one"), state("two"), state("three")]).toEqual(["folded", "open", "folded"]);
  });

  it("writes pins under the per-user key and reopens them on the next load", async () => {
    const store = new Map<string, unknown>();
    const ports = makePorts({ store, userId: "u-7" });
    mount(ports, <Page currentId="one" />);
    await waitFor(() => expect(state("one")).toBe("open"));
    // let the async identity read settle so the key is known
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByTestId("pin-three"));
    await waitFor(() => expect(store.get("fixture-pinned:u-7")).toBe(JSON.stringify(["three"])));
    cleanup();
    mount(ports, <Page currentId="one" />);
    await waitFor(() => expect(state("three")).toBe("open"));
    expect(state("two")).toBe("folded");
  });

  it("pins are session-only with no identity: nothing is written", async () => {
    const store = new Map<string, unknown>();
    mount(makePorts({ store, userId: null }), <Page currentId="one" />);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByTestId("pin-two"));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.size).toBe(0);
    // the pin still holds for the session: a move leaves it open
    fireEvent.click(screen.getByTestId("move-one"));
    expect(state("two")).toBe("open");
  });

  it("keeps moveTo's identity across a re-render with an inline anchorFor", () => {
    const seen: Array<(id: string) => void> = [];
    function Probe(): ReactElement {
      const f = useSectionFolding({
        ids: IDS,
        currentId: "one",
        pinPrefix: "fixture-pinned",
        anchorFor: (id) => `a-${id}`,
      });
      seen.push(f.moveTo);
      return <span />;
    }
    const ports = makePorts({ store: new Map() });
    const { rerender } = mount(ports, <Probe />);
    rerender(
      <PortsProvider ports={ports} config={EMPTY_AZURE_CONFIG}>
        <Probe />
      </PortsProvider>,
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2]);
  });

  it("a pin clicked before the stored pins load is merged with them, and written only after the load", async () => {
    const store = new Map<string, unknown>([["fixture-pinned:u-9", JSON.stringify(["one"])]]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ports = {
      contentCache: {
        get: async (k: string) => {
          await gate;
          return store.get(k) ?? null;
        },
        set: async (k: string, v: unknown) => {
          store.set(k, v);
        },
      },
      user: { current: async () => ({ id: "u-9" }) },
    } as unknown as UiPorts;
    mount(ports, <Page currentId="two" />);
    fireEvent.click(screen.getByTestId("pin-three"));
    await new Promise((r) => setTimeout(r, 0));
    // Not yet written: the stored list has not been read, so a write would replace it.
    expect(store.get("fixture-pinned:u-9")).toBe(JSON.stringify(["one"]));
    release();
    await waitFor(() =>
      expect(JSON.parse(store.get("fixture-pinned:u-9") as string).sort()).toEqual(["one", "three"]),
    );
    // Both pins hold: the stored one opened on load, the in-session one stayed.
    expect(state("one")).toBe("open");
    expect(state("three")).toBe("open");
  });
});
