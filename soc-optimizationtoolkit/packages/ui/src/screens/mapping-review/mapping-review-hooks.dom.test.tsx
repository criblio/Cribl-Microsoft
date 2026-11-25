// @vitest-environment happy-dom
/**
 * DOM pins for useLearnedMappings against a store that REFUSES (DBT-181).
 *
 * Since DBT-145 the KV store throws on a non-encrypted 403 (a 5xx always did).
 * The hook swallowed all three calls: a refused READ looked like a solution
 * with nothing learned, a refused LEARN (on Approve) left the approved hand
 * edits applying this session and gone the next with nothing said, and a
 * refused FORGET ("Clear learned mappings") emptied the bar while the store
 * kept every decision to replay next time. Each refusal is now kept - which
 * call, and why - for the section to say, and only for the solution it was
 * asked under: a late answer from the last solution claims nothing here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { FakeContentCache, learnedMappingsCacheKey } from "@soc/core";
import type {
  ContentCache,
  GapReport,
  LearnedMapping,
  SchemaCatalog,
} from "@soc/core";
import {
  describeLearnedRefusal,
  useLearnedMappings,
} from "./mapping-review-hooks";
import { MappingReviewSection } from "./mapping-review-section";

afterEach(cleanup);

type Learned = ReturnType<typeof useLearnedMappings>;

const STORED: LearnedMapping[] = [
  { sourceName: "src", destName: "SourceIP", action: "map" },
];

/** One analyzed row, `src -> SrcAddr`, which the reviewer re-points. */
const REPORT = {
  logType: "Traffic",
  fieldMappings: [{ source: "src", dest: "SrcAddr", action: "rename" }],
} as unknown as GapReport;
const EDITED = () => [{ source: "src", dest: "SourceIP", action: "rename" }];

function refusingCache(refuse: { get?: boolean; set?: boolean }): ContentCache {
  const inner = new FakeContentCache();
  return {
    get: async (key: string) => {
      if (refuse.get === true) throw new Error("KV read refused (403)");
      return inner.get(key);
    },
    set: async (key: string, value: unknown) => {
      if (refuse.set === true) throw new Error("KV write refused (403)");
      await inner.set(key, value);
    },
  } as ContentCache;
}

function mountLearned(cache: ContentCache, solution: string) {
  const seen: { current: Learned | null } = { current: null };
  function Probe({ name }: { name: string }) {
    seen.current = useLearnedMappings(cache, name);
    return null;
  }
  const view = render(<Probe name={solution} />);
  return { seen, move: (name: string) => view.rerender(<Probe name={name} />) };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("useLearnedMappings - a refused store (DBT-181)", () => {
  it("a healthy store reports no refusal and replays what is stored", async () => {
    const cache = new FakeContentCache();
    await cache.set(learnedMappingsCacheKey("Acme"), STORED);
    const { seen } = mountLearned(cache, "Acme");
    await waitFor(() => expect(seen.current?.learned).toHaveLength(1));
    expect(seen.current?.storeRefused).toBeNull();
  });

  it("a refused READ is exposed with its reason, not shown as nothing learned", async () => {
    const { seen } = mountLearned(refusingCache({ get: true }), "Acme");
    await waitFor(() =>
      expect(seen.current?.storeRefused).toEqual({
        action: "read",
        reason: "Error: KV read refused (403)",
      }),
    );
    expect(seen.current?.learned).toEqual([]);
  });

  it("a refused LEARN is exposed, and the edit still applies this session", async () => {
    const { seen } = mountLearned(refusingCache({ set: true }), "Acme");
    await settle();
    expect(seen.current?.storeRefused).toBeNull();
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    await waitFor(() =>
      expect(seen.current?.storeRefused).toEqual({
        action: "learn",
        reason: "Error: KV write refused (403)",
      }),
    );
    expect(seen.current?.learned).toEqual(STORED);
  });

  it("an Approve after a refused READ never overwrites what may be stored", async () => {
    // The load failed, so `learned` is [] while the store may hold decisions.
    // Writing merge([], fresh) would replace them with only this Approve's
    // edits - a silent loss. The learn re-reads first; still refused, it skips
    // the write and says the edits were not saved.
    const inner = new FakeContentCache();
    await inner.set(learnedMappingsCacheKey("Acme"), [
      { sourceName: "old", destName: "OldDest", action: "map" },
    ]);
    const writes: unknown[] = [];
    const cache = {
      get: async () => {
        throw new Error("KV read refused (403)");
      },
      set: async (key: string, value: unknown) => {
        writes.push(value);
        await inner.set(key, value);
      },
    } as unknown as ContentCache;
    const { seen } = mountLearned(cache, "Acme");
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("read"));
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    await waitFor(() =>
      expect(seen.current?.storeRefused).toEqual({
        action: "learn",
        reason: "Error: KV read refused (403)",
      }),
    );
    expect(writes).toEqual([]);
    expect(seen.current?.learned).toEqual(STORED);
  });

  it("an Approve after a refused READ merges over the store once it reads again", async () => {
    const inner = new FakeContentCache();
    const OLD = { sourceName: "old", destName: "OldDest", action: "map" } as const;
    await inner.set(learnedMappingsCacheKey("Acme"), [OLD]);
    let refuseRead = true;
    const cache = {
      get: async (key: string) => {
        if (refuseRead) throw new Error("KV read refused (403)");
        return inner.get(key);
      },
      set: async (key: string, value: unknown) => inner.set(key, value),
    } as unknown as ContentCache;
    const { seen } = mountLearned(cache, "Acme");
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("read"));
    refuseRead = false;
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    await waitFor(async () =>
      expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([OLD, ...STORED]),
    );
    expect(seen.current?.learned).toEqual([OLD, ...STORED]);
    expect(seen.current?.storeRefused).toBeNull();
  });

  it("a refused FORGET is exposed, since the store may replay them next session", async () => {
    const { seen } = mountLearned(refusingCache({ set: true }), "Acme");
    await settle();
    act(() => seen.current?.clearLearned());
    await waitFor(() =>
      expect(seen.current?.storeRefused).toEqual({
        action: "forget",
        reason: "Error: KV write refused (403)",
      }),
    );
    expect(seen.current?.learned).toEqual([]);
  });

  it("a write refused AFTER the solution changed is not said about the next one", async () => {
    const pending: Array<() => void> = [];
    const inner = new FakeContentCache();
    const cache = {
      get: async (key: string) => inner.get(key),
      set: () =>
        new Promise<void>((_resolve, reject) => {
          pending.push(() => reject(new Error("KV write refused (403)")));
        }),
    } as unknown as ContentCache;
    const { seen, move } = mountLearned(cache, "Acme");
    await settle();
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    act(() => seen.current?.clearLearned());
    expect(pending).toHaveLength(2);
    move("Globex");
    await settle();
    await act(async () => {
      pending[0]();
      pending[1]();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen.current?.storeRefused).toBeNull();
  });
});

describe("MappingReviewSection - a refused learned-mappings read (DBT-181)", () => {
  const catalog: SchemaCatalog = { resolveSchema: async () => [] };
  const notes = (c: HTMLElement) => c.querySelectorAll(".learned-mappings-refused");

  it("says the learned decisions could not be read, with the reason, once", async () => {
    const view = render(
      <MappingReviewSection
        solutionName="Acme"
        samples={[]}
        catalog={catalog}
        learnedCache={refusingCache({ get: true })}
        onReportsChange={() => undefined}
        onGateChange={() => undefined}
      />,
    );
    await waitFor(() => expect(notes(view.container)).toHaveLength(1));
    const text = notes(view.container)[0].textContent ?? "";
    expect(text).toContain("KV read refused (403)");
    expect(text).toMatch(/could not be read/);
  });

  it("says nothing when the store answers", async () => {
    const view = render(
      <MappingReviewSection
        solutionName="Acme"
        samples={[]}
        catalog={catalog}
        learnedCache={new FakeContentCache()}
        onReportsChange={() => undefined}
        onGateChange={() => undefined}
      />,
    );
    await settle();
    expect(notes(view.container)).toHaveLength(0);
  });
});

describe("describeLearnedRefusal (DBT-181)", () => {
  it("says what is off, why, and the consequence - per refused call", () => {
    const read = describeLearnedRefusal({ action: "read", reason: "R" });
    expect(read).toContain("(R)");
    expect(read).toMatch(/could not be read/);
    expect(read).toMatch(/none are being replayed/);
    // An Approve after a refused read does not overwrite what may be stored.
    expect(read).toMatch(/none are overwritten/);
    const learn = describeLearnedRefusal({ action: "learn", reason: "W" });
    expect(learn).toContain("(W)");
    expect(learn).toMatch(/will not replay/);
    const forget = describeLearnedRefusal({ action: "forget", reason: "F" });
    expect(forget).toContain("(F)");
    expect(forget).toMatch(/may replay/);
    expect(new Set([read, learn, forget]).size).toBe(3);
  });
});
