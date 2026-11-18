// @vitest-environment happy-dom
/**
 * Pins for useLiveFlow (AZR-33, ADR 0007 D15): zero calls until Watch is on,
 * one registration through the PollRegistry (never a timer of its own),
 * paused while the tab is hidden, exactly one metrics request per run, the
 * lookback-then-window sequence, and honest states (403 is "no permission",
 * a failed lookback is "lookback failed", never "waiting" or 0).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";

import {
  FLOW_LAST_SEEN_KEY,
  FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS,
  FakeKvDocumentStore,
  emptyProgress,
  withCriblSource,
  type CriblClient,
  type CriblRequest,
  type PortHttpResponse,
} from "@soc/core";

import { PollRegistryProvider, useMergedPolls } from "../../../polling/poll-registry";
import type { ConsolidatedPoll } from "../../../polling/use-consolidated-polling";
import {
  LIVE_FLOW_INTERVAL_MS,
  LIVE_FLOW_POLL_ID,
  LIVE_FLOW_PRIORITY,
  liveFlowLanes,
  useLiveFlow,
  type LiveFlow,
  type LiveFlowLane,
} from "./use-live-flow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

const ENTRA: LiveFlowLane = { sourceId: "entraId", input: { type: "eventhub", id: "azure_onb_eh_ns_hub" }, groupId: "g1" };
const LANES: readonly LiveFlowLane[] = [ENTRA];

type Responder = (opts: CriblRequest) => PortHttpResponse | Promise<PortHttpResponse>;

function fakeCribl(responder: Responder) {
  const calls: CriblRequest[] = [];
  const client: CriblClient = {
    request: vi.fn(async (opts: CriblRequest) => {
      calls.push(opts);
      return responder(opts);
    }),
    listGroups: vi.fn(async () => {
      throw new Error("listGroups must not be called");
    }),
  } as unknown as CriblClient;
  return { client, calls };
}

const rows = (n: number): PortHttpResponse => ({
  status: 200,
  body: { results: [{ input: "eventhub:azure_onb_eh_ns_hub", in_events: n, in_bytes: n * 100 }] },
});
const earliestOf = (c: CriblRequest): unknown => (c.body as { earliest?: unknown } | undefined)?.earliest;
const forbidden: PortHttpResponse = { status: 403, body: { message: "forbidden" } };

interface Captured {
  polls: readonly ConsolidatedPoll[];
  live: LiveFlow | null;
}

function Probe({ cap }: { cap: Captured }) {
  const polls = useMergedPolls(NO_POLLS);
  useEffect(() => {
    cap.polls = polls;
  });
  return null;
}
const NO_POLLS: readonly ConsolidatedPoll[] = [];

function Subject({
  cap,
  client,
  watching,
  groupId = "g1",
  lanes = LANES,
}: {
  cap: Captured;
  client: CriblClient;
  watching: boolean;
  groupId?: string | null;
  lanes?: readonly LiveFlowLane[];
}) {
  const live = useLiveFlow({ cribl: client, groupId, lanes, watching, now: () => 1_000 });
  cap.live = live;
  return null;
}

function setup(client: CriblClient, watching: boolean) {
  const cap: Captured = { polls: [], live: null };
  const view = render(
    <PollRegistryProvider duplicates="throw">
      <Probe cap={cap} />
      <Subject cap={cap} client={client} watching={watching} />
    </PollRegistryProvider>,
  );
  const rerender = (w: boolean, extra: { groupId?: string | null; lanes?: readonly LiveFlowLane[] } = {}) =>
    view.rerender(
      <PollRegistryProvider duplicates="throw">
        <Probe cap={cap} />
        <Subject cap={cap} client={client} watching={w} {...extra} />
      </PollRegistryProvider>,
    );
  return { cap, rerender, unmount: view.unmount };
}

async function runOnce(cap: Captured) {
  const poll = cap.polls.find((p) => p.id === LIVE_FLOW_POLL_ID);
  if (poll === undefined) throw new Error("no live-flow poll registered");
  await act(async () => {
    await poll.run();
  });
}

describe("useLiveFlow - registration", () => {
  it("registers nothing on mount or while not watching, and makes no Cribl call", () => {
    const { client, calls } = fakeCribl(() => rows(1));
    const { cap } = setup(client, false);
    expect(cap.polls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(cap.live?.states).toBeNull();
    expect(cap.live?.polling).toBe(false);
  });

  it("registers one poll while watching, at 60s and priority 5, and unregisters when Watch goes off", () => {
    const { client } = fakeCribl(() => rows(1));
    const { cap, rerender } = setup(client, true);
    expect(cap.polls.map((p) => [p.id, p.intervalMs, p.priority])).toEqual([
      [LIVE_FLOW_POLL_ID, LIVE_FLOW_INTERVAL_MS, LIVE_FLOW_PRIORITY],
    ]);
    expect([LIVE_FLOW_INTERVAL_MS, LIVE_FLOW_PRIORITY]).toEqual([60_000, 5]);
    rerender(false);
    expect(cap.polls).toHaveLength(0);
  });

  it("unregisters while the document is hidden and re-registers when it is visible", () => {
    const { client } = fakeCribl(() => rows(1));
    const { cap } = setup(client, true);
    expect(cap.polls).toHaveLength(1);
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(cap.polls).toHaveLength(0);
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(cap.polls).toHaveLength(1);
  });

  it("registers nothing without a worker group or without a lane", () => {
    const { client } = fakeCribl(() => rows(1));
    const { cap, rerender } = setup(client, true);
    rerender(true, { groupId: null });
    expect(cap.polls).toHaveLength(0);
    rerender(true, { groupId: "g1", lanes: [] });
    expect(cap.polls).toHaveLength(0);
  });

  it("starts no timer of its own", () => {
    const si = vi.spyOn(globalThis, "setInterval");
    const st = vi.spyOn(globalThis, "setTimeout");
    const { client } = fakeCribl(() => rows(1));
    const { rerender } = setup(client, true);
    rerender(false);
    rerender(true);
    expect(si).not.toHaveBeenCalled();
    expect(st).not.toHaveBeenCalled();
  });
});

describe("useLiveFlow - runs", () => {
  it("each run sends exactly one LEADER POST scoped to the group; lookback first, then the window", async () => {
    const { client, calls } = fakeCribl(() => rows(0));
    const { cap } = setup(client, true);
    await runOnce(cap);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/system/metrics/query" });
    expect(calls[0]!.groupId).toBeUndefined();
    expect((calls[0]!.body as { where: string }).where).toBe('__worker_group=="g1" && __dist_mode=="worker"');
    expect(calls.map(earliestOf)).toEqual(["86400s"]);
    expect(cap.live?.lookbackStatus).toBe("answered");

    await runOnce(cap);
    expect(calls).toHaveLength(2);
    expect(calls.map(earliestOf)).toEqual(["86400s", "300s"]);
    expect(cap.live?.lastQuery).toBe("window");
    expect(cap.live?.asOf).toBe(1_000);
  });

  it("data already arriving cannot read flowing on the first run: the lookback comes first, the window one interval later", async () => {
    // Recorded latency (ADR 0007 D15): the first run is always the 24h
    // lookback, which can only say "seen"; flowing needs the 300s window,
    // which first runs one interval (60s) after Watch is turned on.
    const { client, calls } = fakeCribl(() => rows(5));
    const { cap } = setup(client, true);
    await runOnce(cap);
    expect(calls.map(earliestOf)).toEqual(["86400s"]);
    expect(cap.live?.states?.entraId?.kind).toBe("idle");
    await runOnce(cap);
    expect(calls.map(earliestOf)).toEqual(["86400s", "300s"]);
    expect(cap.live?.states?.entraId).toEqual({ kind: "flowing", events: 5 });
  });

  it("a measured window row > 0 is flowing; a later 0 is idle (seen), never never-seen", async () => {
    let n = 0;
    const answers = [rows(0), rows(7), rows(0)];
    const { client } = fakeCribl(() => answers[n++] as PortHttpResponse);
    const { cap } = setup(client, true);
    await runOnce(cap); // lookback: row of 0 -> answered, not seen
    await runOnce(cap); // window 7
    expect(cap.live?.states?.entraId).toEqual({ kind: "flowing", events: 7 });
    await runOnce(cap); // window 0
    expect(cap.live?.states?.entraId?.kind).toBe("idle");
  });

  it("a lane measured flowing this session stays idle (seen) when a later window has no row, never never-seen", async () => {
    let n = 0;
    const answers: PortHttpResponse[] = [
      { status: 200, body: { results: [] } }, // lookback: answered, no row -> not seen in 24h
      rows(7), // window: flowing
      { status: 200, body: { results: [] } }, // window: no row for this input
    ];
    const { client } = fakeCribl(() => answers[n++] as PortHttpResponse);
    const { cap } = setup(client, true);
    await runOnce(cap);
    expect(cap.live?.lookbackStatus).toBe("answered");
    await runOnce(cap);
    expect(cap.live?.states?.entraId).toEqual({ kind: "flowing", events: 7 });
    await runOnce(cap);
    const third = cap.live?.states?.entraId;
    expect(third?.kind).not.toBe("never-seen");
    expect(third).toMatchObject({ kind: "idle", seenInSession: true });
  });

  it("a 403 reads 'no permission', never a zero", async () => {
    const { client } = fakeCribl(() => forbidden);
    const { cap } = setup(client, true);
    await runOnce(cap);
    expect(cap.live?.states?.entraId).toMatchObject({ kind: "not-measured", reason: "no-permission" });
  });

  it("after a failed lookback with no window row the lane reads 'lookback failed', not 'waiting'", async () => {
    let n = 0;
    const answers: PortHttpResponse[] = [{ status: 500, body: "boom" }, { status: 200, body: { results: [] } }];
    const { client, calls } = fakeCribl(() => answers[n++] ?? { status: 200, body: { results: [] } });
    const { cap } = setup(client, true);
    await runOnce(cap);
    expect(cap.live?.lookbackStatus).toBe("failed");
    await runOnce(cap);
    expect(cap.live?.states?.entraId).toMatchObject({ kind: "not-measured", reason: "lookback-failed" });
    // The lookback is retried on the 5th run after the failure.
    for (let i = 0; i < 4; i++) await runOnce(cap);
    const earliest = calls.map(earliestOf);
    expect(earliest).toEqual(["86400s", "300s", "300s", "300s", "300s", "86400s"]);
  });

  it("a lane in another worker group is not measured, and says why", async () => {
    const { client } = fakeCribl(() => rows(3));
    const { cap, rerender } = setup(client, true);
    rerender(true, { lanes: [{ ...ENTRA, groupId: "g2" }] });
    expect(cap.live?.states?.entraId).toMatchObject({ kind: "not-measured", reason: "waiting" });
    expect(JSON.stringify(cap.live?.states)).toContain("worker group g2");
  });

  it("turning Watch off drops the readings, so states are null again", async () => {
    const { client } = fakeCribl(() => rows(3));
    const { cap, rerender } = setup(client, true);
    await runOnce(cap);
    rerender(false);
    expect(cap.live?.states).toBeNull();
    expect(cap.live?.lookbackStatus).toBe("pending");
  });

  it("unmount aborts the in-flight run, and its late answer is dropped without a state update", async () => {
    let release: (r: PortHttpResponse) => void = () => undefined;
    const { client } = fakeCribl(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const err = vi.spyOn(console, "error");
    const { cap, unmount } = setup(client, true);
    const before = abort.mock.calls.length;
    const poll = cap.polls[0] as ConsolidatedPoll;
    const pending = poll.run();
    unmount();
    expect(abort.mock.calls.length).toBeGreaterThan(before);
    const last = cap.live;
    release(rows(1));
    await pending;
    expect(cap.live).toBe(last);
    expect(err).not.toHaveBeenCalled();
  });
});

// AZR-37: the remembered last-seen time is written only from a measured,
// non-zero window row, never over a document that could not be read, and an
// unreadable document is unknown - never "never seen".
describe("useLiveFlow - last seen, remembered", () => {
  const KEY = "g1/eventhub:azure_onb_eh_ns_hub";

  function setupWithStore(
    client: CriblClient,
    store: FakeKvDocumentStore,
    clock: { t: number },
    lanes: readonly LiveFlowLane[] = LANES,
  ) {
    const cap: Captured = { polls: [], live: null };
    function WithStore({ watching }: { watching: boolean }) {
      const live = useLiveFlow({ cribl: client, groupId: "g1", lanes, watching, now: () => clock.t, store });
      cap.live = live;
      return null;
    }
    const tree = (w: boolean) => (
      <PollRegistryProvider duplicates="throw">
        <Probe cap={cap} />
        <WithStore watching={w} />
      </PollRegistryProvider>
    );
    const view = render(tree(false));
    const watch = async () => {
      await act(async () => {
        view.rerender(tree(true));
      });
    };
    return { cap, watch };
  }
  const lastSeenLoads = (store: FakeKvDocumentStore) => store.loads.filter((k) => k === FLOW_LAST_SEEN_KEY).length;
  const lastSeenSaves = (store: FakeKvDocumentStore) => store.saves.filter((s) => s.key === FLOW_LAST_SEEN_KEY);
  const savedTimes = (store: FakeKvDocumentStore) =>
    (store.peek(FLOW_LAST_SEEN_KEY) as { byInput?: Record<string, number> } | undefined)?.byInput;

  it("reads nothing until Watch is on, then reads the document once", async () => {
    const store = new FakeKvDocumentStore();
    const { client } = fakeCribl(() => rows(0));
    const { cap, watch } = setupWithStore(client, store, { t: 1_000 });
    expect(store.loads).toEqual([]);
    expect(cap.live?.lastSeen).toBeNull();
    await watch();
    await runOnce(cap);
    expect(store.loads.filter((k) => k === FLOW_LAST_SEEN_KEY)).toEqual([FLOW_LAST_SEEN_KEY]);
    expect(cap.live?.lastSeen).toEqual({ entraId: { kind: "never" } });
  });

  it("writes the time only from a measured non-zero WINDOW row - never from the lookback or a zero row", async () => {
    const store = new FakeKvDocumentStore();
    let n = 7;
    const { client } = fakeCribl(() => rows(n));
    const clock = { t: 5_000 };
    const { cap, watch } = setupWithStore(client, store, clock);
    await watch();
    await runOnce(cap); // the lookback: 7 events in 24h, but no time
    expect(lastSeenSaves(store)).toEqual([]);
    n = 0;
    await runOnce(cap); // a window with a zero row
    expect(lastSeenSaves(store)).toEqual([]);
    expect(cap.live?.lastSeen).toEqual({ entraId: { kind: "never" } });
    n = 3;
    clock.t = 9_000;
    await runOnce(cap); // a window that measured events
    await act(async () => {});
    expect(lastSeenSaves(store)).toHaveLength(1);
    expect(savedTimes(store)).toEqual({ [KEY]: 9_000 });
    expect(cap.live?.lastSeen).toEqual({ entraId: { kind: "seen", at: 9_000 } });
  });

  it("writes at most once per input per interval, while still showing the newest time", async () => {
    const store = new FakeKvDocumentStore();
    const { client } = fakeCribl(() => rows(2));
    const clock = { t: 1_000 };
    const { cap, watch } = setupWithStore(client, store, clock);
    await watch();
    await runOnce(cap); // lookback
    await runOnce(cap); // window at 1s
    await act(async () => {});
    clock.t = 61_000;
    await runOnce(cap); // a minute later: shown, not written
    await act(async () => {});
    expect(lastSeenSaves(store)).toHaveLength(1);
    expect(cap.live?.lastSeen).toEqual({ entraId: { kind: "seen", at: 61_000 } });
    clock.t = 1_000 + FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS;
    await runOnce(cap);
    await act(async () => {});
    expect(lastSeenSaves(store)).toHaveLength(2);
    expect(savedTimes(store)).toEqual({ [KEY]: 1_000 + FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS });
  });

  it("keeps another tab's later time and other inputs when it writes", async () => {
    const store = new FakeKvDocumentStore({
      [FLOW_LAST_SEEN_KEY]: { kind: "soc.flow-last-seen", version: 1, byInput: { "eventhub:other": 50 } },
    });
    const { client } = fakeCribl(() => rows(2));
    const { cap, watch } = setupWithStore(client, store, { t: 4_000 });
    await watch();
    await runOnce(cap);
    // Another tab records a LATER time for this input before this one writes.
    await store.save(FLOW_LAST_SEEN_KEY, { kind: "soc.flow-last-seen", version: 1, byInput: { "eventhub:other": 50, [KEY]: 8_000 } });
    await runOnce(cap);
    await act(async () => {});
    expect(savedTimes(store)).toEqual({ "eventhub:other": 50, [KEY]: 8_000 });
  });

  it("an unreadable document is unknown, never 'never seen', and is never written over", async () => {
    const store = new FakeKvDocumentStore();
    store.scriptLoad(FLOW_LAST_SEEN_KEY, { kind: "unknown", reason: "HTTP 503", status: 503 });
    const { client } = fakeCribl(() => rows(4));
    const { cap, watch } = setupWithStore(client, store, { t: 2_000 });
    await watch();
    await runOnce(cap);
    await runOnce(cap);
    await act(async () => {});
    expect(lastSeenSaves(store)).toEqual([]);
    expect(cap.live?.lastSeen).toEqual({
      entraId: { kind: "unknown", reason: "the remembered times could not be read (HTTP 503)" },
    });
  });

  // Review round 2: a document that became unreadable after it was first read
  // (another tab or a newer release rewrote it) turns the lanes unknown at the
  // write, instead of leaving the older read on screen as "never seen".
  it("a document rewritten unreadable before a write turns every lane unknown, and is not written over", async () => {
    const elsewhere: LiveFlowLane = { sourceId: "activityLog", input: ENTRA.input, groupId: "g2" };
    const store = new FakeKvDocumentStore();
    const { client } = fakeCribl(() => rows(3));
    const { cap, watch } = setupWithStore(client, store, { t: 8_000 }, [ENTRA, elsewhere]);
    await watch();
    await runOnce(cap); // lookback, into the empty document that was read
    expect(cap.live?.lastSeen).toEqual({ entraId: { kind: "never" }, activityLog: { kind: "never" } });
    const newer = { kind: "soc.flow-last-seen", version: 2, byInput: {} };
    await store.save(FLOW_LAST_SEEN_KEY, newer);
    const savesBefore = lastSeenSaves(store).length;
    await runOnce(cap); // window: due, but the read before the write cannot decode it
    await act(async () => {});
    expect(lastSeenSaves(store)).toHaveLength(savesBefore);
    expect(store.peek(FLOW_LAST_SEEN_KEY)).toEqual(newer);
    const unknown = { kind: "unknown", reason: "the remembered times could not be read (it was written by a release this one cannot read)" };
    expect(cap.live?.lastSeen).toEqual({ entraId: unknown, activityLog: unknown });
  });

  // Review round 1 (AZR-37): a failed load is retried, a concurrent writer's
  // drop is repaired, another group's lane is never stamped, and a failing
  // store is not hammered once a minute.
  it("a load the store refused is read again on the next poll, and then records", async () => {
    const store = new FakeKvDocumentStore();
    store.scriptLoad(FLOW_LAST_SEEN_KEY, { kind: "unknown", reason: "HTTP 503", status: 503 });
    const { client } = fakeCribl(() => rows(4));
    const clock = { t: 3_000 };
    const { cap, watch } = setupWithStore(client, store, clock);
    await watch(); // the last-seen load answers 503
    expect(lastSeenLoads(store)).toBe(1);
    expect(cap.live?.lastSeen?.entraId).toMatchObject({ kind: "unknown" });
    store.clearScript();
    await runOnce(cap); // lookback: the poll reads the document again
    await act(async () => {});
    expect(lastSeenLoads(store)).toBe(2);
    expect(cap.live?.lastSeen).toEqual({ entraId: { kind: "never" } });
    clock.t = 70_000;
    await runOnce(cap); // window, now into a document that was read
    await act(async () => {});
    expect(savedTimes(store)).toEqual({ [KEY]: 70_000 });
  });

  it("a document read but not understood is not read again every poll", async () => {
    const store = new FakeKvDocumentStore({ [FLOW_LAST_SEEN_KEY]: { kind: "someone-else" } });
    const { client } = fakeCribl(() => rows(4));
    const { cap, watch } = setupWithStore(client, store, { t: 3_000 });
    await watch();
    await runOnce(cap);
    await runOnce(cap);
    await runOnce(cap);
    await act(async () => {});
    expect(lastSeenLoads(store)).toBe(1);
    expect(lastSeenSaves(store)).toEqual([]);
  });

  it("re-saves when another tab's save in the same instant dropped this tab's entry", async () => {
    const OTHER = "g1/eventhub:other";
    class RacingStore extends FakeKvDocumentStore {
      raced = false;
      override async save(key: string, value: unknown): Promise<void> {
        await super.save(key, value);
        if (key === FLOW_LAST_SEEN_KEY && !this.raced) {
          this.raced = true;
          // The other tab loaded {} before this save and saves only its own entry after it.
          await super.save(key, { kind: "soc.flow-last-seen", version: 1, byInput: { [OTHER]: 6_000 } });
        }
      }
    }
    const store = new RacingStore();
    const { client } = fakeCribl(() => rows(2));
    const { cap, watch } = setupWithStore(client, store, { t: 5_000 });
    await watch();
    await runOnce(cap); // lookback
    await runOnce(cap); // window: due, write, raced
    await act(async () => {});
    expect(savedTimes(store)).toEqual({ [KEY]: 5_000, [OTHER]: 6_000 });
    expect(lastSeenSaves(store)).toHaveLength(3);
  });

  it("never stamps a lane in another worker group from the watched group's window", async () => {
    const elsewhere: LiveFlowLane = { sourceId: "activityLog", input: ENTRA.input, groupId: "g2" };
    const store = new FakeKvDocumentStore();
    const { client } = fakeCribl(() => rows(3));
    const { cap, watch } = setupWithStore(client, store, { t: 8_000 }, [ENTRA, elsewhere]);
    await watch();
    await runOnce(cap);
    await runOnce(cap);
    await act(async () => {});
    expect(savedTimes(store)).toEqual({ [KEY]: 8_000 });
    expect(cap.live?.lastSeen).toEqual({ entraId: { kind: "seen", at: 8_000 }, activityLog: { kind: "never" } });
  });

  it("a failing save is not tried again until the interval has passed", async () => {
    const store = new FakeKvDocumentStore();
    store.failSaves();
    const { client } = fakeCribl(() => rows(2));
    const clock = { t: 1_000 };
    const { cap, watch } = setupWithStore(client, store, clock);
    await watch();
    await runOnce(cap); // lookback
    await runOnce(cap); // window: one attempt (load + failed save)
    await act(async () => {});
    expect(lastSeenLoads(store)).toBe(2);
    for (let i = 1; i <= 5; i++) {
      clock.t = 1_000 + i * 60_000;
      await runOnce(cap);
      await act(async () => {});
    }
    expect(lastSeenLoads(store)).toBe(2);
    store.failSaves(null);
    clock.t = 1_000 + FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS;
    await runOnce(cap);
    await act(async () => {});
    expect(savedTimes(store)).toEqual({ [KEY]: 1_000 + FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS });
  });
});

describe("liveFlowLanes", () => {
  it("lists every created Cribl source with its input and group", () => {
    const p = withCriblSource(emptyProgress(), "entraId", {
      groupId: "g1",
      inputId: "azure_onb_eh_ns_hub",
      inputType: "eventhub",
      secretId: "s1",
    });
    expect(liveFlowLanes(p)).toEqual([ENTRA]);
    expect(liveFlowLanes(emptyProgress())).toEqual([]);
  });
});
