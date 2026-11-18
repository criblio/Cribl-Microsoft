/**
 * useLiveFlow - the opt-in "Watch for data" reading of the onboarding diagram
 * (AZR-33, ADR 0007 D15).
 *
 * WHAT IT SPENDS. Nothing until the operator turns Watch on. While watching,
 * the document is visible, a worker group is known and at least one lane has a
 * Cribl source, it registers ONE poll with the shell's PollRegistry
 * ({@link LIVE_FLOW_POLL_ID}, every {@link LIVE_FLOW_INTERVAL_MS}, priority
 * {@link LIVE_FLOW_PRIORITY}); the shell's single budgeted
 * useConsolidatedPolling runs it. Any condition failing passes null, which
 * unregisters. This hook never starts a timer of its own.
 *
 * EACH RUN SENDS EXACTLY ONE REQUEST: core's nextFlowQuery picks the lookback
 * (cumulative over the last 24 hours) or the window (the last 300 seconds),
 * and readSourceFlow makes one leader-level POST /system/metrics/query, scoped
 * to the group in its where (AZR-95), that covers every lane. The lookback runs first; once it answers every run is a
 * window run; if it fails, the window runs and the lookback is retried every
 * 5th run until it answers.
 *
 * HONESTY (claude-kit standards/cribl-metrics.md). The lane states come from
 * core's classifyLaneFlow, so a refused read is "not measured: no permission"
 * and never 0, a missing row is never idle unless something measured the
 * input, and only "flowing" animates. The "as of" time is the UI's clock
 * (Date.now here, never in core).
 *
 * A lane whose source was created in another worker group than the one being
 * watched is "not measured: waiting", with the reason in its detail: the one
 * query only covers the watched group.
 *
 * LAST SEEN, REMEMBERED (AZR-37). With a `store`, turning Watch on reads ONE
 * app KV document (FLOW_LAST_SEEN_KEY) - never on mount - and a window answer
 * that MEASURED an input above zero records the time it arrived. A write is
 * due at most once per input per FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS, and is
 * a read-merge-write (per input, the later time) so another tab's times are
 * kept. A document that could not be read is never written over and never
 * shown as "never seen": its lanes say unknown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  FLOW_LAST_SEEN_KEY,
  FLOW_LOOKBACK,
  FLOW_WINDOW_SECONDS,
  classifyLaneFlow,
  describeFlowRequest,
  encodeFlowLastSeen,
  lastSeenFor,
  mergeFlowLastSeen,
  nextFlowQuery,
  readFlowLastSeen,
  readSourceFlow,
  recordFlowSeen,
  unmatchedInputLabels,
  windowSawInput,
  type CriblClient,
  type FlowAnswer,
  type FlowInput,
  type FlowLastSeen,
  type FlowLastSeenRead,
  type FlowQueryKind,
  type KvDocumentStore,
  type LaneFlowState,
  type LastSeenView,
  type Logger,
  type LookbackStatus,
  type OnboardingProgress,
  type OnboardingSourceId,
} from "@soc/core";

import { useRegisterPoll } from "../../../polling/poll-registry";
import { useDocumentVisible } from "../../../polling/use-document-visible";

export const LIVE_FLOW_POLL_ID = "azure-onboarding-flow";
export const LIVE_FLOW_INTERVAL_MS = 60_000;
export const LIVE_FLOW_PRIORITY = 5;

/** One lane the live flow measures: its source, its Cribl input, and the group it lives in. */
export interface LiveFlowLane {
  readonly sourceId: OnboardingSourceId;
  readonly input: FlowInput;
  readonly groupId: string;
}

/** Every lane with a created Cribl source, from the progress document. */
export function liveFlowLanes(progress: OnboardingProgress): LiveFlowLane[] {
  const out: LiveFlowLane[] = [];
  for (const [sourceId, record] of Object.entries(progress.criblSources)) {
    if (record === undefined) continue;
    out.push({
      sourceId: sourceId as OnboardingSourceId,
      input: { type: record.inputType, id: record.inputId },
      groupId: record.groupId,
    });
  }
  return out;
}

export interface UseLiveFlowOptions {
  readonly cribl: CriblClient;
  /** The worker group the one query asks; null or '' sends nothing. */
  readonly groupId: string | null;
  readonly lanes: readonly LiveFlowLane[];
  /** The operator's "Watch for data" toggle. */
  readonly watching: boolean;
  /** Clock override for tests; defaults to Date.now. */
  readonly now?: () => number;
  /** The app KV store, for the remembered last-seen times. Without it, every lane's last seen is unknown. */
  readonly store?: KvDocumentStore;
  readonly logger?: Logger;
}

export interface LiveFlowRequest {
  readonly method: "POST";
  readonly path: string;
  readonly body: string;
}

export interface LiveFlow {
  /** True while the poll is registered with the shell. */
  readonly polling: boolean;
  /** Lane states keyed by source; null while not watching. */
  readonly states: Readonly<Partial<Record<OnboardingSourceId, LaneFlowState>>> | null;
  readonly lookbackStatus: LookbackStatus;
  /** The query the last run sent, or null before any run. */
  readonly lastQuery: FlowQueryKind | null;
  /** When the last answer arrived (ms since the epoch, UI clock), or null. */
  readonly asOf: number | null;
  readonly windowSeconds: number;
  readonly lookback: string;
  /** The literal requests, for the (i): null without a worker group. */
  readonly requests: { readonly window: LiveFlowRequest | null; readonly lookback: LiveFlowRequest | null };
  /** Input labels in the last answer that matched no lane (shown in the (i)). */
  readonly unmatchedLabels: readonly string[];
  /** When each lane was last seen flowing, as remembered (AZR-37); null while not watching. */
  readonly lastSeen: Readonly<Partial<Record<OnboardingSourceId, LastSeenView>>> | null;
}

interface Readings {
  readonly windowAnswer: FlowAnswer | null;
  readonly lookbackAnswer: FlowAnswer | null;
  readonly lookbackStatus: LookbackStatus;
  readonly lookbackAsOf: string | undefined;
  /** Input keys (`type:id`) a window answer measured above zero this session. */
  readonly seen: ReadonlySet<string>;
  readonly lastQuery: FlowQueryKind | null;
  readonly asOf: number | null;
}

const NO_READINGS: Readings = {
  windowAnswer: null,
  lookbackAnswer: null,
  lookbackStatus: "pending",
  lookbackAsOf: undefined,
  seen: new Set(),
  lastQuery: null,
  asOf: null,
};

function inputKey(input: FlowInput): string {
  return `${input.type}:${input.id}`;
}

function answered(answer: FlowAnswer): boolean {
  return answer.kind === "rows" || answer.kind === "empty";
}

export function formatAsOf(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** A remembered last-seen time: date and time, since it may be days old. */
export function formatLastSeen(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function useLiveFlow({ cribl, groupId, lanes, watching, now = Date.now, store, logger }: UseLiveFlowOptions): LiveFlow {
  const visible = useDocumentVisible();
  const group = groupId ?? "";
  const [readings, setReadings] = useState<Readings>(NO_READINGS);

  // AZR-37: the remembered last-seen times. Null until Watch is first on.
  const [lastSeenRead, setLastSeenRead] = useState<FlowLastSeenRead | null>(null);
  const lastSeenRef = useRef<FlowLastSeenRead | null>(null);
  const lastSeenLoad = useRef<Promise<void> | null>(null);
  /** What the store held at the last read or write: the write throttle's reference. */
  const persistedRef = useRef<FlowLastSeen | null>(null);
  const setLastSeen = useCallback((next: FlowLastSeenRead) => {
    lastSeenRef.current = next;
    setLastSeenRead(next);
  }, []);
  useEffect(() => {
    if (!watching || store === undefined || lastSeenLoad.current !== null) return;
    lastSeenLoad.current = store
      .load(FLOW_LAST_SEEN_KEY)
      .then((load) => readFlowLastSeen(load))
      .catch((err: unknown): FlowLastSeenRead => ({ kind: "unknown", reason: err instanceof Error ? err.message : String(err) }))
      .then((read) => {
        if (!mounted.current) return;
        if (read.kind === "read") persistedRef.current = read.doc;
        // Times recorded while the load was in flight are kept.
        const held = lastSeenRef.current;
        setLastSeen(read.kind === "read" && held?.kind === "read" ? { kind: "read", doc: mergeFlowLastSeen(read.doc, held.doc) } : read);
      });
  }, [watching, store, setLastSeen]);

  /** Read-merge-write, so another tab's later times survive; never over an unreadable document. */
  const persistLastSeen = useCallback(
    async (doc: FlowLastSeen) => {
      if (store === undefined) return;
      try {
        const fresh = readFlowLastSeen(await store.load(FLOW_LAST_SEEN_KEY));
        if (fresh.kind === "unknown") {
          logger?.warn("live-flow: last-seen document unreadable; not written", { reason: fresh.reason });
          return;
        }
        const merged = mergeFlowLastSeen(fresh.doc, doc);
        await store.save(FLOW_LAST_SEEN_KEY, encodeFlowLastSeen(merged));
        persistedRef.current = merged;
        const held = lastSeenRef.current;
        if (mounted.current && held?.kind === "read") setLastSeen({ kind: "read", doc: mergeFlowLastSeen(held.doc, merged) });
      } catch (err) {
        logger?.warn("live-flow: last-seen time not saved", { error: err instanceof Error ? err.message : String(err) });
      }
    },
    [store, logger, setLastSeen],
  );
  const persistRef = useRef(persistLastSeen);
  persistRef.current = persistLastSeen;

  // The run reads the latest values through refs, so the registry keeps one
  // stable registration while props change.
  const latest = useRef({ cribl, group, lanes, now });
  latest.current = { cribl, group, lanes, now };
  const readingsRef = useRef(readings);
  readingsRef.current = readings;
  const runsSinceLookback = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const resetReadings = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    runsSinceLookback.current = 0;
    readingsRef.current = NO_READINGS;
    setReadings(NO_READINGS);
  }, []);

  // A new group, or Watch turned off, starts the measurement over (the
  // lookback re-runs). Hiding the tab only pauses it.
  useEffect(() => {
    resetReadings();
  }, [group, watching, resetReadings]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, []);

  const run = useCallback(async () => {
    const { cribl: client, group: g, lanes: current, now: clock } = latest.current;
    if (!g) return;
    const before = readingsRef.current;
    const kind = nextFlowQuery({
      lookback: before.lookbackStatus,
      runsSinceLookbackAttempt: runsSinceLookback.current + 1,
    });
    runsSinceLookback.current = kind === "lookback" ? 0 : runsSinceLookback.current + 1;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const answer = await readSourceFlow(client, g, kind, controller.signal);
    if (!mounted.current || controller.signal.aborted || latest.current.group !== g) return;
    if (inFlight.current === controller) inFlight.current = null;
    const at = clock();
    const prev = readingsRef.current;
    let next: Readings;
    if (kind === "lookback") {
      next = answered(answer)
        ? { ...prev, lookbackAnswer: answer, lookbackStatus: "answered", lookbackAsOf: formatAsOf(at), lastQuery: kind, asOf: at }
        : { ...prev, lookbackAnswer: answer, lookbackStatus: "failed", lastQuery: kind, asOf: at };
    } else {
      const seen = new Set(prev.seen);
      const flowing: FlowInput[] = [];
      for (const lane of current) {
        if (!windowSawInput(answer, lane.input)) continue;
        seen.add(inputKey(lane.input));
        flowing.push(lane.input);
      }
      next = { ...prev, windowAnswer: answer, seen, lastQuery: kind, asOf: at };
      // AZR-37: only a measured, non-zero window row is remembered, and only
      // into a document that was read (an unknown one is never overwritten).
      const held = lastSeenRef.current;
      if (flowing.length > 0 && held?.kind === "read") {
        const recorded = recordFlowSeen(held.doc, flowing, at, persistedRef.current ?? held.doc);
        setLastSeen({ kind: "read", doc: recorded.doc });
        if (recorded.due) void persistRef.current(recorded.doc);
      }
    }
    readingsRef.current = next;
    setReadings(next);
    // setLastSeen is stable, so the poll registration stays stable too.
  }, [setLastSeen]);

  const active = watching && visible && group !== "" && lanes.length > 0;
  useRegisterPoll(
    active ? { id: LIVE_FLOW_POLL_ID, intervalMs: LIVE_FLOW_INTERVAL_MS, priority: LIVE_FLOW_PRIORITY, run } : null,
  );

  const states = useMemo(() => {
    if (!watching) return null;
    const out: Partial<Record<OnboardingSourceId, LaneFlowState>> = {};
    for (const lane of lanes) {
      if (group !== "" && lane.groupId !== group) {
        out[lane.sourceId] = {
          kind: "not-measured",
          reason: "waiting",
          detail: `the source is in worker group ${lane.groupId}; this view watches ${group}`,
        };
        continue;
      }
      out[lane.sourceId] = classifyLaneFlow({
        input: lane.input,
        windowAnswer: readings.windowAnswer,
        lookbackAnswer: readings.lookbackAnswer,
        lookbackStatus: readings.lookbackStatus,
        seenInSession: readings.seen.has(inputKey(lane.input)),
        ...(readings.lookbackAsOf !== undefined ? { lookbackAsOf: readings.lookbackAsOf } : {}),
      });
    }
    return out;
  }, [watching, lanes, group, readings]);

  const requests = useMemo(
    () => ({ window: describeFlowRequest(group, "window"), lookback: describeFlowRequest(group, "lookback") }),
    [group],
  );

  const lastSeen = useMemo(() => {
    if (!watching) return null;
    const out: Partial<Record<OnboardingSourceId, LastSeenView>> = {};
    for (const lane of lanes) {
      out[lane.sourceId] =
        store === undefined
          ? { kind: "unknown", reason: "this build has no app storage to remember it in" }
          : lastSeenFor(lastSeenRead, lane.input);
    }
    return out;
  }, [watching, lanes, store, lastSeenRead]);

  const unmatchedLabels = useMemo(() => {
    const last = readings.lastQuery === "lookback" ? readings.lookbackAnswer : readings.windowAnswer;
    return last === null ? [] : unmatchedInputLabels(last, lanes.map((l) => l.input));
  }, [readings, lanes]);

  return {
    polling: active,
    states,
    lookbackStatus: readings.lookbackStatus,
    lastQuery: readings.lastQuery,
    asOf: readings.asOf,
    windowSeconds: FLOW_WINDOW_SECONDS,
    lookback: FLOW_LOOKBACK,
    requests,
    unmatchedLabels,
    lastSeen,
  };
}
