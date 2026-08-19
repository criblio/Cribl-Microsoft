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
export function extractCapturedEvents(body: unknown): string[] {
  const lines: string[] = [];

  const pushRecord = (record: unknown): void => {
    const raw = readString(record, "_raw");
    if (raw !== undefined) {
      lines.push(raw);
      return;
    }
    if (typeof record === "string") {
      if (record.trim() !== "") lines.push(record);
      return;
    }
    if (record !== null && typeof record === "object") {
      lines.push(JSON.stringify(record));
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
        lines.push(trimmed);
      }
    }
    return lines;
  }

  const items = criblEnvelopeItems(body);
  if (items !== null) {
    for (const item of items) pushRecord(item);
  }
  return lines;
}

/** Clamp a requested bound into the API's accepted range. */
function clampMaxEvents(requested: number | undefined): {
  value: number;
  note?: string;
} {
  if (requested === undefined) return { value: DEFAULT_MAX_EVENTS };
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
  const duration = Math.max(
    1,
    Math.floor(options.durationSeconds ?? DEFAULT_DURATION_SECONDS),
  );

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
          ? " - Cribl rejected the filter expression; its message is above"
          : "";
    notes.push(`The capture returned HTTP ${status}${hint}. ${detail ?? ""}`.trim());
    return empty(false);
  }

  const rawEvents = extractCapturedEvents(body);
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
