import { isKvDocumentKey } from "../ports/kv-document-store";
import type { KvDocumentLoad, KvDocumentStore } from "../ports/kv-document-store";

/** One recorded {@link FakeKvDocumentStore.save} call that reached the store. */
export interface FakeKvDocumentSave {
  key: string;
  value: unknown;
}

/**
 * In-memory {@link KvDocumentStore} for tests. Pure and deterministic: no
 * clock, no ids.
 *
 * By default it behaves like a working store - a saved key loads back as
 * `value`, any other key as `absent: not-found`. A test makes it misbehave on
 * purpose:
 * - {@link scriptLoad} pins what `load(key)` answers (an `unknown` read, a
 *   corrupt `absent`, a foreign `value`) regardless of what is stored, until
 *   {@link clearScript}.
 * - {@link failSaves} makes every later `save` reject, the way a non-ok PUT
 *   does, without recording or storing anything.
 *
 * What it records: {@link loads} (every key asked for, in order - the screen
 * pins count them) and {@link saves} (every save that succeeded, in order).
 * Values in and out are JSON copies, so mutating what a test passed or got
 * back never reaches the store, and a value JSON cannot carry fails here as it
 * would on the wire.
 *
 * Like the port, `load` never rejects - an unsafe key loads as `unknown` - and
 * `save` rejects on a key {@link isKvDocumentKey} refuses, so a key that would
 * 404 in the product cannot pass a unit test.
 */
export class FakeKvDocumentStore implements KvDocumentStore {
  /** Every key `load` was called with, in call order. */
  readonly loads: string[] = [];
  /** Every save that succeeded, in call order (JSON copies). */
  readonly saves: FakeKvDocumentSave[] = [];

  private readonly stored = new Map<string, string>();
  private readonly scripted = new Map<string, KvDocumentLoad>();
  private saveFailure: Error | null = null;

  /** Seed stored documents, as if an earlier session had saved them. */
  constructor(seed: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.stored.set(key, JSON.stringify(value));
    }
  }

  /** Make `load(key)` answer `outcome` until {@link clearScript}. */
  scriptLoad(key: string, outcome: KvDocumentLoad): this {
    this.scripted.set(key, copy(outcome));
    return this;
  }

  /** Drop every scripted load, so `load` reads the stored documents again. */
  clearScript(): this {
    this.scripted.clear();
    return this;
  }

  /**
   * Make every later `save` reject with `error` (a default message when
   * omitted), or pass `null` to let saves succeed again.
   */
  failSaves(error: Error | null = new Error("PUT kvstore: HTTP 500 (FakeKvDocumentStore)")): this {
    this.saveFailure = error;
    return this;
  }

  /** The document stored at `key` as a JSON copy, or undefined - for assertions. */
  peek(key: string): unknown {
    const text = this.stored.get(key);
    return text === undefined ? undefined : JSON.parse(text);
  }

  async load(key: string): Promise<KvDocumentLoad> {
    this.loads.push(key);
    if (!isKvDocumentKey(key)) {
      return { kind: "unknown", reason: `unsafe KV key '${key}'` };
    }
    const scripted = this.scripted.get(key);
    if (scripted !== undefined) {
      return copy(scripted);
    }
    const text = this.stored.get(key);
    return text === undefined
      ? { kind: "absent", why: "not-found" }
      : { kind: "value", value: JSON.parse(text) as unknown };
  }

  async save(key: string, value: unknown): Promise<void> {
    if (!isKvDocumentKey(key)) {
      throw new Error(`unsafe KV key '${key}'`);
    }
    if (this.saveFailure !== null) {
      throw this.saveFailure;
    }
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new Error(`KV document for '${key}' is not JSON-serializable`);
    }
    this.stored.set(key, text);
    this.saves.push({ key, value: JSON.parse(text) as unknown });
  }
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
