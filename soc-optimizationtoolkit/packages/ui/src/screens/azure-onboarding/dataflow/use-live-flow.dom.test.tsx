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
  it("each run sends exactly one POST to the group's metrics query; lookback first, then the window", async () => {
    const { client, calls } = fakeCribl(() => rows(0));
    const { cap } = setup(client, true);
    await runOnce(cap);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", groupId: "g1", path: "/system/metrics/query" });
    expect(calls.map(earliestOf)).toEqual(["-24h"]);
    expect(cap.live?.lookbackStatus).toBe("answered");

    await runOnce(cap);
    expect(calls).toHaveLength(2);
    expect(calls.map(earliestOf)).toEqual(["-24h", "-300s"]);
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
    expect(calls.map(earliestOf)).toEqual(["-24h"]);
    expect(cap.live?.states?.entraId?.kind).toBe("idle");
    await runOnce(cap);
    expect(calls.map(earliestOf)).toEqual(["-24h", "-300s"]);
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
    expect(earliest).toEqual(["-24h", "-300s", "-300s", "-300s", "-300s", "-24h"]);
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
