import type { TaggedSample } from "../domain/sample-parsing/models";
import type { TaggedSampleStore } from "../ports/tagged-sample-store";

/**
 * In-memory {@link TaggedSampleStore} for tests. Pure and deterministic - it
 * takes NO injected dependencies (no clock, no ids): entries are keyed by
 * logType and `list` returns them in first-upsert order. All values in and out
 * are deep copies, so mutating a returned sample never affects the store (and
 * the round-trip mirrors the KV/host adapters' JSON serialization).
 */
export class FakeTaggedSampleStore implements TaggedSampleStore {
  private readonly entries = new Map<string, TaggedSample>();

  async upsert(sample: TaggedSample): Promise<void> {
    // A plain Map.set gives exactly the legacy replace semantics: an existing
    // logType is updated IN PLACE (its list position is preserved), a new one
    // is appended. This mirrors the legacy in-place replace of tagged samples.
    this.entries.set(sample.logType, deepCopy(sample));
  }

  async get(logType: string): Promise<TaggedSample | null> {
    const found = this.entries.get(logType);
    return found === undefined ? null : deepCopy(found);
  }

  async list(): Promise<TaggedSample[]> {
    return [...this.entries.values()].map(deepCopy);
  }

  async remove(logType: string): Promise<void> {
    this.entries.delete(logType);
  }
}

/** JSON-faithful deep copy (TaggedSample is defined to be KV-serializable). */
function deepCopy(sample: TaggedSample): TaggedSample {
  return JSON.parse(JSON.stringify(sample)) as TaggedSample;
}
