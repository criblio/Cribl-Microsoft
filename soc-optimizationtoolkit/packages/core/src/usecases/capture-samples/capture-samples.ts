/**
 * capture-samples - run one bounded Cribl capture and split what comes back
 * into per-log-type samples (sample-acquisition plan Phase 4, ADR 0003).
 *
 *     POST /m/{groupId}/system/capture
 *     {filter, level: 0, maxEvents, duration}
 *     -> application/x-ndjson stream of captured events
 *
 * BOUNDED BY CONSTRUCTION. `maxEvents` and `duration` both terminate the
 * capture, so the request cannot hang and cannot pull an unbounded volume. The
 * defaults here are deliberately small: this is a SAMPLE, and the operator can
 * raise them.
 *
 * LEVEL 0 - captured at the SOURCE, before any pipeline runs. That is the whole
 * point: the samples drive pipeline generation, so they must be what arrives,
 * not what a pipeline already shaped.
 *
 * NDJSON, NOT JSON. The response is a stream of one event per line and the port
 * hands it over as a STRING (readPortBody JSON.parses and falls back to raw
 * text). Parsing it whole with JSON.parse is the mistake the cribl-api notes
 * call out; it is split by line here.
 *
 * Never throws for a capture that returns nothing - an empty capture is a
 * RESULT, and one the operator needs stated plainly rather than as an error.
 */

import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import { criblEnvelopeItems, readString } from "../../domain/cribl-api/envelope";
import {
  splitFoundNoDiscriminator,
  splitSamplesByLogType,
} from "../../domain/sample-parsing/splitting";
import { detectCaptureInnerFormat } from "../../domain/sample-parsing/format-detection";
import type { SampleFormat, SplitSample } from "../../domain/sample-parsing/models";

/** The capture endpoint, in a worker-group context. */
export const SYSTEM_CAPTURE_PATH = "/system/capture";

/** Capture bounds. Small on purpose - this is a sample, not an export. */
export const DEFAULT_MAX_EVENTS = 100;
export const DEFAULT_DURATION_SECONDS = 10;
/**
 * The longest capture window an operator may ask for.
 *
 * THIS WAS 12 SECONDS AND THE REASON WAS TRUE BUT NOT STRUCTURAL (AZR-18).
 * The 2026-08-20 bug-hunt found that a capture holds the response open for its
 * whole duration while the cloud adapter's fetch gave up at 15s, so a 30s
 * capture ALWAYS failed - and failed by blaming the platform bridge for a
 * capture that had run perfectly server-side. Capping at 12 made the app honest.
 * It also made a 10-minute capture impossible, which is what an operator asked
 * for on 2026-09-04.
 *
 * The 15s was never a PLATFORM limit. platform/http.ts says so in its own
 * header: the locked bridge ignores AbortSignal and a DETACHED bridge never
 * settles, so "there is no platform timeout to save us" - the client-side race
 * exists to catch a DEAD bridge, not to bound a legitimately slow call. One
 * guard for every product API call meant the slowest legitimate call set the
 * ceiling for all of them.
 *
 * So the wait is now stated per request ({@link CriblRequest.timeoutMs}) and
 * this ceiling is a product decision rather than a transport artifact: ten
 * minutes, which is what was asked for and long enough that a source with any
 * traffic will have produced samples.
 *
 * NOT VERIFIED ABOVE ~12s AT THE TIME OF THE CHANGE, and said plainly rather
 * than discovered later: the client no longer gives up, and the platform
 * imposes no timeout on the product API that this repo has measured - but a
 * held connection can still be closed by something between the browser and the
 * leader that nobody here has probed. If a long capture fails, the note the
 * caller gets names the transport, and that is the thing to measure next.
 */
export const MAX_DURATION_SECONDS = 600;

/**
 * Headroom added to the capture window to get the request's timeout: the
 * capture runs for `duration`, then the response still has to come back.
 *
 * Deliberately generous. Being slightly too patient costs an operator who is
 * already waiting out their own capture window a few extra seconds; being too
 * impatient reports a transport failure for a capture that SUCCEEDED, which is
 * the exact defect this constant exists to stop repeating.
 */
export const CAPTURE_TIMEOUT_HEADROOM_MS = 20000;
/** The API's own ceiling (CaptureParamsReq.maxEvents maximum). */
export const MAX_EVENTS_LIMIT = 10000;

/** Options for {@link captureSamples}. */
export interface CaptureSamplesOptions {
  /** Worker group hosting the source. */
  groupId: string;
  /** The composed filter expression (see domain/capture-filter). */
  filter: string;
  /** How many events to capture; clamped to the API's 1..10000. */
  maxEvents?: number;
  /** How long to hold the capture open, in seconds. */
  durationSeconds?: number;
}

/** What one capture produced. */
export interface CaptureSamplesResult {
  /** Per-log-type splits, ready to tag. Empty when nothing was captured. */
  splits: SplitSample[];
  /** Raw event lines exactly as captured, before splitting. */
  rawEvents: string[];
  /** The format detected from the captured content, never declared. */
  format: SampleFormat;
  /**
   * True when the splitter found NO discriminator, so `splits` is one
   * undifferentiated group rather than real log types.
   *
   * Surfaced rather than swallowed: route-value-discriminator.ts already refuses
   * to emit a match-all route silently one step later, and the operator is much
   * better placed to name the log type now, while they still remember what they
   * captured.
   */
  noDiscriminator: boolean;
  /** Operator-facing notes: an empty capture, a clamped bound, an HTTP error. */
  notes: string[];
  /** False when the request itself failed - `notes` says why. */
  ok: boolean;
}

/** What a capture body yielded: the usable lines, and what was set aside. */
export interface CapturedEvents {
  /** The event lines to split and tag. */
  lines: string[];
  /**
   * Records with NO `_raw` that were left out because raw-bearing ones existed.
   * Reported so the count the operator sees matches what they get.
   */
  droppedHusks: number;
}

/**
 * Pull the raw event lines out of a capture response.
 *
 * THREE SHAPES, because the platform is not consistent about this: the
 * documented NDJSON stream (a string of one JSON object per line), an
 * already-parsed array when the bridge decided the body was JSON, and the
 * `{count, items}` envelope some leaders wrap it in. Each line is returned as
 * the raw vendor bytes where the event carries `_raw`, and as the serialized
 * event otherwise.
 */
export function extractCapturedEvents(body: unknown): CapturedEvents {
  const withRaw: string[] = [];
  const husks: string[] = [];

  const pushRecord = (record: unknown): void => {
    const raw = readString(record, "_raw");
    if (raw !== undefined) {
      withRaw.push(raw);
      return;
    }
    if (typeof record === "string") {
      if (record.trim() !== "") withRaw.push(record);
      return;
    }
    if (record !== null && typeof record === "object") {
      husks.push(JSON.stringify(record));
    }
  };

  if (typeof body === "string") {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        pushRecord(JSON.parse(trimmed));
      } catch {
        // Not JSON - a capture of a plain text stream. Keep the line as-is.
        withRaw.push(trimmed);
      }
    }
    return settle(withRaw, husks);
  }

  const items = criblEnvelopeItems(body);
  if (items !== null) {
    for (const item of items) pushRecord(item);
    return settle(withRaw, husks);
  }

  // ONE EVENT arrives as a BARE OBJECT, not a list (2026-08-20 bug-hunt).
  // The cloud adapter's readPortBody JSON.parses the WHOLE body, so a
  // single-line NDJSON response parses cleanly into an object and never reaches
  // the string branch above. criblEnvelopeItems then answers null for it, and a
  // perfectly good one-event capture was reported as "returned no events" -
  // sending the operator to widen a filter that was already correct.
  //
  // Two events behave differently: two lines are not valid JSON, so the body
  // stays a string. That asymmetry is exactly why the fixtures missed this -
  // they build a string a real single-event response can never be.
  // searchResultRows already had this branch; this is the same treatment.
  if (body !== null && typeof body === "object") {
    pushRecord(body);
  }
  return settle(withRaw, husks);
}

/**
 * Decide what the captured LINES are, given the two kinds of record seen.
 *
 * RAW-BEARING RECORDS WIN OUTRIGHT when there are any. Mixing a serialized
 * husk into a list of vendor text breaks the split downstream:
 * splitSamplesByLogType only reaches its CSV/PAN-OS fallback when NOTHING
 * parses as JSON, so one husk - a keepalive, a metric, an internal event with
 * no `_raw` - suppresses the fallback and collapses a clean TRAFFIC/THREAT
 * split into one undifferentiated group. The operator is then invited to name
 * it, and names it after whichever type they recognise, mislabelling the rest
 * in the store that drives route and pipeline generation.
 *
 * Husks are used only when NO record carried a payload, which is the
 * structured-source case where serializing really is the best available answer.
 */
function settle(withRaw: string[], husks: string[]): CapturedEvents {
  if (withRaw.length > 0) {
    return { lines: withRaw, droppedHusks: husks.length };
  }
  return { lines: husks, droppedHusks: 0 };
}

/** Clamp a requested bound into the API's accepted range. */
function clampMaxEvents(requested: number | undefined): {
  value: number;
  note?: string;
} {
  if (requested === undefined || !Number.isFinite(requested)) {
    // NaN reached the wire as {"maxEvents":null} and a note reading "adjusted
    // to NaN". The sibling clamp in query-lake-samples already guarded this.
    return { value: DEFAULT_MAX_EVENTS };
  }
  const value = Math.min(Math.max(Math.floor(requested), 1), MAX_EVENTS_LIMIT);
  if (value !== requested) {
    return {
      value,
      note: `Event count adjusted to ${value} - the capture API accepts 1 to ${MAX_EVENTS_LIMIT}.`,
    };
  }
  return { value };
}

/**
 * Run one capture and split the result by log type.
 *
 * The split reuses {@link splitSamplesByLogType} - the same discriminator logic
 * a mixed upload goes through - so a capture and an upload of the same events
 * produce the same log types. That equivalence is why the splitter survived the
 * browser's removal.
 */
export async function captureSamples(
  cribl: CriblClient,
  options: CaptureSamplesOptions,
  logger?: Logger,
): Promise<CaptureSamplesResult> {
  const notes: string[] = [];
  const bounded = clampMaxEvents(options.maxEvents);
  if (bounded.note !== undefined) notes.push(bounded.note);
  const requestedDuration = options.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const duration = Number.isFinite(requestedDuration)
    ? Math.min(Math.max(Math.floor(requestedDuration), 1), MAX_DURATION_SECONDS)
    : DEFAULT_DURATION_SECONDS;
  if (Number.isFinite(requestedDuration) && duration !== requestedDuration) {
    // SAID, not silent. A clamped duration changes how much the operator gets,
    // and the empty-capture note below tells them to "try a longer capture" -
    // advice that would be actively wrong if we had quietly shortened it.
    notes.push(
      // The reason CHANGED with the ceiling and the sentence had to change with
      // it. It used to say the platform bridge gives up after this many seconds,
      // which was true of the old 12s cap and is not true of this one: the wait
      // now follows the requested window, so the cap is a product choice about
      // how long an operator should sit on one screen, not a transport limit.
      // Leaving the old wording would have been a comment arguing from a premise
      // its own change removed.
      `Capture window adjusted to ${duration}s, the longest this app will hold a capture open.`,
    );
  }

  const empty = (ok: boolean): CaptureSamplesResult => ({
    splits: [],
    rawEvents: [],
    format: "unknown",
    noDiscriminator: false,
    notes,
    ok,
  });

  let status: number;
  let body: unknown;
  try {
    const response = await cribl.request({
      method: "POST",
      path: SYSTEM_CAPTURE_PATH,
      groupId: options.groupId,
      body: {
        filter: options.filter,
        // At the SOURCE, before pipelines - the samples must be what arrives.
        level: 0,
        maxEvents: bounded.value,
        duration,
      },
      // The wait FOLLOWS the window the operator asked for. Without this the
      // adapter's short default applied, so the capture window could never
      // exceed it and the ceiling was 12 seconds - see MAX_DURATION_SECONDS.
      // Derived rather than a constant, so raising the ceiling cannot leave the
      // timeout behind and reintroduce "the bridge gave up on a capture that
      // ran".
      timeoutMs: duration * 1000 + CAPTURE_TIMEOUT_HEADROOM_MS,
    });
    status = response.status;
    body = response.body;
  } catch (err) {
    logger?.warn("capture-samples: request failed", { error: String(err) });
    notes.push(
      `The capture request failed: ${String(err)}. Nothing was captured; uploading a sample still works.`,
    );
    return empty(false);
  }

  if (status < 200 || status >= 300) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    const hint =
      status === 403 || status === 401
        ? " - the app's credentials may not carry capture permission on this group"
        : status === 400
          ? " - either the filter expression was rejected, or no worker nodes are connected to this group (the documented 400); Cribl's own message is above"
          : "";
    notes.push(`The capture returned HTTP ${status}${hint}. ${detail ?? ""}`.trim());
    return empty(false);
  }

  const captured = extractCapturedEvents(body);
  const rawEvents = captured.lines;
  if (captured.droppedHusks > 0) {
    notes.push(
      `${captured.droppedHusks} captured event(s) carried no raw payload and were left out, so they could not confuse the log-type split.`,
    );
  }
  if (rawEvents.length === 0) {
    // A RESULT, not an error, and the likeliest causes are worth naming: the
    // filter matched nothing, or nothing flowed during the window.
    notes.push(
      `The capture ran but matched no events in ${duration}s. Either the filter matches nothing on this source, or the source was idle - try a longer capture, or remove the log-type filter to see what it does send.`,
    );
    return empty(true);
  }

  // Format from the CONTENT, never declared - the same rule the intake path
  // follows. A capture wraps vendor bytes, so this reads the inner form.
  const format = detectCaptureInnerFormat(rawEvents);
  const splits = splitSamplesByLogType(rawEvents, "captured", format);
  const noDiscriminator = splitFoundNoDiscriminator(splits, "captured");
  if (noDiscriminator) {
    notes.push(
      "No field in these events distinguishes one log type from another, so they are offered as a single sample. Name it yourself if you know what it is.",
    );
  }

  logger?.info("capture-samples: captured", {
    events: rawEvents.length,
    format,
    splits: splits.length,
    noDiscriminator,
  });
  return { splits, rawEvents, format, noDiscriminator, notes, ok: true };
}
