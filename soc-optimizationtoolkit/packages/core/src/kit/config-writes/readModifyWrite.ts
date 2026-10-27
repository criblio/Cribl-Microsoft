// Writing to configuration another admin also owns: merge, diff, and the confirm-then-write flow.
//
// Standard: standards/config-plane-writes.md rules 1–6 and 8.
//
// Provenance:
//  - Many Cribl PATCH endpoints replace the whole object ("does not support partial updates…
//    removes any omitted fields") — Documented (OpenAPI 4.19.0, e.g. PATCH /system/inputs/{id}).
//    That is why this module never sends a partial body.
//  - A PATCH with a complete top level but a partial `schedule` sub-object deleted `tz` and
//    `keepLastN` with a 200 — Measured 2026-09-17 (PATCH /search/saved/{id}). Hence recursive merge.
//  - Server-owned fields sent back are ignored by the server (`user`, `displayUsername` on that
//    object) — Measured 2026-09-17. Hence "round-trip by default, strip only a proven allow-list".
//  - Config GETs answer `{items:[obj]}` — Measured on every endpoint this was written against.
//  - A `byId` merge whose element id was no longer in the fresh read (another admin deleted it
//    while the dialog was open) used to re-append the element silently, resurrecting it at the end
//    of a shared list — found by an app audit 2026-10-06, where the app's copy had already fixed it.
//    Hence `MissingArrayElementError` (append is opt-in via `allowAppend`), the `void` + `missing`
//    outcome, `idOrderProblem`, and per-element diff rows so the dialog names the element.
//
// The flow it enforces:
//   1. Before the dialog: read, compute the human-facing diff, render it. (`planChange`)
//   2. The person approves THAT diff.
//   3. After the answer, in the same tick as the write: read AGAIN, recompute the diff against the
//      fresh read, and compare diffs. Different → VOID (re-render). Empty → already applied.
//      Same → send the merged fresh body. (`writeApproved`)
//   4. The audit entry is built from what was SENT, not from what was rendered.
//   5. After a 2xx: read the object back and re-plan the same change against it. Anything left to
//      change is "written, not verified" — never committed or deployed. (`verifyStored`)
//
// No request between the re-read and the write (added 2026-10-07). Every pre-write check that needs
// a request of its own — objects the change points at, an ownership record in KV, the commit scope
// (`commitScopeGrew`) — runs BEFORE `writeApproved`. A check that must look at the re-read is
// two-phase: its async preparation runs first and returns a synchronous `FreshCheck`, which
// `writeApproved` runs on the re-read just before the write. An app that awaited such checks between
// its re-read and its whole-table PATCH reverted a route another admin saved during the checks.

import { isOk, type ApiResponse, type Request } from './transport';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

export const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep equality over JSON. Key order is not a difference; array order is. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

/**
 * How an array-valued field is reconciled. There is no default that is right for both a list the
 * app owns and a list shared with the customer, so every array the change touches must be declared
 * — the merge throws on an undeclared one rather than guessing.
 *  - `replace`: the app owns the whole list (or the caller supplies the whole list, copied from a
 *    read, and relies on the diff compare to void if anything else in it moved).
 *  - `byId`: shared list; elements matched on `idKey`, the app's elements merged in, others kept in
 *    place. A change element whose id is not in the list throws `MissingArrayElementError` unless
 *    `allowAppend` is set: on a shared list a missing id usually means someone deleted it while the
 *    dialog was open, and appending would quietly put it back at the end.
 *
 * Keys are paths: `routes`, `conf.functions`; an element's children are under `<path>[]`.
 */
export type ArrayPolicy = { kind: 'replace' } | { kind: 'byId'; idKey: string; allowAppend?: boolean };

export class UndeclaredArrayError extends Error {
  // Plain field, not a parameter property: erasableSyntaxOnly (create-app scaffold) rejects them.
  readonly path: string;
  constructor(path: string) {
    super(`The change sets an array at "${path}" with no declared ArrayPolicy. Decide replace-whole or by-id and write it down at the call site.`);
    this.name = 'UndeclaredArrayError';
    this.path = path;
  }
}

/** A `byId` change names an element the list no longer holds (or names no id at all). */
export class MissingArrayElementError extends Error {
  readonly path: string;
  readonly id: unknown;
  constructor(path: string, id: unknown) {
    super(
      id === undefined
        ? `The change to "${path}" names an element without an id.`
        : `"${path}" no longer holds an element with id ${JSON.stringify(id)}; it may have been deleted in Cribl.`,
    );
    this.name = 'MissingArrayElementError';
    this.path = path;
    this.id = id;
  }
}

/**
 * Merge `changes` into `current` recursively. Keys absent from `changes` are kept — including keys
 * this app has never heard of, because under full replacement a dropped key is a deleted key.
 * `undefined` in `changes` means "leave alone"; to remove a key the caller must do it explicitly.
 */
export function deepMerge(current: unknown, changes: unknown, arrays: Readonly<Record<string, ArrayPolicy>> = {}, path = ''): Json {
  if (Array.isArray(changes)) {
    const policy = arrays[path];
    if (!policy) throw new UndeclaredArrayError(path || '(root)');
    if (policy.kind === 'replace' || !Array.isArray(current)) return changes as Json;
    const out = [...(current as Json[])];
    for (const el of changes as Json[]) {
      const id = isPlainObject(el) ? el[policy.idKey] : undefined;
      const at = id === undefined ? -1 : out.findIndex((c) => isPlainObject(c) && sameValue(c[policy.idKey], id));
      if (at === -1) {
        if (!policy.allowAppend || id === undefined) throw new MissingArrayElementError(path, id);
        out.push(el);
      } else out[at] = deepMerge(out[at], el, arrays, `${path}[]`);
    }
    return out;
  }
  if (isPlainObject(changes)) {
    const base: JsonObject = isPlainObject(current) ? { ...(current as JsonObject) } : {};
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) continue;
      const childPath = path ? `${path}.${k}` : k;
      base[k] = deepMerge(base[k], v, arrays, childPath);
    }
    return base;
  }
  return changes as Json;
}

/** One human-readable row of a change. */
export interface DiffRow {
  path: string;
  from: Json | undefined;
  to: Json | undefined;
}

/**
 * Leaf-level differences between two objects, in the units the person approves.
 *
 * Arrays: with no `arrays` entry an array compares whole (one row). With a `byId` policy and the
 * same ids in the same order on both sides, each element diffs on its own, under
 * `path[id=<id>]`. With a `replace` policy and equal lengths, elements diff by index, under
 * `path[<i>]`. Anything else (a length change, a reorder, a missing or repeated id) is one
 * whole-array row, so an add, remove or reorder can never hide behind an empty diff.
 */
export function diffRows(before: unknown, after: unknown, arrays: Readonly<Record<string, ArrayPolicy>> = {}): DiffRow[] {
  return diffAt(before, after, arrays, '', '');
}

function elementIds(list: readonly unknown[], idKey: string): unknown[] | null {
  const ids = list.map((el) => (isPlainObject(el) ? el[idKey] : undefined));
  if (ids.some((id) => id === undefined || id === null || typeof id === 'object')) return null;
  return new Set(ids).size === ids.length ? ids : null;
}

function diffAt(before: unknown, after: unknown, arrays: Readonly<Record<string, ArrayPolicy>>, shown: string, policyPath: string): DiffRow[] {
  if (sameValue(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffAt(before[k], after[k], arrays, shown ? `${shown}.${k}` : k, policyPath ? `${policyPath}.${k}` : k));
  }
  const policy = arrays[policyPath];
  if (policy && Array.isArray(before) && Array.isArray(after)) {
    if (policy.kind === 'byId') {
      const a = elementIds(before, policy.idKey);
      const b = elementIds(after, policy.idKey);
      if (a && b && sameValue(a, b)) {
        return before.flatMap((el, i) => diffAt(el, after[i], arrays, `${shown}[id=${String(a[i])}]`, `${policyPath}[]`));
      }
    } else if (before.length === after.length) {
      return before.flatMap((el, i) => diffAt(el, after[i], arrays, `${shown}[${i}]`, `${policyPath}[]`));
    }
  }
  return [{ path: shown || '(root)', from: before as Json | undefined, to: after as Json | undefined }];
}

/** The value at a dotted policy path (no `[]` segments), or undefined. */
function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * For every top-level `byId` list without `allowAppend`: the ids in `merged` must be exactly the ids
 * in `fresh`, in the same order. The merge cannot add, drop or move an element on its own, so this is
 * the belt to its braces. Returns the first list that differs, or null.
 */
export function idOrderProblem(fresh: unknown, merged: unknown, arrays: Readonly<Record<string, ArrayPolicy>> = {}): string | null {
  for (const [path, policy] of Object.entries(arrays)) {
    if (policy.kind !== 'byId' || policy.allowAppend || path.includes('[]')) continue;
    const ids = (v: unknown) => (Array.isArray(v) ? v.map((el) => (isPlainObject(el) ? el[policy.idKey] : undefined)) : null);
    if (!sameValue(ids(valueAt(fresh, path)), ids(valueAt(merged, path)))) return path;
  }
  return null;
}

/** Two diffs describe the same change. This, not body equality, is the drift check (rule 6). */
export function sameDiff(a: readonly DiffRow[], b: readonly DiffRow[]): boolean {
  const key = (r: DiffRow) => r.path;
  const sa = [...a].sort((x, y) => key(x).localeCompare(key(y)));
  const sb = [...b].sort((x, y) => key(x).localeCompare(key(y)));
  return sa.length === sb.length && sa.every((r, i) => r.path === sb[i]!.path && sameValue(r.from, sb[i]!.from) && sameValue(r.to, sb[i]!.to));
}

/** `{items:[obj]}` → obj, or a bare object. */
export function firstItem(body: unknown): Record<string, unknown> | null {
  const items = isPlainObject(body) ? body.items : undefined;
  if (Array.isArray(items)) return isPlainObject(items[0]) ? items[0] : null;
  return isPlainObject(body) ? body : null;
}

export interface WriteTarget {
  /** e.g. `/m/default/system/inputs/in_syslog`. */
  path: string;
  /**
   * The verb, chosen after READING THE ENDPOINT'S DESCRIPTION in the spec (rule 1). Never inferred
   * from an example body. Whatever it is, this module sends the full merged object.
   */
  method: 'PATCH' | 'PUT';
  /** Fields the server provably owns, each with how you know. Everything else round-trips. */
  serverOwned?: Readonly<Record<string, string>>;
  arrays?: Readonly<Record<string, ArrayPolicy>>;
}

export type Plan =
  | { kind: 'planned'; before: Record<string, unknown>; diff: DiffRow[] }
  | { kind: 'nothing-to-do'; before: Record<string, unknown> }
  | { kind: 'unreadable'; response: ApiResponse };

/** Step 1: the read the dialog describes. Its body is NOT reused for the write. */
export async function planChange(request: Request, target: WriteTarget, changes: Record<string, unknown>, signal?: AbortSignal): Promise<Plan> {
  const r = await request('GET', target.path, { signal });
  const before = isOk(r.status) ? firstItem(r.body) : null;
  if (!before) return { kind: 'unreadable', response: r };
  const diff = diffRows(before, deepMerge(before, changes, target.arrays), target.arrays);
  return diff.length ? { kind: 'planned', before, diff } : { kind: 'nothing-to-do', before };
}

export type WriteOutcome =
  | { kind: 'written'; sent: Json; response: ApiResponse; audit: DiffRow[] }
  | { kind: 'already-applied' }
  /** `missing` is set when the element the change names is no longer there (or the list moved). */
  | { kind: 'void'; approved: DiffRow[]; now: DiffRow[]; missing?: string }
  | { kind: 'unreadable'; response: ApiResponse }
  | { kind: 'refused'; response: ApiResponse; sent: Json }
  /** `checkFresh` refused the re-read (or threw, or was not synchronous). Nothing was sent. */
  | { kind: 'refused-before-write'; reason: string; fresh: Record<string, unknown> };

/**
 * The synchronous half of a two-phase pre-write check, run by `writeApproved` on the re-read just
 * before the write. Returns a reason to refuse, or null. It must not make a request: prepare
 * everything it needs (KV records, referenced objects) BEFORE calling `writeApproved`, so no request
 * sits between the re-read and the write and nothing another admin saves in between can be reverted.
 */
export type FreshCheck = (fresh: Record<string, unknown>, merged: Record<string, unknown>) => string | null;

/**
 * Step 3: after the person approved `approvedDiff`. Re-reads, re-derives, compares diffs, writes.
 * There is deliberately no parameter that skips the re-read.
 *
 * Between the re-read and the write only `checkFresh` runs, and it runs synchronously: a check that
 * returns a promise refuses the write rather than being awaited. Every check that needs a request
 * runs before this call (standard rule 2, "No request between the re-read and the write").
 */
export async function writeApproved(
  request: Request,
  target: WriteTarget,
  changes: Record<string, unknown>,
  approvedDiff: readonly DiffRow[],
  signal?: AbortSignal,
  checkFresh?: FreshCheck,
): Promise<WriteOutcome> {
  const r = await request('GET', target.path, { signal });
  const fresh = isOk(r.status) ? firstItem(r.body) : null;
  if (!fresh) return { kind: 'unreadable', response: r };

  let merged: JsonObject;
  try {
    merged = deepMerge(fresh, changes, target.arrays) as JsonObject;
  } catch (err) {
    // The element the person approved a change to is gone: there is nothing their approval describes.
    if (err instanceof MissingArrayElementError) return { kind: 'void', approved: [...approvedDiff], now: [], missing: err.message };
    throw err;
  }
  // The merge never adds, drops or moves an element of a shared list; refuse if it somehow did.
  const moved = idOrderProblem(fresh, merged, target.arrays);
  if (moved) return { kind: 'void', approved: [...approvedDiff], now: [], missing: `The elements of "${moved}" would not go back exactly as read.` };
  const now = diffRows(fresh, merged, target.arrays);
  // Someone already set exactly what we were about to: the transition is empty.
  if (now.length === 0) return { kind: 'already-applied' };
  // Anything else that moved — in either direction — voids the approval. Re-render, don't re-derive.
  if (!sameDiff(now, approvedDiff)) return { kind: 'void', approved: [...approvedDiff], now };

  if (checkFresh) {
    let why: unknown;
    try {
      why = checkFresh(fresh, merged);
    } catch (err) {
      why = `The check this change needs before writing failed (${err instanceof Error ? err.message : String(err)}).`;
    }
    if (why !== null && typeof (why as { then?: unknown } | undefined)?.then === 'function') {
      // Awaiting it would put a request between the re-read and the write. Refuse; never await.
      (why as Promise<unknown>).catch(() => undefined);
      why = 'A pre-write check returned a promise; prepare it before writeApproved and pass its synchronous half.';
    }
    if (why !== null && why !== undefined) return { kind: 'refused-before-write', reason: String(why), fresh };
  }

  const sent: JsonObject = { ...merged };
  for (const k of Object.keys(target.serverOwned ?? {})) delete sent[k];
  const response = await request(target.method, target.path, { body: sent, signal });
  if (!isOk(response.status)) return { kind: 'refused', response, sent };
  // The audit is the diff that was actually SENT against the fresh read.
  return { kind: 'written', sent, response, audit: diffRows(fresh, sent, target.arrays) };
}

export type StoredCheck =
  | { kind: 'stored' }
  /** Applying the change to what Cribl now holds would still change these rows: `from` is stored, `to` was sent. */
  | { kind: 'mismatch'; mismatches: DiffRow[] }
  /** A by-id element the change named is gone from the read-back. */
  | { kind: 'missing-element'; message: string }
  | { kind: 'unreadable'; response: ApiResponse }
  /** The read-back itself rejected (network, timeout, abort). Still unverified, never "probably fine". */
  | { kind: 'read-failed'; error: unknown };

/**
 * Read the object back after an ACCEPTED write (rule 1a: an endpoint can answer 200 and reset or
 * drop a field). Stored means re-planning the same change against what Cribl now holds would change
 * nothing — so only the fields the change named are compared, and a by-id array compares per
 * element, so another admin's edit to a different element of the same list is not a mismatch.
 * Anything but `stored` is "written, not verified": never commit or deploy it.
 *
 * Prefer this over `readBack` for any target with shared arrays — `readBack` compares an array
 * field whole. Either proves the value is stored, not that it took effect (rule 1b).
 */
export async function verifyStored(request: Request, target: WriteTarget, changes: Record<string, unknown>, signal?: AbortSignal): Promise<StoredCheck> {
  let p: Plan;
  try {
    p = await planChange(request, target, changes, signal);
  } catch (err) {
    if (err instanceof MissingArrayElementError) return { kind: 'missing-element', message: err.message };
    // The write already landed: a rejected read-back must not escape as a generic error a caller
    // could mistake for "the write failed" (or swallow and go on to commit).
    return { kind: 'read-failed', error: err };
  }
  if (p.kind === 'nothing-to-do') return { kind: 'stored' };
  if (p.kind === 'unreadable') return { kind: 'unreadable', response: p.response };
  return { kind: 'mismatch', mismatches: p.diff };
}

/**
 * A 200 and a correct read-back do not prove the write took effect (rule 1b: some fields are
 * creation-only). Use this to say "stored" — and keep saying "not verified in effect" where the
 * effect can only be observed in data. Compares each named field WHOLE, arrays included: for a
 * shared list use `verifyStored`.
 */
export async function readBack(request: Request, path: string, expected: Record<string, unknown>, signal?: AbortSignal): Promise<{ stored: boolean; mismatches: DiffRow[] }> {
  const r = await request('GET', path, { signal });
  const obj = isOk(r.status) ? firstItem(r.body) : null;
  if (!obj) return { stored: false, mismatches: [{ path: '(root)', from: undefined, to: undefined }] };
  const mismatches = Object.entries(expected).flatMap(([k, v]) => diffRows({ [k]: v }, { [k]: obj[k] }));
  return { stored: mismatches.length === 0, mismatches };
}
