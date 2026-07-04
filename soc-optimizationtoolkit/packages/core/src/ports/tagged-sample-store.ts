/**
 * TaggedSampleStore port - persistence for user-tagged samples, keyed by log
 * type (porting-plan Unit 11, ENG-18). The shell binds the adapter:
 * - Cloud shell: KV-backed (the 200-event rawEvents cap keeps each entry small).
 * - Local shell: the Node host store.
 *
 * Semantics: `upsert` REPLACES any existing entry for the same logType (the
 * store is keyed by TaggedSample.logType, so re-tagging a log type overwrites
 * it rather than accumulating). This is the seam behind the sample-intake UI's
 * "one chip per log type" model.
 */

import type { TaggedSample } from "../domain/sample-parsing/models";

/**
 * CRUD store for {@link TaggedSample}s within one scope (e.g. one solution).
 *
 * Error semantics: `upsert`/`remove` reject on backend failure. `get` resolves
 * null for an unknown logType; `list` resolves [] when empty; `remove` of an
 * unknown logType is a no-op (does not reject).
 */
export interface TaggedSampleStore {
  /**
   * Insert `sample`, REPLACING any existing entry with the same
   * {@link TaggedSample.logType}. Resolves when persisted.
   */
  upsert(sample: TaggedSample): Promise<void>;

  /** Resolve the tagged sample for `logType`, or null when none exists. */
  get(logType: string): Promise<TaggedSample | null>;

  /** List all tagged samples. Resolves [] when the store is empty. */
  list(): Promise<TaggedSample[]>;

  /** Remove the entry for `logType`. A missing logType is a no-op. */
  remove(logType: string): Promise<void>;
}
