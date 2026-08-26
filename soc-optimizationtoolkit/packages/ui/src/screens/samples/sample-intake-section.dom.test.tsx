// @vitest-environment happy-dom
/**
 * DOM pins for the Sample Data section's TWO WAYS IN, and specifically for the
 * offer that only one of them used to make.
 *
 * THE DEFECT (live, 2026-08-25): "fetching samples from Cribl Lake seems to work
 * but when I click add samples it adds them but doesn't give me the preview to
 * modify them." Paste and upload both open the headerless-CSV column-naming
 * dialog the moment a positional sample is tagged. A Lake commit - and a capture
 * commit, which is the same code shape - did not, because the acquisition panels
 * are SIBLINGS of this section: they reach the shared store and cannot reach the
 * resolution queue, which is state in here. The samples landed, the chips even
 * offered a "Resolve headers" button, and nothing volunteered.
 *
 * These pins are in a DOM file because there is nowhere else they can live. The
 * queue's decisions are thoroughly covered by csv-resolution-state.test.ts and
 * every one of them passed while the dialog never opened - what was missing was
 * a wire between two components, which no pure test can see. Same lesson the
 * Integrate screen's own smoke file records: the file with tests was not the
 * file with the bug.
 *
 * WHAT EACH GROUP IS FOR:
 *   - "an arrival from a sibling panel" - the seam itself: it fires, it fires
 *     ONCE per commit, it queues every headerless arrival and only those, and it
 *     re-reads the store so this section's own copy of the list is not left
 *     short by exactly the samples that just arrived.
 *   - "a pasted PAN-OS export" - behaviour that has been live and unpinned: a
 *     log type PAN-OS documents a column order for is named on the way in and is
 *     NOT asked about, while one it does not (AUTH, WILDFIRE, GTP...) stays
 *     positional and IS. That asymmetry is the whole reason the dialog exists,
 *     and it was resting on a chain of four decisions in three modules with no
 *     test standing at the end of it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  FakeContentCache,
  buildVendorFieldDefinition,
  vendorFieldDefinitionKey,
} from "@soc/core";
import type { ContentCache, TaggedSample, TaggedSampleStore } from "@soc/core";
import { SampleIntakeSection } from "./sample-intake-section";
import { tagSampleFromContent } from "./sample-intake-state";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Real PAN-OS lines, two per log type. The distinguishing property is the log
 * type in field 3: PAN-OS documents a column order for TRAFFIC and does not for
 * AUTH or WILDFIRE, so the first parses to NAMED fields and the other two to
 * positional `_0.._N`. The column counts differ (9 vs 10) on purpose, so the
 * dialog's own title says WHICH queued sample is on screen.
 *
 * These were USERID and IPTAG until 2026-08-25, when both gained a column order
 * transcribed from Palo Alto's published field descriptions and stopped being
 * positional. The subjects moved to two types that are STILL undictionaried
 * rather than the tests being weakened - what is under test here is the
 * named-vs-positional asymmetry, not those two log types. AUTH is the pointed
 * choice: it is live on the lab dataset and the toolkit deliberately declines
 * to guess an order for it, because Palo Alto publishes none.
 */
const PANOS = {
  traffic: [
    "1,2026/08/13 10:49:02,013201031064,TRAFFIC,end,2817,2026/08/13 10:48:54,10.0.0.5,8.8.8.8",
    "1,2026/08/13 10:49:05,013201031064,TRAFFIC,end,2818,2026/08/13 10:48:57,10.0.0.6,8.8.4.4",
  ].join("\n"),
  auth: [
    "1,2026/08/13 10:49:02,013201031064,AUTH,0,2817,2026/08/13 10:48:54,vsys1,user1",
    "1,2026/08/13 10:49:06,013201031064,AUTH,0,2818,2026/08/13 10:48:58,vsys1,user2",
  ].join("\n"),
  wildfire: [
    "1,2026/08/13 10:49:02,013201031064,WILDFIRE,0,2817,2026/08/13 10:48:54,vsys1,10.0.0.9,tag1",
    "1,2026/08/13 10:49:07,013201031064,WILDFIRE,0,2819,2026/08/13 10:48:59,vsys1,10.0.0.10,tag2",
  ].join("\n"),
};

/** An NDJSON sample: named fields, nothing to resolve. */
const NAMED_JSON = '{"user":"a","action":"login"}\n{"user":"b","action":"logout"}';

const lakeSample = (logType: string, content: string): TaggedSample =>
  tagSampleFromContent(logType, content, `lake:${logType}`);

/** An in-memory TaggedSampleStore with replace-by-logType semantics. */
function makeStore(seed: readonly TaggedSample[] = []) {
  const byType = new Map(seed.map((s) => [s.logType, s]));
  const store: TaggedSampleStore = {
    upsert: vi.fn(async (sample: TaggedSample) => {
      byType.set(sample.logType, sample);
    }),
    get: vi.fn(async (logType: string) => byType.get(logType) ?? null),
    list: vi.fn(async () => [...byType.values()]),
    remove: vi.fn(async (logType: string) => {
      byType.delete(logType);
    }),
  };
  return { store, byType };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Mount the section over `store` and wait for its initial store read. */
async function mount(store: TaggedSampleStore) {
  const onSamplesChange = vi.fn();
  const view = render(
    <SampleIntakeSection store={store} onSamplesChange={onSamplesChange} />,
  );
  await waitFor(() => {
    expect(onSamplesChange).toHaveBeenCalled();
  });
  const show = (arrival?: { nonce: number; samples: readonly TaggedSample[] }) => {
    view.rerender(
      <SampleIntakeSection
        store={store}
        onSamplesChange={onSamplesChange}
        arrivalEvent={arrival}
      />,
    );
  };
  return { ...view, onSamplesChange, show };
}

/**
 * Do what a sibling acquisition panel does: write the batch to the shared store,
 * then announce it. One nonce per commit - that is the contract the section
 * consumes against.
 */
async function siblingCommits(
  view: Awaited<ReturnType<typeof mount>>,
  store: TaggedSampleStore,
  arrived: readonly TaggedSample[],
  nonce: number,
): Promise<void> {
  await act(async () => {
    for (const sample of arrived) {
      await store.upsert(sample);
    }
  });
  await act(async () => {
    view.show({ nonce, samples: arrived });
  });
}

const dialogs = (c: HTMLElement) => c.querySelectorAll(".csv-dialog");

/** The dialog's title, which names the column count of the queued sample. */
const dialogTitle = (c: HTMLElement) =>
  c.querySelector(".csv-dialog-title")?.textContent ?? "";

/** The dialog's caption, which names the sample's source and its queue turn. */
const dialogCaption = (c: HTMLElement) =>
  c.querySelector(".csv-dialog .field-hint")?.textContent ?? "";

const chipNames = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".sample-chip-name")).map(
    (n) => n.textContent ?? "",
  );

/** The field names on the chip for `logType`, from its expandable table. */
function chipFields(c: HTMLElement, logType: string): string[] {
  const chip = Array.from(c.querySelectorAll(".sample-chip")).find(
    (el) => el.querySelector(".sample-chip-name")?.textContent === logType,
  );
  if (chip === undefined) {
    throw new Error(`no chip for "${logType}"`);
  }
  return Array.from(chip.querySelectorAll(".sample-field-table tbody tr")).map(
    (row) => row.querySelector("td")?.textContent ?? "",
  );
}

function clickButton(c: HTMLElement, label: string): void {
  const button = Array.from(c.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
  if (button === undefined) {
    throw new Error(`no button labelled "${label}"`);
  }
  fireEvent.click(button);
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe("SampleIntakeSection - an arrival from a sibling panel", () => {
  it("offers the column dialog for a headerless commit", async () => {
    // The reported bug, in one assertion. The samples are in the store before
    // the announcement, exactly as the Lake panel leaves them.
    const { store } = makeStore();
    const view = await mount(store);
    expect(dialogs(view.container)).toHaveLength(0);

    await siblingCommits(view, store, [lakeSample("AUTH", PANOS.auth)], 1);

    expect(dialogs(view.container)).toHaveLength(1);
    expect(dialogTitle(view.container)).toBe(
      "Headerless CSV detected (9 columns)",
    );
    expect(dialogCaption(view.container)).toContain("lake:AUTH");
  });

  it("opens NOTHING when the commit's samples are already named", async () => {
    const { store } = makeStore();
    const view = await mount(store);

    await siblingCommits(view, store, [lakeSample("Named", NAMED_JSON)], 1);

    expect(dialogs(view.container)).toHaveLength(0);
    // And the arrival WAS processed - "no dialog" has to be distinguishable
    // from "the event never reached this section", which is the bug.
    expect(chipNames(view.container)).toEqual(["Named"]);
  });

  it("queues EVERY headerless sample in a multi-log-type commit, one turn each", async () => {
    // The batch rule upload has had since Unit 12: a commit carrying three log
    // types, two of them positional, resolves both rather than the first.
    const { store } = makeStore();
    const view = await mount(store);

    await siblingCommits(
      view,
      store,
      [
        lakeSample("AUTH", PANOS.auth),
        lakeSample("Named", NAMED_JSON),
        lakeSample("WILDFIRE", PANOS.wildfire),
      ],
      1,
    );

    // Turn one: the first headerless arrival, and the queue knows there are two.
    expect(dialogTitle(view.container)).toBe(
      "Headerless CSV detected (9 columns)",
    );
    expect(dialogCaption(view.container)).toContain("lake:AUTH");
    // CHANGED 2026-08-26: the caption said "Resolving file 1 of 2" for a
    // sample whose sourceName is `lake:AUTH`. Nothing on this path is a file -
    // the queue holds TAGGED SAMPLES, one per log type, and a queued one may
    // have arrived as an upload, a paste, or (as here) a Lake dataset. The
    // wording was pinned as-is, so test and component agreed on copy that was
    // wrong for the very path the arrival seam exists to serve.
    expect(dialogCaption(view.container)).toContain("Naming log type 1 of 2");

    // Turn two: the OTHER headerless arrival - not the named one, which was
    // never queued, and not a repeat of the first.
    clickButton(view.container, "Skip");
    expect(dialogTitle(view.container)).toBe(
      "Headerless CSV detected (10 columns)",
    );
    expect(dialogCaption(view.container)).toContain("lake:WILDFIRE");
    // Same copy change as turn one - see the comment above.
    expect(dialogCaption(view.container)).toContain("Naming log type 2 of 2");
    // And it never calls a Lake dataset a file.
    expect(dialogCaption(view.container)).not.toContain("file");

    // Two headerless samples, two turns, then done.
    clickButton(view.container, "Skip");
    expect(dialogs(view.container)).toHaveLength(0);
    expect(chipNames(view.container)).toEqual(["AUTH", "Named", "WILDFIRE"]);
  });

  it("fires ONCE per commit, not on every re-render carrying the batch", async () => {
    // Without this the dialog would reopen every time the parent re-rendered -
    // on any samples-list refresh, on any unrelated state change - which is a
    // worse experience than the bug being fixed.
    const { store } = makeStore();
    const view = await mount(store);
    await siblingCommits(view, store, [lakeSample("AUTH", PANOS.auth)], 1);

    clickButton(view.container, "Skip");
    expect(dialogs(view.container)).toHaveLength(0);

    // A fresh object carrying the SAME nonce: a re-render, not a new commit.
    await act(async () => {
      view.show({ nonce: 1, samples: [lakeSample("AUTH", PANOS.auth)] });
    });
    expect(dialogs(view.container)).toHaveLength(0);

    // A genuinely new commit still opens, so the guard is a nonce check and not
    // a one-shot latch.
    await siblingCommits(view, store, [lakeSample("WILDFIRE", PANOS.wildfire)], 2);
    expect(dialogTitle(view.container)).toBe(
      "Headerless CSV detected (10 columns)",
    );
  });

  it("re-reads the store, so its own list is not left short by the arrivals", async () => {
    // This section holds its OWN copy of the list; a sibling writes behind its
    // back. Left short, the next write from in here rebuilds the reported list
    // from that copy and reports the arrivals away again - they would sit in the
    // store while the page below stopped counting them.
    const seeded = tagSampleFromContent("Existing", NAMED_JSON, "pasted");
    const { store } = makeStore([seeded]);
    const view = await mount(store);
    expect(store.list).toHaveBeenCalledTimes(1);

    await siblingCommits(view, store, [lakeSample("AUTH", PANOS.auth)], 1);

    expect(store.list).toHaveBeenCalledTimes(2);
    expect(chipNames(view.container)).toEqual(["Existing", "AUTH"]);
    const reported = view.onSamplesChange.mock.calls.at(-1)?.[0] as TaggedSample[];
    expect(reported.map((s) => s.logType)).toEqual(["Existing", "AUTH"]);
  });
});

// ---------------------------------------------------------------------------
// The paste path, and the PAN-OS asymmetry underneath it
// ---------------------------------------------------------------------------

/** Paste `content` under `logType` and press Add Sample. */
async function paste(
  container: HTMLElement,
  logType: string,
  content: string,
): Promise<void> {
  const textarea = container.querySelector(
    "textarea.sample-paste",
  ) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: content } });
  const name = container.querySelector(
    ".sample-intake-input input[type=text]",
  ) as HTMLInputElement;
  fireEvent.change(name, { target: { value: logType } });
  await act(async () => {
    clickButton(container, "Add Sample");
  });
}

describe("SampleIntakeSection - a pasted PAN-OS export", () => {
  it("is asked about a log type PAN-OS has NO bundled column order for", async () => {
    // AUTH is genuinely undictionaried (pinned in panos-dictionary.test.ts),
    // so the parse can only name its columns positionally - which is exactly
    // the case the dialog exists for.
    const { store } = makeStore();
    const view = await mount(store);

    await paste(view.container, "PanAuth", PANOS.auth);

    expect(dialogs(view.container)).toHaveLength(1);
    expect(dialogTitle(view.container)).toBe(
      "Headerless CSV detected (9 columns)",
    );
    // The columns really are unnamed, which is WHY it is asked.
    expect(chipFields(view.container, "PanAuth")).toEqual([
      "_0",
      "_1",
      "_2",
      "_3",
      "_4",
      "_5",
      "_6",
      "_7",
      "_8",
    ]);
  });

  it("is NOT asked about TRAFFIC, whose column order ships with the app", async () => {
    // The other half, and the one that would silently regress: if the bundled
    // dictionary ever stopped being applied, TRAFFIC would parse positionally
    // and the operator would be asked to hand-name 9 columns the app already
    // knows. Asserting the NAMES is what makes "no dialog" mean "already named"
    // rather than "nothing parsed".
    const { store } = makeStore();
    const view = await mount(store);

    await paste(view.container, "PanTraffic", PANOS.traffic);

    expect(dialogs(view.container)).toHaveLength(0);
    expect(chipFields(view.container, "PanTraffic")).toEqual([
      "receive_time",
      "serial",
      "type",
      "subtype",
      "generated_time",
      "src",
      "dst",
    ]);
  });
});

// ---------------------------------------------------------------------------
// A PARTIAL definition, which is an encouraged action and used to be terminal
// ---------------------------------------------------------------------------

/** The dialog's own header-row box, not the section's paste box. */
const dialogTextarea = (c: HTMLElement) =>
  c.querySelector(".csv-dialog textarea.sample-paste") as HTMLTextAreaElement;

const buttonLabels = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).map((b) => b.textContent ?? "");

describe("SampleIntakeSection - applying a definition that covers PART of the columns", () => {
  /** Paste PANOS.auth, then apply `headers` in the dialog it opens. */
  async function pasteThenApply(
    view: Awaited<ReturnType<typeof mount>>,
    headers: string,
  ): Promise<void> {
    await paste(view.container, "PanAuth", PANOS.auth);
    fireEvent.change(dialogTextarea(view.container), {
      target: { value: headers },
    });
    await act(async () => {
      clickButton(view.container, "Apply headers");
    });
  }

  it("leaves the unnamed columns POSITIONAL, exactly as the preview showed them", async () => {
    // THE DEFECT: core parseCsvWithHeaders parked the surplus values at
    // `_extra_7`, so the operator read `_7` in the coverage line, `_7
    // (unmapped)` in the preview rows and `_extra_N` in the mismatch warning -
    // three names for the same two positions - and got a fourth outcome.
    const { store } = makeStore();
    const view = await mount(store);
    await pasteThenApply(
      view,
      "receive_time,serial,type,subtype,eventid,vsys,user",
    );

    const fields = chipFields(view.container, "PanAuth");
    expect(fields).toEqual([
      "receive_time",
      "serial",
      "type",
      "subtype",
      "eventid",
      "vsys",
      "user",
      "_7",
      "_8",
    ]);
    expect(fields.some((f) => f.startsWith("_extra_"))).toBe(false);
  });

  it("KEEPS the offer to finish, which applying used to destroy", async () => {
    // 7 of 9 columns named leaves a MINORITY positional, so core
    // isHeaderlessCsv says no - and the chip used to ask exactly that question.
    // Both the button and the hint vanished with two columns still unnamed and
    // no route back to the dialog: a dead end reached by a normal action.
    const { store } = makeStore();
    const view = await mount(store);
    await pasteThenApply(
      view,
      "receive_time,serial,type,subtype,eventid,vsys,user",
    );

    expect(dialogs(view.container)).toHaveLength(0);
    expect(buttonLabels(view.container)).toContain("Name columns");
    // And the hint names a column really in THIS sample - `_0` is long since
    // named here, so illustrating with it would send the operator looking for
    // something that is not there.
    expect(view.container.textContent).toContain(
      "Some columns are still unnamed (_7 and so on)",
    );

    // And it really does re-open, on the same nine positions, with the seven
    // names already applied - the definition is finished, not redone.
    clickButton(view.container, "Name columns");
    expect(dialogTitle(view.container)).toBe(
      "Headerless CSV detected (9 columns)",
    );
  });

  it("stops offering once every column has a name", async () => {
    // The other half: "still unnamed" has to be distinguishable from "done", or
    // the affordance is just noise on every chip.
    const { store } = makeStore();
    const view = await mount(store);
    await pasteThenApply(view, "a,b,c,d,e,f,g,h,i");

    expect(chipFields(view.container, "PanAuth")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
    ]);
    expect(buttonLabels(view.container)).not.toContain("Name columns");
    expect(view.container.textContent).not.toContain(
      "Some columns are still unnamed",
    );
  });
});

// ---------------------------------------------------------------------------
// Provenance on the chip, and the undo the override notice implies
// ---------------------------------------------------------------------------

/** A solution name detectVendorIdentity resolves to "Palo Alto Networks". */
const PANOS_SOLUTION = "Palo Alto Networks PAN-OS";

const provenance = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".sample-chip-provenance")).map(
    (n) => n.textContent ?? "",
  );

/** Mount with a solution and a definition cache bound, and wait for the load. */
async function mountWithVendor(
  store: TaggedSampleStore,
  definitionCache: ContentCache,
) {
  const onSamplesChange = vi.fn();
  const view = render(
    <SampleIntakeSection
      store={store}
      solutionName={PANOS_SOLUTION}
      definitionCache={definitionCache}
      onSamplesChange={onSamplesChange}
    />,
  );
  await waitFor(() => {
    expect(onSamplesChange).toHaveBeenCalled();
  });
  return { ...view, onSamplesChange };
}

describe("SampleIntakeSection - where a chip's column names came from", () => {
  it("says so on the chip, not only inside the dialog", async () => {
    // THE DEFECT: the notice was passed to the dialog and nowhere else, so once
    // the dialog closed a sample named from a bundled dictionary, one named
    // from the operator's own stored order and one typed by hand from real
    // values were indistinguishable. A later reader seeing `receive_time / src
    // / dst` could not tell whether anyone ever confirmed those names against
    // values - which is the off-by-one the preview surface exists to expose.
    const { store } = makeStore();
    const cache = new FakeContentCache();
    const view = await mountWithVendor(store, cache);

    await paste(view.container, "TRAFFIC", PANOS.traffic);

    await waitFor(() => {
      expect(provenance(view.container)).toHaveLength(1);
    });
    expect(provenance(view.container)[0]).toContain(
      "Bundled Palo Alto Networks TRAFFIC column order",
    );
  });

  it("STAYS SILENT when the names did not come from that order", async () => {
    // A remembered or bundled order exists for the scope whether or not this
    // sample was ever named from it. Captioning a hand-typed sample with
    // somebody else's provenance is the same failure as inventing a name.
    const { store } = makeStore();
    const cache = new FakeContentCache();
    const view = await mountWithVendor(store, cache);

    // AUTH rows tagged as TRAFFIC: the scope resolves the bundled TRAFFIC
    // order, but these columns were never named from it.
    await paste(view.container, "TRAFFIC", PANOS.auth);
    clickButton(view.container, "Skip");
    expect(dialogs(view.container)).toHaveLength(0);
    // Columns still positional, nothing to attribute, so nothing is claimed.
    expect(chipFields(view.container, "TRAFFIC")[0]).toBe("_0");
    expect(provenance(view.container)).toEqual([]);

    // ...and the silence is about THIS SAMPLE, not about a missing scope:
    // replacing the chip's content with rows that really did come from that
    // order captions it, under the very same log type.
    await paste(view.container, "TRAFFIC", PANOS.traffic);
    await waitFor(() => {
      expect(provenance(view.container)).toHaveLength(1);
    });
  });

  it("wires FORGET, so a mistaken saved order can be taken back", async () => {
    // useVendorColumnOrder.forget was written, documented as "the way back from
    // a mistaken paste", and its only caller anywhere was its own test - while
    // the notice told the operator their order had REPLACED the bundled one.
    const { store } = makeStore();
    const cache = new FakeContentCache();
    const key = vendorFieldDefinitionKey(
      "Palo Alto Networks",
      "AUTH",
    ) as string;
    const mistake = buildVendorFieldDefinition("Palo Alto Networks", "AUTH", [
      "wrong_a",
      "wrong_b",
      "wrong_c",
    ]);
    await cache.set(key, mistake);

    const view = await mountWithVendor(store, cache);
    await paste(view.container, "AUTH", PANOS.auth);

    // The dialog opens pre-filled with the mistake, and says it is theirs.
    await waitFor(() => {
      expect(dialogs(view.container)).toHaveLength(1);
    });
    expect(
      view.container.querySelector(".csv-dialog-prefill")?.textContent,
    ).toContain("Your saved Palo Alto Networks AUTH column order");
    expect(dialogTextarea(view.container).value).toBe(
      "wrong_a\nwrong_b\nwrong_c",
    );

    await act(async () => {
      clickButton(view.container, "Forget my saved order");
    });

    // Gone from the store, and the dialog is back to knowing nothing about
    // AUTH - which is the honest state, since PAN-OS publishes no AUTH order.
    await waitFor(async () => {
      expect(await cache.get(key)).toBeNull();
    });
    expect(view.container.querySelector(".csv-dialog-prefill")).toBeNull();
    expect(dialogTextarea(view.container).value).toBe("");
  });
});
