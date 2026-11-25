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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  FakeContentCache,
  learnedMappingsCacheKey,
  parseSampleContent,
} from "@soc/core";
import type {
  ContentCache,
  GapReport,
  LearnedMapping,
  SchemaCatalog,
  TaggedSample,
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
/** A second table, so two Approves learn two different decisions. */
const REPORT2 = {
  logType: "Threat",
  fieldMappings: [{ source: "dst", dest: "DstAddr", action: "rename" }],
} as unknown as GapReport;
const EDITED2 = () => [{ source: "dst", dest: "DestinationIP", action: "rename" }];
const OLD: LearnedMapping = { sourceName: "old", destName: "OldDest", action: "map" };
const SRC: LearnedMapping = STORED[0];
const DST: LearnedMapping = { sourceName: "dst", destName: "DestinationIP", action: "map" };

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // Store calls run one at a time (review A3), so each write is released on
  // its own rather than both being in flight together.
  for (const call of ["learn", "forget"] as const) {
    it(`a ${call} refused AFTER the solution changed is not said about the next one`, async () => {
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
      act(() => {
        if (call === "learn") seen.current?.persistLearned([REPORT], EDITED);
        else seen.current?.clearLearned();
      });
      await waitFor(() => expect(pending).toHaveLength(1));
      move("Globex");
      await settle();
      await act(async () => {
        pending[0]();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(seen.current?.storeRefused).toBeNull();
    });
  }
});

describe("useLearnedMappings - review fixes (DBT-181 review)", () => {
  it("A1: a Clear after a refused READ writes nothing and keeps the read note", async () => {
    const inner = new FakeContentCache();
    await inner.set(learnedMappingsCacheKey("Acme"), [OLD]);
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
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("learn"));
    act(() => seen.current?.clearLearned());
    await settle();
    expect(writes).toEqual([]);
    expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([OLD]);
    expect(seen.current?.learned).toEqual([]);
    // The unsaved edits are gone, so the note is the read one again.
    expect(seen.current?.storeRefused).toEqual({
      action: "read",
      reason: "Error: KV read refused (403)",
    });
  });

  it("A2: a re-read that succeeds saves the earlier unsaved edits too, then clears the note", async () => {
    const inner = new FakeContentCache();
    await inner.set(learnedMappingsCacheKey("Acme"), [OLD]);
    let refusedReads = 2; // the load and the first Approve's re-read
    const cache = {
      get: async (key: string) => {
        if (refusedReads > 0) {
          refusedReads -= 1;
          throw new Error("KV read refused (403)");
        }
        return inner.get(key);
      },
      set: async (key: string, value: unknown) => inner.set(key, value),
    } as unknown as ContentCache;
    const { seen } = mountLearned(cache, "Acme");
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("read"));
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("learn"));
    act(() => seen.current?.persistLearned([REPORT2], EDITED2));
    await waitFor(async () =>
      expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([OLD, SRC, DST]),
    );
    expect(seen.current?.learned).toEqual([OLD, SRC, DST]);
    expect(seen.current?.storeRefused).toBeNull();
  });

  it("A3: two Approves are serialized - never two store calls in flight", async () => {
    const inner = new FakeContentCache();
    await inner.set(learnedMappingsCacheKey("Acme"), [OLD]);
    let loaded = false;
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = async <T,>(work: () => Promise<T>): Promise<T> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await tick(5);
        return await work();
      } finally {
        inFlight -= 1;
      }
    };
    const cache = {
      get: async (key: string) => {
        if (!loaded) {
          loaded = true;
          throw new Error("KV read refused (403)");
        }
        return slow(() => inner.get(key));
      },
      set: (key: string, value: unknown) => slow(() => inner.set(key, value)),
    } as unknown as ContentCache;
    const { seen } = mountLearned(cache, "Acme");
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("read"));
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    act(() => seen.current?.persistLearned([REPORT2], EDITED2));
    await waitFor(async () =>
      expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([OLD, SRC, DST]),
    );
    await act(async () => {
      await tick(30);
    });
    expect(maxInFlight).toBe(1);
    expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([OLD, SRC, DST]);
  });

  it("A4: an Approve before the load answers does not write over the store", async () => {
    const inner = new FakeContentCache();
    await inner.set(learnedMappingsCacheKey("Acme"), [OLD]);
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let first = true;
    const writes: unknown[] = [];
    const cache = {
      get: async (key: string) => {
        if (first) {
          first = false;
          await loadGate;
        }
        return inner.get(key);
      },
      set: async (key: string, value: unknown) => {
        writes.push(value);
        await inner.set(key, value);
      },
    } as unknown as ContentCache;
    const { seen } = mountLearned(cache, "Acme");
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    await settle();
    expect(writes).toEqual([]);
    await act(async () => {
      releaseLoad();
      await tick(0);
    });
    await waitFor(async () =>
      expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([OLD, SRC]),
    );
    expect(writes).toEqual([[OLD, SRC]]);
    expect(seen.current?.learned).toEqual([OLD, SRC]);
  });

  it("A5: a later successful learn clears the learn note", async () => {
    let refuseWrites = 1;
    const inner = new FakeContentCache();
    const cache = {
      get: async (key: string) => inner.get(key),
      set: async (key: string, value: unknown) => {
        if (refuseWrites > 0) {
          refuseWrites -= 1;
          throw new Error("KV write refused (403)");
        }
        await inner.set(key, value);
      },
    } as unknown as ContentCache;
    const { seen } = mountLearned(cache, "Acme");
    await settle();
    act(() => seen.current?.persistLearned([REPORT], EDITED));
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("learn"));
    act(() => seen.current?.persistLearned([REPORT2], EDITED2));
    await waitFor(() => expect(seen.current?.storeRefused).toBeNull());
    // The later write covers the edits the refused one lost.
    expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([SRC, DST]);
  });

  it("A5: a later successful clear clears the forget note", async () => {
    let refuseWrites = 1;
    const inner = new FakeContentCache();
    await inner.set(learnedMappingsCacheKey("Acme"), STORED);
    const cache = {
      get: async (key: string) => inner.get(key),
      set: async (key: string, value: unknown) => {
        if (refuseWrites > 0) {
          refuseWrites -= 1;
          throw new Error("KV write refused (403)");
        }
        await inner.set(key, value);
      },
    } as unknown as ContentCache;
    const { seen } = mountLearned(cache, "Acme");
    await waitFor(() => expect(seen.current?.learned).toHaveLength(1));
    act(() => seen.current?.clearLearned());
    await waitFor(() => expect(seen.current?.storeRefused?.action).toBe("forget"));
    act(() => seen.current?.clearLearned());
    await waitFor(() => expect(seen.current?.storeRefused).toBeNull());
    expect(await inner.get(learnedMappingsCacheKey("Acme"))).toEqual([]);
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

describe("MappingReviewSection - learn and forget refusals reach the screen (DBT-181 review)", () => {
  const catalog: SchemaCatalog = {
    resolveSchema: async () => [
      { name: "TimeGenerated", type: "datetime" },
      { name: "AdditionalExtensions", type: "string" },
      { name: "SourceMACAddress", type: "string" },
    ],
  };
  const notes = (c: HTMLElement) => c.querySelectorAll(".learned-mappings-refused");

  function sample(): TaggedSample {
    const content = JSON.stringify({
      TimeGenerated: "2026-10-29T12:00:00Z",
      qqvendorfield: "00:11:22:33:44:55",
    });
    return {
      logType: "PanOS",
      format: "json",
      rawEvents: [content],
      parsed: parseSampleContent(content, { sourceName: "panos.json" }),
    };
  }

  /** Open a combobox and click the option whose label is exactly `text`. */
  function chooseOption(control: HTMLElement, text: string): void {
    fireEvent.click(control);
    const option = [
      ...(control.closest(".searchable-select")?.querySelectorAll(".searchable-select-option") ??
        []),
    ].find(
      (o) =>
        (o.querySelector(".searchable-select-option-label")?.textContent ?? o.textContent) ===
        text,
    );
    if (option === undefined) throw new Error(`no option "${text}"`);
    fireEvent.click(option);
  }

  it("says an Approve's hand edits could not be learned", async () => {
    const view = render(
      <MappingReviewSection
        solutionName="Acme"
        samples={[sample()]}
        catalog={catalog}
        learnedCache={refusingCache({ set: true })}
        onReportsChange={() => undefined}
        onGateChange={() => undefined}
      />,
    );
    const c = view.container;
    const analyze = [...c.querySelectorAll("button")].find((b) =>
      /analyze/i.test(b.textContent ?? ""),
    );
    if (analyze === undefined) throw new Error("Analyze button not rendered");
    fireEvent.click(analyze);
    await waitFor(() => expect(c.querySelector(".mapping-review-grid")).not.toBeNull());
    const row = [
      ...c.querySelectorAll<HTMLTableRowElement>(
        ".mapping-review-grid tbody tr.mapping-row:not(.mapping-row-unmapped)",
      ),
    ].find((tr) => tr.cells[0]!.textContent === "qqvendorfield");
    if (row === undefined) throw new Error("no qqvendorfield row");
    const dest = row.querySelector<HTMLElement>(".mapping-select .searchable-select-control");
    if (dest === null) throw new Error("no Dest Field control");
    chooseOption(dest, "SourceMACAddress");
    const approve = c.querySelector<HTMLButtonElement>(".gap-approval-bar .next-action-button");
    if (approve === null) throw new Error("no Approve button");
    fireEvent.click(approve);
    await waitFor(() => expect(notes(c)).toHaveLength(1));
    expect(notes(c)[0].textContent).toBe(
      describeLearnedRefusal({ action: "learn", reason: "Error: KV write refused (403)" }),
    );
  });

  it("says a Clear could not forget the stored decisions", async () => {
    const inner = new FakeContentCache();
    await inner.set(learnedMappingsCacheKey("Acme"), STORED);
    const cache = {
      get: async (key: string) => inner.get(key),
      set: async () => {
        throw new Error("KV write refused (403)");
      },
    } as unknown as ContentCache;
    const view = render(
      <MappingReviewSection
        solutionName="Acme"
        samples={[]}
        catalog={catalog}
        learnedCache={cache}
        onReportsChange={() => undefined}
        onGateChange={() => undefined}
      />,
    );
    const c = view.container;
    await waitFor(() => expect(c.querySelector(".learned-mappings-bar")).not.toBeNull());
    const clear = [...c.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear learned mappings",
    );
    if (clear === undefined) throw new Error("no Clear learned mappings button");
    fireEvent.click(clear);
    await waitFor(() => expect(notes(c)).toHaveLength(1));
    expect(notes(c)[0].textContent).toBe(
      describeLearnedRefusal({ action: "forget", reason: "Error: KV write refused (403)" }),
    );
  });
});

describe("describeLearnedRefusal (DBT-181)", () => {
  it("says what is off, why, and the consequence - per refused call", () => {
    expect(describeLearnedRefusal({ action: "read", reason: "R" })).toBe(
      "Learned decisions for this solution could not be read (R), so none are " +
        "being replayed. Approving still applies your edits; they are saved only " +
        "once the stored decisions can be read, so none are overwritten. Until " +
        "then, Clear learned mappings clears only this session's edits and " +
        "leaves the store untouched.",
    );
    expect(describeLearnedRefusal({ action: "learn", reason: "W" })).toBe(
      "The approved hand edits could not be saved as learned decisions (W). " +
        "They apply now but will not replay on the next analysis.",
    );
    expect(describeLearnedRefusal({ action: "forget", reason: "F" })).toBe(
      "The learned decisions could not be cleared (F). They are not applied " +
        "now, but they may replay on the next analysis.",
    );
  });
});
