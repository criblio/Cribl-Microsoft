/**
 * Elastic integrations test-file parsing and event unwrapping - porting-plan
 * Unit 16 (ENG-19). Ported verbatim from legacy sample-resolver.ts.
 *
 * Two pure concerns, both load-bearing for the elastic tier:
 * 1. parseElasticFileContent - the 6-FORMAT CASCADE that turns one raw test file
 *    into individual event strings. Elastic test data appears as: a JSON array,
 *    a single wrapper object ({"events":[...]}), true NDJSON, concatenated
 *    pretty-printed JSON objects, or plain text (syslog/CEF/KV/CSV one per line).
 *    The branch order is the contract.
 * 2. unwrapElasticEvents / extractInnerEvent - strips the vendor envelopes that
 *    hide the real fields: an {"events":[...]} array wrapper, an object/`data`/
 *    `result`/`payload` wrapper (used only when the inner object is field-richer
 *    than the outer), the FILEBEAT MESSAGE ENVELOPE (the real log line is the
 *    `message` string), and ECS/Filebeat NOISE-FIELD removal (@timestamp, log,
 *    tags, input, agent, ecs, host, fileset, service, observer, _metadata).
 *
 * The legacy logged each swallowed parse error; here those become silent
 * keep-as-is branches (pure core has no logger), preserving the OUTPUT contract.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/**
 * Parse one Elastic test file's content into individual event strings, trying
 * each known shape in order (verbatim from legacy `parseElasticFileContent`):
 *   1. JSON array
 *   2. single JSON object (possibly {"events":[...]})
 *   3. true NDJSON (every line parses)
 *   4. concatenated pretty-printed objects (split on `\n{`)
 *   5. plain text, one event per line
 */
export function parseElasticFileContent(
  content: string,
  fileName: string,
): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // Try 1: JSON array.
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
      }
    } catch {
      // Starts with "[" but not a valid array; keep probing.
    }
  }

  // Try 2: single JSON object (may be a {"events":[...]} wrapper).
  if (trimmed.startsWith("{") && fileName.endsWith(".json")) {
    try {
      const parsed = JSON.parse(trimmed) as { events?: unknown };
      if (Array.isArray(parsed.events)) {
        return parsed.events.map((e: unknown) =>
          typeof e === "string" ? e : JSON.stringify(e),
        );
      }
      return [JSON.stringify(parsed)];
    } catch {
      // Not a single valid object; keep probing.
    }
  }

  // Try 3: NDJSON or concatenated pretty-printed JSON.
  if (trimmed.startsWith("{")) {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    let allJson = true;
    const ndjsonEvents: string[] = [];
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      try {
        JSON.parse(l);
        ndjsonEvents.push(l);
      } catch {
        allJson = false;
        break;
      }
    }
    if (allJson && ndjsonEvents.length > 0) return ndjsonEvents;

    // Not simple NDJSON: split on top-level object boundaries.
    const chunks = trimmed.split(/\n(?=\{)/);
    const prettyEvents: string[] = [];
    for (const chunk of chunks) {
      try {
        const obj = JSON.parse(chunk.trim());
        prettyEvents.push(JSON.stringify(obj));
      } catch {
        // Skip an unparseable chunk.
      }
    }
    if (prettyEvents.length > 0) return prettyEvents;
  }

  // Try 4: plain text (syslog, CEF, KV, CSV) - one event per line.
  return trimmed.split("\n").filter((l) => l.trim());
}

/**
 * Extract the inner event from a wrapper object, or null when the "inner event"
 * is a raw string (a Filebeat `message`) the caller should use as-is. Ported
 * verbatim from legacy `extractInnerEvent`.
 */
export function extractInnerEvent(
  obj: Record<string, unknown>,
): Record<string, unknown> | null {
  // Object wrapper fields carrying the real event.
  const objectWrapperFields = ["event", "data", "result", "payload"];
  for (const field of objectWrapperFields) {
    const val = obj[field];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const innerKeys = Object.keys(val as Record<string, unknown>);
      const outerKeys = Object.keys(obj).filter((k) => k !== field);
      if (innerKeys.length > outerKeys.length) {
        return val as Record<string, unknown>;
      }
    }
  }

  // Filebeat envelope: the real event is the `message` string.
  if (typeof obj.message === "string" && obj.message.length > 10) {
    const msg = obj.message;
    try {
      const parsed = JSON.parse(msg);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not embedded JSON; fall through to signal raw-message use.
    }
    return null; // caller uses the raw message string directly
  }

  // No obvious wrapper: remove noisy Filebeat/ECS object fields.
  const cleaned: Record<string, unknown> = { ...obj };
  const noiseFields = [
    "@timestamp",
    "log",
    "tags",
    "input",
    "agent",
    "ecs",
    "host",
    "fileset",
    "service",
    "observer",
    "_metadata",
  ];
  let removed = 0;
  for (const noise of noiseFields) {
    if (noise in cleaned && typeof cleaned[noise] === "object") {
      delete cleaned[noise];
      removed++;
    }
  }
  if (removed > 0 && Object.keys(cleaned).length >= 3) {
    return cleaned;
  }

  return obj;
}

/**
 * Unwrap nested event structures common in Elastic test samples so field
 * mapping sees real vendor fields. Ported verbatim from legacy
 * `unwrapElasticEvents`: expands {"events":[...]} array wrappers, applies
 * {@link extractInnerEvent} per event, and preserves the raw Filebeat `message`
 * line when that is the true event. Non-JSON lines pass through untouched.
 */
export function unwrapElasticEvents(rawEvents: readonly string[]): string[] {
  const unwrapped: string[] = [];

  for (const raw of rawEvents) {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      unwrapped.push(raw); // not JSON, keep as-is
      continue;
    }

    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      unwrapped.push(raw);
      continue;
    }

    const record = obj as Record<string, unknown>;

    // Pattern 1: {"events":[...]} array wrapper - expand to individual events.
    if (Array.isArray(record.events)) {
      for (const evt of record.events) {
        if (typeof evt === "object" && evt !== null) {
          const evtRecord = evt as Record<string, unknown>;
          const inner = extractInnerEvent(evtRecord);
          if (inner === null && typeof evtRecord.message === "string") {
            unwrapped.push(evtRecord.message);
          } else if (inner) {
            unwrapped.push(JSON.stringify(inner));
          } else {
            unwrapped.push(JSON.stringify(evt));
          }
        } else {
          unwrapped.push(typeof evt === "string" ? evt : JSON.stringify(evt));
        }
      }
      continue;
    }

    // Pattern 2: envelope with an inner event object or raw message string.
    const inner = extractInnerEvent(record);
    if (inner === null && typeof record.message === "string") {
      unwrapped.push(record.message);
    } else if (inner) {
      unwrapped.push(JSON.stringify(inner));
    } else {
      unwrapped.push(raw);
    }
  }

  return unwrapped;
}

/**
 * Derive a human-readable log type from an Elastic test filename. Ported
 * verbatim from legacy `logTypeFromFilename`:
 * "test-panw-panos-traffic-sample.log" -> "traffic".
 */
export function logTypeFromFilename(fileName: string, packageName: string): string {
  let name = fileName
    .replace(/\.[^.]+$/, "") // remove extension
    .replace(/^test[-_]/, "") // remove "test-" prefix
    .replace(/[-_]sample$/, ""); // remove "-sample" suffix
  const pkgParts = packageName.split(/[_-]/);
  for (const part of pkgParts) {
    name = name.replace(new RegExp(`^${part}[-_]?`, "i"), "");
  }
  return name || "default";
}
