/**
 * When each onboarding source's Cribl input was LAST SEEN FLOWING, remembered
 * beyond the metrics lookback (AZR-37).
 *
 * WHY. The live flow (flow-state.ts) reads Cribl's own metrics: a 300-second
 * window and a cumulative 24-hour lookback. A source that last delivered three
 * days ago reads "never seen in the last 24 hours" - true, and less useful than
 * "last seen 3 days ago". Cribl keeps no such timestamp the app can read, so
 * the app remembers one.
 *
 * WHAT IS WRITTEN, AND WHEN. Only a MEASURED, NON-ZERO window row writes
 * (windowSawInput): never a lookback (cumulative, so it carries no time),
 * never an idle or zero row, never a refused, failed or unreadable answer. The
 * time written is the caller's clock when that window answer arrived, so it
 * means "events arrived in the five minutes before this". A later time only
 * ever replaces an earlier one (merge is per input, max), so two tabs whose
 * writes do not overlap converge. The KV store has no compare-and-swap: two
 * tabs saving in the same instant each save only what they loaded, and the
 * later save drops the other's newer entry. The hook narrows that with one
 * re-read after each save (re-saving the merge when an entry it wrote is
 * missing or older), and an entry still lost is rewritten on that tab's next
 * due write while the source keeps flowing.
 *
 * WHAT IS SHOWN. Three answers, never a fourth:
 *   - seen     a remembered time, labelled as remembered, not measured now;
 *   - never    the document was READ and holds nothing for this input - which
 *              says only that this app never saw it flowing while watching;
 *   - unknown  the document could not be read, or holds a value this release
 *              cannot decode. An unreadable document is NEVER read as empty:
 *              that would claim "never seen" for a source that may have
 *              flowed yesterday.
 *
 * WHERE. Its own app KV document, keyed by worker group and Cribl input
 * (`group/type:id`), not a field on the onboarding progress document: the
 * progress document is saved whole by the screen, so a background write into
 * it from the flow poll would race the operator's own saves and could undo
 * one. The group is part of the key because the same input id can exist in
 * two worker groups (a source created again in another group), and a window
 * answer only measures the group it asked; one app-wide document then serves
 * every tenant.
 *
 * Pure: no IO, no clock (the caller passes every time).
 */

import type { KvDocumentLoad } from "../../ports/kv-document-store";
import type { FlowInput } from "./flow-state";

/** The app KV key of the document. */
export const FLOW_LAST_SEEN_KEY = "azure-onboarding-flow-last-seen";

const KIND = "soc.flow-last-seen";
const VERSION = 1;

/** One Cribl input in the worker group it lives in: what a remembered time is about. */
export interface LastSeenSource {
  readonly groupId: string;
  readonly input: FlowInput;
}

/** Epoch ms each input (by {@link flowInputKey}) was last measured flowing. */
export interface FlowLastSeen {
  readonly byInput: Readonly<Record<string, number>>;
}

/** The document as loaded: understood (possibly empty), or unknown with the reason. */
export type FlowLastSeenRead =
  | { readonly kind: "read"; readonly doc: FlowLastSeen }
  | { readonly kind: "unknown"; readonly reason: string };

/** What one lane shows. */
export type LastSeenView =
  | { readonly kind: "seen"; readonly at: number }
  | { readonly kind: "never" }
  | { readonly kind: "unknown"; readonly reason: string };

export const EMPTY_FLOW_LAST_SEEN: FlowLastSeen = { byInput: {} };

/**
 * The keys of `wrote` that `stored` lacks or holds an older time for: what a
 * concurrent writer dropped. Empty when `stored` kept everything.
 */
export function lostFlowLastSeen(stored: FlowLastSeen, wrote: FlowLastSeen): string[] {
  return Object.entries(wrote.byInput)
    .filter(([key, at]) => {
      const kept = stored.byInput[key];
      return kept === undefined || kept < at;
    })
    .map(([key]) => key);
}

/**
 * Do not rewrite an input's time more often than this: a flowing source would
 * otherwise cost one KV write per poll (one a minute). Ten minutes of drift is
 * nothing beside a "last seen 3 days ago".
 */
export const FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS = 10 * 60 * 1000;

/** The document key of one input: `group/type:id`, pack-qualified when it lives in a pack. */
export function flowInputKey({ groupId, input }: LastSeenSource): string {
  const id = input.packId ? `${input.packId}.${input.id}` : input.id;
  return `${groupId}/${input.type}:${id}`;
}

function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Decode a KV load. Absent is the empty document; anything not understood is unknown. */
export function readFlowLastSeen(load: KvDocumentLoad): FlowLastSeenRead {
  if (load.kind === "unknown") return { kind: "unknown", reason: load.reason };
  if (load.kind === "absent") {
    return load.why === "corrupt"
      ? { kind: "unknown", reason: "the stored value is not JSON" }
      : { kind: "read", doc: EMPTY_FLOW_LAST_SEEN };
  }
  const v = load.value;
  if (typeof v !== "object" || v === null) return { kind: "unknown", reason: "the stored value is not a record" };
  const r = v as Record<string, unknown>;
  if (r.kind !== KIND) return { kind: "unknown", reason: "it holds a document this app did not write" };
  if (r.version !== VERSION) return { kind: "unknown", reason: "it was written by a release this one cannot read" };
  const raw = r.byInput;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "unknown", reason: "the stored value has no inputs" };
  }
  const byInput: Record<string, number> = {};
  for (const [key, at] of Object.entries(raw as Record<string, unknown>)) {
    // One bad entry makes the whole read unknown: dropping it would turn that
    // input into "never seen".
    if (!isTime(at)) return { kind: "unknown", reason: `the time stored for ${key} is not a time` };
    byInput[key] = at;
  }
  return { kind: "read", doc: { byInput } };
}

/** The value to save. */
export function encodeFlowLastSeen(doc: FlowLastSeen): unknown {
  return { kind: KIND, version: VERSION, byInput: { ...doc.byInput } };
}

/** Per input, the later of the two times. Commutative, so writers converge. */
export function mergeFlowLastSeen(a: FlowLastSeen, b: FlowLastSeen): FlowLastSeen {
  const byInput: Record<string, number> = { ...a.byInput };
  for (const [key, at] of Object.entries(b.byInput)) {
    const prev = byInput[key];
    if (prev === undefined || at > prev) byInput[key] = at;
  }
  return { byInput };
}

/**
 * Record that a measured window saw `sources` flowing at `at`. The returned
 * `doc` always carries the new times, so the screen shows them whether or not
 * a write is due. `due` is judged against `persisted` - what was last READ or
 * WRITTEN, not what is merely shown - and is true when at least one input is
 * new there or older than `minIntervalMs`: the only case worth a write.
 * Judging against the shown times would let a source flowing every minute
 * keep pushing its write back forever.
 */
export function recordFlowSeen(
  doc: FlowLastSeen,
  sources: readonly LastSeenSource[],
  at: number,
  persisted: FlowLastSeen = doc,
  minIntervalMs: number = FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS,
): { readonly doc: FlowLastSeen; readonly due: boolean } {
  if (!isTime(at) || sources.length === 0) return { doc, due: false };
  const byInput: Record<string, number> = { ...doc.byInput };
  let due = false;
  for (const source of sources) {
    const key = flowInputKey(source);
    const stored = persisted.byInput[key];
    if (stored === undefined || at - stored >= minIntervalMs) due = true;
    const prev = byInput[key];
    if (prev === undefined || at > prev) byInput[key] = at;
  }
  return { doc: { byInput }, due };
}

/** What the lane for `source` shows. Null `read` means the document has not been read yet. */
export function lastSeenFor(read: FlowLastSeenRead | null, source: LastSeenSource | null): LastSeenView {
  if (source === null) return { kind: "unknown", reason: "no Cribl source has been created for this lane" };
  if (read === null) return { kind: "unknown", reason: "not read yet" };
  if (read.kind === "unknown") return { kind: "unknown", reason: `the remembered times could not be read (${read.reason})` };
  const at = read.doc.byInput[flowInputKey(source)];
  return at === undefined ? { kind: "never" } : { kind: "seen", at };
}

/** The sentence for a lane, with the caller's time format (core has no clock or locale). */
export function describeLastSeen(view: LastSeenView, formatTime: (ms: number) => string): string {
  switch (view.kind) {
    case "seen":
      return `Last seen flowing ${formatTime(view.at)} (remembered by this app from an earlier reading, not measured now).`;
    case "never":
      return "Never seen flowing by this app (it remembers only what it measured while Watch for data was on).";
    case "unknown":
      return `When it was last seen flowing is unknown: ${view.reason}.`;
  }
}
