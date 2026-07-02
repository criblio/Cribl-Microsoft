import type { ArtifactSink } from '../ports/artifact-sink';

/** One recorded {@link FakeArtifactSink.save} call. */
export interface SavedArtifact {
  name: string;
  mimeType: string;
  data: Uint8Array | string;
}

/**
 * In-memory {@link ArtifactSink} for tests. Records every save in call order
 * so assertions can inspect what a usecase exported.
 */
export class FakeArtifactSink implements ArtifactSink {
  /** All saves, in the order they happened. */
  readonly saves: SavedArtifact[] = [];

  async save(name: string, mimeType: string, data: Uint8Array | string): Promise<void> {
    this.saves.push({ name, mimeType, data });
  }

  /** The most recent save with the given name, or undefined. */
  find(name: string): SavedArtifact | undefined {
    for (let i = this.saves.length - 1; i >= 0; i--) {
      if (this.saves[i]!.name === name) return this.saves[i];
    }
    return undefined;
  }
}
